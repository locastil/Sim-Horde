"""
The shared Sim Horde world, kept by the coordinator.

The world advances one month (an epoch) at a time. Each epoch is split into shards, a handful of nations
each; volunteers' workers run the shards (world_kernel.run_shard) and send back each nation's month plus
the shard's new state. When every shard is back, the coordinator runs the month's politics, moves
refugees, writes the headlines, and opens the next month. A shard that isn't returned in time goes to
someone else, so one dropped volunteer never stalls the world for long.

Real countries and real statistics (World Bank, through world/world_data.py); no real people. Leaders are
named only by office ("the President of Brazil") and parties by broad family ("the Conservatives"), so
every event is something that could plausibly happen there, never a claim about an actual person.
The political events are drawn at the rates history shows:

  * coup attempts: about 3 a year worldwide in the 2010s (Powell & Thyne coup data), about half succeed
  * new civil conflicts: a few a year (UCDP/PRIO armed conflict data); about 50 active in a recent year
  * elections on a fixed rhythm in democracies; protest waves, crackdowns, democratic backsliding,
    transitions and border standoffs at rough base rates

The world-level rates are fixed to those totals; which nations they land on depends on the simulation:
stress, rudeness, hardship, inequality and instability make a nation likelier to be the one.
"""
import json
import math
import os
import re
import sys
import random
import threading
import time

import world_kernel as WK

HERE = os.path.dirname(os.path.abspath(__file__))
STATE_DIR = os.path.join(HERE, "world_state")
EPOCH_DAYS = 30
SHARD_AGENTS = 40_000       # one piece of the world: small enough for a phone to run a month in seconds
NATION_MAX = 40_000         # the most simulated people any one nation gets (so every piece fits a phone)
STALE_SECS = 10 * 60
CHECK_WAIT = 120            # a spot check waits this long for a second volunteer; then the first run stands (unchecked)
CHECK_SHARE = 0.10          # share of pieces run twice, by different volunteers, to check each other

# Levels of detail. The Low level is the world above: every nation, small pieces, finished every month so the
# world never stalls. Each finer level simulates the same nations with more people (mult x the Low count),
# split into regions and packed into pieces sized for the devices that can run them. Devices pick up the finest
# piece they can handle once the month's Low pieces are out; a nation finished at a finer level this month is
# simulated (and shown) at that level. Detail pieces keep their state on the device that ran them, so only a
# few numbers cross the network each month; a piece that changes hands starts fresh and warms up first.
LAYERS = [dict(name="Low", mult=1, piece=SHARD_AGENTS),
          dict(name="Medium", mult=4, piece=40_000),       # phone-sized pieces
          dict(name="High", mult=16, piece=250_000),       # computers' browsers and smaller GPUs
          dict(name="Ultra", mult=64, piece=500_000)]      # big GPUs
WARM_MONTHS = 3             # a detail piece counts once it has run this many months in a row from its own state
HOLD_SECS = 45              # at the start of a month, a detail piece waits this long for the device that holds its state
REFUGEE_MAX = 120.0         # the most of a war zone's people who flee in a year, per 1,000 (12%: about the worst ever seen)
# How much of a country a conflict touches. A minor conflict (UCDP: 25-999 battle deaths a year, like an insurgency in one
# region, or a border clash) weighs on a fraction of the country and drives few people abroad; a major one (1,000+)
# weighs on everyone. Before this, every conflict counted as a full-scale war: India's Kashmir insurgency sent 12% of
# Indians abroad a year in the simulation, against a real net migration of under 0.1%.
CONFLICT_WEIGHT = {1: 0.3, 2: 1.0}
REFUGEE_CAP = {1: 3.0, 2: REFUGEE_MAX}       # per 1,000 people a year
# Who actually leaves, beyond how many want to: tested on real 2015-2023 migration in migration_test.py and
# chosen on half the countries, scored on the other half (see the Model lab page). Standard units per country
# come from world/migration_vars.json; a country with no figure counts as typical.
MIG_PUSH = dict(remittances=1.2, immigrants=1.5)      # in a broad range that scores about the same (0.43 vs 0.06 now)
# Day-to-day hardship beyond income: healthy life expectancy (WHO). Tested on real 2015-2023 happiness in
# happiness_test.py and happiness_test2.py, chosen on half the countries and scored on the other half (see the
# Model lab): a steady push on stress per standard unit of shorter healthy life; stronger settings and adding food
# insecurity (which comes from the same Gallup poll as the happiness surveys) did no better.
HAPPY_PUSH = dict(life_expectancy=0.1)
# The United States, county by county. At the finer levels of detail the US's simulated people are split into its
# real counties (small neighbouring counties in the same state grouped together), each with its own conditions from
# the Census Bureau's American Community Survey (world/us_counties_data.py): hardship from the share below 150% of
# the poverty line, unemployment, crowding from population density, age, and broadband. Inequality stays at the
# national figure (no county figure in the source). Each county's conditions are the national ones moved by how far
# the county is from the national average, so the country as a whole stays where the Low level puts it.
COUNTY_NATION = "USA"
# Every other country, region by region. At the same finer levels, each country with regional figures splits into its
# regions from the Global Data Lab's Subnational Human Development Database (world/regions_data.py): a region's
# hardship moves from the national figure by how its income per person differs from the country's (on the same log
# scale the model uses for countries), and its day-to-day stress by how its life expectancy differs (as healthy life
# expectancy does between countries). Checked against the OECD's regional life satisfaction (Gallup World Poll),
# which the simulation never uses as an input. Regions run only where a volunteer's device runs the finer levels.
LE_SD = 7.0          # years of life expectancy per standard unit between countries, for the regional stress push
GUARD = dict(happy=1.5, civ=0.08, stress=0.5)    # a detail result far from the Low result for the same nation is ignored

PER_YEAR = dict(coup=3.0, conflict=3.5, protest=24.0, standoff=1.2, war=0.25)    # world totals a year
# share of protest waves that police break up or arrest (any), and that meet deadly force: Mass Mobilization data
CRACK_ANY = dict(dem=0.28, hyb=0.40, aut=0.55, mil=0.55)
CRACK_DEADLY = dict(dem=0.02, hyb=0.08, aut=0.15, mil=0.15)

# Markets and trade. Every country has a stock index (1,000 at the start) that moves each month with the world
# market, with what the simulation did there (people's mood and stress, protests, coups, conflict, elections)
# and with its trading partners. Big global moves come at rough historical rates (a crash of 20%+ about once a
# decade, a 10% correction every couple of years). Trade laws (tariffs, trade deals, sanctions, export bans)
# are drawn at rough yearly totals and change who trades with whom. Markets and trade feed back into the
# simulation: a falling market and sanctions add stress; sanctions push people to leave.
TRADE_PER_YEAR = dict(tariff=8.0, deal=5.0, sanctions=1.5, export_ban=3.0, lift=0.0)
MKT = dict(drift=0.0075, world_sd=0.03, crash=0.10, correction=0.45, rally=0.25)   # about 6-7% a year over the long run
SHOCK = dict(PROTEST=-0.03, CRACKDOWN=-0.015, COUP=-0.12, CONFLICT=-0.10, WAR=-0.12, PEACE=0.06, BORDER=-0.03,
             TRANSITION=0.03, BACKSLIDING=-0.06, OPENING=0.05, SANCTIONS=-0.10, TARIFF=-0.025, DEAL=0.025, BAN=-0.015)
# Prices and growth. Each country starts from its real inflation and growth (World Bank, world/trade_data.py) and
# drifts back toward its usual level, with its central bank raising rates when prices run hot (which slows growth).
# Shocks: world energy and food price spikes (a few a decade), export bans, tariffs, sanctions (currency
# collapses), conflict, coups and crashes. Stagflation is high inflation with a stalling economy at the same time.
# Rising prices squeeze people: they add stress and make cost-of-living protests likelier.
ECON = dict(energy_spike=0.15, food_spike=0.2, stag_infl=6.0, stag_growth=0.5)
GOODS = ["rice", "wheat", "fertilizer", "cooking oil", "steel", "rare earth metals", "natural gas", "medical supplies",
         "sugar", "computer chips", "lithium", "corn"]
CONFLICT_END = 0.10          # chance a civil conflict ends in a given year... per month below
CONFLICT_END_M = 1 - (1 - 0.10) ** (1 / 12)
GOV_LABEL = dict(dem="Democracy", hyb="Mixed regime", aut="Autocracy", mil="Military rule")

# the head of government's title: parliamentary systems have prime ministers, presidential ones presidents
PM = set("GBR CAN AUS NZL IND JPN ITA ESP NLD BEL SWE NOR DNK FIN IRL GRC PRT CZE SVK HUN POL ISR PAK BGD THA MYS SGP NPL "
         "LKA EST LVA LTU SVN HRV BGR ROU SRB MNE MKD ALB ISL LUX MLT JAM TTO BRB BHS PNG FJI SLB VUT KHM ARM GEO MNG".split())
CHANCELLOR = {"DEU", "AUT"}
MONARCH = dict(SAU="King", JOR="King", MAR="King", BHR="King", SWZ="King", OMN="Sultan", BRN="Sultan", QAT="Emir", KWT="Emir")
PARTY_SETS = {
    "USA": ["the Democrats", "the Republicans"],
    "GBR": ["Labour", "the Conservatives", "the Liberal Democrats"],
    "Europe": ["the Social Democrats", "the Conservatives", "the Liberals", "the Greens", "the Nationalists"],
    "Americas": ["the Liberals", "the Conservatives", "the Socialists", "the Centrists"],
    "Oceania": ["Labour", "the Conservatives", "the Greens"],
    "*": ["the Social Democrats", "the Conservatives", "the Liberals", "the Nationalists"],
}


THE = ("United", "Republic", "Democratic Republic", "Czech Republic", "Central African Republic", "Dominican Republic",
       "Netherlands", "Philippines", "Bahamas", "Gambia", "Maldives", "Marshall Islands", "Solomon Islands", "Comoros",
       "Seychelles", "Vatican", "Cayman Islands", "Falkland Islands", "Faroe Islands", "British Virgin Islands",
       "United States Virgin Islands", "Northern Mariana Islands", "Cook Islands", "Turks and Caicos Islands")


def the(name):
    return ("the " + name) if name.startswith(THE) else name


def office(code, region, gov):
    if code == "CHE":
        return "President of the Confederation"
    if code in MONARCH:
        return MONARCH[code]
    if code in CHANCELLOR:
        return "Chancellor"
    if code in PM or (gov == "dem" and region in ("Europe", "Oceania")):
        return "Prime Minister"
    return "President"


def party_set(code, region, gov, r):
    if gov == "aut":
        return ["the ruling party"]
    if gov == "hyb":
        return ["the ruling party", "the opposition alliance"]
    base = PARTY_SETS.get(code) or PARTY_SETS.get(region) or PARTY_SETS["*"]
    return base[:] if code in PARTY_SETS else r.sample(base, k=min(len(base), r.choice([2, 3, 3, 4])))


def cap(s):
    return s[:1].upper() + s[1:]


def monthly(p_year):
    return 1 - (1 - min(0.95, p_year)) ** (1 / 12)


