"""
US county figures, for simulating the United States county by county at the finer levels of detail.

Downloads (no key needed) and writes world/us_counties_cdc.json:
  * conditions, from the U.S. Census Bureau's American Community Survey 5-year estimates (2017-2021), as published
    by the CDC (PLACES Non-Medical Factor Measures for County, data.cdc.gov i6u4-y3g4): unemployment, share below
    150% of the poverty line, households without broadband, share aged 65+, housing cost burden, crowding, adults
    without a high-school diploma; plus population and location;
  * land area, from the Census Bureau's county gazetteer, for how crowded each county is;
  * checks, from CDC PLACES County Data 2025 (BRFSS survey, age-adjusted %, data.cdc.gov swc5-untb): frequent mental
    distress, depression, loneliness and lack of social and emotional support (the last two not in every state).
The CDC file also carries each county's racial and ethnic minority share; the simulation doesn't use race or
ethnicity, so it isn't kept.

Run on the coordinator PC (needs internet):  python world/us_counties_data.py
"""
import io
import json
import os
import time
import urllib.parse
import urllib.request
import zipfile

HERE = os.path.dirname(os.path.abspath(__file__))
OUT = os.path.join(HERE, "us_counties_cdc.json")
SOCRATA = "https://data.cdc.gov/resource/{id}.json?"
GAZ = "https://www2.census.gov/geo/docs/maps-data/data/gazetteer/{y}_Gazetteer/{y}_Gaz_counties_national.zip"
UA = {"User-Agent": "SimHorde/1.0 (county data)"}


def get(url, timeout=120):
    with urllib.request.urlopen(urllib.request.Request(url, headers=UA), timeout=timeout) as r:
        return r.read()


def socrata(id_, **q):
    q.setdefault("$limit", "50000")
    return json.loads(get(SOCRATA.format(id=id_) + urllib.parse.urlencode(q)))


def main():
    C = {}
    rows = socrata("i6u4-y3g4", **{"$select": "locationid,locationname,stateabbr,totalpopulation,geolocation,measureid,data_value"})
    for r in rows:
        f = r.get("locationid") or ""
        if len(f) != 5 or not f.isdigit() or not r.get("totalpopulation"):
            continue                                   # skip anything that isn't a county with a population
        c = C.setdefault(f, dict(name=r.get("locationname") or f, st=r.get("stateabbr") or "", pop=float(r["totalpopulation"])))
        g = r.get("geolocation") or {}
        if g.get("coordinates"):
            c["lon"], c["lat"] = round(float(g["coordinates"][0]), 3), round(float(g["coordinates"][1]), 3)
        m = r.get("measureid") or ""
        if m and m not in ("REMNRTY", "SNGPNT") and r.get("data_value") not in (None, ""):
            c[m.lower()] = float(r["data_value"])
    print(f"  conditions: {len(C)} counties")
    rows = socrata("swc5-untb", **{"$select": "locationid,measureid,data_value",
                                   "$where": "datavaluetypeid='AgeAdjPrv' AND measureid in('MHLTH','LONELINESS','EMOTIONSPT','DEPRESSION')"})
    n = 0
    for r in rows:
        if r.get("locationid") in C and r.get("measureid") and r.get("data_value") not in (None, ""):
            C[r["locationid"]]["t_" + r["measureid"].lower()] = float(r["data_value"]); n += 1
    print(f"  checks: {n} county figures")
    area = 0
    for y in (2021, 2022, 2023):                  # 2021 matches the 2017-2021 survey (Connecticut changed its counties in 2022)
        try:
            z = zipfile.ZipFile(io.BytesIO(get(GAZ.format(y=y))))
            lines = z.read(z.namelist()[0]).decode("utf-8", "replace").splitlines()
            sep = "|" if "|" in lines[0] else "\t"
            head = [h.strip() for h in lines[0].split(sep)]
            gi, ai = head.index("GEOID"), head.index("ALAND_SQMI")
            for line in lines[1:]:
                p = [x.strip() for x in line.split(sep)]
                if p[gi] in C:
                    C[p[gi]]["land_km2"] = round(float(p[ai]) * 2.58999, 1); area += 1
            print(f"  land area: {area} counties ({y} gazetteer)")
            break
        except Exception as e:
            print(f"  land area {y}: {e}")
    json.dump(dict(source=dict(
        conditions="U.S. Census Bureau ACS 5-year estimates 2017-2021, via CDC PLACES Non-Medical Factor Measures for County (data.cdc.gov i6u4-y3g4)",
        area="U.S. Census Bureau county gazetteer", checks="CDC PLACES County Data 2025 release (BRFSS, age-adjusted %), data.cdc.gov swc5-untb"),
        fetched=time.strftime("%Y-%m-%d"), counties=C), open(OUT, "w"), separators=(",", ":"))
    print(f"Wrote {OUT}: {len(C)} counties, {sum(c['pop'] for c in C.values()) / 1e6:.0f} million people")


if __name__ == "__main__":
    main()
