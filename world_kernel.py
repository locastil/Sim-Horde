"""
Sim Horde world kernel: one shard of the shared world (a handful of nations) for a stretch of days.

Everything it needs arrives with the job as plain numbers: each nation's statistics, the behavior weights,
this month's political pressure on each nation, a random seed, and the shard's saved state (an .npz file
with arrays only; loaded with allow_pickle=False, so it can't carry code). It returns per-nation results
and the new state. Nothing is read from or written to disk.

The model is the same idea as the California simulation, made generic: people meet each other every day,
and whether a meeting goes well depends on temperament, stress, irritation and how hard life is where they
live (income, jobs, inequality, crowding). Rudeness spreads irritation; kindness and connection soak it up.
"""
import base64
import io
import math

import numpy as np
import torch

# behavior weights: name -> (low, high). The California calibration supplies the shared ones.
WORLD_RANGES = dict(base=(-3.6, -1.6), w_trait=(0.3, 1.6), w_stress=(0.2, 2.2), w_irr=(0.1, 2.6), hit=(0.1, 0.9),
                    social=(0.0, 0.06), w_pov=(0.0, 2.5), w_dens=(-1.0, 1.5), w_unemp=(0.0, 2.0), w_ineq=(-1.0, 2.0),
                    w_young=(-1.0, 1.5), w_net=(-1.0, 1.5))
WORLD_DEFAULT = dict(base=-2.6, w_trait=0.9, w_stress=1.0, w_irr=1.2, hit=0.45, social=0.02, w_pov=0.8, w_dens=0.3,
                     w_unemp=0.6, w_ineq=0.5, w_young=0.2, w_net=0.1)
FEATURES = ("pov", "dens", "unemp", "ineq", "young", "net")     # each nation's conditions, scaled to about -1..1
PRESSURE = ("stress", "irr", "leave", "kind")                  # political pressure on a nation this month
STATE_KEYS = ("trait", "stress", "irr", "conn")
MAX_AGENTS = 4_000_000


def features(n):
    """A nation's statistics -> the model's conditions (published so anyone can check them)."""
    gdp = max(500.0, float(n["gdp"]))
    return dict(pov=max(-1.0, min(1.0, (math.log(20000.0) - math.log(gdp)) / 2.0)),
                dens=max(-1.0, min(1.0, (float(n["urban"]) - 55.0) / 35.0)),
                unemp=max(-1.0, min(1.5, (float(n["unemp"]) - 6.0) / 8.0)),
                ineq=max(-1.0, min(1.5, (float(n["gini"]) - 36.0) / 12.0)),
                young=max(-1.0, min(1.0, (float(n["young"]) - 64.0) / 8.0)),
                net=max(-1.0, min(1.0, (float(n["net"]) - 60.0) / 35.0)))


def pack_state(st):
    buf = io.BytesIO()
    np.savez_compressed(buf, **{k: v.detach().to("cpu", torch.float16).numpy() for k, v in st.items()})
    return base64.b64encode(buf.getvalue()).decode()


def unpack_state(b64, dev):
    with np.load(io.BytesIO(base64.b64decode(b64)), allow_pickle=False) as z:
        if set(z.files) != set(STATE_KEYS):
            raise ValueError("unexpected state arrays")
        return {k: torch.from_numpy(z[k].astype(np.float32)).to(dev) for k in STATE_KEYS}


