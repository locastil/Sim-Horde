"""
Personal scenarios run by the horde, paid for with kudos.
=========================================================
Volunteers earn kudos for every accepted piece of work (people simulated x days / 10 million). On the
scenario page they can spend them to have a volunteer's graphics card run their what-if world at a level of
detail no single phone or browser could: Medium (1 million simulated people), High (2 million) or Ultra
(4 million). Running a scenario at Low detail on your own device is always free.

Kudos belong to a device's secret key; a link code joins devices into one pool. No accounts, no email,
no internet addresses. The events and their effects are fixed here on the server: a scenario request is only
a list of event names, countries, strengths and months, never code or raw numbers.
"""
import json
import math
import time

# what each kind of event does to people's days (same numbers as the scenario page's own runs)
EFFECTS = {
    "war":       dict(p=dict(stress=0.35, irr=0.8, leave=2.0, kind=0.25), nb=dict(stress=0.04)),
    "unrest":    dict(p=dict(stress=0.05, irr=0.6, kind=0.05)),
    "crackdown": dict(p=dict(stress=0.1, irr=0.3)),
    "coup":      dict(p=dict(stress=0.12, leave=0.5)),
    "sanctions": dict(p=dict(stress=0.05, leave=0.3), f=dict(unemp=0.1)),
    "tradewar":  dict(p=dict(stress=0.03), f=dict(unemp=0.05)),
    "prices":    dict(p=dict(stress=0.08)),
    "recession": dict(p=dict(stress=0.05), f=dict(unemp=0.35, pov=0.1)),
    "pandemic":  dict(p=dict(stress=0.05, leave=-0.3), f=dict(dens=-0.4, unemp=0.15)),
    "disaster":  dict(p=dict(stress=0.18, leave=0.6), f=dict(pov=0.15)),
    "robots":    dict(p=dict(stress=0.3, irr=0.5, leave=0.9, kind=0.15), nb=dict(stress=0.03)),
    "cash":      dict(p=dict(stress=-0.04), f=dict(pov=-0.3)),
    "jobs":      dict(f=dict(unemp=-0.35)),
    "peace":     dict(calm=True, p=dict(stress=-0.03)),
    "connect":   dict(p=dict(kind=-0.1), f=dict(net=0.3)),
}
STRENGTH = dict(mild=0.5, serious=1.0, severe=1.7)
LEVELS = dict(Medium=1_000_000, High=2_000_000, Ultra=4_000_000)   # simulated people
YEARS = (1, 2, 3, 5)
PRICE_PER = 1e8            # kudos = people x days / 100 million: a tenth of what the same work earns
ASSIGN_SECS = 30 * 60      # a run not back in 30 minutes goes to someone else
MAX_TRIES = 3

SCHEMA = """
CREATE TABLE IF NOT EXISTS wallets(id INTEGER PRIMARY KEY, spent REAL DEFAULT 0);
CREATE TABLE IF NOT EXISTS links(code TEXT PRIMARY KEY, wallet INTEGER, expires REAL);
CREATE TABLE IF NOT EXISTS scenarios(id INTEGER PRIMARY KEY, wallet INTEGER, spec TEXT, payload TEXT, status TEXT,
    cost REAL, created REAL, assigned_to INTEGER, assigned_at REAL, progress INTEGER DEFAULT 0, result TEXT,
    error TEXT, tries INTEGER DEFAULT 0, done_at REAL);
CREATE INDEX IF NOT EXISTS scenarios_status ON scenarios(status);
"""


def init(c):
    c.executescript(SCHEMA)
    try:
        c.execute("ALTER TABLE workers ADD COLUMN wallet INTEGER")
    except Exception:
        pass                                    # already there


# ------------------------------------------------------------------ kudos
def kudos_for(people, days):
    return round(people * days / 1e7, 3)


def wallet_of(w):
    return w["wallet"] if "wallet" in w.keys() and w["wallet"] else w["id"]


def balance(c, wallet):
    earned = c.execute("SELECT COALESCE(SUM(kudos), 0) FROM workers WHERE COALESCE(wallet, id)=? AND flagged=0", (wallet,)).fetchone()[0]
    r = c.execute("SELECT spent FROM wallets WHERE id=?", (wallet,)).fetchone()
    spent = r[0] if r else 0.0
    devices = c.execute("SELECT COUNT(*) FROM workers WHERE COALESCE(wallet, id)=?", (wallet,)).fetchone()[0]
    return dict(kudos=round(earned - spent, 2), earned=round(earned, 2), spent=round(spent, 2), devices=devices)


def spend(c, wallet, amount):
    c.execute("INSERT OR IGNORE INTO wallets(id, spent) VALUES(?, 0)", (wallet,))
    c.execute("UPDATE wallets SET spent=spent+? WHERE id=?", (amount, wallet))


