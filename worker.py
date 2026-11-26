"""
Sim Horde worker
================
Lends this computer's GPU to the Sim Horde. It joins the coordinator, receives the county data
(kept in memory only), then loops: get a job, run it, send back the county numbers.

A job is only data: a set of behavior weights (each checked against the published ranges), a
random seed and a population size. This program never downloads or runs code it's sent.

    start_sim_horde.bat                 (Windows: double-click)
    python worker.py --name "Your name"
    python worker.py --once          # one job, then stop
"""
import argparse
import gzip
import hashlib
import json
import math
import os
import platform
import shutil
import sys
import tempfile
import time
import urllib.error
import urllib.request

HERE = os.path.dirname(os.path.abspath(__file__))
sys.path.insert(0, HERE)
CONFIG = os.path.join(HERE, "worker_config.json")
STOP = os.path.join(HERE, "worker_stop.flag")
DIRECTORY = "https://raw.githubusercontent.com/locastil/Sim-Horde/main/coordinator.json"
VERSION = "0.2"
_h = hashlib.sha256()
for _f in ("sim_kernel.py", "world_kernel.py"):
    _h.update(open(os.path.join(HERE, _f), "rb").read())
KERNEL_SHA = _h.hexdigest()


def say(msg):
    print(time.strftime("%H:%M:%S"), msg, flush=True)


def call(server, path, body, timeout=60, raw=False):
    body = dict(body, kernel=KERNEL_SHA, version=VERSION)
    req = urllib.request.Request(server.rstrip("/") + path, data=json.dumps(body).encode(),
                                 headers={"Content-Type": "application/json", "User-Agent": f"SimHordeWorker/{VERSION}"})
    try:
        with urllib.request.urlopen(req, timeout=timeout) as r:
            data = r.read()
            return r.status, (data if raw else json.loads(data or b"{}"))
    except urllib.error.HTTPError as e:
        try:
            return e.code, json.loads(e.read() or b"{}")
        except Exception:
            return e.code, {"error": str(e)}
    except (urllib.error.URLError, OSError) as e:
        return 0, {"error": str(getattr(e, "reason", e))}


def find_server():
    """The coordinator's current address is published in this project's repo."""
    try:
        with urllib.request.urlopen(urllib.request.Request(DIRECTORY, headers={"User-Agent": f"SimHordeWorker/{VERSION}"}), timeout=20) as r:
            return json.loads(r.read())["server"]
    except Exception as e:
        sys.exit(f"Couldn't look up the Sim Horde coordinator ({e}). Check your internet connection, or pass --server.")


def pick_device(torch, pref):
    if pref and not pref.startswith(("cuda", "cpu")) and torch.cuda.is_available():
        # a name, e.g. --device 5070: the first GPU whose name contains it
        for i in range(torch.cuda.device_count()):
            if pref.lower() in torch.cuda.get_device_name(i).lower():
                return torch.device(f"cuda:{i}")
        sys.exit(f"No GPU named like '{pref}' found: " + ", ".join(torch.cuda.get_device_name(i) for i in range(torch.cuda.device_count())))
    if pref:
        return torch.device(pref)
    if not torch.cuda.is_available():
        say("No NVIDIA GPU found by PyTorch, so this will run on the CPU (slow).")
        return torch.device("cpu")
    best = max(range(torch.cuda.device_count()), key=lambda i: torch.cuda.get_device_properties(i).total_memory)
    return torch.device(f"cuda:{best}")


def gpu_info(torch, dev):
    if dev.type == "cuda":
        p = torch.cuda.get_device_properties(dev)
        return p.name, round(p.total_memory / 2**30, 1)
    return f"CPU ({platform.processor() or platform.machine()})", 0.0


