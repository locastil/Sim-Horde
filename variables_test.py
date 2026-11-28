"""Variables test: four candidates for what the simulation's happiness still gets wrong (Model lab, Nov 2026).

After the happiness scale was fixed, the remaining misses had a pattern: countries in a sudden economic collapse
(Sri Lanka, Lebanon, Egypt) came out too happy; Afghanistan too; South Korea and Hong Kong a little too; much of
Latin America too unhappy. Candidates, none of them from the Gallup poll the happiness surveys come from:
  economic shock: inflation jumping well above the country's own recent normal, and incomes falling (changes
                  year to year; the model already counts high inflation itself, this is the jump)
  women's freedoms: the World Bank's Women, Business and the Law index (less freedom: more stress)
  working hours: annual hours per worker (Penn World Table, via Our World in Data)
  family ties: average household size (UN, via Our World in Data)
Each goes in as a steady push on how stressed a country's simulated people are, at three strengths.
Round 1, unseen countries: the strength is chosen on half the countries and scored on the other half; then swap.
Round 2, real ups and downs: the strengths round 1 chose, unchanged, against each country's year-to-year rises and
falls in the surveys, which round 1 never looked at. A variable passes only if it wins round 1 on both halves and
doesn't make round 2 worse. A candidate whose data won't download is skipped and reported.
Nothing in the live world changes. Results: backtest/variables_test.*
"""
import json, math, os, random, sys, time
import torch

HERE = os.path.dirname(os.path.abspath(__file__))
sys.path.insert(0, HERE)
import backtest as B                # noqa: E402
import world_kernel as WK           # noqa: E402
from migration_test import wb_latest, latest   # noqa: E402

YEARS = list(range(2015, 2024))
PEOPLE = int(os.environ.get("VAR_TEST_PEOPLE", "600000"))
STRENGTHS = [0.05, 0.1, 0.2]          # stress per standard unit (a war adds about 0.35)
CASES = {"LKA": "Sri Lanka", "LBN": "Lebanon", "EGY": "Egypt", "AFG": "Afghanistan", "KOR": "South Korea", "VEN": "Venezuela",
         "TUR": "Turkey", "ARG": "Argentina", "BRA": "Brazil", "MEX": "Mexico"}


def zscore(d, codes):
    vs = [d[c] for c in codes if c in d]
    if len(vs) < 30:
        return None
    m = sum(vs) / len(vs); s = math.sqrt(sum((v - m) ** 2 for v in vs) / len(vs)) or 1
    return {c: max(-2.5, min(2.5, (d[c] - m) / s)) if c in d else 0.0 for c in codes}