LINK_ALPHABET = "23456789ABCDEFGHJKMNPQRSTUVWXYZ"   # no 0/O, 1/I/L


def new_link(c, wallet, secrets):
    c.execute("DELETE FROM links WHERE expires<?", (time.time(),))
    code = "-".join("".join(secrets.choice(LINK_ALPHABET) for _ in range(4)) for _ in range(2))
    c.execute("INSERT OR REPLACE INTO links VALUES(?,?,?)", (code, wallet, time.time() + 24 * 3600))
    return dict(code=code, hours=24)


def use_link(c, w, code):
    code = "".join(ch for ch in str(code).upper() if ch.isalnum())
    code = code[:4] + "-" + code[4:8]
    r = c.execute("SELECT wallet FROM links WHERE code=? AND expires>?", (code, time.time())).fetchone()
    if r is None:
        return dict(error="that code isn't valid (codes last 24 hours)"), 404
    target = r[0]
    if target == wallet_of(w):
        return dict(ok=True, already=True), 200
    # this device, and any devices already pooled with it, join the code's pool
    c.execute("UPDATE workers SET wallet=? WHERE COALESCE(wallet, id)=?", (target, wallet_of(w)))
    mine = c.execute("SELECT spent FROM wallets WHERE id=?", (wallet_of(w),)).fetchone()
    if mine and mine[0]:
        spend(c, target, mine[0]); c.execute("UPDATE wallets SET spent=0 WHERE id=?", (wallet_of(w),))
    return dict(ok=True), 200


# ------------------------------------------------------------------ scenario requests
def parse_spec(spec, nations):
    """Check a request from the page: only known events, countries, strengths and months."""
    if not isinstance(spec, dict):
        return None, "bad request"
    level, years = spec.get("level"), spec.get("years")
    if level not in LEVELS or years not in YEARS:
        return None, "pick a level (Medium, High or Ultra) and 1, 2, 3 or 5 years"
    evs = spec.get("events")
    if not isinstance(evs, list) or len(evs) > 12:
        return None, "up to 12 events"
    codes = {n["code"] for n in nations.values()}
    out = []
    for e in evs:
        if not isinstance(e, dict) or e.get("type") not in EFFECTS or e.get("strength") not in STRENGTH:
            return None, "unknown event"
        where = e.get("where")
        if not isinstance(where, list) or not where or len(where) > 260 or any(c not in codes for c in where):
            return None, "unknown country in an event"
        start, months = e.get("start"), e.get("months")
        if not isinstance(start, int) or not 1 <= start <= 12 or not isinstance(months, int) or not 1 <= months <= 60:
            return None, "bad timing"
        out.append(dict(type=e["type"], where=sorted(set(where)), strength=e["strength"], start=start, months=months))
    return dict(level=level, years=years, events=out), None


def cost_of(spec):
    return round(LEVELS[spec["level"]] * (spec["years"] * 12 + 2) * 30 / PRICE_PER, 1)


def build_payload(spec, nations, theta, pressure_of, seed):
    """Everything the volunteer's device needs, as plain numbers: the same starting world the shared one
    runs on (real statistics, today's wars and protests), split into this many simulated people."""
    live = [n for n in nations.values() if n.get("last")]
    tot = sum(n["pop"] for n in live)
    people = LEVELS[spec["level"]]
    rows = []
    for n in sorted(live, key=lambda n: n["code"]):
        rows.append(dict(code=n["code"], agents=int(max(60, min(500_000, round(n["pop"] / tot * people)))),
                         feat={k: round(float(v), 4) for k, v in n["feat"].items()}, base=pressure_of(n),
                         b=[b for b in n.get("borders", []) if b in nations]))
    evs = [dict(e, strength=STRENGTH[e["strength"]]) for e in spec["events"]]
    return dict(nations=rows, theta=theta, months=spec["years"] * 12, warm=2, days=30, seed=seed, events=evs,
                effects={k: EFFECTS[k] for k in {e["type"] for e in evs}})


def submit(c, w, spec_in, nations, theta, pressure_of, seed):
    spec, err = parse_spec(spec_in, nations)
    if err:
        return dict(error=err), 400
    wallet = wallet_of(w)
    cost = cost_of(spec)
    bal = balance(c, wallet)
    if bal["kudos"] < cost:
        return dict(error=f"this run costs {cost:g} kudos and you have {bal['kudos']:g}", cost=cost, kudos=bal["kudos"]), 402
    if c.execute("SELECT COUNT(*) FROM scenarios WHERE wallet=? AND status IN ('queued','running')", (wallet,)).fetchone()[0] >= 2:
        return dict(error="you already have two scenarios waiting or running; let one finish first"), 429
    payload = build_payload(spec, nations, theta, pressure_of, seed)
    spend(c, wallet, cost)
    cur = c.execute("INSERT INTO scenarios(wallet, spec, payload, status, cost, created) VALUES(?,?,?,?,?,?)",
                    (wallet, json.dumps(spec), json.dumps(payload, separators=(",", ":")), "queued", cost, time.time()))
    ahead = c.execute("SELECT COUNT(*) FROM scenarios WHERE status IN ('queued','running') AND id<?", (cur.lastrowid,)).fetchone()[0]
    return dict(ok=True, id=cur.lastrowid, cost=cost, ahead=ahead, kudos=round(bal["kudos"] - cost, 2)), 200


