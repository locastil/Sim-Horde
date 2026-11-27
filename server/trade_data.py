"""
Trade openness and stock market size for every country, from World Bank Open Data, for the Sim Horde world's
markets and trade:
  trade   NE.TRD.GNFS.ZS     trade (exports + imports) as % of GDP: how much a country's economy rides on others
  mktcap  CM.MKT.LCAP.GD.ZS  market capitalization of listed companies, % of GDP: how much its markets matter
  infl    FP.CPI.TOTL.ZG     consumer price inflation, % a year: where each country's prices start
  growth  NY.GDP.MKTP.KD.ZG  real GDP growth, % a year: where each economy starts
Writes engine/sim_data/world/economy.json. Countries without a figure get none (the world estimates one).
    python world/trade_data.py
"""
import json
import os
import urllib.request

HERE = os.path.dirname(os.path.abspath(__file__))
OUT = os.path.join(os.path.dirname(HERE), "engine", "sim_data", "world", "economy.json")
WB = "https://api.worldbank.org/v2/country/all/indicator/{code}?format=json&per_page=20000&mrnev=1"
WANT = {"trade": "NE.TRD.GNFS.ZS", "mktcap": "CM.MKT.LCAP.GD.ZS", "infl": "FP.CPI.TOTL.ZG", "growth": "NY.GDP.MKTP.KD.ZG"}


def fetch(code):
    req = urllib.request.Request(WB.format(code=code), headers={"User-Agent": "SimHorde/1.0"})
    with urllib.request.urlopen(req, timeout=60) as r:
        data = json.loads(r.read())
    out = {}
    for row in (data[1] if isinstance(data, list) and len(data) > 1 and data[1] else []):
        iso, v = row.get("countryiso3code"), row.get("value")
        if iso and v is not None:
            out[iso] = (float(v), row.get("date"))
    return out


def main():
    res = {}
    for key, code in WANT.items():
        try:
            got = fetch(code)
        except Exception as e:
            print(f"Couldn't get {key} ({code}): {e}")
            continue
        for iso, (v, yr) in got.items():
            res.setdefault(iso, {})[key] = round(v, 2)
        print(f"{key}: {len(got)} countries")
    if res:
        os.makedirs(os.path.dirname(OUT), exist_ok=True)
        json.dump(dict(source="World Bank Open Data: " + ", ".join(WANT.values()), countries=res), open(OUT, "w"), indent=0)
        print(f"Wrote {OUT}")


if __name__ == "__main__":
    main()
