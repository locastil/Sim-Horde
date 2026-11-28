"""
Regions of every country, for running the world region by region at the finer levels of detail, and a regional
yardstick to test it against.

Downloads (no key needed) and writes world/regions.json:
  * conditions: the Subnational Human Development Database of the Global Data Lab (Radboud University), via the
    Peace Research Institute Oslo's mirror (version 8.0): for about 1,800 regions in some 180 countries, gross national
    income per person, life expectancy, schooling and population, latest year. Source: Global Data Lab,
    https://globaldatalab.org/shdi/ (free for non-commercial use with this reference; GDL doesn't endorse this project).
  * the yardstick: the OECD Regional Well-Being database (https://oecdregionalwellbeing.org/): average life
    satisfaction (0-10, from the Gallup World Poll) and perceived social network support for about 510 regions of
    OECD countries. Used only to check the simulation, never as an input.

Run on the coordinator PC (needs internet):  python world/regions_data.py
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
OUT = os.path.join(HERE, "regions.json")
NATIONS = os.path.join(os.path.dirname(HERE), "engine", "sim_data", "world", "nations.json")
GDL = "https://cdn.cloud.prio.org/files/831b54bf-9efd-4be6-a618-9794109790c1/SHDI-SGDI-Total%2080.csv?inline=true"
OECD = "https://oecdregionalwellbeing.org/assets/downloads/OECD-Regional-Well-Being-Data-File.xlsx"
UA = {"User-Agent": "SimHorde/1.0 (regional data)"}
ALIAS = {"korea": "KOR", "republic of korea": "KOR", "slovak republic": "SVK", "czechia": "CZE", "czech republic": "CZE", "türkiye": "TUR",
         "turkey": "TUR", "united states": "USA", "united kingdom": "GBR", "russian federation": "RUS"}


def get(url):
    with urllib.request.urlopen(urllib.request.Request(url, headers=UA), timeout=180) as r:
        return r.read()


def num(v):
    try:
        return float(v)
    except (TypeError, ValueError):
        return None


def gdl():
    rows = list(csv.DictReader(io.StringIO(get(GDL).decode("utf-8-sig", "replace"))))
    print(f"  Global Data Lab: {len(rows)} rows; columns: {', '.join(list(rows[0])[:40])}")
    k = {c.lower(): c for c in rows[0]}
    col = lambda *names: next((k[n] for n in names if n in k), None)
    c_iso, c_code, c_reg, c_lvl, c_year = col("iso_code"), col("gdlcode"), col("region"), col("level"), col("year")
    c_gni, c_le, c_ms, c_pop = col("gnic"), col("lifexp"), col("msch"), col("pop")
    latest = {}
    for r in rows:
        if c_lvl and r[c_lvl].strip().lower().startswith("nat"):
            continue
        g = r[c_code]
        y = int(float(r[c_year] or 0))
        if num(r[c_gni]) and (g not in latest or y > latest[g][0]):
            latest[g] = (y, r)
    out = []
    for g, (y, r) in latest.items():
        out.append(dict(code=g, iso3=r[c_iso], region=r[c_reg], year=y, gni=num(r[c_gni]), lifexp=num(r[c_le]) if c_le else None,
                        school=num(r[c_ms]) if c_ms else None, pop=num(r[c_pop]) if c_pop else None))
    return out


def xlsx_rows(data, sheet_name):
    z = zipfile.ZipFile(io.BytesIO(data))
    try:
        ss = z.read("xl/sharedStrings.xml").decode("utf-8")
    except KeyError:
        ss = ""
    S = ["".join(re.findall(r"<t[^>]*>([^<]*)</t>", si)) for si in re.findall(r"<si>(.*?)</si>", ss, re.S)]
    wb = z.read("xl/workbook.xml").decode("utf-8")
    rels = z.read("xl/_rels/workbook.xml.rels").decode("utf-8")
    rid = re.search(r'<sheet [^>]*name="%s"[^>]*r:id="([^"]+)"' % re.escape(sheet_name), wb).group(1)
    target = re.search(r'Id="%s"[^>]*Target="([^"]+)"' % re.escape(rid), rels) or re.search(r'Target="([^"]+)"[^>]*Id="%s"' % re.escape(rid), rels)
    path = "xl/" + target.group(1).lstrip("/").replace("xl/", "")
    sh = z.read(path).decode("utf-8")
    out = []
    for row in re.findall(r"<row [^>]*>(.*?)</row>", sh, re.S):
        cells = {}
        for ref, attrs, _, body in re.findall(r'<c r="([A-Z]+)\d+"([^>]*?)(?:/>()|>(.*?)</c>)', row, re.S):
            ci = 0
            for ch in ref:
                ci = ci * 26 + ord(ch) - 64
            v = re.search(r"<v>([^<]*)</v>", body or "")
            if 't="s"' in attrs and v:
                cells[ci - 1] = S[int(v.group(1))]
            elif 't="inlineStr"' in attrs:
                cells[ci - 1] = "".join(re.findall(r"<t[^>]*>([^<]*)</t>", body or "")) or None
            else:
                cells[ci - 1] = v.group(1) if v else None
        out.append([cells.get(i) for i in range(max(cells) + 1)] if cells else [])
    return out


def oecd(names):
    raw = get(OECD)
    open(os.path.join(HERE, "oecd_regional.xlsx"), "wb").write(raw)          # kept, so a failed read can be checked
    R = xlsx_rows(raw, "Indicator_Last")
    hi = next(i for i, r in enumerate(R) if any(v and "Life satisfaction" in v for v in r))
    h = [(v or "").strip() for v in R[hi]]
    ix = lambda name: next(i for i, v in enumerate(h) if v.lower().startswith(name.lower()))
    c_c, c_r, c_k = ix("Country"), ix("Region"), ix("Code")
    c_ls, c_sup, c_inc, c_le, c_un = ix("Life satisfaction"), ix("Perceived social network"), ix("Disposable income"), ix("Life expectancy"), ix("Unemployment rate")
    out, miss = [], set()
    for r in R[hi + 2:]:
        r = r + [None] * (len(h) - len(r))
        if not r[c_r] or not r[c_k]:
            continue
        iso = ALIAS.get(r[c_c].strip().lower()) or names.get(r[c_c].strip().lower())
        if not iso:
            miss.add(r[c_c]); continue
        out.append(dict(iso3=iso, region=r[c_r].strip(), code=r[c_k].strip(), life_sat=num(r[c_ls]), support=num(r[c_sup]),
                        income=num(r[c_inc]), lifexp=num(r[c_le]), unemp=num(r[c_un])))
    if miss:
        print("  OECD countries not matched: " + ", ".join(sorted(miss)))
    return out


def main():
    nat = json.load(open(NATIONS, encoding="utf-8"))["nations"]
    names = {n["name"].lower(): n["iso3"] for n in nat}
    res = dict(fetched=time.strftime("%Y-%m-%d"), sources=dict(
        conditions="Global Data Lab, Subnational Human Development Database v8.0 (via PRIO), https://globaldatalab.org/shdi/",
        check="OECD Regional Well-Being database (life satisfaction from the Gallup World Poll), https://oecdregionalwellbeing.org/"))
    try:
        res["gdl"] = gdl(); print(f"  Global Data Lab: {len(res['gdl'])} regions in {len({r['iso3'] for r in res['gdl']})} countries")
    except Exception as e:
        print(f"  Global Data Lab download failed: {e}"); res["gdl"] = []
    try:
        res["oecd"] = oecd(names); print(f"  OECD: {len(res['oecd'])} regions, {sum(1 for r in res['oecd'] if r['life_sat'] is not None)} with life satisfaction")
    except Exception as e:
        import traceback; traceback.print_exc()
        print(f"  OECD download failed: {e}"); res["oecd"] = []
    if not res["gdl"]:
        raise SystemExit("No regional data: the world keeps running country by country.")
    json.dump(res, open(OUT, "w"), separators=(",", ":"))
    print(f"Wrote {OUT}")


if __name__ == "__main__":
    main()