def status(c, w, sid):
    r = c.execute("SELECT * FROM scenarios WHERE id=?", (sid,)).fetchone()
    if r is None or r["wallet"] != wallet_of(w):
        return dict(error="no such scenario"), 404
    out = dict(id=r["id"], status=r["status"], progress=r["progress"], months=json.loads(r["spec"])["years"] * 12,
               spec=json.loads(r["spec"]), cost=r["cost"], error=r["error"])
    if r["status"] == "queued":
        out["ahead"] = c.execute("SELECT COUNT(*) FROM scenarios WHERE status IN ('queued','running') AND id<?", (r["id"],)).fetchone()[0]
    if r["status"] == "done":
        out["result"] = json.loads(r["result"])
    return out, 200


def mine(c, w):
    rows = c.execute("SELECT id, spec, status, progress, cost, created FROM scenarios WHERE wallet=? ORDER BY id DESC LIMIT 10",
                     (wallet_of(w),)).fetchall()
    return [dict(id=r["id"], spec=json.loads(r["spec"]), status=r["status"], progress=r["progress"], cost=r["cost"],
                 created=r["created"]) for r in rows]


# ------------------------------------------------------------------ handing runs to volunteers' graphics cards
def requeue_stale(c):
    now = time.time()
    for r in c.execute("SELECT id, tries, wallet, cost FROM scenarios WHERE status='running' AND assigned_at<?", (now - ASSIGN_SECS,)).fetchall():
        if r["tries"] >= MAX_TRIES:
            c.execute("UPDATE scenarios SET status='failed', error='no volunteer could finish it; your kudos are back' WHERE id=?", (r["id"],))
            spend(c, r["wallet"], -r["cost"])
        else:
            c.execute("UPDATE scenarios SET status='queued', assigned_to=NULL WHERE id=?", (r["id"],))


def pop(c, w):
    requeue_stale(c)
    r = c.execute("SELECT id, payload FROM scenarios WHERE status='queued' ORDER BY id LIMIT 1").fetchone()
    if r is None:
        return None
    c.execute("UPDATE scenarios SET status='running', assigned_to=?, assigned_at=?, tries=tries+1, progress=0 WHERE id=?",
              (w["id"], time.time(), r["id"]))
    return dict(id=f"s{r['id']}", kind="scenario", payload=json.loads(r["payload"]))


def progress(c, w, sid, month):
    c.execute("UPDATE scenarios SET progress=?, assigned_at=? WHERE id=? AND assigned_to=? AND status='running'",
              (int(month), time.time(), sid, w["id"]))
    return dict(ok=True), 200


def finish(c, w, sid, out):
    r = c.execute("SELECT * FROM scenarios WHERE id=?", (sid,)).fetchone()
    if r is None or r["status"] != "running" or r["assigned_to"] != w["id"]:
        return dict(error="that scenario isn't assigned to you"), 409
    p = json.loads(r["payload"])
    codes = {n["code"] for n in p["nations"]}
    try:                                             # only numbers for known countries, one set per month
        months = out["months"]
        assert isinstance(months, list) and len(months) == p["months"] + 1
        for m in months:
            assert set(m) == codes
            for v in m.values():
                assert len(v) == 2 and all(isinstance(x, (int, float)) and math.isfinite(x) for x in v)
                assert 0 <= v[0] <= 10 and 0 <= v[1] <= 10000
    except Exception:
        c.execute("UPDATE scenarios SET status='queued', assigned_to=NULL WHERE id=?", (sid,))
        return dict(error="result rejected: it doesn't look like a scenario run"), 400
    c.execute("UPDATE scenarios SET status='done', result=?, done_at=?, progress=? WHERE id=?",
              (json.dumps(dict(months=months), separators=(",", ":")), time.time(), p["months"], sid))
    people = sum(n["agents"] for n in p["nations"])
    kd = kudos_for(people, (p["months"] + p["warm"]) * p["days"])
    c.execute("UPDATE workers SET jobs_done=jobs_done+1, kudos=kudos+? WHERE id=?", (kd, w["id"]))   # running someone's scenario earns too
    return dict(ok=True, kudos=kd), 200
