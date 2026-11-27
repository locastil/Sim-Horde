"""
Sim Horde status: is everything running, and how is the world doing?

    python horde_status.py            a status page at http://<this PC>:7711/?k=<key> (phone on the same Wi-Fi too)
    python horde_status.py --console  the same in this window, refreshed every 5 seconds

Read-only: it looks at the coordinator on this PC, the public website, the logs and the graphics cards, and
changes nothing. The key in the link (status_key.txt) keeps other people on your Wi-Fi from reading it.
"""
import json
import os
import secrets
import socket
import subprocess
import sys
import time
import urllib.request
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer

HERE = os.path.dirname(os.path.abspath(__file__))
LOGS = os.path.join(HERE, "logs")
KEYFILE = os.path.join(HERE, "status_key.txt")
LOCAL = "http://127.0.0.1:7700"
PUBLIC = "https://sim-horde.org"
PORT = 7711


def key():
    if os.path.exists(KEYFILE):
        k = open(KEYFILE).read().strip()
        if k:
            return k
    k = secrets.token_urlsafe(9)
    open(KEYFILE, "w").write(k)
    return k


def get(url, timeout=6):
    try:
        with urllib.request.urlopen(urllib.request.Request(url, headers={"User-Agent": "SimHordeStatus/1"}), timeout=timeout) as r:
            return json.loads(r.read())
    except Exception:
        return None


def tail(name, n):
    p = os.path.join(LOGS, name)
    try:
        with open(p, "rb") as f:
            f.seek(max(0, os.path.getsize(p) - 20000))
            lines = f.read().decode("utf-8", "replace").splitlines()
        return [l for l in lines if l.strip()][-n:], time.time() - os.path.getmtime(p)
    except OSError:
        return [], None


def gpus():
    try:
        out = subprocess.run(["nvidia-smi", "--query-gpu=name,utilization.gpu,temperature.gpu,memory.used,memory.total",
                              "--format=csv,noheader,nounits"], capture_output=True, text=True, timeout=8,
                             creationflags=getattr(subprocess, "CREATE_NO_WINDOW", 0)).stdout
        rows = []
        for line in out.strip().splitlines():
            n, u, t, mu, mt = [x.strip() for x in line.split(",")]
            rows.append(dict(name=n.replace("NVIDIA GeForce ", ""), util=int(u), temp=int(t), mem=round(int(mu) / 1024, 1), mem_total=round(int(mt) / 1024, 1)))
        return rows
    except Exception:
        return []


_cache = {"t": 0, "public": None}


def snapshot():
    stats = get(LOCAL + "/api/v1/stats")
    globe = get(LOCAL + "/api/v1/globe")
    mk = get(LOCAL + "/api/v1/markets")
    if time.time() - _cache["t"] > 30:                       # the public path (website -> Cloudflare -> this PC), every 30 s
        _cache["public"] = get(PUBLIC + "/api/v1/stats?status=1", timeout=10) is not None
        _cache["t"] = time.time()
    wlog, wage = tail("worker.log", 8)
    slog, _ = tail("service.log", 8)
    w = (mk or {}).get("world") or {}
    return dict(
        at=time.strftime("%H:%M:%S"),
        parts=dict(coordinator=stats is not None, website=_cache["public"], worker=wage is not None and wage < 150),
        worker_last=round(wage) if wage is not None else None,
        world=dict(date=(globe or {}).get("date"), progress=(globe or {}).get("month_progress"),
                   levels=(globe or {}).get("levels") or [], happiness=(globe or {}).get("happiness"),
                   conflicts=(globe or {}).get("conflicts"), index=w.get("i"), m1=w.get("m1"), infl=w.get("infl"),
                   growth=w.get("growth"), stag=w.get("stag")),
        volunteers=dict(online=(stats or {}).get("workers_online"), devices=(stats or {}).get("gpus") or []),
        california=dict(done=(stats or {}).get("runs_done"), goal=(stats or {}).get("runs_goal")),
        gpus=gpus(), worker_log=wlog, service_log=slog)


