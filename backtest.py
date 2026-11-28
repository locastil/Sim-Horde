"""
Sim Horde backtest: does the model get *change* right?
======================================================
Starts the world from every country's real conditions in 2015, feeds in what really happened year by year
(the World Bank's figures for incomes, jobs, cities, inequality, internet, inflation; the wars, coups,
sanctions, mass protests and the COVID-19 pandemic listed below), runs it month by month to the end of
2024, and compares what comes out with what real people reported in life-satisfaction surveys, and with
where people really emigrated from.

The one thing fitted is how the simulation's happiness scale lines up with the survey scale, and only on
2015. Everything after that is a test the model never saw. The weights come from the California tuning and
are not changed here.

First it tunes how strongly each kind of event (war, coup, sanctions, protests, inflation, collapse, the
pandemic) weighs on people, using 2015-2019 ONLY. Then it tests on 2019-2024, which the tuning never saw,
before and after tuning, so the improvement (or not) is measured honestly.

Needs internet (Our World in Data, World Bank) and runs best on a graphics card:
    python backtest.py               (about 20-30 minutes on a recent GPU)
Writes backtest/backtest.json and backtest/backtest.md.
"""
import csv
import io
import json
import math
import os
import sys
import time
import urllib.request

import torch

HERE = os.path.dirname(os.path.abspath(__file__))
sys.path.insert(0, HERE)
import world_kernel as WK     # noqa: E402

OUT_DIR = os.path.join(HERE, "backtest")
YEARS = list(range(2015, 2025))
PEOPLE = int(os.environ.get("BACKTEST_PEOPLE", "2000000"))       # simulated people, shared by population
TUNE_PEOPLE = int(os.environ.get("BACKTEST_TUNE_PEOPLE", "400000"))   # fewer for each tuning try, to keep it quick
TUNE_TRIES = int(os.environ.get("BACKTEST_TUNE_TRIES", "30"))
UA = {"User-Agent": "SimHorde/1.0 (backtest)"}
WB = "https://api.worldbank.org/v2/country/all/indicator/{code}?format=json&per_page=400&date={year}"
IND = dict(pop="SP.POP.TOTL", urban="SP.URB.TOTL.IN.ZS", gdp="NY.GDP.PCAP.PP.CD", unemp="SL.UEM.TOTL.ZS",
           young="SP.POP.1564.TO.ZS", gini="SI.POV.GINI", net="IT.NET.USER.ZS", infl="FP.CPI.TOTL.ZG",
           netmig="SM.POP.NETM")
HAPPY_URL = "https://ourworldindata.org/grapher/happiness-cantril-ladder.csv"
# Our World in Data republishes these World Bank series as single files, which download far more reliably
# than the World Bank's own API: used first, with the World Bank as a fallback (and for the two OWID lacks).
OWID = dict(pop="population", urban="share-of-population-urban", gdp="gdp-per-capita-worldbank", unemp="unemployment-rate",
            gini="economic-inequality-gini-index", net="share-of-individuals-using-the-internet", infl="inflation-of-consumer-prices")
OWID_URL = "https://ourworldindata.org/grapher/{slug}.csv?v=1&csvType=full&useColumnShortNames=true"

# What really happened, 2015-2024, by country (ISO codes) and years. Broad and public; no people named.
WARS = {  # major armed conflict on the country's own territory
    "SYR": (2015, 2024), "YEM": (2015, 2024), "AFG": (2015, 2021), "IRQ": (2015, 2017), "LBY": (2015, 2020),
    "SSD": (2015, 2020), "SOM": (2015, 2024), "NGA": (2015, 2024), "MLI": (2015, 2024), "UKR": (2022, 2024),
    "ETH": (2020, 2022), "MMR": (2021, 2024), "SDN": (2023, 2024), "PSE": (2023, 2024), "COD": (2015, 2024),
    "CAF": (2015, 2024), "BFA": (2016, 2024), "MOZ": (2017, 2024), "AZE": (2020, 2020), "ARM": (2020, 2020),
    "CMR": (2017, 2024), "NER": (2015, 2024), "HTI": (2021, 2024)}
