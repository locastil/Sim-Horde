"""
Today's real world, for starting a fresh Sim Horde world as a copy of the real one.

World Bank figures, happiness surveys and kinds of government come from world_data.py. This adds what that
leaves out: which countries are at war or in armed conflict right now, from the UCDP/PRIO Armed Conflict
Dataset (Uppsala Conflict Data Program, CC BY 4.0): every conflict with at least 25 battle deaths in its
latest year. Writes world/today.json. Run on the coordinator PC (needs internet):  python world/today_data.py

Only countries and the fact of fighting carry over; no real people, groups or leaders are named in the world.
"""
import csv
import io
import json
import os
import re
import time
import urllib.request
import zipfile

HERE = os.path.dirname(os.path.abspath(__file__))
NATIONS = os.path.join(os.path.dirname(HERE), "engine", "sim_data", "world", "nations.json")
OUT = os.path.join(HERE, "today.json")
URLS = ["https://ucdp.uu.se/downloads/ucdpprio/ucdp-prio-acd-{v}-csv.zip".format(v=v) for v in ("261", "251")]

# UCDP's place names that differ from the world's
ALIAS = {
    "dr congo": "COD", "congo": "COG", "myanmar": "MMR", "burma": "MMR", "russia": "RUS", "soviet union": "RUS",
    "united states of america": "USA", "united states": "USA", "united kingdom": "GBR", "iran": "IRN", "syria": "SYR",
    "israel": "ISR", "palestine": "PSE", "south korea": "KOR", "north korea": "PRK", "ivory coast": "CIV",
    "cote d'ivoire": "CIV", "côte d’ivoire": "CIV", "côte d'ivoire": "CIV", "turkey": "TUR", "türkiye": "TUR",
    "laos": "LAO", "venezuela": "VEN", "bolivia": "BOL", "tanzania": "TZA", "vietnam": "VNM", "czech republic": "CZE",
    "macedonia": "MKD", "north macedonia": "MKD", "eswatini": "SWZ", "swaziland": "SWZ", "cape verde": "CPV",
    "east timor": "TLS", "timor-leste": "TLS", "cambodia": "KHM", "kampuchea": "KHM", "yemen": "YEM",
    "north yemen": "YEM", "south sudan": "SSD", "sudan": "SDN", "central african republic": "CAF",
    "bosnia-herzegovina": "BIH", "serbia": "SRB", "yugoslavia": "SRB", "zaire": "COD", "rumania": "ROU",
    "madagascar": "MDG", "malagasy": "MDG", "gambia": "GMB", "guinea-bissau": "GNB", "hyderabad": "IND",
}


def get(url):
    req = urllib.request.Request(url, headers={"User-Agent": "SimHorde/0.3 (world data)"})
    with urllib.request.urlopen(req, timeout=120) as r:
        return r.read()


def places(loc, names):
    out = []
    for part in loc.split(","):
        p = re.sub(r"\s*\(.*?\)\s*", " ", part).strip().lower()
        code = ALIAS.get(p) or names.get(p)
        if not code:
            inner = re.findall(r"\((.*?)\)", part)
            code = next((ALIAS.get(i.strip().lower()) or names.get(i.strip().lower()) for i in inner if (ALIAS.get(i.strip().lower()) or names.get(i.strip().lower()))), None)
        out.append((part.strip(), code))
    return out


def main():
    nations = json.load(open(NATIONS, encoding="utf-8"))["nations"]
    names = {n["name"].lower(): n["iso3"] for n in nations}
    rows, used = None, None
    for url in URLS:
        try:
            z = zipfile.ZipFile(io.BytesIO(get(url)))
            name = next(n for n in z.namelist() if n.lower().endswith(".csv"))
            rows = list(csv.DictReader(io.StringIO(z.read(name).decode("utf-8-sig"))))
            used = url
            break
        except Exception as e:
            print(f"  {url}: {e}")
    if not rows:
        raise SystemExit("Couldn't download the UCDP conflict data; the world keeps starting at peace.")
    year = max(int(r["year"]) for r in rows)
    now = [r for r in rows if int(r["year"]) == year]
    borders = {n["iso3"]: set(n.get("borders") or []) for n in nations}
    conflicts, unmatched = {}, set()
    for r in now:
        kind = "war" if r["type_of_conflict"] == "2" else "civil"
        start = int((r.get("start_date") or str(year))[:4])
        here = places(r["location"], names)
        for raw, code in here:
            if not code:
                unmatched.add(raw); continue
            # a war between states lists every government taking part, wherever the fighting is. A country counts
            # as at war at home only if it borders an enemy or the war is a major one (1,000+ deaths a year): so
            # strikes from far away (say, on shipping lanes) don't put the striking country itself at war.
            if kind == "war" and r["intensity_level"] != "2" and not any(x and x != code and x in borders.get(code, ()) for _, x in here):
                continue
            c = conflicts.setdefault(code, dict(kind=kind, since=start, intensity=1, wars_with=[]))
            if kind == "war":
                c["kind"] = "war"
                c["wars_with"] = sorted(set(c["wars_with"]) | {x for _, x in here if x and x != code})
            c["since"] = min(c["since"], start)
            c["intensity"] = max(c["intensity"], int(r["intensity_level"]))
    json.dump(dict(fetched=time.strftime("%Y-%m-%d"), source="UCDP/PRIO Armed Conflict Dataset (" + used.rsplit("/", 1)[-1] + "), CC BY 4.0",
                   year=year, conflicts=conflicts, unmatched=sorted(unmatched)), open(OUT, "w"), indent=1)
    print(f"Armed conflict in {year}: {len(conflicts)} countries ({sum(1 for c in conflicts.values() if c['intensity'] == 2)} at war level, "
          f"1,000+ deaths a year; {sum(1 for c in conflicts.values() if c['kind'] == 'war')} in fighting between states).")
    if unmatched:
        print("  Places not matched to a country: " + ", ".join(sorted(unmatched)))
    print(f"Wrote {OUT}")


if __name__ == "__main__":
    main()