PAGE = r"""<!DOCTYPE html><html lang="en"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1,viewport-fit=cover"><meta name="theme-color" content="#0B1626">
<title>Sim Horde status</title>
<style>
:root{--bg:#0B1626;--card:#12203A;--line:#24365A;--ink:#E9EFF7;--dim:#93A4BD;--up:#3DDC97;--down:#FF6B57;--warn:#FFC46B}
*{box-sizing:border-box}body{margin:0;background:var(--bg);color:var(--ink);font:15px/1.45 system-ui,-apple-system,"Segoe UI",sans-serif;padding:18px 16px 40px}
h1{font-size:1.35rem;margin:0}header{display:flex;justify-content:space-between;align-items:baseline;gap:12px;max-width:980px;margin:0 auto 14px}
.at{color:var(--dim);font-size:.85rem}
main{max-width:980px;margin:0 auto;display:grid;grid-template-columns:repeat(auto-fit,minmax(290px,1fr));gap:12px}
section{background:var(--card);border:1px solid var(--line);border-radius:14px;padding:14px 16px}
h2{font-size:.8rem;font-weight:600;color:var(--dim);margin:0 0 10px;letter-spacing:.01em}
.row{display:flex;justify-content:space-between;gap:10px;padding:6px 0;border-top:1px solid var(--line)}.row:first-of-type{border-top:0}
.ok{color:var(--up)}.bad{color:var(--down)}.warn{color:var(--warn)}
.big{font-size:1.6rem;font-weight:700;font-variant-numeric:tabular-nums}
.num{font-variant-numeric:tabular-nums}
.bar{height:6px;background:#0B1626;border-radius:4px;overflow:hidden;margin-top:6px}.bar i{display:block;height:100%;background:var(--up)}
pre{margin:0;white-space:pre-wrap;font:12px/1.5 ui-monospace,Consolas,monospace;color:#C9D6E6}
.wide{grid-column:1/-1}
.dot{display:inline-block;width:9px;height:9px;border-radius:50%;margin-right:7px;vertical-align:1px}
.dot.ok{background:var(--up)}.dot.bad{background:var(--down)}.dot.warn{background:var(--warn)}
</style></head><body>
<header><h1>Sim Horde status</h1><span class="at" id="at">loading...</span></header>
<main id="m"></main>
<script>
const K = new URLSearchParams(location.search).get("k") || "";
const esc = s => String(s ?? "").replace(/[&<>]/g, c => ({"&":"&amp;","<":"&lt;",">":"&gt;"}[c]));
const pct = x => x == null ? "–" : (x > 0 ? "+" : "") + (x * 100).toFixed(1) + "%";
const dot = (on, mid) => `<span class="dot ${on ? "ok" : mid ? "warn" : "bad"}"></span>`;
async function tick() {
  let d;
  try { d = await (await fetch("data?k=" + encodeURIComponent(K), {cache: "no-store"})).json(); }
  catch (e) { document.getElementById("at").textContent = "can't reach the status service"; return; }
  if (d.error) { document.getElementById("m").innerHTML = `<section class="wide">${esc(d.error)}</section>`; return; }
  const p = d.parts, w = d.world, lv = (w.levels || []).filter(l => l.pieces);
  const allOk = p.coordinator && p.worker && p.website !== false;
  document.getElementById("at").innerHTML = `${allOk ? '<span class="ok">All running</span>' : '<span class="bad">Something needs a look</span>'} · ${esc(d.at)}`;
  const parts = [["Coordinator (the world's server)", p.coordinator, false, p.coordinator ? "running" : "not answering"],
    ["Website reaches this PC", p.website, p.website == null, p.website == null ? "checking..." : p.website ? "yes" : "no: check the tunnel"],
    ["Your worker", p.worker, false, p.worker ? `working (last update ${d.worker_last}s ago)` : d.worker_last == null ? "not started" : `quiet for ${d.worker_last}s`]];
  const g = d.gpus.map(x => `<div class="row"><span>${esc(x.name)}</span><span class="num">${x.util}% busy · ${x.temp}°C · ${x.mem}/${x.mem_total} GB</span></div>`).join("") || '<div class="row"><span class="at">No graphics card info</span></div>';
  document.getElementById("m").innerHTML = `
  <section><h2>Running</h2>${parts.map(([n, on, mid, t]) => `<div class="row"><span>${dot(on, mid)}${n}</span><span class="${on ? "ok" : mid ? "warn" : "bad"}">${esc(t)}</span></div>`).join("")}</section>
  <section><h2>The world</h2><div class="big">${esc(w.date || "–")}</div>
    ${w.progress ? `<div class="row"><span>This month's pieces</span><span class="num">${w.progress[0]} / ${w.progress[1]}</span></div><div class="bar"><i style="width:${Math.round(100 * w.progress[0] / Math.max(1, w.progress[1]))}%"></i></div>` : ""}
    ${lv.slice(1).map(l => `<div class="row"><span>${esc(l.name)} detail</span><span class="num">${l.done} / ${l.pieces} pieces · ${l.nations} countries</span></div>`).join("")}
    <div class="row"><span>Happiness · conflicts</span><span class="num">${w.happiness != null ? w.happiness.toFixed(2) : "–"} · ${w.conflicts ?? "–"}</span></div></section>
  <section><h2>The World Exchange</h2><div class="big num">${w.index != null ? w.index.toLocaleString("en-US", {maximumFractionDigits: 2}) : "–"} <span class="${(w.m1||0) >= 0 ? "ok" : "bad"}" style="font-size:1rem">${pct(w.m1)}</span></div>
    <div class="row"><span>Inflation</span><span class="num">${w.infl != null ? w.infl.toFixed(1) + "%" : "–"}</span></div>
    <div class="row"><span>Growth</span><span class="num ${(w.growth||0) < 0 ? "bad" : ""}">${w.growth != null ? w.growth.toFixed(1) + "%" : "–"}</span></div>
    ${w.stag ? '<div class="row"><span class="bad">Global stagflation</span></div>' : ""}</section>
  <section><h2>Volunteers</h2><div class="big">${d.volunteers.online ?? "–"} <span class="at">devices online</span></div>
    ${(d.volunteers.devices || []).map(([n, c]) => `<div class="row"><span>${esc(n)}</span><span class="num">${c}</span></div>`).join("")}
    ${d.california.done != null ? `<div class="row"><span>California tuning runs</span><span class="num">${d.california.done}${d.california.goal ? " / " + d.california.goal : ""}</span></div>` : ""}
</section>
  <section><h2>Graphics cards</h2>${g}</section>
  <section class="wide"><h2>Your worker, latest</h2><pre>${esc(d.worker_log.join("\n"))}</pre></section>
  <section class="wide"><h2>Background service, latest</h2><pre>${esc(d.service_log.join("\n"))}</pre></section>`;
}
tick(); setInterval(tick, 5000);
</script></body></html>"""