COUPS = {"ZWE": [2017], "SDN": [2019, 2021], "MLI": [2020, 2021], "MMR": [2021], "GIN": [2021], "TCD": [2021],
         "BFA": [2022], "NER": [2023], "GAB": [2023], "BOL": [2019]}
SANCTIONS = {"RUS": (2022, 2024), "IRN": (2015, 2024), "VEN": (2017, 2024), "PRK": (2015, 2024), "SYR": (2015, 2024),
             "CUB": (2015, 2024), "BLR": (2020, 2024), "MMR": (2021, 2024)}
PROTESTS = {"FRA": [2018, 2019, 2023], "CHL": [2019], "COL": [2021], "IRN": [2019, 2022], "LBN": [2019, 2020],
            "SDN": [2019], "USA": [2020], "BLR": [2020], "KAZ": [2022], "LKA": [2022], "IRQ": [2019], "ECU": [2019],
            "BOL": [2019], "VEN": [2017, 2019], "NIC": [2018], "THA": [2020], "PER": [2022], "KEN": [2023, 2024],
            "BGD": [2024], "ISR": [2023], "HUN": [2018], "SRB": [2024], "GEO": [2024], "BRA": [2015, 2016]}
PANDEMIC = (2020, 3, 2021, 12)          # COVID-19 lockdowns and distancing, everywhere
COLLAPSES = {  # economic or state collapse without (or beyond) open war: savings wiped out, services failing, aid cut off
    "LBN": (2019, 2024), "AFG": (2021, 2024), "VEN": (2015, 2021), "LKA": (2022, 2023), "ZWE": (2019, 2020),
    "HTI": (2019, 2024), "SDN": (2019, 2022), "SYR": (2020, 2024), "ARG": (2018, 2019), "TUR": (2021, 2023),
    "PAK": (2022, 2023), "GHA": (2022, 2023), "EGY": (2022, 2024), "NGA": (2023, 2024)}

# how strongly each kind of event weighs on people: the 2015-2019 tuning searches these, nothing else
DEFAULT_FX = dict(war=1.0, coup=1.0, sanctions=1.0, protests=1.0, infl=1.2, pandemic=0.05, pandemic_dens=0.4, collapse=0.0)
RANGES = dict(war=(0.1, 1.2), coup=(0.2, 1.5), sanctions=(0.2, 1.5), protests=(0.2, 1.5), infl=(0.0, 3.0),
              pandemic=(-0.06, 0.08), pandemic_dens=(0.0, 0.6), collapse=(0.0, 0.4))


def get(url, tries=3):
    """Downloads, waiting longer and trying again when a server is slow (the World Bank's often is)."""
    for k in range(tries):
        try:
            with urllib.request.urlopen(urllib.request.Request(url, headers=UA), timeout=60 + 30 * k) as r:
                return r.read()
        except Exception as e:
            if k == tries - 1:
                raise
            print(f"    slow answer ({type(e).__name__}); trying again in {10 * (k + 1)}s...")
            time.sleep(10 * (k + 1))


def cached(name, fetch):
    """Keeps each download in backtest/cache, so a second run doesn't fetch it again."""
    d = os.path.join(OUT_DIR, "cache"); os.makedirs(d, exist_ok=True)
    p = os.path.join(d, name + ".json")
    if os.path.exists(p):
        return json.load(open(p))
    v = fetch()
    json.dump(v, open(p, "w"))
    return v


def owid(slug):
    """year-by-country figures from an Our World in Data file (the first value column)."""
    rows = cached("owid_" + slug, lambda: list(csv.reader(io.StringIO(get(OWID_URL.format(slug=slug)).decode("utf-8")))))
    head, out = rows[0], {}
    ci, yi = head.index("code"), head.index("year")
    vi = yi + 1
    for r in rows[1:]:
        try:
            c, y, v = r[ci], int(r[yi]), float(r[vi])
        except (ValueError, IndexError):
            continue
        if len(c) == 3 and 2012 <= y <= 2024:
            out.setdefault(c, {})[y] = v
    return out


