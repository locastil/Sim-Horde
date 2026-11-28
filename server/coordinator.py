"""
Sim Horde coordinator
=====================
Hands out simulation jobs to volunteer GPUs, checks and scores what comes back, keeps the kudos
ledger, and serves the public website. An expansion of the California simulation (LA-Sim): the
engine and data come from the folder above this one.

Jobs are data only (a set of behavior weights, a random seed, a population size). The simulation
engine itself is only handed to workers that have joined the team (optionally with an invite code).

    python coordinator.py                 # http://127.0.0.1:7700
    python coordinator.py --port 7700 --public-url https://your-pc.ts.net
"""
import argparse
import gzip
import hashlib
import json
import math
import os
import random
import secrets
import sqlite3
import sys
import threading
import time
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer

HERE = os.path.dirname(os.path.abspath(__file__))
ENGINE = os.environ.get("SIM_ENGINE_DIR", os.path.join(HERE, "engine"))   # Sim Horde's own copy of the engine
sys.path.insert(0, ENGINE)

import calibrate as CAL                          # noqa: E402  (the engine's own calibration code)
import world_engine                              # noqa: E402
import scenarios as SC                           # noqa: E402  (kudos, link codes, horde-run scenarios)
import ideas as IDEAS                            # noqa: E402  (the idea desk on the Model lab page)
from ca_region_gpu import COUNTIES, W_DEFAULT, MEET    # noqa: E402
MEET_MODE = MEET["mode"]                         # how people meet, as the engine copy's trained weights say

DB = os.path.join(HERE, "horde.db")
WEB = os.path.join(HERE, "web")
LOCK = threading.RLock()
ONLINE_SECS = 180            # a worker seen in the last 3 minutes is online
ASSIGN_TIMEOUT = 45 * 60     # a job not returned in 45 minutes goes back in the queue
VERIFY_SHARE = 0.10          # share of finished jobs re-run by a different worker
VERIFY_TOL = 0.06            # two runs of the same job must agree within this on the fit score
CAMPAIGN = dict(name="California calibration", explore=600, refine=2500, agents=400_000)
NAMES = sorted(COUNTIES, key=lambda n: -COUNTIES[n][1])
FIT, TEST = NAMES[0::2], NAMES[1::2]
T, TMETA = None, None        # real county targets, loaded at start
DATA_PACK = b""              # county data for workers (gzip JSON), sent only to registered workers
KERNEL_SHA = ""              # the public kernel's fingerprint; workers running anything else are turned away
BROWSER_SHA = ""             # the browser kernel's fingerprint (web/worker/kernel.js): phones, tablets, any browser
PACK_FILES = ["fred_cache.json"] + [f"official/{f}.json" for f in
              ("commute", "irs_moves", "polls", "sci", "social_capital", "third_places", "tracts", "places", "population")]
INVITE = ""                  # if set, joining needs this code


# ------------------------------------------------------------------ database
def db():
    c = sqlite3.connect(DB, timeout=30, isolation_level=None)
    c.row_factory = sqlite3.Row
    return c


def init_db():
    c = db()
    c.executescript("""
    PRAGMA journal_mode=WAL;
    CREATE TABLE IF NOT EXISTS workers(
        id INTEGER PRIMARY KEY, name TEXT, key_hash TEXT UNIQUE, gpu TEXT, vram_gb REAL,
        created REAL, last_seen REAL, status TEXT, jobs_done INTEGER DEFAULT 0, kudos REAL DEFAULT 0,
        trust INTEGER DEFAULT 0, flagged INTEGER DEFAULT 0, secs_total REAL DEFAULT 0);
    CREATE TABLE IF NOT EXISTS jobs(
        id INTEGER PRIMARY KEY, kind TEXT, tag TEXT, payload TEXT, status TEXT, created REAL,
        assigned_to INTEGER, assigned_at REAL, done_at REAL, verify_of INTEGER, result TEXT,
        score_fit REAL, score_test REAL, civ REAL, secs REAL, verified INTEGER DEFAULT 0);
    CREATE INDEX IF NOT EXISTS jobs_status ON jobs(status);
    CREATE TABLE IF NOT EXISTS signups(ip TEXT, t REAL);
    """)
    SC.init(c)
    c.close()


def key_hash(k):
    return hashlib.sha256(k.encode()).hexdigest()