def check_job(job, RANGES):
    """Refuse anything that isn't exactly the kind of job the published code runs."""
    p = job.get("payload") or {}
    th = p.get("theta")
    if job.get("kind") != "calibrate" or not isinstance(th, dict) or set(th) - set(RANGES):
        return None, "unknown job type or weight names"
    clean = {}
    for k, v in th.items():
        lo, hi = RANGES[k]
        if not isinstance(v, (int, float)) or not math.isfinite(v) or not (lo - 1e-9 <= v <= hi + 1e-9):
            return None, f"weight {k} out of range"
        clean[k] = float(v)
    if p.get("meet", "classic") not in ("classic", "social"):
        return None, "unknown way of meeting"
    agents, seed, mina = p.get("agents"), p.get("seed"), p.get("min_agents", 250)
    if not (isinstance(agents, int) and 10_000 <= agents <= 5_000_000):
        return None, "population size out of range"
    if not (isinstance(seed, int) and 0 < seed < 2**31) or not (isinstance(mina, int) and 50 <= mina <= 5000):
        return None, "bad seed or county minimum"
    return dict(theta=clean, seed=seed, agents=agents, min_agents=mina, meet=p.get("meet", "classic")), None


def load_from_coordinator(server, key):
    """County data comes from the coordinator and lives only in memory: the folder it's unpacked
    into for loading is deleted right after."""
    code, pack = call(server, "/api/v1/data", dict(key=key), timeout=180, raw=True)
    if code != 200:
        sys.exit(f"Couldn't get the county data: {pack.get('error', code) if isinstance(pack, dict) else code}")
    files = json.loads(gzip.decompress(pack))
    tmp = tempfile.mkdtemp(prefix="simhorde_")
    try:
        for rel, text in files.items():
            if ".." in rel or rel.startswith(("/", "\\")):
                continue
            p = os.path.join(tmp, rel)
            os.makedirs(os.path.dirname(p), exist_ok=True)
            open(p, "w", encoding="utf8").write(text)
        os.environ["SIM_HORDE_DATA_ROOT"] = tmp
        import sim_kernel as K
        names = sorted(K.COUNTIES, key=lambda n: -K.COUNTIES[n][1])
        data = K.load_data(names, True)
    finally:
        shutil.rmtree(tmp, ignore_errors=True)
    return K, data