def world_bank():
    """Each figure from Our World in Data where it has it, otherwise from the World Bank one year at a time.
    A figure that still won't download is left out (the run then holds it at its latest value) and says so."""
    data, missing = {}, []
    for key, code in IND.items():
        got = 0
        if key in OWID:
            try:
                for c, ys in owid(OWID[key]).items():
                    data.setdefault(c, {})[key] = ys; got += len(ys)
                print(f"  {key:7s} {OWID[key]:40s} {got} figures (Our World in Data)")
                continue
            except Exception as e:
                print(f"    Our World in Data didn't answer for {key} ({e}); trying the World Bank")
        bad = 0
        for year in range(2012, 2025):
            try:
                rows = cached(f"wb_{key}_{year}", lambda: json.loads(get(WB.format(code=code, year=year), tries=2)))
            except Exception as e:
                missing.append(f"{key} {year}"); bad += 1
                if bad >= 3 and not got:
                    print(f"    the World Bank isn't answering for {key}; holding it at its latest value")
                    missing += [f"{key} {y}" for y in range(year + 1, 2025)]
                    break
                continue
            rows = rows[1] if isinstance(rows, list) and len(rows) > 1 and rows[1] else []
            for r in rows:
                iso, v = r.get("countryiso3code"), r.get("value")
                if iso and v is not None:
                    data.setdefault(iso, {}).setdefault(key, {})[int(r["date"])] = float(v); got += 1
        print(f"  {key:7s} {code:40s} {got} figures (World Bank)")
    data["_missing"] = missing
    return data


def happiness():
    rows = cached("happiness", lambda: list(csv.reader(io.StringIO(get(HAPPY_URL).decode("utf-8")))))
    head, out = rows[0], {}
    ci, yi = head.index("Code"), head.index("Year")
    for row in rows[1:]:
        try:
            out.setdefault(row[ci], {})[int(row[yi])] = float(row[-1])
        except (ValueError, IndexError):
            continue
    return {c: v for c, v in out.items() if len(c) == 3}


def value(series, year, fallback):
    """This year's figure, or the nearest year's (figures like inequality are only measured every few years)."""
    if not series:
        return fallback
    if year in series:
        return series[year]
    near = min(series, key=lambda y: (abs(y - year), y > year))      # prefer the earlier year on a tie
    return series[near]


def pressure(code, year, month, infl, fx=DEFAULT_FX):
    p = dict(stress=0.0, irr=0.0, leave=0.0, kind=0.0)
    w = WARS.get(code)
    if w and w[0] <= year <= w[1]:
        k = fx["war"]; p.update(stress=0.35 * k, irr=0.8 * k, leave=2.0 * k, kind=0.25 * k)
    if year in COUPS.get(code, []):
        p["stress"] += 0.12 * fx["coup"]; p["leave"] += 0.5 * fx["coup"]
    s = SANCTIONS.get(code)
    if s and s[0] <= year <= s[1]:
        p["stress"] += 0.05 * fx["sanctions"]; p["leave"] += 0.3 * fx["sanctions"]
    if year in PROTESTS.get(code, []):
        k = fx["protests"]; p["stress"] += 0.05 * k; p["irr"] += 0.6 * k; p["kind"] += 0.05 * k
    if infl is not None and infl > 4:
        p["stress"] += min(0.2, (infl - 4) / 100 * fx["infl"])
    c = COLLAPSES.get(code)
    if c and c[0] <= year <= c[1]:
        p["stress"] += fx["collapse"]; p["leave"] += fx["collapse"] * 3
    a = (PANDEMIC[0], PANDEMIC[1]) <= (year, month) <= (PANDEMIC[2], PANDEMIC[3])
    if a:
        p["stress"] += fx["pandemic"]; p["leave"] -= 0.3
    return p, a


def theta():
    th = {}
    for p in (os.path.join(HERE, "engine", "sim_data", "calibrated_weights.json"),
              os.path.join(os.path.dirname(HERE), "LA-Sim", "sim_data", "calibrated_weights.json")):
        try:
            cal = json.load(open(p)); cal = cal.get("weights", cal)
            for k, (lo, hi) in WK.WORLD_RANGES.items():
                if isinstance(cal.get(k), (int, float)):
                    th[k] = max(lo, min(hi, float(cal[k])))
            return th, p
        except (OSError, ValueError):
            continue
    return th, None