def worker_for(c, key):
    if not key or len(key) > 100:
        return None
    return c.execute("SELECT * FROM workers WHERE key_hash=?", (key_hash(key),)).fetchone()


# ------------------------------------------------------------------ jobs
def finished_rows(c):
    rows = []
    for j in c.execute("SELECT j.tag, j.payload, j.score_fit FROM jobs j LEFT JOIN workers w ON w.id=j.assigned_to "
                       "WHERE j.status='done' AND j.verify_of IS NULL AND COALESCE(w.flagged,0)=0"):
        rows.append(dict(tag=j["tag"], theta=json.loads(j["payload"])["theta"], score_fit=j["score_fit"]))
    return rows


def top_up_queue(c, want):
    """Keep enough jobs queued: the exploration design first, then fine-tuning around the best results."""
    queued = c.execute("SELECT COUNT(*) FROM jobs WHERE status='queued'").fetchone()[0]
    if queued >= want:
        return
    n = want - queued
    made = c.execute("SELECT tag, COUNT(*) FROM jobs WHERE verify_of IS NULL GROUP BY tag").fetchall()
    made = {r[0]: r[1] for r in made}
    rng = random.Random(time.time_ns())
    thetas = []
    if made.get("explore", 0) < CAMPAIGN["explore"]:
        k = min(n, CAMPAIGN["explore"] - made.get("explore", 0))
        thetas += [("explore", t) for t in CAL.sample_thetas(k, rng)]
    if len(thetas) < n and made.get("refine", 0) < CAMPAIGN["refine"]:
        rows = finished_rows(c)
        if rows:
            done = made.get("refine", 0)
            sigma = max(0.012, 0.12 * 0.85 ** (done // 100))
            k = min(n - len(thetas), CAMPAIGN["refine"] - done)
            thetas += [("refine", t) for t in CAL.refine_thetas(rows, k, rng, sigma)]
    now = time.time()
    for tag, th in thetas:
        payload = dict(theta={k: float(v) for k, v in th.items()}, seed=rng.randrange(1, 2**31),
                       agents=CAMPAIGN["agents"], min_agents=250, meet=MEET_MODE)
        c.execute("INSERT INTO jobs(kind, tag, payload, status, created) VALUES('calibrate', ?, ?, 'queued', ?)",
                  (tag, json.dumps(payload), now))


def requeue_stale(c):
    c.execute("UPDATE jobs SET status='queued', assigned_to=NULL, assigned_at=NULL WHERE status='assigned' AND assigned_at<?",
              (time.time() - ASSIGN_TIMEOUT,))


def pop_job(c, w):
    requeue_stale(c)
    online = c.execute("SELECT COUNT(*) FROM workers WHERE last_seen>?", (time.time() - ONLINE_SECS,)).fetchone()[0]
    top_up_queue(c, max(4, online * 3))
    # verification jobs go first, and never to the worker whose result is being checked
    j = c.execute("""SELECT j.* FROM jobs j WHERE j.status='queued' AND j.verify_of IS NOT NULL
                     AND NOT EXISTS (SELECT 1 FROM jobs o WHERE o.id=j.verify_of AND o.assigned_to=?)
                     ORDER BY j.id LIMIT 1""", (w["id"],)).fetchone()
    if j is None:
        j = c.execute("SELECT * FROM jobs WHERE status='queued' AND verify_of IS NULL ORDER BY id LIMIT 1").fetchone()
    if j is None:
        return None
    c.execute("UPDATE jobs SET status='assigned', assigned_to=?, assigned_at=? WHERE id=?", (w["id"], time.time(), j["id"]))
    return dict(id=j["id"], kind=j["kind"], payload=json.loads(j["payload"]))



def valid_out(out):
    try:
        for k in ("log_rude", "stress", "irr", "leave"):
            d = out[k]
            if set(d) != set(NAMES):
                return False
            if any(not isinstance(v, (int, float)) or not math.isfinite(v) for v in d.values()):
                return False
        return 0.0 <= float(out["civ"]) <= 1.0
    except Exception:
        return False


def submit(c, w, job_id, out, secs):
    j = c.execute("SELECT * FROM jobs WHERE id=?", (job_id,)).fetchone()
    if j is None or j["status"] != "assigned" or j["assigned_to"] != w["id"]:
        return dict(error="that job isn't assigned to you (it may have timed out and gone to someone else)"), 409
    if not valid_out(out):
        c.execute("UPDATE jobs SET status='queued', assigned_to=NULL WHERE id=?", (job_id,))
        return dict(error="result rejected: it doesn't look like a simulation output"), 400
    s_fit, _ = CAL.score(out, T, FIT)
    s_test, _ = CAL.score(out, T, TEST)
    payload = json.loads(j["payload"])
    c.execute("""UPDATE jobs SET status='done', done_at=?, result=?, score_fit=?, score_test=?, civ=?, secs=? WHERE id=?""",
              (time.time(), json.dumps(out), s_fit, s_test, float(out["civ"]), float(secs), job_id))
    kd = SC.kudos_for(payload["agents"], CAL.BURN + CAL.MEASURE)
    c.execute("UPDATE workers SET jobs_done=jobs_done+1, kudos=kudos+?, secs_total=secs_total+? WHERE id=?", (kd, float(secs), w["id"]))
    msg = None
    if j["verify_of"] is not None:
        orig = c.execute("SELECT * FROM jobs WHERE id=?", (j["verify_of"],)).fetchone()
        if orig and orig["status"] == "done":
            agree = abs(orig["score_fit"] - s_fit) <= VERIFY_TOL and abs(orig["civ"] - float(out["civ"])) <= 0.02
            if agree:
                for jid in (orig["id"], job_id):
                    c.execute("UPDATE jobs SET verified=1 WHERE id=?", (jid,))
                c.execute("UPDATE workers SET trust=trust+1 WHERE id IN (?,?)", (orig["assigned_to"], w["id"]))
                msg = "verified: matched another volunteer's run"
            else:
                checks = c.execute("SELECT COUNT(*) FROM jobs WHERE verify_of=?", (orig["id"],)).fetchone()[0]
                if checks < 2:      # a third opinion settles it
                    c.execute("INSERT INTO jobs(kind, tag, payload, status, created, verify_of) VALUES(?,?,?,'queued',?,?)",
                              (orig["kind"], orig["tag"], orig["payload"], time.time(), orig["id"]))
                else:
                    third = [r for r in c.execute("SELECT * FROM jobs WHERE verify_of=? AND status='done'", (orig["id"],))]
                    fits = [orig["score_fit"]] + [r["score_fit"] for r in third]
                    med = sorted(fits)[len(fits) // 2]
                    for r in [orig] + third:
                        if abs(r["score_fit"] - med) > VERIFY_TOL:
                            c.execute("UPDATE workers SET trust=trust-2, flagged=CASE WHEN trust-2<=-4 THEN 1 ELSE flagged END WHERE id=?",
                                      (r["assigned_to"],))
    elif random.random() < VERIFY_SHARE:
        c.execute("INSERT INTO jobs(kind, tag, payload, status, created, verify_of) VALUES(?,?,?,'queued',?,?)",
                  (j["kind"], j["tag"], j["payload"], time.time(), job_id))
    return dict(ok=True, kudos=kd, score_fit=round(s_fit, 4), score_test=round(s_test, 4), note=msg), 200


# ------------------------------------------------------------------ public numbers
def stats(c):
    now = time.time()
    on = c.execute("SELECT name, gpu, vram_gb, status FROM workers WHERE last_seen>? AND flagged=0", (now - ONLINE_SECS,)).fetchall()
    done = c.execute("SELECT COUNT(*), COALESCE(SUM(secs),0) FROM jobs WHERE status='done'").fetchone()
    day = c.execute("SELECT COUNT(*) FROM jobs WHERE status='done' AND done_at>?", (now - 86400,)).fetchone()[0]
    best = c.execute("""SELECT j.score_fit, j.score_test, j.done_at, w.name, w.gpu FROM jobs j JOIN workers w ON w.id=j.assigned_to
                        WHERE j.status='done' AND j.verify_of IS NULL AND w.flagged=0 ORDER BY j.score_fit DESC LIMIT 1""").fetchone()
    made = {r[0]: r[1] for r in c.execute("SELECT tag, COUNT(*) FROM jobs WHERE status='done' AND verify_of IS NULL GROUP BY tag")}
    goal = CAMPAIGN["explore"] + CAMPAIGN["refine"]
    total_runs = sum(made.values())
    days = CAL.BURN + CAL.MEASURE
    gpus = {}
    for r in on:
        gpus[r["gpu"] or "GPU"] = gpus.get(r["gpu"] or "GPU", 0) + 1
    recent = []
    for r in c.execute("""SELECT j.id, j.done_at, j.score_fit, j.civ, j.secs, j.verified, j.verify_of, w.name, w.gpu FROM jobs j
                          JOIN workers w ON w.id=j.assigned_to WHERE j.status='done' ORDER BY j.done_at DESC LIMIT 12"""):
        recent.append(dict(id=r["id"], ago=round(now - r["done_at"]), score=round(r["score_fit"], 3),
                           secs=round(r["secs"], 1), verified=bool(r["verified"]), check=r["verify_of"] is not None,
                           worker=r["name"], gpu=r["gpu"]))
    return dict(
        campaign=CAMPAIGN["name"], workers_online=len(on), vram_online=round(sum(r["vram_gb"] or 0 for r in on), 1),
        gpus=sorted(([k, v] for k, v in gpus.items()), key=lambda x: -x[1]),
        runs_done=total_runs, runs_goal=goal, runs_24h=day, checks_done=c.execute(
            "SELECT COUNT(*) FROM jobs WHERE status='done' AND verify_of IS NOT NULL").fetchone()[0],
        person_days=done[0] * CAMPAIGN["agents"] * days, gpu_hours=round(done[1] / 3600, 2),
        best=None if best is None else dict(fit=round(best["score_fit"], 3), test=round(best["score_test"], 3),
                                            worker=best["name"], gpu=best["gpu"], ago=round(now - best["done_at"])),
        recent=recent, server_time=now, agents=CAMPAIGN["agents"], days=days,
        avg_secs=round(done[1] / done[0], 1) if done[0] else None)


def progress(c):
    pts, best, i = [], -9.0, 0
    for r in c.execute("SELECT score_fit FROM jobs WHERE status='done' AND verify_of IS NULL ORDER BY done_at"):
        i += 1
        best = max(best, r[0])
        pts.append([i, round(r[0], 4), round(best, 4)])
    step = max(1, len(pts) // 400)
    out = dict(points=pts[::step] + (pts[-1:] if pts and (len(pts) - 1) % step else []), goal=0.75)
    # The best run, checked on the half of the counties it was NOT picked on (picking the best of many runs
    # flatters the score it was picked by), with each real-world signal on its own.
    r = c.execute("SELECT result, score_fit, score_test FROM jobs WHERE status='done' AND verify_of IS NULL "
                  "ORDER BY score_fit DESC LIMIT 1").fetchone()
    if r is not None and T:
        try:
            _, parts = CAL.score(json.loads(r["result"]), T, TEST)
            out["best"] = dict(fit=round(r["score_fit"], 3), held_out=round(r["score_test"], 3),
                               parts={k: round(v, 3) for k, v in parts.items()}, counties=len(TEST))
        except Exception:
            pass
    return out


def latest_map(c):
    """The newest finished run, county by county: what the hero map shows."""
    r = c.execute("""SELECT j.id, j.result, j.done_at, j.score_fit, w.name, w.gpu FROM jobs j JOIN workers w ON w.id=j.assigned_to
                     WHERE j.status='done' AND w.flagged=0 ORDER BY j.done_at DESC LIMIT 1""").fetchone()
    if r is None:
        return dict(run=None)
    out = json.loads(r["result"])
    rude = {n: math.exp(v) for n, v in out["log_rude"].items()}
    return dict(run=r["id"], ago=round(time.time() - r["done_at"]), worker=r["name"], gpu=r["gpu"],
                score=round(r["score_fit"], 3), rude=rude, civ=out["civ"])


_WORLD = {"key": None, "body": None}
EVENT_KINDS = {"NEWS", "LAW", "STATE", "COURT", "VOTE", "HOLIDAY"}     # never "YOU" or anything personal


def live_world():
    """Your own live world (the one running in ca_region_gpu.py), county totals and headlines only."""
    import glob
    paths = [p for p in glob.glob(os.path.join(ENGINE, "*_results", "history.json"))]
    if not paths:
        return dict(world=None)
    p = max(paths, key=os.path.getmtime)
    key = (p, os.path.getmtime(p))
    if _WORLD["key"] != key:
        try:
            h = json.load(open(p, encoding="utf-8"))
        except (OSError, ValueError):
            return _WORLD["body"] or dict(world=None)
        counties = {c["name"]: dict(civ=c.get("civ"), stress=c.get("stress"), robots=bool(c.get("robots")),
                                    laws=len(c.get("laws") or [])) for c in h.get("counties", [])}
        events = [[e[1], e[2], str(e[3])[:240]] for e in h.get("events", [])[-400:] if len(e) >= 4 and e[2] in EVENT_KINDS][-30:]
        series = [[d, v] for d, v in (h.get("series") or [])][-240:]
        _WORLD["key"] = key
        _WORLD["body"] = dict(world=h.get("label", "California"), full_scale=os.path.basename(os.path.dirname(p)).startswith("california_full"),
                              date=h.get("date"), day=h.get("day"), civ=h.get("civ"), stress=h.get("stress"),
                              state_laws=h.get("state_laws", [])[:12], counties=counties, events=events[::-1], series=series,
                              mtime=os.path.getmtime(p))
    out = dict(_WORLD["body"])
    out["age"] = round(time.time() - out.pop("mtime"))
    return out


def leaderboard(c):
    rows = []
    for r in c.execute("SELECT name, gpu, jobs_done, secs_total, last_seen, trust FROM workers WHERE flagged=0 AND jobs_done>0 "
                       "ORDER BY secs_total DESC LIMIT 100"):
        rows.append(dict(name=r["name"], gpu=r["gpu"], jobs=r["jobs_done"],
                         hours=round(r["secs_total"] / 3600, 2), online=time.time() - (r["last_seen"] or 0) < ONLINE_SECS,
                         verified=r["trust"] > 0))
    return dict(workers=rows)


# ------------------------------------------------------------------ http
STATIC_TYPES = {".html": "text/html; charset=utf-8", ".css": "text/css", ".js": "application/javascript",
                ".json": "application/json", ".svg": "image/svg+xml", ".png": "image/png", ".mp4": "video/mp4",
                ".webp": "image/webp", ".ico": "image/x-icon", ".zip": "application/zip", ".woff2": "font/woff2"}


_GZ = {}


TRAFFIC_FILE = os.path.join(os.path.dirname(os.path.abspath(__file__)), "logs", "traffic.json")
_traffic = dict(mtime=0, raw=b"", gz=b"")


def live_traffic_body(gz):
    """The latest snapshot from live_traffic.py, or None if it isn't running (or is over 10 minutes old)."""
    try:
        mt = os.path.getmtime(TRAFFIC_FILE)
    except OSError:
        return None
    if time.time() - mt > 600:
        return None
    if mt != _traffic["mtime"]:
        raw = open(TRAFFIC_FILE, "rb").read()
        _traffic.update(mtime=mt, raw=raw, gz=gzip.compress(raw, 6))
    return (_traffic["gz"], True) if gz else (_traffic["raw"], False)


def gzip_cached(path, body):
    import gzip
    key = (path, os.path.getmtime(path))
    if key not in _GZ:
        _GZ[key] = gzip.compress(body, 6)
    return _GZ[key]


class H(BaseHTTPRequestHandler):
    server_version = "SimHorde/0.1"

    def log_message(self, fmt, *args):
        pass

    def _send(self, code, body, ctype="application/json", cache="no-store"):
        if isinstance(body, (dict, list)):
            body = json.dumps(body, separators=(",", ":")).encode()
        self.send_response(code)
        self.send_header("Content-Type", ctype)
        self.send_header("Content-Length", str(len(body)))
        self.send_header("Cache-Control", cache)
        self.send_header("X-Content-Type-Options", "nosniff")
        if getattr(self, "_gz", False):
            self.send_header("Content-Encoding", "gzip")
            self.send_header("Vary", "Accept-Encoding")
            self._gz = False
        self.end_headers()
        self.wfile.write(body)

    def _body(self):
        n = int(self.headers.get("Content-Length") or 0)
        if n > 120_000_000:
            raise ValueError("request too large")
        return json.loads(self.rfile.read(n) or b"{}")

    def _ip(self):
        return self.headers.get("X-Forwarded-For", self.client_address[0]).split(",")[0].strip()

    def do_GET(self):
        path = self.path.split("?")[0]
        with LOCK:
            c = db()
            try:
                if path == "/api/v1/stats":
                    return self._send(200, stats(c))
                if path == "/api/v1/progress":
                    return self._send(200, progress(c))
                if path == "/api/v1/leaderboard":
                    return self._send(200, leaderboard(c))
            finally:
                c.close()
        if path == "/api/v1/globe":
            return self._send(200, WORLD.public() if WORLD else dict(date=None))
        if path == "/api/v1/markets":
            body = json.dumps(WORLD.markets() if WORLD else dict(date=None), separators=(",", ":")).encode()
            if "gzip" in (self.headers.get("Accept-Encoding") or ""):
                body = gzip.compress(body, 6)
                self._gz = True
            return self._send(200, body)
        if path == "/api/v1/traffic":                  # real aircraft and ships, gathered by live_traffic.py
            body = live_traffic_body("gzip" in (self.headers.get("Accept-Encoding") or ""))
            if body is None:
                return self._send(200, dict(t=None, planes=[], ships=[], status=dict(planes="off", ships="off")))
            self._gz = body[1]
            return self._send(200, body[0], cache="public, max-age=20")
        if path == "/api/v1/counties":
            return self._send(200, COUNTY_SHAPES, cache="public, max-age=86400")
        if path == "/":
            path = "/index.html"
        f = os.path.normpath(os.path.join(WEB, path.lstrip("/")))
        if not f.startswith(WEB) or not os.path.isfile(f):
            return self._send(404, dict(error="not found"))
        ext = os.path.splitext(f)[1].lower()
        body = open(f, "rb").read()
        if ext in (".js", ".json", ".css", ".html", ".svg") and "gzip" in (self.headers.get("Accept-Encoding") or ""):
            body = gzip_cached(f, body)
            self._gz = True
        self._send(200, body, STATIC_TYPES.get(ext, "application/octet-stream"),
                   cache="no-cache" if ext == ".html" else "public, max-age=3600")

    def do_POST(self):
        path = self.path.split("?")[0]
        if path == "/api/v1/ideas/chat" and int(self.headers.get("Content-Length") or 0) > 100_000:
            return self._send(413, dict(error="too long"))
        try:
            d = self._body()
        except Exception as e:
            return self._send(400, dict(error=str(e)[:200]))
        if path == "/api/v1/ideas/chat":               # the idea desk: no worker key, its own limits (ideas.py)
            body, code = IDEAS.chat(d, self.headers.get("CF-Connecting-IP") or self._ip())
            return self._send(code, body)
        with LOCK:
            c = db()
            try:
                if path == "/api/v1/workers":
                    if INVITE and not secrets.compare_digest(str(d.get("invite", "")).strip(), INVITE):
                        return self._send(403, dict(error="Sim Horde is invite-only right now: ask the team for an invite code"))
                    ip = self._ip()
                    c.execute("DELETE FROM signups WHERE t<?", (time.time() - 3600,))
                    cap = 60 if ip in ("127.0.0.1", "::1") else 5     # behind a tunnel that hides addresses, cap the total instead
                    if c.execute("SELECT COUNT(*) FROM signups WHERE ip=?", (ip,)).fetchone()[0] >= cap:
                        return self._send(429, dict(error="too many new workers from this address; try again in an hour"))
                    name = "".join(ch for ch in str(d.get("name", ""))[:32] if ch.isalnum() or ch in " -_.").strip() or "volunteer"
                    key = secrets.token_urlsafe(24)
                    c.execute("INSERT INTO workers(name, key_hash, gpu, vram_gb, created, last_seen, status) VALUES(?,?,?,?,?,?,?)",
                              (name, key_hash(key), str(d.get("gpu", ""))[:60], float(d.get("vram_gb") or 0), time.time(), time.time(), "ready"))
                    c.execute("INSERT INTO signups VALUES(?,?)", (ip, time.time()))
                    return self._send(200, dict(key=key, name=name))
                w = worker_for(c, d.get("key"))
                if w is None:
                    return self._send(401, dict(error="unknown worker key - run the worker's setup again"))
                if w["flagged"]:
                    return self._send(403, dict(error="this worker is paused: its results didn't match other volunteers' runs"))
                if path == "/api/v1/me":
                    return self._send(200, dict(name=w["name"], **SC.balance(c, SC.wallet_of(w))))
                if path == "/api/v1/link/new":
                    return self._send(200, SC.new_link(c, SC.wallet_of(w), secrets))
                if path == "/api/v1/link/use":
                    body, code = SC.use_link(c, w, d.get("code", ""))
                    return self._send(code, dict(body, **SC.balance(c, SC.wallet_of(worker_for(c, d.get("key"))))) if code == 200 else body)
                if path == "/api/v1/scenarios/new":
                    if not WORLD:
                        return self._send(503, dict(error="the world isn't running right now"))
                    with WORLD.lock:
                        body, code = SC.submit(c, w, d.get("spec"), WORLD.w["nations"], WORLD.theta, WORLD.pressure, random.randrange(1, 2**31))
                    return self._send(code, body)
                if path == "/api/v1/scenarios/status":
                    try:
                        body, code = SC.status(c, w, int(d.get("id")))
                    except (TypeError, ValueError):
                        body, code = dict(error="bad id"), 400
                    return self._send(code, body)
                if path == "/api/v1/scenarios/mine":
                    return self._send(200, dict(scenarios=SC.mine(c, w), **SC.balance(c, SC.wallet_of(w))))
                c.execute("UPDATE workers SET last_seen=?, status=?, gpu=COALESCE(NULLIF(?, ''), gpu), vram_gb=COALESCE(?, vram_gb) WHERE id=?",
                          (time.time(), str(d.get("status", "ready"))[:20], str(d.get("gpu", ""))[:60],
                           float(d["vram_gb"]) if d.get("vram_gb") else None, w["id"]))
                browser = d.get("client") == "browser"
                want = BROWSER_SHA if browser else KERNEL_SHA
                if want and d.get("kernel") != want:
                    return self._send(426, dict(error="this worker is out of date: reload the Sim Horde page" if browser
                                                else "this worker is out of date: download the latest one from the Sim Horde page"))
                if browser and path in ("/api/v1/data",) or browser and path.startswith("/api/v1/jobs/") and path != "/api/v1/jobs/pop":
                    return self._send(404, dict(error="browsers only run pieces of the shared world"))
                if path == "/api/v1/data":
                    body = DATA_PACK
                    self.send_response(200)
                    self.send_header("Content-Type", "application/gzip")
                    self.send_header("Content-Length", str(len(body)))
                    self.end_headers()
                    self.wfile.write(body)
                    return
                if path == "/api/v1/heartbeat":
                    return self._send(200, dict(ok=True))
                if path == "/api/v1/jobs/pop":
                    cap = None
                    try:
                        cap = int(d["cap"]) if d.get("cap") else None    # the most people this device wants in one piece
                    except (TypeError, ValueError):
                        pass
                    j = None
                    if not browser and d.get("scenarios") and cap is None and (not WORLD or WORLD.low_done()):
                        j = SC.pop(c, w)                                  # someone's scenario, paid for with kudos
                    if j is None:
                        j = WORLD.job_for(w["id"], cap) if WORLD else None  # the shared world comes first
                    if j is None and not browser:                       # California tuning needs the full engine
                        j = pop_job(c, w)
                    return self._send(200, dict(job=j))
                if path == "/api/v1/world/result":
                    if not WORLD:
                        return self._send(404, dict(error="no world running"))
                    body, code = WORLD.submit(w["id"], str(d.get("job", "")), d.get("out"))
                    if code == 200:
                        kd = SC.kudos_for(WORLD.job_agents(str(d.get("job", ""))), world_engine.EPOCH_DAYS)
                        c.execute("UPDATE workers SET jobs_done=jobs_done+1, kudos=kudos+?, secs_total=secs_total+? WHERE id=?",
                                  (kd, float(d.get("secs") or 0), w["id"]))
                        body["kudos"] = kd
                        for wid, dt in (body.pop("trust", None) or {}).items():   # spot-checks: agree +1, disagree -2
                            c.execute("UPDATE workers SET trust=trust+?, flagged=CASE WHEN trust+?<=-4 THEN 1 ELSE flagged END WHERE id=?",
                                      (dt, dt, wid))
                    return self._send(code, body)
                if path in ("/api/v1/scenarios/progress", "/api/v1/scenarios/result") and not browser:
                    try:
                        sid = int(str(d.get("id", "")).lstrip("s"))
                    except ValueError:
                        return self._send(400, dict(error="bad id"))
                    if path.endswith("progress"):
                        body, code = SC.progress(c, w, sid, d.get("month") or 0)
                    else:
                        body, code = SC.finish(c, w, sid, d.get("out"))
                    return self._send(code, body)
                if path.startswith("/api/v1/jobs/") and path.endswith("/result"):
                    try:
                        jid = int(path.split("/")[4])
                    except ValueError:
                        return self._send(400, dict(error="bad job id"))
                    body, code = submit(c, w, jid, d.get("out"), float(d.get("secs") or 0))
                    return self._send(code, body)
                return self._send(404, dict(error="not found"))
            finally:
                c.close()


COUNTY_SHAPES = {}
def load_shapes():
    """California's 58 counties, lightly simplified, for the website's live map."""
    global COUNTY_SHAPES
    m = json.load(open(os.path.join(ENGINE, "sim_data", "ca_map.json")))["counties"]
    out = []
    for c in m:
        rings = []
        for r in c["r"]:
            step = max(1, len(r) // 120)
            rings.append([[round(x, 3), round(y, 3)] for x, y in r[::step]])
        out.append(dict(name=c["n"], rings=rings, pop=COUNTIES.get(c["n"], [0, 0])[1]))
    COUNTY_SHAPES = dict(counties=out)


def build_pack():
    global DATA_PACK, KERNEL_SHA, BROWSER_SHA
    import gzip
    files = {}
    for f in PACK_FILES:
        p = os.path.join(ENGINE, "sim_data", f)
        if os.path.exists(p):
            files["sim_data/" + f] = open(p, encoding="utf8").read()
    DATA_PACK = gzip.compress(json.dumps(files).encode(), 6)
    ks = [os.path.join(HERE, "public", f) for f in ("sim_kernel.py", "world_kernel.py")]
    if all(os.path.exists(k) for k in ks):
        h = hashlib.sha256()
        for k in ks:
            h.update(open(k, "rb").read())
        KERNEL_SHA = h.hexdigest()
    bk = os.path.join(HERE, "web", "worker", "kernel.js")
    if os.path.exists(bk):
        BROWSER_SHA = hashlib.sha256(open(bk, "rb").read()).hexdigest()
    return len(files)


WORLD = None


def main():
    global T, TMETA, WORLD, INVITE
    ap = argparse.ArgumentParser()
    ap.add_argument("--port", type=int, default=7700)
    ap.add_argument("--host", default="127.0.0.1", help="127.0.0.1 = only through the tunnel (safer)")
    ap.add_argument("--invite", default=os.environ.get("SIM_HORDE_INVITE", ""), help="require this code to join")
    ap.add_argument("--no-world", action="store_true", help="only hand out California calibration jobs")
    ap.add_argument("--month-secs", type=int, default=120, help="the world's pace: seconds per simulated month (120 = a year every 24 minutes)")
    ap.add_argument("--world-agents", type=int, default=1_200_000, help="simulated people in a new world (all shards together)")
    ap.add_argument("--agents", type=int, default=CAMPAIGN["agents"], help="simulated people per job")
    a = ap.parse_args()
    CAMPAIGN["agents"] = a.agents
    INVITE = a.invite.strip()
    init_db()
    T, TMETA = CAL.targets(NAMES)
    load_shapes()
    if a.no_world:
        print("Shared world: off (--no-world)")
    elif os.path.exists(os.path.join(ENGINE, "sim_data", "world", "nations.json")):
        WORLD = world_engine.World(ENGINE, target_agents=a.world_agents, month_secs=a.month_secs)
        print(f"Shared world: {WORLD.date()}, {len(WORLD.w['nations'])} nations in {len(WORLD.w['shards'])} shards")
    else:
        print("Shared world: no data yet. Run  python world/world_data.py  once, then restart.")
    nf = build_pack()
    print(f"Data pack: {nf} files, {len(DATA_PACK) / 1e6:.1f} MB. Kernel: {KERNEL_SHA[:12] or 'not built (run build_kernel.py)'}")
    if INVITE:
        print("Joining needs the invite code.")
    print(f"Sim Horde coordinator: http://127.0.0.1:{a.port}  (campaign: {CAMPAIGN['name']}, targets: {', '.join(T)})")
    ThreadingHTTPServer((a.host, a.port), H).serve_forever()


if __name__ == "__main__":
    main()
