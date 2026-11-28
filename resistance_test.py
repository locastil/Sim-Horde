"""Resistance test: do simulated people who get used to lasting conditions give a more realistic happiness?

Resistance: each country's simulated people carry a slow memory of how stressed they have been (it fades with a
half-life of one to three years). Each month part of that remembered stress is offset, so conditions that have
lasted for years (crime, inequality, a long low-level conflict) weigh less than they did at first, while a sudden
shock lands in full because it isn't in the memory yet. Poverty and unemployment still weigh on people directly.

The world runs on real 2015-2023 conditions, month by month, as it is now and at six resistance settings.
Round 1, unseen countries: the setting is chosen on half the countries (how well each year's simulated happiness
lines up with the real life-satisfaction surveys) and scored on the other half, which it never saw; then the
halves swap. Also checked: whether the simulation still leans against unequal countries.
Round 2, real ups and downs: the settings round 1 chose, unchanged, are checked on something round 1 never looked
at: each country's year-to-year rises and falls in the surveys (Greece's recovery, Venezuela's collapse, Lebanon's
crisis, Ukraine's war, Afghanistan, Sri Lanka...). Resistance passes only if it wins round 1 on both halves and
doesn't make round 2 worse.
Nothing in the live world changes. Results: backtest/resistance_test.*
"""
import json, math, os, random, sys, time
import torch

HERE = os.path.dirname(os.path.abspath(__file__))
sys.path.insert(0, HERE)
import backtest as B                # noqa: E402
import world_kernel as WK           # noqa: E402

YEARS = list(range(2015, 2024))
PEOPLE = int(os.environ.get("RESIST_TEST_PEOPLE", "600000"))
SETTINGS = [(r, h) for h in (12, 36) for r in (0.25, 0.5, 0.75)]   # (how much remembered stress is offset, memory half-life in months)
CASES = {"GRC": "Greece", "VEN": "Venezuela", "LBN": "Lebanon", "UKR": "Ukraine", "AFG": "Afghanistan", "LKA": "Sri Lanka",
         "TUR": "Turkey", "ZWE": "Zimbabwe", "USA": "United States", "COL": "Colombia"}