def corr(xs, ys):
    n = len(xs)
    if n < 5:
        return None
    mx, my = sum(xs) / n, sum(ys) / n
    sxy = sum((a - mx) * (b - my) for a, b in zip(xs, ys)); sxx = sum((a - mx) ** 2 for a in xs); syy = sum((b - my) ** 2 for b in ys)
    return round(sxy / math.sqrt(sxx * syy), 3) if sxx > 0 and syy > 0 else None


def rank(xs, ys):
    rk = lambda v: {i: r for r, i in enumerate(sorted(range(len(v)), key=lambda j: v[j]))}
    if len(xs) < 5:
        return None
    a, b = rk(xs), rk(ys); n = len(xs)
    return round(1 - 6 * sum((a[i] - b[i]) ** 2 for i in range(n)) / (n * (n * n - 1)), 3)


def main():
    t0 = time.time()
    dev = torch.device("cuda" if torch.cuda.is_available() else "cpu")
    print(f"Backtest 2015-2024 on {torch.cuda.get_device_name(0) if dev.type == 'cuda' else 'the CPU'}")
    print("Downloading real figures...")
    wb, happy = world_bank(), happiness()
    missing = wb.pop("_missing", [])
    core = [m for m in missing if m.split()[0] not in ("young", "netmig")]
    incomplete = len(core) > len(OWID) * 13 * 0.25
    if incomplete:
        print(f"\n  WARNING: {len(missing)} downloads failed. The run will finish, but it would mostly be testing")
        print("  made-up flat figures, so it's marked incomplete and won't be shown on the site.\n")
    print(f"  happiness surveys: {len(happy)} countries")
    th, th_src = theta()
    nat = json.load(open(os.path.join(HERE, "engine", "sim_data", "world", "nations.json")))
    nat = nat.get("nations", nat)
    rows = nat if isinstance(nat, list) else list(nat.values())
    key = lambda r: r.get("code") or r.get("iso3")
    codes = [key(r) for r in rows if r.get("pop")]
    latest = {key(r): r for r in rows}
    pop15 = {c: value(wb.get(c, {}).get("pop"), 2015, latest[c]["pop"]) for c in codes}
    tot = sum(pop15.values())
    agents_for = lambda people: {c: int(max(60, min(500_000, round(pop15[c] / tot * people)))) for c in codes}

    feat_cache = {}
    def feats(c, year):
        k = (c, year)
        if k not in feat_cache:
            s, L = wb.get(c, {}), latest[c]
            feat_cache[k] = WK.features(dict(gdp=value(s.get("gdp"), year, L.get("gdp") or 8000), urban=value(s.get("urban"), year, L.get("urban") or 55),
                                             unemp=value(s.get("unemp"), year, L.get("unemp") or 6), gini=value(s.get("gini"), year, L.get("gini") or 36),
                                             young=value(s.get("young"), year, L.get("young") or 64), net=value(s.get("net"), year, L.get("net") or 50)))
        return feat_cache[k]

    def simulate(years, fx, agents, label=""):
        def job(year, month, state, seed):
            ns = []
            for c in codes:
                f = feats(c, year)
                p, pand = pressure(c, year, month, value(wb.get(c, {}).get("infl"), year, None), fx)
                if pand:
                    f = dict(f, dens=max(-1.0, f["dens"] - fx["pandemic_dens"]), unemp=min(1.5, f["unemp"] + 0.15))
                ns.append(dict(code=c, agents=agents[c], feat={k: round(v, 4) for k, v in f.items()},
                               pressure={k: round(max(-9.5, min(9.5, v)), 4) for k, v in p.items()}))
            return dict(nations=ns, theta=th, days=30, seed=seed, state=state)
        state = None
        for w in range(3):                              # settle in on the first year's conditions
            state = WK.run_shard(job(years[0], 1, state, 900 + w), dev)["state"]
        yearly = {}
        for y in years:
            acc = {c: [0.0, 0.0] for c in codes}
            for m in range(1, 13):
                r = WK.run_shard(job(y, m, state, y * 100 + m), dev)
                state = r["state"]
                for c, v in r["nations"].items():
                    acc[c][0] += v["happy"] / 12; acc[c][1] += v["leave"] / 12
            yearly[y] = acc
            if label:
                print(f"  {label} {y} done ({time.time() - t0:.0f}s)")
        return yearly

    def scale(yearly):
        """Line the simulation's happiness up with the surveys, on 2015 ONLY."""
        pts = [(yearly[2015][c][0], happy[c][2015], math.sqrt(pop15[c])) for c in codes if 2015 in happy.get(c, {})]
        W_ = sum(p[2] for p in pts); mx = sum(p[0] * p[2] for p in pts) / W_; my = sum(p[1] * p[2] for p in pts) / W_
        sxy = sum(p[2] * (p[0] - mx) * (p[1] - my) for p in pts); sxx = sum(p[2] * (p[0] - mx) ** 2 for p in pts)
        b = max(0.3, min(3.0, sxy / sxx if sxx > 0 else 1.0)); a = my - b * mx
        return a, b, len(pts)

    def change(yearly, y0, y1, a, b):
        """Each country's change in happiness from y0 to y1 (or the nearest surveyed years), simulated vs real."""
        H = lambda raw: max(0.0, min(10.0, a + b * raw))
        ch = []
        for c in codes:
            hy = happy.get(c, {})
            ys = [y for y in range(y0, y1 + 1) if y in hy and y in yearly]
            if len(ys) < 2 or ys[-1] - ys[0] < max(3, (y1 - y0) // 2):
                continue
            f, t = ys[0], ys[-1]
            ch.append(dict(code=c, name=latest[c].get("name", c), from_year=f, to_year=t,
                           sim=round(H(yearly[t][c][0]) - H(yearly[f][c][0]), 3), real=round(hy[t] - hy[f], 3)))
        sims, reals = [x["sim"] for x in ch], [x["real"] for x in ch]
        big = [x for x in ch if abs(x["real"]) >= 0.3]
        mae = sum(abs(p - q) for p, q in zip(sims, reals)) / max(1, len(ch)); mae0 = sum(abs(q) for q in reals) / max(1, len(ch))
        return dict(years=[y0, y1], countries=len(ch), r=corr(sims, reals), rank=rank(sims, reals), mae=round(mae, 3), mae_no_change=round(mae0, 3),
                    direction=round(sum(1 for x in big if (x["sim"] > 0) == (x["real"] > 0)) / max(1, len(big)), 3), direction_countries=len(big),
                    biggest_misses=sorted(ch, key=lambda x: -abs(x["sim"] - x["real"]))[:8],
                    examples=sorted(big, key=lambda x: x["real"])[:5] + sorted(big, key=lambda x: x["real"])[-5:])

    def objective(c):
        return (c["rank"] or 0) + (c["mae_no_change"] - c["mae"]) / max(0.01, c["mae_no_change"])

    # ---------------------------------------------------------------- 1. tune the event effects on 2015-2019 ONLY
    import random
    rnd = random.Random(7)
    small = agents_for(TUNE_PEOPLE)
    train = list(range(2015, 2020))
    tried = []
    print(f"Tuning how strongly events weigh on people, on 2015-2019 only ({TUNE_TRIES} tries, {sum(small.values()):,} people each)...")
    best = None
    for i in range(TUNE_TRIES):
        if i == 0:
            fx = dict(DEFAULT_FX)
        elif best is None or i < TUNE_TRIES * 0.6:
            fx = {k: round(rnd.uniform(lo, hi), 3) for k, (lo, hi) in RANGES.items()}
        else:                                                   # then search around the best so far
            fx = {k: round(min(hi, max(lo, best[1][k] + rnd.gauss(0, (hi - lo) * 0.12))), 3) for k, (lo, hi) in RANGES.items()}
        y = simulate(train, fx, small)
        a, b, _ = scale(y)
        c = change(y, 2015, 2019, a, b)
        sc = objective(c)
        tried.append(dict(fx=fx, score=round(sc, 3), rank=c["rank"], mae=c["mae"], mae_no_change=c["mae_no_change"]))
        if best is None or sc > best[0]:
            best = (sc, fx)
        print(f"  try {i + 1}/{TUNE_TRIES}: score {sc:+.3f} (best {best[0]:+.3f})  [{time.time() - t0:.0f}s]")
    tuned = best[1]

    # ---------------------------------------------------------------- 2. test on 2020-2024, which the tuning never saw
    agents = agents_for(PEOPLE)
    print(f"Testing on 2020-2024 with {sum(agents.values()):,} people: first as before, then with the tuned effects...")
    before = simulate(YEARS, DEFAULT_FX, agents, "before")
    after = simulate(YEARS, tuned, agents, "tuned")
    a0, b0, n0 = scale(before); a1, b1, n1 = scale(after)
    test_before, test_after = change(before, 2019, 2024, a0, b0), change(after, 2019, 2024, a1, b1)
    full_after = change(after, 2015, 2024, a1, b1)

    H = lambda raw: max(0.0, min(10.0, a1 + b1 * raw))
    per_year = []
    for y in YEARS:
        pairs = [(H(after[y][c][0]), happy[c][y]) for c in codes if y in happy.get(c, {})]
        if pairs:
            xs, ys = zip(*pairs)
            per_year.append(dict(year=y, countries=len(xs), mae=round(sum(abs(p - q) for p, q in pairs) / len(xs), 3), rank=rank(list(xs), list(ys)),
                                 sim_world=round(sum(xs) / len(xs), 3), real_world=round(sum(ys) / len(ys), 3)))

    em = []
    for c in codes:
        nm = wb.get(c, {}).get("netmig") or ({2023: latest[c]["netmig"]} if latest[c].get("netmig") else None)
        if not nm:
            continue
        real = sum(value(nm, y, 0) for y in YEARS) / len(YEARS) / pop15[c] * 1000
        if real < 0:
            em.append((sum(after[y][c][1] for y in YEARS) / len(YEARS), -real))
    emig = dict(countries=len(em), rank=rank([e[0] for e in em], [e[1] for e in em]))

    out = dict(made=time.strftime("%Y-%m-%d %H:%M"), years=[YEARS[0], YEARS[-1]], people=sum(agents.values()), countries=len(codes),
               weights_from="the California tuning (calibrated_weights.json)" if th_src else "default weights",
               scale_fit_2015=dict(a=round(a1, 3), b=round(b1, 3), countries=n1),
               tuning=dict(years=[train[0], train[-1]], tries=TUNE_TRIES, people=sum(small.values()), effects_before=DEFAULT_FX, effects_tuned=tuned,
                           best_score=round(best[0], 3), all_tries=sorted(tried, key=lambda t: -t["score"])[:10]),
               test=dict(years=[2019, 2024], before=test_before, after=test_after),
               change=full_after, per_year=per_year, emigration=emig, secs=round(time.time() - t0), missing_figures=missing, incomplete=incomplete,
               events=dict(wars=WARS, coups=COUPS, sanctions=SANCTIONS, protests=PROTESTS, collapses=COLLAPSES, pandemic=PANDEMIC),
               sources=["World Bank Open Data, via Our World in Data where available (indicators in backtest.py)",
                        "World Happiness Report via Our World in Data (CC BY)"])
    os.makedirs(OUT_DIR, exist_ok=True)
    json.dump(out, open(os.path.join(OUT_DIR, "backtest.json"), "w"), indent=1)
    json.dump(dict(effects=tuned, tuned_on=[train[0], train[-1]], made=out["made"]), open(os.path.join(OUT_DIR, "event_effects.json"), "w"), indent=1)
    tb, ta = test_before, test_after
    fmt = lambda c: f"rank match {c['rank']}, error {c['mae']} vs {c['mae_no_change']} for 'no change', direction right {c['direction']:.0%} of {c['direction_countries']}"
    md = [f"# Backtest {YEARS[0]}-{YEARS[-1]}", "",
          f"Event effects tuned on 2015-2019 only ({TUNE_TRIES} tries). Tested on 2019-2024 change, which the tuning never saw.", "",
          f"**Test, before tuning ({tb['countries']} countries):** {fmt(tb)}.",
          f"**Test, after tuning ({ta['countries']} countries):** {fmt(ta)}.", "",
          "Tuned effects: " + ", ".join(f"{k} {DEFAULT_FX[k]} -> {v}" for k, v in tuned.items()), "",
          f"**Emigration:** rank match {emig['rank']} across {emig['countries']} countries people really left."]
    open(os.path.join(OUT_DIR, "backtest.md"), "w").write("\n".join(md) + "\n")
    print("\n" + "\n".join(md))
    print(f"\nWrote {OUT_DIR} in {out['secs']}s")


if __name__ == "__main__":
    main()