class World:
    def __init__(self, engine_dir, target_agents=1_200_000, seed=1, month_secs=120):
        self.lock = threading.RLock()
        self.month_secs = month_secs          # the world's pace: at least this long between months
        self.opened = 0.0
        self.engine_dir = engine_dir
        os.makedirs(STATE_DIR, exist_ok=True)
        self.path = os.path.join(STATE_DIR, "world.json")
        self.jobs = {}                     # shard index -> dict(status, worker, at, result)
        self.counties = self.load_counties()
        self.regions, self.oecd_regions = self.load_regions()
        if os.path.exists(self.path):
            self.w = json.load(open(self.path, encoding="utf-8"))
            if "layers" not in self.w:
                self.build_layers(self.w)
                self.save()
            if not self.w.get("pop_fix_1"):
                self.repair_population()
                self.save()
            if not self.w.get("conflict_levels"):
                self.set_conflict_levels()
                self.save()
            if (self.counties and not self.w.get("county_regions")) or (self.regions and not self.w.get("gdl_regions")):
                self.build_layers(self.w)          # the US splits into counties at the finer levels; those pieces start fresh
                self.w["detail"] = {}
                self.save()
        else:
            self.w = self.create(target_agents, seed)
            self.save()
        self.theta = self.load_theta()
        self.load_trade()
        try:
            self.mig_vars = json.load(open(os.path.join(HERE, "world", "migration_vars.json")))
        except (OSError, ValueError):
            self.mig_vars = {}
        try:
            hv = json.load(open(os.path.join(HERE, "world", "happiness_vars.json")))
            self.hard = {c: sum(b * hv.get(k, {}).get(c, 0.0) for k, b in HAPPY_PUSH.items()) for c in self.w["nations"]}
        except (OSError, ValueError):
            self.hard = {}
        self.open_epoch()
        self.opened = 0.0                     # after a restart, carry on right away

    # ------------------------------------------------------------------ setup
    def load_counties(self):
        """US county figures (world/us_counties_cdc.json); fetched once if missing (needs internet)."""
        path = os.path.join(HERE, "world", "us_counties_cdc.json")
        if not os.path.exists(path):
            try:
                sys.path.insert(0, os.path.join(HERE, "world"))
                import us_counties_data
                us_counties_data.main()
            except Exception as e:
                print(f"No US county data ({e}): the US runs as one country at every level.", flush=True)
                return {}
        try:
            C = json.load(open(path, encoding="utf-8"))["counties"]
        except (OSError, ValueError, KeyError):
            return {}
        C = {f: c for f, c in C.items() if c.get("pop", 0) > 0 and "pov150" in c and "unemp" in c}
        print(f"US counties: {len(C)} with figures, for the finer levels of detail", flush=True)
        return C

    def load_regions(self):
        """Regions of every country (world/regions.json); fetched once if missing (needs internet)."""
        path = os.path.join(HERE, "world", "regions.json")
        if not os.path.exists(path):
            try:
                sys.path.insert(0, os.path.join(HERE, "world"))
                import regions_data
                regions_data.main()
            except BaseException as e:
                print(f"No regional data ({e}): countries run whole at every level.", flush=True)
                return {}, []
        try:
            d = json.load(open(path, encoding="utf-8"))
        except (OSError, ValueError):
            return {}, []
        R = {}
        for r in d.get("gdl", []):
            if r.get("gni") and r.get("pop") and r["iso3"] != COUNTY_NATION:
                R.setdefault(r["iso3"], []).append(r)
        R = {c: sorted(v, key=lambda r: r["code"]) for c, v in R.items() if len(v) >= 2}
        print(f"Regions: {sum(len(v) for v in R.values())} in {len(R)} countries, for the finer levels of detail; "
              f"{sum(1 for r in d.get('oecd', []) if r.get('life_sat') is not None)} OECD regions to check against", flush=True)
        return R, d.get("oecd", [])

    def region_groups(self, c, total, min_agents):
        """A country's simulated people at one level, shared over its regions by population; a region too small for
        min_agents joins the next one. Returns [(code, agents, [GDL codes])]."""
        rs = self.regions[c]
        pop = sum(r["pop"] for r in rs) or 1
        out, cur, acc = [], [], 0.0
        for r in rs:
            cur.append(r["code"]); acc += total * r["pop"] / pop
            if acc >= min_agents:
                out.append((cur, acc)); cur, acc = [], 0.0
        if cur:
            if out:
                out[-1] = (out[-1][0] + cur, out[-1][1] + acc)
            else:
                out.append((cur, acc))
        return [(f"{c}#{i}", max(50, int(round(a))), codes) for i, (codes, a) in enumerate(out)]

    def gdl_feat(self, c, codes):
        """A group of regions' conditions: the country's own, moved by how far its income is from the country's."""
        n = self.w["nations"][c]
        base = dict(n["feat"])
        rs = {r["code"]: r for r in self.regions.get(c, [])}
        pop = sum(r["pop"] for r in rs.values())
        nat_gni = math.exp(sum(math.log(r["gni"]) * r["pop"] for r in rs.values()) / pop)
        g = [rs[k] for k in codes if k in rs]
        w = sum(r["pop"] for r in g) or 1
        gni = math.exp(sum(math.log(r["gni"]) * r["pop"] for r in g) / w)
        return dict(base, pov=round(max(-1.0, min(1.0, base["pov"] + (math.log(nat_gni) - math.log(gni)) / 2.0)), 4))

    def gdl_stress(self, c, codes):
        """Extra day-to-day stress for a group of regions where people live shorter lives than the country average."""
        rs = {r["code"]: r for r in self.regions.get(c, []) if r.get("lifexp")}
        if not rs:
            return 0.0
        pop = sum(r["pop"] for r in rs.values())
        nat = sum(r["lifexp"] * r["pop"] for r in rs.values()) / pop
        g = [rs[k] for k in codes if k in rs]
        if not g:
            return 0.0
        le = sum(r["lifexp"] * r["pop"] for r in g) / sum(r["pop"] for r in g)
        return round(HAPPY_PUSH.get("life_expectancy", 0.0) * max(-2.5, min(2.5, (nat - le) / LE_SD)), 4)

    def county_feat(self, fips_list):
        """A group of counties' conditions: the US's own, moved by how far the group is from the US average."""
        n = self.w["nations"][COUNTY_NATION]
        base = dict(n["feat"])
        C = self.counties
        if not hasattr(self, "_us_avg"):
            pop = sum(c["pop"] for c in C.values())
            avg = lambda k: sum(c[k] * c["pop"] for c in C.values() if k in c) / max(1, sum(c["pop"] for c in C.values() if k in c))
            urb = lambda c: 100 / (1 + math.exp(-1.3 * (math.log(max(0.1, c["pop"] / c["land_km2"])) - math.log(60)))) if c.get("land_km2") else None
            self._urb = urb
            self._us_avg = dict(pov150=avg("pov150"), unemp=avg("unemp"), age65=avg("age65"), broad=avg("broad"),
                                urban=sum(urb(c) * c["pop"] for c in C.values() if urb(c) is not None) / max(1, sum(c["pop"] for c in C.values() if urb(c) is not None)))
        A, cs = self._us_avg, [C[f] for f in fips_list if f in C]
        if not cs:
            return base
        w = sum(c["pop"] for c in cs)
        g = lambda k: sum(c.get(k, A[k]) * c["pop"] for c in cs) / w
        urbs = [(self._urb(c), c["pop"]) for c in cs if self._urb(c) is not None]
        urban = sum(u * p for u, p in urbs) / sum(p for _, p in urbs) if urbs else A["urban"]
        clip = lambda v, lo, hi: max(lo, min(hi, v))
        return dict(base,
                    pov=round(clip(base["pov"] + 0.4 * math.log(max(1.0, g("pov150")) / max(1.0, A["pov150"])), -1.0, 1.0), 4),
                    unemp=round(clip(base["unemp"] + (g("unemp") - A["unemp"]) / 8.0, -1.0, 1.5), 4),
                    dens=round(clip(base["dens"] + (urban - A["urban"]) / 35.0, -1.0, 1.0), 4),
                    young=round(clip(base["young"] - (g("age65") - A["age65"]) / 8.0, -1.0, 1.0), 4),
                    net=round(clip(base["net"] - (g("broad") - A["broad"]) / 35.0, -1.0, 1.0), 4))

    def region_feat(self, k, code):
        fs = (self.w.get("county_regions") or {}).get(str(k), {}).get(code)
        if fs is None:
            gc = (self.w.get("gdl_regions") or {}).get(str(k), {}).get(code)
            if gc is None:
                return self.w["nations"][code.split("#")[0]]["feat"]
            cache = self.__dict__.setdefault("_rfeat", {})
            if (k, code) not in cache:
                cache[(k, code)] = self.gdl_feat(code.split("#")[0], gc)
            return cache[(k, code)]
        cache = self.__dict__.setdefault("_rfeat", {})
        if (k, code) not in cache:
            cache[(k, code)] = self.county_feat(fs)
        return cache[(k, code)]

    def region_pressure(self, k, code):
        c = code.split("#")[0]
        p = self.pressure(self.w["nations"][c])
        gc = (self.w.get("gdl_regions") or {}).get(str(k), {}).get(code)
        if gc:
            cache = self.__dict__.setdefault("_rstress", {})
            if (k, code) not in cache:
                cache[(k, code)] = self.gdl_stress(c, gc)
            p = dict(p, stress=round(max(-9.5, min(9.5, p["stress"] + cache[(k, code)])), 4))
        return p

    def set_conflict_levels(self):
        """Once, for worlds made before conflicts had a size: today's real conflicts take their UCDP size
        (major at 1,000+ battle deaths a year); conflicts the simulation started count as minor."""
        try:
            today = json.load(open(os.path.join(HERE, "world", "today.json"), encoding="utf-8")).get("conflicts", {})
        except (OSError, ValueError):
            today = {}
        for c, n in self.w["nations"].items():
            if n.get("conflict"):
                x = today.get(c) or {}
                n["conflict_level"] = 2 if x.get("intensity") == 2 else 1
        self.w["conflict_levels"] = time.strftime("%Y-%m-%d")

    def repair_population(self):
        """Once, for worlds made before refugee flows were capped: an uncapped flight from war zones had emptied
        some countries (and overfilled their neighbours) far beyond anything real. Put every country back to its
        real share of today's simulated world population, keeping the world total."""
        src = os.path.join(self.engine_dir, "sim_data", "world", "nations.json")
        try:
            d = json.load(open(src, encoding="utf-8"))
        except (OSError, ValueError):
            return
        real = {n["iso3"]: float(n["pop"]) for n in d["nations"] if n.get("pop")}
        N = self.w["nations"]
        now = sum(n["pop"] for n in N.values()); base = sum(real.get(c, 0.0) for c in N)
        if now <= 0 or base <= 0:
            return
        moved = 0.0
        for c, n in N.items():
            if c in real:
                new = real[c] * now / base
                moved += abs(new - n["pop"]); n["pop"] = new
            n["mig_year"] = 0.0
        self.w["pop_fix_1"] = time.strftime("%Y-%m-%d")
        print(f"Population repaired after the refugee-flow fix: {moved / 2 / 1e6:,.0f} million people put back where they belong")

    def create(self, target_agents, seed):
        src = os.path.join(self.engine_dir, "sim_data", "world", "nations.json")
        if not os.path.exists(src):
            raise SystemExit("No world data yet: run  python world/world_data.py  first.")
        d = json.load(open(src, encoding="utf-8"))
        nations = [n for n in d["nations"] if n["iso3"] not in ("SCG", "ANT")]     # entities that no longer exist
        total = sum(n["pop"] for n in nations)
        scale = max(100, round(total / target_agents))
        rnd = random.Random(seed)
        N = {}
        for n in nations:
            r = random.Random("pol:" + n["iso3"])
            voice = float(n.get("voice", 0))
            if n.get("regime") is not None:       # Regimes of the World, when it downloaded
                gov = {0: "aut", 1: "hyb", 2: "dem", 3: "dem"}.get(int(n["regime"]), "hyb")
            else:
                gov = "dem" if voice > 0.3 else "aut" if voice < -0.75 else "hyb"
            pts = party_set(n["iso3"], n["region"], gov, r)
            title = office(n["iso3"], n["region"], gov)
            N[n["iso3"]] = dict(
                code=n["iso3"], num=n["num"], name=n["name"], region=n["region"], borders=[b for b in n["borders"]],
                pop=float(n["pop"]), agents=int(max(300, min(NATION_MAX, round(n["pop"] / scale)))),
                feat=WK.features(n), stats={k: n.get(k) for k in ("homicide", "suicide", "netmig", "gdp", "unemp", "gini", "happiness", "happiness_year")},
                demonym=n.get("demonym", ""), gov=gov, title=title, parties=pts, ruling=r.choice(pts) if gov == "dem" else "the ruling party",
                stab=max(0.05, min(0.95, 0.5 + float(n.get("stable", 0)) / 4)),
                next_election=r.randint(1, 48) if gov in ("dem", "hyb") else None,
                protests=0, crackdown=0, conflict=False, conflict_since=None, coup_recent=0, transition=None,
                rating=False, turnover=0, standoff=0, refugees_in=0.0, last=None, series=[])
        # a copy of the real world today: countries in armed conflict now start in conflict (world/today.json)
        today = {}
        try:
            today = json.load(open(os.path.join(HERE, "world", "today.json"), encoding="utf-8"))
        except (OSError, ValueError):
            print("No world/today.json: the world starts with every country at peace (run world/today_data.py).")
        start = time.localtime()
        for c, x in today.get("conflicts", {}).items():
            if c in N:
                N[c].update(conflict=True, conflict_since=-12 * max(0, start.tm_year - int(x.get("since", start.tm_year))),
                            conflict_level=2 if x.get("intensity") == 2 else 1)
        codes = sorted(N, key=lambda c: (N[c]["region"], -N[c]["pop"]))
        shards, cur, size = [], [], 0
        for c in codes:
            if size + N[c]["agents"] > SHARD_AGENTS and cur:
                shards.append(cur); cur, size = [], 0
            cur.append(c); size += N[c]["agents"]
        if cur:
            shards.append(cur)
        print(f"New world: {len(N)} nations, {total / 1e9:.2f} billion people, 1 simulated person = {scale:,} real, "
              f"{sum(n['agents'] for n in N.values()):,} simulated people in {len(shards)} shards")
        if today.get("conflicts"):
            print(f"Starting as today's real world: {sum(1 for n in N.values() if n['conflict'])} countries in armed conflict ({today.get('source')}).")
        w = dict(created=time.strftime("%Y-%m-%d"), epoch=0, scale=scale, seed=seed, data=d.get("meta", {}),
                 start=[start.tm_year, start.tm_mon], today=dict(source=today.get("source"), year=today.get("year")) if today else None,
                 nations=N, shards=shards, events=[], world_series=[])
        self.build_layers(w)
        return w

    def county_groups(self, total, min_agents):
        """The US's simulated people at one level, shared out over its counties by population; small counties
        are grouped with their neighbours in the same state (in FIPS order) until a group has min_agents.
        Returns [(code, agents, [fips...])]."""
        C = self.counties
        pop = sum(c["pop"] for c in C.values()) or 1
        out, cur, acc, prev_st = [], [], 0.0, None
        for f in sorted(C):
            st = f[:2]
            if cur and st != prev_st and acc >= min_agents / 2:
                out.append((cur, acc)); cur, acc = [], 0.0
            cur.append(f); acc += total * C[f]["pop"] / pop; prev_st = st
            if acc >= min_agents:
                out.append((cur, acc)); cur, acc = [], 0.0
        if cur:
            if out and acc < min_agents / 2:
                out[-1] = (out[-1][0] + cur, out[-1][1] + acc)
            else:
                out.append((cur, acc))
        return [(f"{COUNTY_NATION}#{i}", max(50, int(round(a))), fs) for i, (fs, a) in enumerate(out)]

    def build_layers(self, w):
        """Regions and pieces for the finer levels (worlds made before levels existed get them on load)."""
        N = w["nations"]
        codes = sorted(N, key=lambda c: (N[c]["region"], -N[c]["pop"]))
        layers = []
        w["county_regions"] = {}
        w["gdl_regions"] = {}
        for k, L in enumerate(LAYERS):
            if k == 0:
                continue
            pieces, cur, size = [], [], 0
            for c in codes:
                total = int(min(N[c]["agents"] * L["mult"], max(N[c]["agents"], N[c]["pop"] / 10)))
                if c == COUNTY_NATION and getattr(self, "counties", None):
                    groups = self.county_groups(total, max(400, L["piece"] // 250))     # at most ~250 regions in a piece
                    w["county_regions"][str(k)] = {code: fs for code, _, fs in groups}
                    regions = [(code, a) for code, a, _ in groups]
                elif c in (getattr(self, "regions", None) or {}) and total >= 200:
                    groups = self.region_groups(c, total, max(100, L["piece"] // 250))
                    w["gdl_regions"].setdefault(str(k), {}).update({code: codes for code, _, codes in groups})
                    regions = [(code, a) for code, a, _ in groups]
                else:
                    r = max(1, math.ceil(total / L["piece"]))
                    regions = [(f"{c}#{j}", total // r + (1 if j < total % r else 0)) for j in range(r)]
                for code, a in regions:
                    if a < 50:
                        continue
                    if size + a > L["piece"] and cur:
                        pieces.append(cur); cur, size = [], 0
                    cur.append([code, a]); size += a
            if cur:
                pieces.append(cur)
            layers.append(dict(name=L["name"], pieces=pieces))
        w["layers"] = layers
        w.setdefault("detail", {})
        print("Levels of detail: " + ", ".join(f"{x['name']} {sum(a for p in x['pieces'] for _, a in p):,} people in {len(x['pieces'])} pieces"
                                                for x in layers))

    def load_trade(self):
        """Trade openness and market size (World Bank, world/trade_data.py); estimated where there's no figure."""
        got = {}
        for f in ("trade.json", "economy.json"):
            try:
                for c, v in json.load(open(os.path.join(self.engine_dir, "sim_data", "world", f))).get("countries", {}).items():
                    got.setdefault(c, {}).update(v)
            except (OSError, ValueError):
                pass
        for c, n in self.w["nations"].items():
            t = got.get(c, {})
            lp = math.log10(max(1e4, n["pop"]) / 1e5)
            n["open"] = round(t.get("trade") or (25 + 200 * math.exp(-0.6 * max(0.0, lp))), 1)   # % of GDP: small countries trade more
            n["mktcap"] = t.get("mktcap")
            n["open_real"] = "trade" in t
            n["netmig_real"] = t.get("netmig")                  # real net migration, people a year (World Bank)
            rich = (n["stats"].get("gdp") or 3000) > 25000
            # where prices settle when nothing's going on: about 2% in rich democracies, more elsewhere
            anchor = 2.2 if rich and n["gov"] == "dem" else 3.5 if rich else 5.0 if n["gov"] in ("dem", "hyb") else 7.0
            usual_g = 2.0 if rich else 4.0
            e = n.get("econ")
            if not e:
                infl = t.get("infl")
                g = t.get("growth")
                n["econ"] = dict(infl=round(max(-2.0, min(60.0, infl if infl is not None else anchor)), 2),
                                 growth=round(max(-15.0, min(15.0, g if g is not None else usual_g)), 2),
                                 anchor=anchor, usual=usual_g, rate=round(anchor + 0.5, 2), stag=False, real=infl is not None)

    def load_theta(self):
        """Use the California calibration's weights where the names match; defaults for the rest."""
        p = os.path.join(self.engine_dir, "sim_data", "calibrated_weights.json")
        th = {}
        try:
            cal = json.load(open(p))
            cal = cal.get("weights", cal)
            for k, (lo, hi) in WK.WORLD_RANGES.items():
                if isinstance(cal.get(k), (int, float)):
                    th[k] = max(lo, min(hi, float(cal[k])))
        except (OSError, ValueError):
            pass
        return th

    def save(self):
        tmp = self.path + ".tmp"
        with open(tmp, "w", encoding="utf-8") as f:
            json.dump(self.w, f, separators=(",", ":"))
        os.replace(tmp, self.path)

    def shard_state_path(self, i):
        return os.path.join(STATE_DIR, f"shard_{i:03d}.b64")

    # ------------------------------------------------------------------ calendar
    def date(self, epoch=None):
        e = self.w["epoch"] if epoch is None else epoch
        months = ["January", "February", "March", "April", "May", "June", "July", "August", "September",
                  "October", "November", "December"]
        if self.w.get("start"):            # a world started as a copy of the real one runs on the real calendar
            m = self.w["start"][0] * 12 + self.w["start"][1] - 1 + e
            return f"{months[m % 12]} {m // 12}"
        return f"{months[e % 12]}, Year {e // 12 + 1}"

    # ------------------------------------------------------------------ jobs
    def open_epoch(self):
        self.opened = time.time()
        rnd = random.Random(self.w["seed"] * 31 + self.w["epoch"])
        # each piece needs one result, or two from different volunteers for a spot-check
        self.jobs = {i: dict(status="open", need=2 if rnd.random() < CHECK_SHARE else 1, done=[], assigned={}, result=None)
                     for i in range(len(self.w["shards"]))}
        self.djobs = {(k + 1, p): dict(assigned={}, result=None) for k, L in enumerate(self.w.get("layers", []))
                      for p in range(len(L["pieces"]))}
        self.recheck = {}                      # extra checks of finished Low pieces by devices with nothing else to do

    def shard_agents(self, i):
        return sum(self.w["nations"][c]["agents"] for c in self.w["shards"][i])

    def migrate(self, live):
        """Ordinary migration: each month some of the people who want to leave (outside war zones, where the
        refugee step above handles it) actually go. How many want to leave is the simulation's own answer;
        the world total each year is set to the real one (World Bank net arrivals), and they head mostly for
        richer countries, nearby ones, and the places migrants already go."""
        real_in = sum(max(0.0, n.get("netmig_real") or 0.0) for n in live)
        month_total = (real_in or 0.0007 * sum(n["pop"] for n in live)) / 12
        push = lambda c: math.exp(max(-3.0, min(3.0, sum(b * self.mig_vars.get(k, {}).get(c, 0.0) for k, b in MIG_PUSH.items()))))
        want = {n["code"]: n["pop"] * n["last"]["leave"] / 1000 / 12 * push(n["code"]) for n in live if n["last"] and not (n["conflict"] and n.get("conflict_level", 1) == 2)}
        k = month_total / (sum(want.values()) or 1)

        def pull(d):
            if (d["conflict"] and d.get("conflict_level", 1) == 2) or not d["last"]:
                return 0.0
            m = max(0.0, d.get("netmig_real") or 0.0) / 1000 + 0.02 * d["pop"] / 1e6 * (d["stats"].get("gdp") or 3000) / 10000
            return m * (0.3 if d.get("sanctions", 0) > 0 else 1.0)
        P = {d["code"]: pull(d) for d in live}
        for n in live:
            n["migrants_in"] = 0.0
            n.setdefault("mig_year", 0.0)
        for o in live:
            out = min(want.get(o["code"], 0.0) * k, o["pop"] * 0.002)
            if out <= 0:
                continue
            nb = set(o["borders"])
            ws = [(d, P[d["code"]] * (1.0 if d["code"] in nb else 0.45 if d["region"] == o["region"] else 0.15))
                  for d in live if d is not o and P[d["code"]] > 0]
            tot = sum(w for _, w in ws)
            if tot <= 0:
                continue
            o["pop"] -= out; o["mig_year"] -= out
            for d, w in ws:
                x = out * w / tot
                d["pop"] += x; d["mig_year"] += x; d["migrants_in"] += x / max(1.0, d["pop"])

    def fit_migration(self):
        """Once a simulated year: how the world's net migration by country compares with the real figures.
        Scored on the countries people really leave (real net migration below zero), because that's the
        simulation's own judgement; where they arrive leans on the real figures, so scoring it would flatter."""
        live = [n for n in self.w["nations"].values() if n["last"]]
        pts = []
        for n in live:
            n["mig_last"] = round(n.get("mig_year", 0.0) / max(1.0, n["pop"]) * 1000, 2)     # per 1,000 people a year
            if n.get("netmig_real") is not None and n["netmig_real"] < 0:
                pts.append((n["mig_last"], n["netmig_real"] / max(1.0, n["pop"]) * 1000))
            n["mig_year"] = 0.0
        if len(pts) < 15:
            return
        mx, my = sum(p[0] for p in pts) / len(pts), sum(p[1] for p in pts) / len(pts)
        sxy = sum((a - mx) * (b - my) for a, b in pts); sxx = sum((a - mx) ** 2 for a, _ in pts); syy = sum((b - my) ** 2 for _, b in pts)
        rank = lambda v: {i: r for r, i in enumerate(sorted(range(len(v)), key=lambda j: v[j]))}
        ra, rb = rank([p[0] for p in pts]), rank([p[1] for p in pts])
        nn = len(pts)
        rho = 1 - 6 * sum((ra[i] - rb[i]) ** 2 for i in range(nn)) / (nn * (nn * nn - 1))
        self.w["mig_fit"] = dict(r=round(sxy / math.sqrt(sxx * syy), 3) if sxx > 0 and syy > 0 else None, rank=round(rho, 3), n=nn)

    def pressure(self, n):
        p = dict(stress=getattr(self, "hard", {}).get(n["code"], 0.0), irr=0.0, leave=0.0, kind=0.0)
        if n["protests"] > 0:
            p["stress"] += 0.05; p["irr"] += 0.6; p["kind"] += 0.05
        if n["crackdown"] > 0:
            p["stress"] += 0.1; p["irr"] += 0.3
        if n["conflict"]:
            k = CONFLICT_WEIGHT[n.get("conflict_level", 1)]
            p["stress"] += 0.35 * k; p["irr"] += 0.8 * k; p["leave"] += 2.0 * k; p["kind"] += 0.25 * k
        if n["coup_recent"] > 0:
            p["stress"] += 0.12; p["leave"] += 0.5
        if n["turnover"] > 0:
            p["stress"] -= 0.03
        if n["standoff"] > 0:
            p["stress"] += 0.03
        if n["refugees_in"] > 0.002:
            p["stress"] += min(0.08, n["refugees_in"] * 10)
        if n.get("migrants_in", 0) > 0.0005:            # many newcomers in one month strain housing and jobs a little
            p["stress"] += min(0.03, n["migrants_in"] * 20)
        if n.get("sanctions", 0) > 0:                  # sanctions: shortages, lost jobs, people looking to leave
            p["stress"] += 0.05; p["leave"] += 0.3
        if n.get("tariff", 0) > 0:
            p["stress"] += 0.012
        ec = n.get("econ") or {}
        if ec.get("infl", 0) > 4:                       # rising prices: the cost of living squeezes everyone
            p["stress"] += min(0.12, (ec["infl"] - 4) / 100 * 1.2)
        if ec.get("stag"):
            p["stress"] += 0.03
        if ec.get("growth", 1) < -1:                    # a shrinking economy: lost jobs
            p["stress"] += min(0.06, -ec["growth"] / 100 * 1.5)
        r = (n.get("mkt") or {}).get("r", 0.0)          # a falling market: savings and jobs on the line
        if r < -0.05:
            p["stress"] += min(0.06, -r * 0.3 * (0.3 + 0.7 * n.get("rich", 0.5)))
        return {k: round(v, 4) for k, v in p.items()}

    def job_for(self, worker_id, cap=None):
        """A world piece for this worker (no bigger than `cap` simulated people), or None.
        A piece being spot-checked goes to two different volunteers. Stale assignments go to the next asker."""
        with self.lock:
            now = time.time()
            self.maybe_close(now)
            # with too few volunteers online, a spot check can't find a second device: don't let it hold the month up
            waited = False
            for j in self.jobs.values():
                if (j["status"] != "done" and j["done"] and not {w: t for w, t in j["assigned"].items() if now - t < STALE_SECS}
                        and now - j.get("t_first", now) > CHECK_WAIT):
                    j.update(status="done", result=j["done"][0][1], unchecked=True)
                    waited = True
            if waited:
                self.maybe_close(now)
            order = sorted(self.jobs, key=lambda i: (len(self.jobs[i]["done"]) > 0, i))   # unstarted pieces first
            for i in order:
                j = self.jobs[i]
                if j["status"] == "done":
                    continue
                j["assigned"] = {w: t for w, t in j["assigned"].items() if now - t < STALE_SECS}
                if worker_id in j["assigned"] or any(w == worker_id for w, _ in j["done"]):
                    continue
                if len(j["done"]) + len(j["assigned"]) >= j["need"]:
                    continue
                if cap and self.shard_agents(i) > cap:
                    continue
                if True:
                    j["assigned"][worker_id] = now
                    N = self.w["nations"]
                    sp = self.shard_state_path(i)
                    state = open(sp).read() if os.path.exists(sp) else None
                    payload = dict(nations=[dict(code=c, agents=N[c]["agents"], feat=N[c]["feat"], pressure=self.pressure(N[c]))
                                            for c in self.w["shards"][i]],
                                   theta=self.theta, days=EPOCH_DAYS, seed=self.w["seed"] * 1_000_003 + self.w["epoch"] * 1009 + i,
                                   state=state)
                    return dict(id=f"w{self.w['epoch']}.{i}", kind="world", payload=payload)
            return self.detail_for(worker_id, cap, now) or self.recheck_for(worker_id, cap, now)

    def low_done(self):
        return all(x["status"] == "done" for x in self.jobs.values())

    def maybe_close(self, now=None):
        """The month turns once every Low piece is in and the world's pace allows; the finer levels fill the wait."""
        now = now or time.time()
        if self.low_done() and now - self.opened >= self.month_secs:
            self.advance()
            return True
        return False

    def piece_nations(self, k, p):
        return self.w["layers"][k - 1]["pieces"][p]

    def detail_for(self, worker_id, cap, now):
        """The finest detail piece this device can run (its own pieces first: it holds their state)."""
        if not self.djobs:
            return None
        e, D = self.w["epoch"], self.w["detail"]
        best = None
        for (k, p), j in self.djobs.items():
            if j["result"] is not None:
                continue
            j["assigned"] = {w: t for w, t in j["assigned"].items() if now - t < STALE_SECS}
            if j["assigned"]:
                continue
            size = sum(a for _, a in self.piece_nations(k, p))
            if cap and size > cap:
                continue
            rec = D.get(f"{k}.{p}") or {}
            mine = rec.get("holder") == worker_id and rec.get("epoch") == e - 1
            if not mine and rec.get("holder") and rec.get("epoch") == e - 1 and now - self.opened < HOLD_SECS:
                continue                       # its holder may still come for it
            rank = (mine, k, -p)
            if best is None or rank > best[0]:
                best = (rank, k, p, mine)
        if not best:
            return None
        _, k, p, mine = best
        self.djobs[(k, p)]["assigned"][worker_id] = now
        N = self.w["nations"]
        nations = [dict(code=code, agents=a, feat=self.region_feat(k, code), pressure=self.region_pressure(k, code))
                   for code, a in self.piece_nations(k, p)]
        payload = dict(nations=nations, theta=self.theta, days=EPOCH_DAYS,
                       seed=self.w["seed"] * 1_000_003 + e * 1009 + 100_000 * k + p, state=None,
                       piece=f"L{k}.{p}", resume=f"L{k}.{p}@{e - 1}" if mine else None, level=LAYERS[k]["name"])
        return dict(id=f"w{e}.L{k}.{p}", kind="world", payload=payload)

    def recheck_for(self, worker_id, cap, now):
        """Nothing left at any level: re-run a finished Low piece as an extra check on whoever ran it."""
        for i, j in self.jobs.items():
            if j["status"] != "done" or (cap and self.shard_agents(i) > cap):
                continue
            if any(w == worker_id for w, _ in j["done"]) or i in self.recheck:
                continue
            self.recheck[i] = (worker_id, now)
            N = self.w["nations"]
            sp = self.shard_state_path(i)
            state = open(sp).read() if os.path.exists(sp) else None
            payload = dict(nations=[dict(code=c, agents=N[c]["agents"], feat=N[c]["feat"], pressure=self.pressure(N[c]))
                                    for c in self.w["shards"][i]],
                           theta=self.theta, days=EPOCH_DAYS, seed=self.w["seed"] * 1_000_003 + self.w["epoch"] * 1009 + i,
                           state=state)
            return dict(id=f"w{self.w['epoch']}.{i}", kind="world", payload=payload)
        return None

    def job_agents(self, job_id):
        """How many simulated people a world job had (for kudos)."""
        try:
            parts = job_id[1:].split(".")
            if len(parts) == 3:
                return sum(a for _, a in self.piece_nations(int(parts[1][1:]), int(parts[2])))
            return self.shard_agents(int(parts[1]))
        except Exception:
            return 0

    def submit_detail(self, worker_id, e, k, p, out):
        if (k, p) not in self.djobs:
            return dict(error="no such piece"), 400
        j = self.djobs[(k, p)]
        if j["result"] is not None or worker_id not in j["assigned"]:
            return dict(error="that piece isn't assigned to you (it may have timed out)"), 409
        codes = [c for c, _ in self.piece_nations(k, p)]
        res = (out or {}).get("nations")
        if not isinstance(res, dict) or set(res) != set(codes):
            return dict(error="result rejected: wrong regions"), 400
        for c, v in res.items():
            try:
                ok = (0 <= v["happy"] <= 10 and 0 <= v["civ"] <= 1 and 0 <= v["stress"] <= 3.5 and 0 <= v["irr"] <= 4
                      and 0 <= v["conn"] <= 1.01 and 0 <= v["leave"] < 1e5)
            except (KeyError, TypeError):
                ok = False
            if not ok:
                return dict(error=f"result rejected: numbers for {c} out of range"), 400
        del j["assigned"][worker_id]
        j["result"] = res
        key = f"{k}.{p}"
        rec = self.w["detail"].get(key) or {}
        resumed = bool((out or {}).get("resumed")) and rec.get("holder") == worker_id and rec.get("epoch") == e - 1
        self.w["detail"][key] = dict(holder=worker_id, epoch=e, age=(rec.get("age", 0) + 1) if resumed else 1)
        adv = self.maybe_close()
        return dict(ok=True, month=self.date(e), world_advanced=adv, level=LAYERS[k]["name"],
                    note=None if resumed else "a fresh start at this level: it counts after a few months on this device"), 200

    def submit_recheck(self, worker_id, i, out):
        """An extra check of a finished Low piece: agreeing earns trust for both, disagreeing costs the checker."""
        mine = self.recheck.get(i)
        if not mine or mine[0] != worker_id:
            return dict(error="that check isn't assigned to you"), 409
        j = self.jobs[i]
        res = (out or {}).get("nations")
        if not isinstance(res, dict) or set(res) != set(self.w["shards"][i]):
            return dict(error="result rejected: wrong nations"), 400
        ok = self.agree(i, j["result"], dict(nations=res))
        first = j["done"][0][0]
        trust = {worker_id: 1, first: 1} if ok else {worker_id: -1}
        return dict(ok=True, month=self.date(), world_advanced=self.maybe_close(), trust=trust,
                    note="checked: matched another volunteer's run" if ok else "didn't match the first run"), 200

    def submit(self, worker_id, job_id, out):
        with self.lock:
            parts = job_id[1:].split(".")
            try:
                if len(parts) == 3:
                    e, k, p = int(parts[0]), int(parts[1][1:]), int(parts[2])
                else:
                    e, i = int(parts[0]), int(parts[1])
            except (ValueError, IndexError):
                return dict(error="bad world job id"), 400
            if e != self.w["epoch"]:
                return dict(error="that month is already finished"), 409
            if len(parts) == 3:
                return self.submit_detail(worker_id, e, k, p, out)
            if i not in self.jobs:
                return dict(error="bad world job id"), 400
            if self.jobs[i]["status"] == "done" and i in self.recheck:
                return self.submit_recheck(worker_id, i, out)
            j = self.jobs[i]
            if j["status"] == "done" or worker_id not in j["assigned"]:
                return dict(error="that piece isn't assigned to you (it may have timed out)"), 409
            codes = self.w["shards"][i]
            res = (out or {}).get("nations")
            if not isinstance(res, dict) or set(res) != set(codes):
                return dict(error="result rejected: wrong nations"), 400
            for c, v in res.items():
                try:
                    ok = (0 <= v["happy"] <= 10 and 0 <= v["civ"] <= 1 and 0 <= v["stress"] <= 3.5 and 0 <= v["irr"] <= 4 and 0 <= v["conn"] <= 1.01
                          and 0 <= v["leave"] < 1e5)
                except (KeyError, TypeError):
                    ok = False
                if not ok:
                    return dict(error=f"result rejected: numbers for {c} out of range"), 400
            st = (out or {}).get("state")
            if not isinstance(st, str) or len(st) > 80_000_000:
                return dict(error="result rejected: no state"), 400
            try:
                import torch
                s = WK.unpack_state(st, torch.device("cpu"))
                if s["trait"].numel() != sum(self.w["nations"][c]["agents"] for c in codes):
                    raise ValueError
            except Exception:
                return dict(error="result rejected: state doesn't match the shard"), 400
            del j["assigned"][worker_id]
            j["done"].append((worker_id, dict(nations=res, state=st)))
            j.setdefault("t_first", time.time())
            trust, note = self.settle(i, j)
            done = self.maybe_close()
            return dict(ok=True, month=self.date(e), world_advanced=done, note=note, trust=trust), 200

    def agree(self, i, a, b):
        """Two runs of the same piece from the same start, with different random draws (and maybe different
        hardware or code: GPU, CPU, a phone's browser): do they tell the same story?"""
        bad = 0
        codes = self.w["shards"][i]
        for c in codes:
            n = max(50, self.w["nations"][c]["agents"])
            x, y = a["nations"][c], b["nations"][c]
            if abs(x["happy"] - y["happy"]) > 0.15 + 6 / math.sqrt(n) or abs(x["civ"] - y["civ"]) > 0.01 + 0.8 / math.sqrt(n):
                bad += 1
        return bad <= max(1, len(codes) // 10)

    def settle(self, i, j):
        """Decide a piece once it has its results. Returns trust changes {worker: +n/-n} and a note."""
        if len(j["done"]) < j["need"]:
            return {}, None
        if j["need"] == 1:
            j.update(status="done", result=j["done"][0][1])
            return {}, None
        runs = j["done"]
        if len(runs) == 2:
            if self.agree(i, runs[0][1], runs[1][1]):
                j.update(status="done", result=runs[0][1])
                return {runs[0][0]: 1, runs[1][0]: 1}, "checked: matched another volunteer's run"
            j["need"] = 3                      # a third volunteer settles it
            return {}, None
        # three runs: keep the one the others agree with; anyone who disagrees with both loses trust
        ok = [k for k in range(3) if sum(self.agree(i, runs[k][1], runs[m][1]) for m in range(3) if m != k) >= 1]
        pick = ok[0] if ok else 0
        j.update(status="done", result=runs[pick][1])
        return {runs[k][0]: (1 if k in ok else -2) for k in range(3)}, None

    # ------------------------------------------------------------------ the month's politics
    def advance(self):
        W, N = self.w, self.w["nations"]
        e = W["epoch"]
        rnd = random.Random(W["seed"] * 7919 + e)
        for i, j in self.jobs.items():
            with open(self.shard_state_path(i) + ".tmp", "w") as f:
                f.write(j["result"]["state"])
            os.replace(self.shard_state_path(i) + ".tmp", self.shard_state_path(i))
            for c, v in j["result"]["nations"].items():
                N[c]["last"] = v
                N[c]["detail"] = 0
        self.apply_detail(N)
        live = [n for n in N.values() if n["last"]]
        wsum = sum(n["pop"] for n in live) or 1
        mean_stress = sum(n["last"]["stress"] * n["pop"] for n in live) / wsum
        mean_unciv = sum((1 - n["last"]["civ"]) * n["pop"] for n in live) / wsum
        mean_irr = sum(n["last"]["irr"] * n["pop"] for n in live) / wsum
        date = self.date(e)
        events = []

        def say(n, kind, text):
            text = text[0].upper() + text[1:]
            events.append([e, date, n["code"] if n else "", n["name"] if n else "", kind, text])

        def draw(kind, weight, eligible):
            """Spread the world's yearly total for this kind of event over nations by risk."""
            cand = [(n, weight(n)) for n in live if eligible(n)]
            tot = sum(w for _, w in cand) or 1
            hits = []
            for n, w in cand:
                if rnd.random() < monthly(PER_YEAR[kind] * w / tot):
                    hits.append(n)
            return hits

        dz = lambda n: n["last"]["stress"] - mean_stress
        # countdowns
        for n in live:
            for k in ("protests", "crackdown", "coup_recent", "turnover", "standoff"):
                n[k] = max(0, n[k] - 1)
            n["stab"] += 0.02 * (0.55 - n["stab"]) - 0.04 * max(0.0, dz(n))
        # protest waves
        for n in draw("protest", lambda n: {"dem": 1.2, "hyb": 1.0, "aut": 0.5, "mil": 0.7}[n["gov"]]
                      * math.exp(3 * dz(n) + 1.5 * (n["last"]["irr"] - mean_irr) + 0.5 * n["feat"]["net"]
                                 + 0.05 * max(0.0, (n.get("econ") or {}).get("infl", 0) - 5)),
                      lambda n: n["protests"] == 0):
            n["protests"] = rnd.randint(1, 6); n["stab"] -= 0.08
            say(n, "PROTEST", f"Mass protests spread through cities in {the(n['name'])} over the cost of living and public services.")
            # how governments answer protests, from the Mass Mobilization data (protests against governments in 162
            # countries, 1990-2020): police break up or arrest protesters in about a quarter of protests even in
            # democracies, and more often the less free the government; deadly force is rare outside autocracies.
            # Tested on half the countries and scored on the other half (see the Model lab); the countries' V-Dem
            # repression scores added nothing on top of the kind of government.
            u = rnd.random()
            if u < CRACK_DEADLY[n["gov"]]:
                n["crackdown"] = 3; n["stab"] -= 0.05
                say(n, "CRACKDOWN", f"Security forces in {the(n['name'])} fire on protesters; there are deaths, and hundreds are detained.")
            elif u < CRACK_ANY[n["gov"]]:
                n["stab"] -= 0.02
                say(n, "CRACKDOWN", f"Police in {the(n['name'])} break up the protests and make arrests.")
        # coup attempts
        for n in draw("coup", lambda n: {"dem": 0.08, "hyb": 1.0, "aut": 0.7, "mil": 1.3}[n["gov"]]
                      * math.exp(1.2 * n["feat"]["pov"] + 2.0 * (0.5 - n["stab"]) + 0.8 * (n["protests"] > 0)
                                 + 1.0 * n["conflict"] + 2.5 * dz(n)),
                      lambda n: True):
            n["coup_recent"] = 6; n["stab"] -= 0.15
            if rnd.random() < 0.5:
                old = n["title"]
                n.update(gov="mil", title="military council", ruling="the armed forces", next_election=None,
                         transition=e + rnd.randint(18, 48))
                say(n, "COUP", f"Coup in {the(n['name'])}: " + ("rival officers depose the military council and install their own." if old == "military council"
                    else f"officers seize power and detain the {old}. A military council takes charge and promises elections."))
            else:
                say(n, "COUP", f"Coup attempt fails in {the(n['name'])}; loyal troops put it down and the {n['title']} stays in office.")
        # civil conflict
        for n in draw("conflict", lambda n: {"dem": 0.4, "hyb": 1.2, "aut": 0.8, "mil": 1.4}[n["gov"]]
                      * math.exp(1.3 * n["feat"]["pov"] + 1.5 * (0.5 - n["stab"]) + 0.6 * n["feat"]["ineq"]
                                 + 0.7 * (n["coup_recent"] > 0) + 2.0 * dz(n) + 0.4 * math.log(max(1e5, n["pop"]) / 1e7)),
                      lambda n: not n["conflict"]):
            n.update(conflict=True, conflict_since=e, conflict_level=1); n["stab"] -= 0.2
            say(n, "CONFLICT", f"Armed conflict breaks out in {the(n['name'])} between government forces and an insurgent coalition.")
        for n in live:
            if n["conflict"] and n["conflict_since"] != e and rnd.random() < CONFLICT_END_M * (1.5 if n["stab"] > 0.4 else 1):
                n["conflict"] = False
                yrs = max(1, (e - n['conflict_since']) // 12)
                say(n, "PEACE", f"A ceasefire holds in {the(n['name'])} after {yrs} year{'s' if yrs != 1 else ''} of fighting.")
        # refugees: people leaving conflict zones go to neighbors
        for n in live:
            n["refugees_in"] = 0.0
            n.setdefault("mig_year", 0.0)
        for n in live:
            if n["conflict"]:
                out = n["pop"] * min(n["last"]["leave"], REFUGEE_CAP[n.get("conflict_level", 1)]) / 1000 / 12
                nb = [N[b] for b in n["borders"] if b in N]
                if nb and out > 0:
                    n["pop"] -= out; n["mig_year"] = n.get("mig_year", 0.0) - out
                    for m in nb:
                        m["pop"] += out / len(nb); m["refugees_in"] += out / len(nb) / max(1, m["pop"])
                        m["mig_year"] = m.get("mig_year", 0.0) + out / len(nb)
        self.migrate(live)
        # border standoffs and wars between neighbors
        pairs = []
        for n in live:
            for b in n["borders"]:
                if b in N and n["code"] < b:
                    pairs.append((n, N[b]))
        if pairs:
            ws = [math.exp(1.5 * ((1 - a["stab"]) + (1 - b["stab"])) + 1.0 * (a["gov"] != "dem") + 1.0 * (b["gov"] != "dem")
                           + 1.5 * (dz(a) + dz(b))) * (0.05 if a["gov"] == b["gov"] == "dem" else 1) for a, b in pairs]
            tot = sum(ws)
            for (a, b), w in zip(pairs, ws):
                if rnd.random() < monthly(PER_YEAR["standoff"] * w / tot):
                    a["standoff"] = b["standoff"] = 4
                    say(a, "BORDER", f"Troops mass on the border between {the(a['name'])} and {the(b['name'])} after a disputed incident.")
                    if rnd.random() < PER_YEAR["war"] / PER_YEAR["standoff"]:
                        for x in (a, b):
                            x.update(conflict=True, conflict_since=e, conflict_level=2); x["stab"] -= 0.15
                        say(a, "WAR", f"Fighting breaks out between {the(a['name'])} and {the(b['name'])}.")
        # elections
        for n in live:
            if n["next_election"] is not None and e >= n["next_election"]:
                lose = 1 / (1 + math.exp(-(-0.4 + 4 * dz(n) + 3 * ((1 - n["last"]["civ"]) - mean_unciv) + 0.5 * (n["protests"] > 0))))
                if n["gov"] == "hyb":
                    lose *= 0.25
                if rnd.random() < lose:
                    old = n["ruling"]
                    others = [p for p in n["parties"] if p != old] or ["the opposition"]
                    n["ruling"] = rnd.choice(others) if n["gov"] == "dem" else "the ruling party"   # the winners become the new ruling party
                    n["turnover"] = 6; n["stab"] += 0.03
                    say(n, "ELECTION", f"{the(n['name'])} votes out {old}: {n['ruling']} win, and their leader becomes {n['title']}." if n["gov"] == "dem"
                        else f"Upset in {the(n['name'])}: the opposition alliance wins despite a tilted race, and its candidate becomes {n['title']}.")
                else:
                    say(n, "ELECTION", f"{the(n['name'])} re-elects {n['ruling']}" + (" amid claims of a tilted vote." if n["gov"] == "hyb" else "."))
                n["next_election"] = e + (rnd.choice([48, 60]) if n["gov"] == "dem" else 72)
        # regime change: transitions, backsliding, opening up
        for n in live:
            if n["gov"] == "mil" and n["transition"] is not None and e >= n["transition"]:
                if rnd.random() < 0.5:
                    n.update(gov="hyb", title=office(n["code"], n["region"], "hyb"), parties=["the ruling party", "the opposition alliance"],
                             ruling="the ruling party", next_election=e + 60, transition=None)
                    say(n, "TRANSITION", f"{the(n['name'])} returns to civilian rule: a new {n['title']} is sworn in after the first vote since the coup.")
                else:
                    n["transition"] = e + 24
                    say(n, "TRANSITION", f"{the(n['name'])}'s transitional council postpones the promised elections by two years.")
            elif n["gov"] == "dem" and n["stab"] < 0.3 and dz(n) > 0.05 and rnd.random() < 0.005:
                n["gov"] = "hyb"
                n["parties"] = ["the ruling party", "the opposition alliance"]; n["ruling"] = "the ruling party"
                say(n, "BACKSLIDING", f"The {n['title']} of {the(n['name'])} suspends parts of the constitution, citing unrest.")
            elif n["gov"] == "aut" and n["protests"] > 0 and rnd.random() < 0.01:
                n.update(gov="hyb", next_election=e + 12, parties=["the ruling party", "the opposition alliance"])
                say(n, "OPENING", f"After months of protest, {the(n['name'])} announces its first competitive elections.")
            elif n["gov"] == "hyb" and n["stab"] > 0.7 and dz(n) < 0 and rnd.random() < 0.003:
                n.update(gov="dem", parties=party_set(n["code"], n["region"], "dem", rnd)); n["ruling"] = rnd.choice(n["parties"])
                say(n, "OPENING", f"Courts and press in {the(n['name'])} win new independence; observers call it a full democracy.")
        self.markets_tick(e, date, rnd, live, dz, say, events)
        for n in live:
            n["stab"] = max(0.02, min(0.98, n["stab"]))
            n["series"] = (n["series"] + [[e, round(n["last"]["civ"], 4), round(n["last"]["stress"], 3)]])[-240:]
        if e % 12 == 0 or "happy_fit" not in W:
            self.fit_happiness()
        if e % 12 == 0:
            self.fit_migration()
        hw = sum(self.happiness(n) * n["pop"] for n in live) / wsum
        W["world_series"] = (W["world_series"] + [[e, round(hw, 3), round(mean_stress, 3),
                                                     sum(1 for n in live if n["conflict"]), sum(1 for n in live if n["rating"])]])[-600:]
        W["events"] = (W["events"] + events)[-3000:]
        W["epoch"] = e + 1
        self.save()
        self.open_epoch()
        print(f"World: {date} done, {len(events)} headline(s). Now {self.date()}.", flush=True)

    # ------------------------------------------------------------------ markets and trade
    def partners(self, n):
        """Who a country trades with most: its neighbors and the biggest economies of its region, weighted by
        the trade laws between them (deals bring them closer, tariffs and sanctions push them apart)."""
        N, T = self.w["nations"], self.w.setdefault("trade_w", {})
        if not hasattr(self, "_big"):
            self._big = {}
            for m in N.values():
                self._big.setdefault(m["region"], []).append(m)
            for r in self._big:
                self._big[r] = sorted(self._big[r], key=lambda m: -m["pop"] * (m["stats"].get("gdp") or 5000))[:4]
        out = {}
        for b in n["borders"]:
            if b in N:
                out[b] = 1.0
        for m in self._big.get(n["region"], []):
            if m["code"] != n["code"]:
                out[m["code"]] = out.get(m["code"], 0) + 0.6
        for b in list(out):
            out[b] *= T.get("|".join(sorted((n["code"], b))), 1.0)
        return out

    def markets_tick(self, e, date, rnd, live, dz, say, events):
        W, N = self.w, self.w["nations"]
        T = W.setdefault("trade_w", {})
        gd = sorted((n["stats"].get("gdp") or 3000) for n in N.values())
        for n in N.values():
            n["rich"] = round(sum(1 for x in gd if x <= (n["stats"].get("gdp") or 3000)) / len(gd), 3)
            n.setdefault("mkt", dict(i=1000.0, h=[], r=0.0))
            for k in ("tariff", "sanctions"):
                n[k] = max(0, n.get(k, 0) - 1)
        econ = lambda n: n["pop"] * (n["stats"].get("gdp") or 3000)

        def pick(cands, weight):
            cands = [(x, weight(x)) for x in cands]
            tot = sum(w for _, w in cands)
            if tot <= 0:
                return None
            r = rnd.random() * tot
            for x, w in cands:
                r -= w
                if r <= 0:
                    return x
            return cands[-1][0]

        def link(a, b, mult):
            key = "|".join(sorted((a["code"], b["code"])))
            T[key] = round(max(0.1, min(2.0, T.get(key, 1.0) * mult)), 3)

        # ---- trade laws
        pairs = [(n, N[b]) for n in live for b in self.partners(n) if b in N and n["code"] < b]
        for _ in range(3):
            if pairs and rnd.random() < TRADE_PER_YEAR["tariff"] / 12 / 3:
                a, b = pick(pairs, lambda p: math.sqrt(econ(p[0]) * econ(p[1])) * math.exp(2 * (dz(p[0]) + dz(p[1]))))
                if rnd.random() < 0.5:
                    a, b = b, a
                a["tariff"] = b["tariff"] = 12; link(a, b, 0.7)
                say(a, "TARIFF", f"{the(a['name'])} raises tariffs on imports from {the(b['name'])}, saying jobs at home come first. "
                                 f"{cap(the(b['name']))} promises to respond.")
            if pairs and rnd.random() < TRADE_PER_YEAR["deal"] / 12 / 3:
                a, b = pick(pairs, lambda p: math.sqrt(econ(p[0]) * econ(p[1])) * (p[0]["stab"] + p[1]["stab"])
                            * (2 if p[0]["gov"] == p[1]["gov"] == "dem" else 1))
                link(a, b, 1.3)
                say(a, "DEAL", f"{the(a['name'])} and {the(b['name'])} sign a trade agreement cutting tariffs on most goods.")
        if rnd.random() < monthly(TRADE_PER_YEAR["sanctions"]):
            tgt = pick([n for n in live if not n.get("sanctions")],
                       lambda n: (3 if n["coup_recent"] else 0) + (2 if n["conflict"] else 0) + (1.5 if n["gov"] in ("aut", "mil") else 0.05)
                       + (2 if n["crackdown"] else 0))
            big = [m for m in sorted(live, key=lambda m: -econ(m))[:12] if m["gov"] == "dem" and tgt and m["code"] != tgt["code"]]
            if tgt and big:
                by = rnd.choice(big)
                tgt["sanctions"] = rnd.randint(12, 36)
                for m in big[:5]:
                    link(m, tgt, 0.3)
                why = ("after the coup" if tgt["coup_recent"] else "over the fighting" if tgt["conflict"]
                       else "over the crackdown on protesters" if tgt["crackdown"] else "over its treatment of the opposition")
                say(tgt, "SANCTIONS", f"{the(by['name'])} and its allies impose sanctions on {the(tgt['name'])} {why}, freezing state assets "
                                      f"and cutting off most trade.")
        for n in live:
            if n.get("sanctions") == 1:
                say(n, "TRADE", f"Sanctions on {the(n['name'])} are lifted; trade starts to recover.")
        if rnd.random() < monthly(TRADE_PER_YEAR["export_ban"]):
            n = pick(live, lambda n: math.exp(3 * dz(n) + 1.2 * n["feat"]["pov"]) * math.sqrt(n["pop"]))
            if n:
                say(n, "BAN", f"{the(n['name'])} bans exports of {rnd.choice(GOODS)} to keep prices down at home; buyers abroad scramble.")
                for b in self.partners(n):
                    if b in N:
                        N[b]["mkt"]["_ban"] = True

        # ---- prices and growth
        spike = 0.0
        if rnd.random() < monthly(ECON["energy_spike"]):
            spike = rnd.uniform(2.0, 5.0)
            say(None, "ECONOMY", rnd.choice(["Energy prices spike worldwide after supply cuts; fuel and heating bills jump.",
                                               "Oil and gas prices surge as shipping routes are disrupted; prices rise everywhere."]))
        elif rnd.random() < monthly(ECON["food_spike"]):
            spike = rnd.uniform(0.8, 2.0)
            say(None, "ECONOMY", "Poor harvests send world food prices to their highest in years.")
        hit_infl, news = {}, []
        for ev in events:
            if ev[2] and ev[4] in ("CONFLICT", "WAR", "COUP"):
                hit_infl[ev[2]] = hit_infl.get(ev[2], 0) + rnd.uniform(2, 6)
            if ev[2] and ev[4] == "SANCTIONS":
                hit_infl[ev[2]] = hit_infl.get(ev[2], 0) + rnd.uniform(5, 15)     # the currency collapses
            if ev[2] and ev[4] in ("TARIFF", "BAN"):
                hit_infl[ev[2]] = hit_infl.get(ev[2], 0) + rnd.uniform(0.2, 0.8)
        for n in live:
            ec = n.setdefault("econ", dict(infl=4.0, growth=3.0, anchor=4.0, usual=3.0, rate=4.5, stag=False, real=False))
            poor = 1 - n.get("rich", 0.5)
            # prices drift back toward their usual level; shocks hit importers and poorer countries harder
            shock = spike * (0.6 + 0.8 * poor) * (0.7 + 0.6 * min(1.5, n.get("open", 50) / 100)) + hit_infl.get(n["code"], 0.0)
            pull = 0.06 if n["gov"] == "dem" else 0.035                 # independent central banks pull it back faster
            # two parts: the underlying rate (slow to move, slow to come back) and price shocks that fade within a year or so
            base = ec.get("base", ec["infl"]); tmp = ec.get("tmp", 0.0)
            persistent = (0.6 if n.get("sanctions") else 0) + (0.3 if n["conflict"] else 0)
            base = base + pull * (ec["anchor"] + 20 * persistent - base) + rnd.gauss(0, 0.15 + 0.25 * poor)
            tmp = tmp * 0.85 + shock - persistent
            infl = base + tmp
            # the central bank answers inflation with rates; high rates slow the economy a few months later
            rate = ec["anchor"] + 0.5 + 1.5 * (infl - ec["anchor"]) if n["gov"] == "dem" else ec["anchor"] + 0.5 + 0.8 * (infl - ec["anchor"])
            rate = max(0.0, min(60.0, rate))
            g = ec["growth"] + 0.08 * (ec["usual"] - ec["growth"]) - 0.04 * max(0.0, rate - ec["anchor"] - 1.5) + rnd.gauss(0, 0.3)
            g -= 0.4 if n["conflict"] else 0
            g -= 0.3 if n.get("sanctions") else 0
            g -= 0.15 * spike * (0.5 + poor)
            g -= 0.2 if n["coup_recent"] else 0
            infl, g = max(-3.0, min(400.0, infl)), max(-20.0, min(15.0, g))
            was = ec.get("stag", False)
            stag = infl >= max(ECON["stag_infl"], ec["anchor"] + 3) and g <= ECON["stag_growth"]
            big = econ(n)
            if stag and not was:
                news.append((big, n, f"Stagflation in {the(n['name'])}: prices are up {infl:.0f}% on a year ago while the economy stalls."))
            elif infl >= 20 and ec["infl"] < 20:
                news.append((big, n, f"Inflation in {the(n['name'])} passes {int(infl // 5 * 5)}%; the central bank raises rates to {rate:.0f}%."))
            elif g < -1.5 and ec["growth"] >= -1.5:
                news.append((big, n, f"{cap(the(n['name']))} falls into recession."))
            ec.update(infl=round(infl, 2), growth=round(g, 2), rate=round(rate, 2), stag=stag, base=round(base, 3), tmp=round(tmp, 3))
        for _, n, text in sorted(news, key=lambda x: -x[0])[:2]:     # the two biggest economies' news, not every country's
            say(n, "ECONOMY", text)

        # ---- the world market this month
        f = rnd.gauss(MKT["drift"], MKT["world_sd"])
        if rnd.random() < monthly(MKT["crash"]):
            f -= rnd.uniform(0.15, 0.28)
            say(None, "MARKETS", rnd.choice(["Global markets crash as a wave of selling spreads from one exchange to the next.",
                                               "A banking scare sends world markets into their worst month in years.",
                                               "Stock markets plunge worldwide as lenders pull back and companies cut jobs."]))
        elif rnd.random() < monthly(MKT["correction"]):
            f -= rnd.uniform(0.06, 0.11)
            say(None, "MARKETS", "World markets slide about a tenth from their highs on worries about growth.")
        elif rnd.random() < monthly(MKT["rally"]):
            f += rnd.uniform(0.05, 0.09)
            say(None, "MARKETS", "World markets rally on strong earnings and easing prices.")
        hit = {}
        for ev in events:                                # what happened in each country this month moves its market
            if ev[2]:
                hit[ev[2]] = hit.get(ev[2], 0.0) + SHOCK.get(ev[4], 0.0) + (rnd.uniform(-0.02, 0.02) if ev[4] == "ELECTION" else 0)
        own, big_moves = {}, []
        for n in live:
            m = n["mkt"]
            prev = m.get("happy")
            m["happy"] = n["last"]["happy"]
            fund = (0.05 * (n["last"]["happy"] - prev) if prev is not None else 0.0) - 0.02 * dz(n) - (0.012 if n["conflict"] else 0)
            fund += -0.04 if n.get("sanctions") else 0
            fund += -0.01 if m.pop("_ban", False) else 0
            ec = n["econ"]
            fund += 0.6 * ec["infl"] / 1200 - 0.004 * max(0.0, ec["rate"] - ec["anchor"] - 1) / 1 * 0.25 + 0.0015 * (ec["growth"] - ec["usual"])
            fund -= 0.01 if ec["stag"] else 0
            sd = 0.025 + 0.05 * (1 - n["rich"])
            # growth makes up for bad months over time (and for the drag of a bumpy ride)
            own[n["code"]] = 0.003 + 0.5 * sd * sd + fund + 0.6 * hit.get(n["code"], 0.0) + rnd.gauss(0, sd)
        for n in live:
            m = n["mkt"]
            beta = 0.6 + 0.6 * n["rich"]
            ps = self.partners(n)
            spill = sum(own.get(b, 0) * w for b, w in ps.items()) / max(1e-9, sum(ps.values())) if ps else 0.0
            r = beta * f + own[n["code"]] + 0.25 * min(1.5, n["open"] / 100) * spill
            r = max(-0.6, min(0.6, r))
            m["r"] = round(r, 4)
            m["i"] = round(max(1.0, m["i"] * (1 + r)), 2)
            m["h"] = (m["h"] + [m["i"]])[-240:]
            if abs(r) >= 0.2 and n["pop"] > 4e6:
                big_moves.append((abs(r), n, r))
        for _, n, r in sorted(big_moves, key=lambda x: -x[0])[:2]:
            say(n, "MARKETS", f"{the(n['name'])}'s stock market {'jumps' if r > 0 else 'falls'} {abs(r):.0%} this month.")
        tot = sum(econ(n) for n in live) or 1
        wr = sum(econ(n) * n["mkt"]["r"] for n in live) / tot
        wm = W.setdefault("market", dict(i=1000.0, h=[]))
        wm["r"] = round(wr, 4)
        wm["i"] = round(wm["i"] * (1 + wr), 2)
        wm["h"] = (wm["h"] + [[e, wm["i"]]])[-600:]
        wi = sum(econ(n) * n["econ"]["infl"] for n in live) / tot
        wg = sum(econ(n) * n["econ"]["growth"] for n in live) / tot
        stag_w = wi >= 5 and wg <= 1.5
        if stag_w and not wm.get("stag"):
            say(None, "ECONOMY", f"Economists warn of global stagflation: world prices are rising {wi:.1f}% a year while growth slows to {wg:.1f}%.")
        wm.update(infl=round(wi, 2), growth=round(wg, 2), stag=stag_w)

    def markets(self):
        """The exchange view: every country's index, the world index, and the trade and market news."""
        with self.lock:
            W, N = self.w, self.w["nations"]
            def chg(h, k):
                return round(h[-1] / h[-1 - k] - 1, 4) if len(h) > k and h[-1 - k] else None
            rows = {}
            for n in N.values():
                m = n.get("mkt")
                if not m or not m["h"]:
                    continue
                h = m["h"]
                ec = n.get("econ") or {}
                flags = [x for x, on in (("stagflation", ec.get("stag")), ("recession", ec.get("growth", 1) < 0),
                                          ("sanctions", n.get("sanctions", 0) > 0), ("tariffs", n.get("tariff", 0) > 0),
                                          ("conflict", n["conflict"]), ("protests", n["protests"] > 0)) if on]
                rows[n["num"]] = dict(t=n["code"], name=n["name"], region=n["region"], i=m["i"], m1=chg(h, 1), m12=chg(h, 12),
                                      h=h[-48:], open=n.get("open"), real_open=n.get("open_real", False), flags=flags,
                                      happy=round(self.happiness(n), 2) if n["last"] else None, gov=GOV_LABEL[n["gov"]],
                                      infl=ec.get("infl"), growth=ec.get("growth"),
                                      partners=[N[b]["name"] for b, _ in sorted(self.partners(n).items(), key=lambda x: -x[1])[:5] if b in N])
            wm = W.get("market") or dict(i=1000.0, h=[])
            wh = [x[1] for x in wm["h"]]
            kinds = ("TARIFF", "DEAL", "SANCTIONS", "BAN", "TRADE", "MARKETS", "ECONOMY")
            ev = [[x[1], x[3], x[4], x[5]] for x in W["events"][-400:] if x[4] in kinds][::-1][:60]
            return dict(date=self.date(), epoch=W["epoch"], start=W.get("start"), month_secs=self.month_secs,
                        world=dict(i=wm["i"], m1=chg(wh, 1), m12=chg(wh, 12), h=wm["h"][-240:], infl=wm.get("infl"), growth=wm.get("growth"),
                                   stag=wm.get("stag", False)),
                        nations=rows, events=ev,
                        note="A simulated market: it moves with the simulated world's own events, not real prices.")

    def apply_detail(self, N):
        """Each nation takes its finest level whose regions all finished this month (and have warmed up)."""
        if not self.djobs:
            return
        D = self.w["detail"]
        by = {}                                         # (level, nation) -> [(region result, agents)], and how many regions it has
        need = {}
        for (k, p), j in self.djobs.items():
            rec = D.get(f"{k}.{p}") or {}
            ok = j["result"] is not None and rec.get("age", 0) >= WARM_MONTHS
            for code, a in self.piece_nations(k, p):
                c = code.split("#")[0]
                need[(k, c)] = need.get((k, c), 0) + 1
                if ok:
                    by.setdefault((k, c), []).append((j["result"][code], a, code))
        counts = [0] * len(LAYERS)
        for c, n in N.items():
            if not n.get("last"):
                continue
            for k in range(len(LAYERS) - 1, 0, -1):
                got = by.get((k, c), [])
                if not got or len(got) != need.get((k, c)):
                    continue
                tot = sum(a for _, a, _ in got)
                v = {f: sum(r[f] * a for r, a, _ in got) / tot for f in ("happy", "civ", "stress", "irr", "conn", "leave")}
                low = n["last"]
                if any(abs(v[f] - low[f]) > GUARD[f] for f in GUARD):
                    continue                            # far from the Low run: don't trust it this month
                n["last"] = {f: round(x, 5) for f, x in v.items()}
                n["detail"] = k
                n["detail_agents"] = tot
                gregs = (self.w.get("gdl_regions") or {}).get(str(k), {})
                if c != COUNTY_NATION and any(code in gregs for _, _, code in got):
                    self.w.setdefault("region_results", {})[c] = dict(level=k, epoch=self.w["epoch"], regions={
                        code: dict(gdl=gregs.get(code, []), happy=round(r["happy"], 4), stress=round(r["stress"], 4), conn=round(r["conn"], 4))
                        for r, a, code in got})
                if c == COUNTY_NATION and (self.w.get("county_regions") or {}).get(str(k)):
                    regs = self.w["county_regions"][str(k)]
                    self.w["county_results"] = dict(level=k, epoch=self.w["epoch"], regions={
                        code: dict(fips=regs.get(code, []), happy=round(r["happy"], 4), stress=round(r["stress"], 4), conn=round(r["conn"], 4))
                        for r, a, code in got})
                    self.fit_counties()
                break
            counts[n.get("detail", 0)] += 1
        self.w["detail_counts"] = counts
        if self.oecd_regions and (self.w.get("region_results") or self.w.get("county_results")):
            self.fit_regions()
        self.w["detail_pieces"] = [[sum(1 for (k, _), j in self.djobs.items() if k == kk and j["result"] is not None),
                                    len(self.w["layers"][kk - 1]["pieces"])] for kk in range(1, len(LAYERS))]

    # ------------------------------------------------------------------ happiness
    def fit_happiness(self):
        """Line the simulation's happiness up with real life-satisfaction surveys (weighted least squares
        over every country with a survey), and keep how well they agree (r) to publish."""
        pts = [(n["last"]["happy"], n["stats"].get("happiness"), math.sqrt(n["pop"])) for n in self.w["nations"].values()
               if n["last"] and "happy" in n["last"] and n["stats"].get("happiness") is not None]
        if len(pts) < 10:
            self.w["happy_fit"] = dict(a=0.0, b=1.0, r=None, n=len(pts))
            return
        sw = sum(w for _, _, w in pts)
        mx = sum(x * w for x, _, w in pts) / sw; my = sum(y * w for _, y, w in pts) / sw
        sxx = sum(w * (x - mx) ** 2 for x, _, w in pts); sxy = sum(w * (x - mx) * (y - my) for x, y, w in pts)
        syy = sum(w * (y - my) ** 2 for _, y, w in pts)
        b = max(0.3, min(3.0, sxy / sxx)) if sxx > 0 else 1.0
        self.w["happy_fit"] = dict(a=round(my - b * mx, 4), b=round(b, 4), n=len(pts),
                                   r=round(sxy / math.sqrt(sxx * syy), 3) if sxx > 0 and syy > 0 else None)

    def fit_counties(self):
        """How the simulated counties line up with the CDC's county survey figures: groups ranked by simulated stress
        against their share of adults in frequent mental distress, and by simulated connection against loneliness."""
        R = (self.w.get("county_results") or {}).get("regions") or {}
        C = self.counties
        def group(fs, k):
            xs = [(C[f][k], C[f]["pop"]) for f in fs if f in C and k in C[f]]
            return sum(v * p for v, p in xs) / sum(p for _, p in xs) if xs else None
        def rho(a, b):
            if len(a) < 20:
                return None
            ra = {i: r for r, i in enumerate(sorted(range(len(a)), key=lambda j: a[j]))}
            rb = {i: r for r, i in enumerate(sorted(range(len(b)), key=lambda j: b[j]))}
            n = len(a)
            return round(1 - 6 * sum((ra[i] - rb[i]) ** 2 for i in range(n)) / (n * (n * n - 1)), 3)
        out = {}
        for key, sim, real, sign in (("distress", "stress", "t_mhlth", 1), ("lonely", "conn", "t_loneliness", -1)):
            pts = [(sign * r[sim], group(r["fips"], real)) for r in R.values()]
            pts = [p for p in pts if p[1] is not None]
            out[key] = dict(rank=rho([p[0] for p in pts], [p[1] for p in pts]), n=len(pts))
        self.w["county_fit"] = out

    @staticmethod
    def _norm(s):
        import unicodedata
        s = unicodedata.normalize("NFKD", s or "").encode("ascii", "ignore").decode().lower()
        s = re.sub(r"\(.*?\)", " ", s)
        s = re.sub(r"\b(region|province|state|prefecture|county|district|voivodeship|autonomous|community|of|the|and|de|del|la)\b", " ", s)
        return set(w for w in re.split(r"[^a-z]+", s) if len(w) > 2)

    def fit_regions(self):
        """The simulation's regions against the OECD's regional life satisfaction (Gallup World Poll), which the model
        never uses: within each country, does it rank its regions the way people there rate their lives? US states
        come from the county results. Scored as the average rank match within countries with 4+ matched regions."""
        G = {r["code"]: r for rs in self.regions.values() for r in rs}
        by = {}                                   # country -> [(simulated happiness, real life satisfaction, name)]
        for c, res in (self.w.get("region_results") or {}).items():
            oecd = [o for o in self.oecd_regions if o["iso3"] == c and o.get("life_sat") is not None]
            if not oecd:
                continue
            for code, r in res["regions"].items():
                names = [G[g]["region"] for g in r["gdl"] if g in G]
                if len(names) != 1:
                    continue                      # a grouped region can't be matched to one OECD region
                a = self._norm(names[0])
                best = max(oecd, key=lambda o: len(a & self._norm(o["region"])) / max(1, len(a | self._norm(o["region"]))))
                if a and len(a & self._norm(best["region"])) / max(1, len(a | self._norm(best["region"]))) >= 0.5:
                    by.setdefault(c, []).append((r["happy"], best["life_sat"], names[0]))
        US = {"AL": "Alabama", "AK": "Alaska", "AZ": "Arizona", "AR": "Arkansas", "CA": "California", "CO": "Colorado", "CT": "Connecticut",
              "DE": "Delaware", "DC": "District of Columbia", "FL": "Florida", "GA": "Georgia", "HI": "Hawaii", "ID": "Idaho", "IL": "Illinois",
              "IN": "Indiana", "IA": "Iowa", "KS": "Kansas", "KY": "Kentucky", "LA": "Louisiana", "ME": "Maine", "MD": "Maryland",
              "MA": "Massachusetts", "MI": "Michigan", "MN": "Minnesota", "MS": "Mississippi", "MO": "Missouri", "MT": "Montana",
              "NE": "Nebraska", "NV": "Nevada", "NH": "New Hampshire", "NJ": "New Jersey", "NM": "New Mexico", "NY": "New York",
              "NC": "North Carolina", "ND": "North Dakota", "OH": "Ohio", "OK": "Oklahoma", "OR": "Oregon", "PA": "Pennsylvania",
              "RI": "Rhode Island", "SC": "South Carolina", "SD": "South Dakota", "TN": "Tennessee", "TX": "Texas", "UT": "Utah",
              "VT": "Vermont", "VA": "Virginia", "WA": "Washington", "WV": "West Virginia", "WI": "Wisconsin", "WY": "Wyoming"}
        CR = (self.w.get("county_results") or {}).get("regions") or {}
        if CR and self.counties:
            st = {}
            for r in CR.values():
                for f in r["fips"]:
                    if f in self.counties:
                        s = st.setdefault(self.counties[f]["st"], [0.0, 0.0]); p = self.counties[f]["pop"]
                        s[0] += r["happy"] * p; s[1] += p
            o = {x["region"]: x["life_sat"] for x in self.oecd_regions if x["iso3"] == COUNTY_NATION and x.get("life_sat") is not None}
            for ab, (hs, ps) in st.items():
                if US.get(ab) in o and ps:
                    by.setdefault(COUNTY_NATION, []).append((hs / ps, o[US[ab]], US[ab]))
        def rho(pts):
            n = len(pts)
            ra = {i: r for r, i in enumerate(sorted(range(n), key=lambda j: pts[j][0]))}
            rb = {i: r for r, i in enumerate(sorted(range(n), key=lambda j: pts[j][1]))}
            return 1 - 6 * sum((ra[i] - rb[i]) ** 2 for i in range(n)) / (n * (n * n - 1))
        per = {c: dict(rank=round(rho(p), 3), n=len(p)) for c, p in by.items() if len(p) >= 4}
        tot = sum(v["n"] for v in per.values())
        self.w["region_fit"] = dict(countries=per, regions=tot,
                                    within=round(sum(v["rank"] * v["n"] for v in per.values()) / tot, 3) if tot else None)

    def region_public(self):
        """Every country's simulated regions (happiness on the survey scale) and how they compare with the OECD's."""
        with self.lock:
            f = self.w.get("happy_fit") or dict(a=0.0, b=1.0)
            G = {r["code"]: r for rs in (self.regions or {}).values() for r in rs}
            out = {}
            for c, res in (self.w.get("region_results") or {}).items():
                out[c] = [dict(regions=[G[g]["region"] for g in r["gdl"] if g in G], happiness=round(max(0.0, min(10.0, f["a"] + f["b"] * r["happy"])), 2))
                          for r in res["regions"].values()]
            return dict(date=self.date(), countries=out, fit=self.w.get("region_fit"),
                        source="Simulated; regional conditions from the Global Data Lab (https://globaldatalab.org/shdi/), checked against the OECD Regional Well-Being database")

    def county_public(self):
        """Each US county's simulated happiness on the survey scale (0-10), from the finest level that ran this month."""
        with self.lock:
            R = (self.w.get("county_results") or {}).get("regions") or {}
            f = self.w.get("happy_fit") or dict(a=0.0, b=1.0)
            out = {}
            for r in R.values():
                h = round(max(0.0, min(10.0, f["a"] + f["b"] * r["happy"])), 2)
                for fips in r["fips"]:
                    out[fips] = h
            C = self.counties
            pts = [[f, C[f]["lat"], C[f]["lon"], h] for f, h in out.items() if f in C and "lat" in C[f]]   # for the globe: nearest county centre
            return dict(date=self.date(), level=LAYERS[(self.w.get("county_results") or {}).get("level", 0)]["name"] if R else None,
                        counties=out, pts=pts, fit=self.w.get("county_fit"),
                        source="Simulated; county conditions from the U.S. Census Bureau ACS via CDC PLACES")

    def happiness(self, n):
        f = self.w.get("happy_fit") or dict(a=0.0, b=1.0)
        return max(0.0, min(10.0, f["a"] + f["b"] * n["last"].get("happy", 5.0)))

    # ------------------------------------------------------------------ public view
    def public(self):
        with self.lock:
            W, N = self.w, self.w["nations"]
            nations = {}
            for n in N.values():
                if not n["last"]:
                    continue
                nations[n["num"]] = dict(name=n["name"], happiness=round(self.happiness(n), 2), survey=n["stats"].get("happiness"),
                                         survey_year=n["stats"].get("happiness_year"), gov=GOV_LABEL[n["gov"]],
                                         office=n["title"], ruling=n["ruling"], conflict=n["conflict"], protests=n["protests"] > 0,
                                         pop=round(n["pop"]), detail=LAYERS[n.get("detail", 0)]["name"],
                                         netmig=n.get("mig_last"),
                                         netmig_real=round(n["netmig_real"] / n["pop"] * 1000, 2) if n.get("netmig_real") is not None and n["pop"] > 1000 else None)
            self.maybe_close()
            done = sum(1 for j in self.jobs.values() if j["status"] == "done")
            dnow = [[L["name"], sum(1 for (k, _), j in self.djobs.items() if k == kk and j["result"] is not None),
                     len(self.w["layers"][kk - 1]["pieces"])] for kk, L in enumerate(LAYERS) if kk > 0]
            dcount = W.get("detail_counts") or [len([n for n in N.values() if n["last"]])] + [0] * (len(LAYERS) - 1)
            levels = [dict(name=L["name"], nations=dcount[kk] if kk < len(dcount) else 0,
                           done=(done if kk == 0 else dnow[kk - 1][1]), pieces=(len(self.jobs) if kk == 0 else dnow[kk - 1][2]))
                      for kk, L in enumerate(LAYERS)]
            # (spot-checked pieces count once they're settled)
            ev = [[x[1], x[3], x[4], x[5]] for x in W["events"][-40:]][::-1]     # no country codes: names only
            last = W["world_series"][-1] if W["world_series"] else None
            return dict(date=self.date(), epoch=W["epoch"], start=W.get("start"), month_secs=self.month_secs, month_progress=[done, len(self.jobs)], scale=W["scale"],
                        people=round(sum(n["pop"] for n in N.values())), simulated=sum(n["agents"] for n in N.values()),
                        happiness=last[1] if last else None, fit=W.get("happy_fit"), mig_fit=W.get("mig_fit"), conflicts=last[3] if last else 0, levels=levels,
                        simulated_detail=sum(n.get("detail_agents", n["agents"]) if n.get("detail") else n["agents"] for n in N.values()),
                        nations=nations, events=ev, county_fit=W.get("county_fit"), region_fit=W.get("region_fit"), series=[[x[0], x[1], x[3], x[4]] for x in W["world_series"][-240:]], source=W.get("data", {}).get("source"))