def run_shard(job, dev):
    """job: nations [{code, agents, feat{...}, pressure{...}}], theta, days, seed, state (b64 or None)."""
    nations = job["nations"]
    th = dict(WORLD_DEFAULT, **job["theta"])
    g = torch.Generator(device=dev)
    g.manual_seed(int(job["seed"]))
    sizes = [int(n["agents"]) for n in nations]
    N, K = sum(sizes), len(nations)
    nat = torch.repeat_interleave(torch.arange(K, device=dev), torch.tensor(sizes, device=dev))
    start = torch.tensor([0] + list(np.cumsum(sizes)[:-1]), device=dev)
    size = torch.tensor(sizes, device=dev, dtype=torch.float32)
    F = {k: torch.tensor([n["feat"][k] for n in nations], device=dev) for k in FEATURES}
    P = {k: torch.tensor([float(n["pressure"].get(k, 0.0)) for n in nations], device=dev) for k in PRESSURE}

    if job.get("state"):
        st = unpack_state(job["state"], dev)
        if st["trait"].numel() != N:
            raise ValueError("state doesn't match the shard")
    else:
        st = dict(trait=torch.randn(N, generator=g, device=dev), stress=0.4 + 0.2 * torch.rand(N, generator=g, device=dev),
                  irr=torch.zeros(N, device=dev), conn=0.5 + 0.2 * torch.rand(N, generator=g, device=dev))
    trait, stress, irr, conn = st["trait"], st["stress"], st["irr"], st["conn"]

    # each nation's fixed push toward rudeness, and its stress level absent anything happening
    cond = (th["w_pov"] * F["pov"] + th["w_dens"] * F["dens"] + th["w_unemp"] * F["unemp"] + th["w_ineq"] * F["ineq"]
            + th["w_young"] * F["young"] + th["w_net"] * F["net"] + P["kind"])
    stress_home = (0.45 + 0.18 * F["pov"] + 0.12 * F["unemp"] + 0.08 * F["ineq"] + P["stress"]).clamp(0.05, 2.5)
    meet = 2.0 + 3.0 * (F["dens"] + 1.0) / 2.0                       # meetings per person per day
    kind_n = torch.zeros(K, device=dev); rude_n = torch.zeros(K, device=dev)
    leave_n = torch.zeros(K, device=dev)
    days = int(job["days"])
    for _ in range(days):
        m = torch.poisson(meet[nat], generator=g).clamp(max=12)
        # a partner from the same nation for each person's meetings (weighted by how many they have)
        partner = start[nat] + (torch.rand(N, generator=g, device=dev) * size[nat]).long().clamp(max=size[nat].long() - 1)
        z = (th["base"] + th["w_trait"] * trait * 0.5 + th["w_stress"] * (stress - 0.5) + th["w_irr"] * irr + cond[nat])
        p_rude = torch.sigmoid(z)
        rude = torch.binomial(m, p_rude, generator=g)
        kind = m - rude
        rude_n.index_add_(0, nat, rude); kind_n.index_add_(0, nat, kind)
        # the people on the other end feel it
        got_rude = torch.zeros(N, device=dev).index_add_(0, partner, rude)
        got_kind = torch.zeros(N, device=dev).index_add_(0, partner, kind)
        irr = (irr * 0.8 + 0.15 * th["hit"] * got_rude * (1.2 - conn) - th["social"] * got_kind + 0.05 * P["irr"][nat]).clamp(0, 3)
        conn = (conn + 0.02 * (0.45 + 0.06 * got_kind - 0.25 * got_rude - conn)).clamp(0.02, 1.0)
        stress = (stress + 0.03 * (stress_home[nat] + 0.25 * irr - 0.3 * (conn - 0.5) - stress)
                  + 0.03 * torch.randn(N, generator=g, device=dev)).clamp(0.0, 3.0)
        # wanting to leave: rises steeply with stress, conflict and hardship (people per day)
        leave_n += torch.zeros(K, device=dev).index_add_(0, nat, torch.sigmoid(-11.2 + 2.0 * stress + 1.0 * F["pov"][nat] + P["leave"][nat]))
    st = dict(trait=trait, stress=stress, irr=irr, conn=conn)
    mean = lambda x: (torch.zeros(K, device=dev).index_add_(0, nat, x) / size)
    s_mean, i_mean, c_mean = mean(stress), mean(irr), mean(conn)
    out = {}
    for i, n in enumerate(nations):
        tot = float(kind_n[i] + rude_n[i])
        out[n["code"]] = dict(civ=round(float(kind_n[i]) / max(1.0, tot), 5), stress=round(float(s_mean[i]), 4),
                              irr=round(float(i_mean[i]), 4), conn=round(float(c_mean[i]), 4),
                              leave=round(float(leave_n[i]) / float(size[i]) / days * 365 * 1000, 3))   # per 1,000 a year
    return dict(nations=out, state=pack_state(st))


def check_world_job(p):
    """The worker's guard: only numbers, only known names, only sane sizes."""
    if not isinstance(p, dict) or not isinstance(p.get("nations"), list) or not 1 <= len(p["nations"]) <= 400:
        return "bad nation list"
    tot = 0
    for n in p["nations"]:
        if not isinstance(n.get("code"), str) or len(n["code"]) > 8 or not isinstance(n.get("agents"), int) or not 50 <= n["agents"] <= 500_000:
            return "bad nation entry"
        tot += n["agents"]
        for d, keys in ((n.get("feat"), FEATURES), (n.get("pressure"), PRESSURE)):
            if not isinstance(d, dict) or set(d) - set(keys):
                return "bad conditions"
            if any(not isinstance(v, (int, float)) or not math.isfinite(v) or abs(v) > 10 for v in d.values()):
                return "condition out of range"
    if tot > MAX_AGENTS:
        return "too many people for one job"
    th = p.get("theta")
    if not isinstance(th, dict) or set(th) - set(WORLD_RANGES):
        return "unknown weights"
    for k, v in th.items():
        lo, hi = WORLD_RANGES[k]
        if not isinstance(v, (int, float)) or not (lo - 1e-9 <= v <= hi + 1e-9):
            return f"weight {k} out of range"
    if not isinstance(p.get("days"), int) or not 1 <= p["days"] <= 120 or not isinstance(p.get("seed"), int):
        return "bad days or seed"
    if p.get("state") is not None and (not isinstance(p["state"], str) or len(p["state"]) > 80_000_000):
        return "bad state"
    return None