def main():
    ap = argparse.ArgumentParser(description="Lend your GPU to the Sim Horde")
    ap.add_argument("--name", default=None, help="name shown on the leaderboard")
    ap.add_argument("--server", default=None, help="coordinator address (normally found automatically)")
    ap.add_argument("--device", default=None, help="cuda, cuda:1, cpu, or part of a GPU name such as 5070 (default: the GPU with the most memory)")
    ap.add_argument("--invite", default="", help="invite code, if the coordinator asks for one")
    ap.add_argument("--once", action="store_true", help="run a single job, then stop")
    ap.add_argument("--max-agents", type=int, default=0, help="skip jobs bigger than this (for small GPUs)")
    a = ap.parse_args()

    cfg = json.load(open(CONFIG)) if os.path.exists(CONFIG) else {}
    server = a.server or cfg.get("server") or find_server()
    name = a.name or cfg.get("name")
    if not name:
        print("\nWelcome to the Sim Horde. Pick a name for the leaderboard (anything, not your real name if you'd rather not).")
        name = input("Name: ").strip()[:32] or platform.node()[:24]

    import torch
    dev = pick_device(torch, a.device)
    gpu, vram = gpu_info(torch, dev)

    if cfg.get("server") != server or not cfg.get("key"):
        code, r = call(server, "/api/v1/workers", dict(name=name, gpu=gpu, vram_gb=vram, invite=a.invite))
        if code != 200:
            sys.exit(f"Couldn't join the Sim Horde: {r.get('error', code)}")
        cfg = dict(server=server, key=r["key"], name=r["name"])
        json.dump(cfg, open(CONFIG, "w"), indent=1)
        say(f"Joined as '{r['name']}'. Your worker key is saved in worker_config.json (keep it private).")
    key = cfg["key"]
    say("Getting county data from the coordinator...")
    K, data = load_from_coordinator(server, key)
    total = sum(d["pop"] for d in data.values())
    say(f"Working on {gpu}{f' ({vram} GB)' if vram else ''}. Close this window to stop.")

    idle, kudos = 5, 0.0
    if os.path.exists(STOP):
        os.remove(STOP)
    while not os.path.exists(STOP):
        code, r = call(server, "/api/v1/jobs/pop", dict(key=key, gpu=gpu, vram_gb=vram, status="ready"))
        if code in (401, 403, 426):
            sys.exit(f"The coordinator turned this worker away: {r.get('error')}")
        job = r.get("job") if code == 200 else None
        if not job:
            if code != 200:
                say(f"Coordinator unreachable ({r.get('error', code)}); retrying in {idle}s")
            time.sleep(idle)
            idle = min(idle * 2, 120)
            continue
        idle = 5
        if job.get("kind") == "world":
            import world_kernel as WK
            err = WK.check_world_job(job.get("payload"))
            if err:
                say(f"Refused world job {job.get('id')}: {err}")
                time.sleep(10)
                continue
            p = job["payload"]
            people = sum(n["agents"] for n in p["nations"])
            say(f"World job {job['id']}: {len(p['nations'])} nations, {people:,} simulated people, {p['days']} days")
            t0 = time.time()
            call(server, "/api/v1/heartbeat", dict(key=key, status="running"), timeout=10)
            try:
                out = WK.run_shard(p, dev)
            except torch.cuda.OutOfMemoryError:
                torch.cuda.empty_cache()
                say("Ran out of GPU memory on that world job; it will go to another volunteer.")
                time.sleep(60)
                continue
            secs = time.time() - t0
            code, r = call(server, "/api/v1/world/result", dict(key=key, job=job["id"], out=out, secs=secs), timeout=300)
            if code == 200:
                kudos += r.get("kudos", 0)
                adv = f" The world moved on to the next month." if r.get("world_advanced") else ""
                say(f"Done in {secs:.0f}s ({r.get('month')}). +{r.get('kudos', 0)} kudos, {kudos:.1f} this session.{adv}")
            else:
                say(f"World result not accepted: {r.get('error', code)}")
            if a.once:
                break
            continue
        p, err = check_job(job, K.RANGES)
        if err:
            say(f"Refused job {job.get('id')}: {err}")
            continue
        if a.max_agents and p["agents"] > a.max_agents:
            say(f"Job {job['id']} needs {p['agents']:,} people (over --max-agents); leaving it for a bigger GPU")
            time.sleep(30)
            continue
        scale = max(1, math.ceil(total / p["agents"]))
        say(f"Job {job['id']}: {p['agents']:,} simulated people, {K.BURN + K.MEASURE} days")
        t0 = time.time()
        call(server, "/api/v1/heartbeat", dict(key=key, status="running"), timeout=10)
        try:
            K.MEET["mode"] = p["meet"]
            out = K.run_once(p["theta"], p["seed"], data, scale, dev, p["min_agents"])
        except torch.cuda.OutOfMemoryError:
            torch.cuda.empty_cache()
            say("Ran out of GPU memory on that job; restart with --max-agents 200000")
            time.sleep(30)
            continue
        secs = time.time() - t0
        out = {k: out[k] for k in ("log_rude", "stress", "irr", "leave", "civ")}
        code, r = call(server, f"/api/v1/jobs/{job['id']}/result", dict(key=key, out=out, secs=secs), timeout=120)
        if code == 200:
            kudos += r.get("kudos", 0)
            note = f" ({r['note']})" if r.get("note") else ""
            say(f"Done in {secs:.0f}s. +{r['kudos']} kudos, {kudos:.1f} this session{note}")
        else:
            say(f"Result not accepted: {r.get('error', code)}")
        if a.once:
            break
    say("Stopped.")


if __name__ == "__main__":
    try:
        main()
    except KeyboardInterrupt:
        say("Stopped.")