def main():
    t0 = time.time()
    dev = torch.device("cuda" if torch.cuda.is_available() else "cpu")
    print(f"Resistance test on {torch.cuda.get_device_name(0) if dev.type == 'cuda' else 'the CPU'}")
    wb, happy = B.world_bank(), B.happiness()
    wb.pop("_missing", None)
    th, _ = B.theta()
    fx = dict(B.DEFAULT_FX)
    try:
        fx.update(json.load(open(os.path.join(B.OUT_DIR, "event_effects.json"))).get("effects", {}))
    except (OSError, ValueError):
        pass
    nat = json.load(open(os.path.join(HERE, "engine", "sim_data", "world", "nations.json")))
    nat = nat.get("nations", nat)
    rows = nat if isinstance(nat, list) else list(nat.values())
    key = lambda r: r.get("code") or r.get("iso3")
    codes = [key(r) for r in rows if r.get("pop")]
    latest_row = {key(r): r for r in rows}
    pop15 = {c: B.value(wb.get(c, {}).get("pop"), 2015, latest_row[c]["pop"]) for c in codes}
    tot = sum(pop15.values())
    agents = {c: int(max(60, min(500_000, round(pop15[c] / tot * PEOPLE)))) for c in codes}
    hle = {}
    try:   # the live world's healthy-life-expectancy push, so the test matches what's running
        hle = json.load(open(os.path.join(HERE, "world", "happiness_vars.json"))).get("life_expectancy", {})
    except (OSError, ValueError):
        pass

    feat_cache = {}
    def feats(c, year):
        k = (c, year)
        if k not in feat_cache:
            s, L = wb.get(c, {}), latest_row[c]
            feat_cache[k] = WK.features(dict(gdp=B.value(s.get("gdp"), year, L.get("gdp") or 8000), urban=B.value(s.get("urban"), year, L.get("urban") or 55),
                                             unemp=B.value(s.get("unemp"), year, L.get("unemp") or 6), gini=B.value(s.get("gini"), year, L.get("gini") or 36),
                                             young=B.value(s.get("young"), year, L.get("young") or 64), net=B.value(s.get("net"), year, L.get("net") or 50)))
        return feat_cache[k]

    def simulate(setting):
        """setting: None (as it is) or (strength, half-life in months). Returns yearly simulated happiness per country."""
        mem = {}                                   # remembered stress per country
        R, H = setting or (0.0, 12)
        keep = 0.5 ** (1 / H)
        def job(year, month, state, seed):
            ns = []
            for c in codes:
                f = dict(feats(c, year))
                p, pand = B.pressure(c, year, month, B.value(wb.get(c, {}).get("infl"), year, None), fx)
                p["stress"] += 0.1 * float(hle.get(c, 0.0))
                if c in mem:
                    p["stress"] -= R * (mem[c] - 0.5)      # resistance: part of the lasting stress is offset
                if pand:
                    f = dict(f, dens=max(-1.0, f["dens"] - fx["pandemic_dens"]), unemp=min(1.5, f["unemp"] + 0.15))
                ns.append(dict(code=c, agents=agents[c], feat={k: round(v, 4) for k, v in f.items()},
                               pressure={k: round(max(-9.5, min(9.5, v)), 4) for k, v in p.items()}))
            return dict(nations=ns, theta=th, days=30, seed=seed, state=state)
        state = None
        for w in range(3):                          # warm-up; countries have lived with their conditions for years
            r = WK.run_shard(job(YEARS[0], 1, state, 900 + w), dev); state = r["state"]
        for c, v in r["nations"].items():
            mem[c] = v["stress"]
        out = {}
        for y in YEARS:
            acc = {c: 0.0 for c in codes}
            for m in range(1, 13):
                r = WK.run_shard(job(y, m, state, y * 100 + m), dev); state = r["state"]
                for c, v in r["nations"].items():
                    acc[c] += v["happy"] / 12
                    mem[c] = keep * mem[c] + (1 - keep) * v["stress"]
            out[y] = acc
        print(f"  {'as it is' if not setting else f'resistance {setting[0]}, half-life {setting[1]} months'}: done ({time.time() - t0:.0f}s)", flush=True)
        return out

    runs = {None: simulate(None)}
    for s in SETTINGS:
        runs[s] = simulate(s)

    rnd = random.Random(11)
    sh = sorted(codes); rnd.shuffle(sh)
    halves = [set(sh[0::2]), set(sh[1::2])]

    def level(run, group):
        rs = []
        for y in YEARS:
            pts = [(run[y][c], happy[c][y]) for c in group if y in happy.get(c, {})]
            if len(pts) >= 15:
                rs.append(B.corr([p[0] for p in pts], [p[1] for p in pts]))
        rs = [r for r in rs if r is not None]
        return round(sum(rs) / len(rs), 3) if rs else None

    def lean(run):
        """After matching the spread, does the simulation still under-rate unequal countries? (0 = no lean)"""
        y = 2019
        pts = [(run[y][c], happy[c][y], feats(c, y)["ineq"]) for c in codes if y in happy.get(c, {})]
        m = lambda v: sum(v) / len(v); sd = lambda v: math.sqrt(sum((x - m(v)) ** 2 for x in v) / len(v)) or 1
        xs, ys = [p[0] for p in pts], [p[1] for p in pts]
        res = [m(ys) + sd(ys) * (x - m(xs)) / sd(xs) - yv for x, yv in zip(xs, ys)]
        return round(B.corr(res, [p[2] for p in pts]), 3)

    def changes(run, group=None):
        """Year-to-year rises and falls: each country's years against its own average, real vs simulated."""
        xs, ys = [], []
        for c in (group or codes):
            yrs = [y for y in YEARS if y in happy.get(c, {})]
            if len(yrs) < 4:
                continue
            ms = sum(run[y][c] for y in yrs) / len(yrs); mr = sum(happy[c][y] for y in yrs) / len(yrs)
            for y in yrs:
                xs.append(run[y][c] - ms); ys.append(happy[c][y] - mr)
        return round(B.corr(xs, ys), 3)

    def case(run, c):
        yrs = [y for y in YEARS if y in happy.get(c, {})]
        if len(yrs) < 2:
            return None
        a, b = yrs[0], yrs[-1]
        return dict(years=[a, b], real=round(happy[c][b] - happy[c][a], 2), sim=round(run[b][c] - run[a][c], 2))

    name = lambda s: "as it is" if s is None else f"strength {s[0]}, half-life {s[1]} months"
    res = dict(people=PEOPLE, years=[YEARS[0], YEARS[-1]], now=dict(match=level(runs[None], set(codes)), lean=lean(runs[None]),
               changes=changes(runs[None])), settings={name(s): dict(match=level(runs[s], set(codes)), lean=lean(runs[s]), changes=changes(runs[s]))
                                                       for s in SETTINGS})
    print(f"\nAs it is: match {res['now']['match']}, lean against unequal countries {res['now']['lean']}, ups and downs {res['now']['changes']}")
    for s in SETTINGS:
        v = res["settings"][name(s)]
        print(f"  {name(s):32s} match {v['match']}, lean {v['lean']}, ups and downs {v['changes']}")

    print("\nRound 1, unseen countries:")
    folds = []
    for tune, test in ((halves[0], halves[1]), (halves[1], halves[0])):
        pick = max([None] + SETTINGS, key=lambda s: level(runs[s], tune) or -9)
        f = dict(chosen=name(pick), unseen_now=level(runs[None], test), unseen_with=level(runs[pick], test),
                 changes_now=changes(runs[None]), changes_with=changes(runs[pick]), pick=pick)
        folds.append(f)
        print(f"  chose {f['chosen']}: unseen countries {f['unseen_now']} -> {f['unseen_with']}")
    r1 = all(f["pick"] is not None and f["unseen_with"] > f["unseen_now"] for f in folds)

    print("\nRound 2, real ups and downs (settings frozen from round 1):")
    for f in folds:
        print(f"  {f['chosen']}: ups and downs {f['changes_now']} -> {f['changes_with']}")
    r2 = all(f["pick"] is not None and f["changes_with"] >= f["changes_now"] - 0.02 for f in folds)
    best = folds[0]["pick"] if folds[0]["pick"] == folds[1]["pick"] else max((f["pick"] for f in folds if f["pick"]), key=lambda s: level(runs[s], set(codes)), default=None)
    res["cases"] = {CASES[c]: dict(now=case(runs[None], c), with_resistance=case(runs[best], c) if best else None) for c in CASES}
    print("\nChange over the years, real vs simulated (as it is -> with resistance):")
    for nm, v in res["cases"].items():
        if v["now"]:
            w = v["with_resistance"]
            print(f"  {nm:14s} {v['now']['years'][0]}-{v['now']['years'][1]}: real {v['now']['real']:+.2f}, simulated {v['now']['sim']:+.2f}"
                  + (f" -> {w['sim']:+.2f}" if w else ""))
    verdict = "adopt" if r1 and r2 else "don't adopt"
    res.update(round1=dict(passed=r1, folds=[{k: v for k, v in f.items() if k != "pick"} for f in folds]),
               round2=dict(passed=r2), best=name(best) if best else None, verdict=verdict)
    print(f"\nRound 1 {'passed' if r1 else 'failed'}, round 2 {'passed' if r2 else 'failed'}: {verdict}"
          + (f" (resistance {name(best)})" if best and verdict == 'adopt' else ""))
    json.dump(res, open(os.path.join(B.OUT_DIR, "resistance_test.json"), "w"), indent=1)
    lines = ["# Resistance test", "", f"{PEOPLE:,} simulated people, real conditions {YEARS[0]}-{YEARS[-1]}.", "",
             f"- As it is: match {res['now']['match']}, lean {res['now']['lean']}, ups and downs {res['now']['changes']}",
             f"- Round 1 (unseen countries): {'passed' if r1 else 'failed'}", f"- Round 2 (real ups and downs): {'passed' if r2 else 'failed'}",
             f"- Verdict: {verdict}" + (f", {name(best)}" if best and verdict == 'adopt' else "")]
    open(os.path.join(B.OUT_DIR, "resistance_test.md"), "w").write("\n".join(lines) + "\n")
    print(f"\nDone in {time.time() - t0:.0f}s. Results are in the backtest folder.")


if __name__ == "__main__":
    main()