def main():
    t0 = time.time()
    dev = torch.device("cuda" if torch.cuda.is_available() else "cpu")
    print(f"Variables test on {torch.cuda.get_device_name(0) if dev.type == 'cuda' else 'the CPU'}")
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

    print("Getting the candidates...")
    V, skipped = {}, {}
    # economic shock, by year: inflation above the country's own last three years, and falling income per person
    shock = {}
    for c in codes:
        inf, gdp = wb.get(c, {}).get("infl") or {}, wb.get(c, {}).get("gdp") or {}
        for y in YEARS:
            s = 0.0
            if y in inf:
                prev = [inf[p] for p in (y - 1, y - 2, y - 3) if p in inf]
                if prev:
                    s += max(0.0, math.log1p(max(0.0, inf[y]) / 100) - math.log1p(max(0.0, sum(prev) / len(prev)) / 100)) * 10
            if y in gdp and (y - 1) in gdp and gdp[y - 1]:
                s += max(0.0, -(gdp[y] / gdp[y - 1] - 1)) * 10
            shock[(c, y)] = s
    vals = list(shock.values()); m = sum(vals) / len(vals); sd = math.sqrt(sum((v - m) ** 2 for v in vals) / len(vals)) or 1
    V["economic shock"] = {k: max(-2.5, min(2.5, (v - m) / sd)) for k, v in shock.items()}
    print(f"  economic shock: {sum(1 for v in vals if v > 0)} country-years with a jump or a fall")

    def static(name, fetch, sign):
        try:
            z = zscore({c: sign * v for c, v in fetch().items() if v is not None}, codes)
        except Exception as e:
            skipped[name] = str(e)[:120]; print(f"  {name}: skipped ({str(e)[:80]})"); return
        if z is None:
            skipped[name] = "too few countries"; print(f"  {name}: skipped (too few countries)"); return
        V[name] = {(c, y): z[c] for c in codes for y in YEARS}
        print(f"  {name}: {sum(1 for c in codes if z[c] != 0)} countries")

    def owid_first(slugs):
        last = None
        for s in slugs:
            try:
                return latest(B.owid(s))
            except Exception as e:
                last = e
        raise last or RuntimeError("no data")

    static("women's freedoms", lambda: {c: v[1] for c, v in wb_latest("SG.LAW.INDX").items()}, -1)
    static("working hours", lambda: owid_first(["annual-working-hours-per-worker"]), +1)
    static("family ties", lambda: owid_first(["average-household-size", "household-size", "mean-household-size"]), -1)

    feat_cache = {}
    def feats(c, year):
        k = (c, year)
        if k not in feat_cache:
            s, L = wb.get(c, {}), latest_row[c]
            feat_cache[k] = WK.features(dict(gdp=B.value(s.get("gdp"), year, L.get("gdp") or 8000), urban=B.value(s.get("urban"), year, L.get("urban") or 55),
                                             unemp=B.value(s.get("unemp"), year, L.get("unemp") or 6), gini=B.value(s.get("gini"), year, L.get("gini") or 36),
                                             young=B.value(s.get("young"), year, L.get("young") or 64), net=B.value(s.get("net"), year, L.get("net") or 50)))
        return feat_cache[k]

    def simulate(push):
        """push: None or (variable, strength). Returns yearly simulated happiness per country."""
        def job(year, month, state, seed):
            ns = []
            for c in codes:
                f = dict(feats(c, year))
                p, pand = B.pressure(c, year, month, B.value(wb.get(c, {}).get("infl"), year, None), fx)
                p["stress"] += 0.1 * float(hle.get(c, 0.0))
                if push:
                    p["stress"] += push[1] * V[push[0]].get((c, year), 0.0)
                if pand:
                    f = dict(f, dens=max(-1.0, f["dens"] - fx["pandemic_dens"]), unemp=min(1.5, f["unemp"] + 0.15))
                ns.append(dict(code=c, agents=agents[c], feat={k: round(v, 4) for k, v in f.items()},
                               pressure={k: round(max(-9.5, min(9.5, v)), 4) for k, v in p.items()}))
            return dict(nations=ns, theta=th, days=30, seed=seed, state=state)
        state = None
        for w in range(3):
            state = WK.run_shard(job(YEARS[0], 1, state, 900 + w), dev)["state"]
        out = {}
        for y in YEARS:
            acc = {c: 0.0 for c in codes}
            for m_ in range(1, 13):
                r = WK.run_shard(job(y, m_, state, y * 100 + m_), dev); state = r["state"]
                for c, v in r["nations"].items():
                    acc[c] += v["happy"] / 12
            out[y] = acc
        print(f"  {'as it is' if not push else f'{push[0]} at {push[1]}'}: done ({time.time() - t0:.0f}s)", flush=True)
        return out

    runs = {None: simulate(None)}
    for k in V:
        for s in STRENGTHS:
            runs[(k, s)] = simulate((k, s))

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

    def changes(run):
        xs, ys = [], []
        for c in codes:
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
        return dict(years=[a, b], real=round(happy[c][b] - happy[c][a], 2), sim=round(run[b][c] - run[a][c], 2), sim_level=round(run[b][c], 2), real_level=round(happy[c][b], 2))

    base = dict(match=level(runs[None], set(codes)), changes=changes(runs[None]))
    res = dict(people=PEOPLE, years=[YEARS[0], YEARS[-1]], now=base, skipped=skipped, variables={})
    print(f"\nAs it is: match {base['match']}, ups and downs {base['changes']}")
    for k in V:
        folds = []
        for tune, test in ((halves[0], halves[1]), (halves[1], halves[0])):
            pick = max([None] + [(k, s) for s in STRENGTHS], key=lambda o: level(runs[o], tune) or -9)
            folds.append(dict(chosen=pick[1] if pick else 0, unseen_now=level(runs[None], test), unseen_with=level(runs[pick], test),
                              changes_with=changes(runs[pick])))
        r1 = all(f["chosen"] and f["unseen_with"] > f["unseen_now"] for f in folds)
        r2 = all(f["chosen"] and f["changes_with"] >= base["changes"] - 0.02 for f in folds)
        best = max((f["chosen"] for f in folds if f["chosen"]), default=0)
        res["variables"][k] = dict(folds=folds, round1=r1, round2=r2, verdict="adopt" if r1 and r2 else "don't adopt", strength=best if r1 and r2 else None,
                                   all={str(s): dict(match=level(runs[(k, s)], set(codes)), changes=changes(runs[(k, s)])) for s in STRENGTHS},
                                   cases={CASES[c]: case(runs[(k, best)], c) for c in CASES} if best else None)
        print(f"\n{k}:")
        print("  round 1, unseen countries: " + ", ".join(f"{f['unseen_now']} -> {f['unseen_with']} (strength {f['chosen']})" for f in folds) + f": {'passed' if r1 else 'failed'}")
        print("  round 2, ups and downs: " + ", ".join(f"{base['changes']} -> {f['changes_with']}" for f in folds) + f": {'passed' if r2 else 'failed'}")
        print(f"  verdict: {res['variables'][k]['verdict']}" + (f" (strength {best})" if r1 and r2 else ""))
    res["cases_now"] = {CASES[c]: case(runs[None], c) for c in CASES}
    json.dump(res, open(os.path.join(B.OUT_DIR, "variables_test.json"), "w"), indent=1)
    lines = ["# Variables test", "", f"{PEOPLE:,} simulated people, real conditions {YEARS[0]}-{YEARS[-1]}. As it is: match {base['match']}, ups and downs {base['changes']}.", ""]
    lines += [f"- {k}: round 1 {'passed' if v['round1'] else 'failed'}, round 2 {'passed' if v['round2'] else 'failed'}: {v['verdict']}" for k, v in res["variables"].items()]
    lines += [f"- {k}: skipped ({v})" for k, v in skipped.items()]
    open(os.path.join(B.OUT_DIR, "variables_test.md"), "w").write("\n".join(lines) + "\n")
    print(f"\nDone in {time.time() - t0:.0f}s. Results are in the backtest folder.")


if __name__ == "__main__":
    main()