class H(BaseHTTPRequestHandler):
    def log_message(self, *a):
        pass

    def send(self, code, body, ctype):
        b = body.encode() if isinstance(body, str) else body
        self.send_response(code)
        self.send_header("Content-Type", ctype)
        self.send_header("Content-Length", str(len(b)))
        self.send_header("Cache-Control", "no-store")
        self.end_headers()
        self.wfile.write(b)

    def do_GET(self):
        path, _, q = self.path.partition("?")
        k = dict(x.split("=", 1) for x in q.split("&") if "=" in x).get("k", "")
        if not secrets.compare_digest(k, KEY):
            return self.send(403, "Open the status link from status_url.txt (it has the key).", "text/plain")
        if path == "/data":
            return self.send(200, json.dumps(snapshot()), "application/json")
        return self.send(200, PAGE, "text/html; charset=utf-8")


def lan_ip():
    try:
        s = socket.socket(socket.AF_INET, socket.SOCK_DGRAM)
        s.connect(("10.255.255.255", 1))
        ip = s.getsockname()[0]
        s.close()
        return ip
    except OSError:
        return "127.0.0.1"


def console():
    while True:
        d = snapshot()
        p, w = d["parts"], d["world"]
        os.system("cls" if os.name == "nt" else "clear")
        mark = lambda on: "running" if on else ("checking" if on is None else "NOT running")
        print(f"Sim Horde status   {d['at']}   (updates every 5 seconds; close this window to stop)\n")
        print(f"  coordinator   {mark(p['coordinator'])}")
        print(f"  website       {'reaches this PC' if p['website'] else 'checking' if p['website'] is None else 'NOT reaching this PC'}")
        print(f"  worker        {mark(p['worker'])}" + (f"  (last update {d['worker_last']}s ago)" if d['worker_last'] is not None else ""))
        if w["date"]:
            pr = w["progress"] or [0, 0]
            print(f"\n  World: {w['date']}   pieces {pr[0]}/{pr[1]}   devices online: {d['volunteers']['online']}")
            for l in (w["levels"] or [])[1:]:
                print(f"    {l['name']:<7} {l['done']:>4}/{l['pieces']:<4} pieces   {l['nations']} countries")
            if w["index"] is not None:
                print(f"  World index {w['index']:,.2f} ({(w['m1'] or 0) * 100:+.1f}%)   inflation {w['infl'] or 0:.1f}%   growth {w['growth'] or 0:.1f}%"
                      + ("   STAGFLATION" if w["stag"] else ""))
        for g in d["gpus"]:
            print(f"  {g['name']:<28} {g['util']:>3}% busy  {g['temp']}°C  {g['mem']}/{g['mem_total']} GB")
        print("\n  Worker:")
        for l in d["worker_log"][-5:]:
            print("   ", l[:150])
        print("\n  Service:")
        for l in d["service_log"][-4:]:
            print("   ", l[:150])
        print(f"\n  Status page: {open(os.path.join(LOGS, 'status_url.txt')).read().strip() if os.path.exists(os.path.join(LOGS, 'status_url.txt')) else '(starts with the background service)'}")
        time.sleep(5)


KEY = key()
if __name__ == "__main__":
    if "--console" in sys.argv:
        try:
            console()
        except KeyboardInterrupt:
            pass
    else:
        os.makedirs(LOGS, exist_ok=True)
        url = f"http://{lan_ip()}:{PORT}/?k={KEY}"
        open(os.path.join(LOGS, "status_url.txt"), "w").write(url + "\n")
        print("Sim Horde status page:", url, flush=True)
        ThreadingHTTPServer(("0.0.0.0", PORT), H).serve_forever()
