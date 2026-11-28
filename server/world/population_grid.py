"""
Where people live, for drawing the globe: the GHS-POP population grid (European Commission, Joint Research Centre,
GHS-POP R2023A, CC BY 4.0), people per ~1 km cell, built by spreading census counts over satellite-mapped buildings.
So the lights show cities, suburbs, sprawl along highways and scattered rural homes as they really are.

Downloads the global grid once (about 450 MB), adds it up into ~4.6 km cells (2.5 arc-minutes), and writes
public_data/popgrid.png: one pixel per cell, brightness = log10(1 + people) scaled to 0-255 (scale in
public_data/popgrid.json). The globe draws both its lights from space and its close-up people from it. Display only:
the simulation itself doesn't use it.

Run on the coordinator PC (needs internet; installs tifffile and imagecodecs if missing):
    python world/population_grid.py
"""
import io
import json
import math
import os
import subprocess
import sys
import time
import urllib.request
import zipfile

HERE = os.path.dirname(os.path.abspath(__file__))
OUT = os.path.join(os.path.dirname(HERE), "public_data")
BASE = "https://jeodpp.jrc.ec.europa.eu/ftp/jrc-opendata/GHSL/GHS_POP_GLOBE_R2023A/GHS_POP_E{y}_GLOBE_R2023A_4326_30ss/V1-0/GHS_POP_E{y}_GLOBE_R2023A_4326_30ss_V1_0.zip"
CACHE = os.path.join(OUT, "ghs_pop_30ss.zip")
F = 5                                     # 30 arc-seconds x 5 = 2.5 arc-minutes


def need(pkg, mod=None):
    try:
        __import__(mod or pkg)
    except ImportError:
        print(f"  installing {pkg}...")
        subprocess.check_call([sys.executable, "-m", "pip", "install", "--quiet", pkg])


def download():
    if os.path.exists(CACHE) and os.path.getsize(CACHE) > 100_000_000:
        return CACHE, json.load(open(CACHE + ".json"))["year"] if os.path.exists(CACHE + ".json") else None
    for y in (2025, 2020, 2015):
        url = BASE.format(y=y)
        try:
            req = urllib.request.Request(url, headers={"User-Agent": "SimHorde/1.0 (population grid)"})
            with urllib.request.urlopen(req, timeout=60) as r, open(CACHE + ".part", "wb") as f:
                total = int(r.headers.get("Content-Length") or 0); got = 0; t0 = time.time()
                while True:
                    b = r.read(1 << 20)
                    if not b:
                        break
                    f.write(b); got += len(b)
                    if time.time() - t0 > 5:
                        print(f"  {got / 1e6:,.0f} of {total / 1e6:,.0f} MB", flush=True); t0 = time.time()
            os.replace(CACHE + ".part", CACHE)
            json.dump(dict(year=y, url=url), open(CACHE + ".json", "w"))
            print(f"  downloaded the {y} grid")
            return CACHE, y
        except Exception as e:
            print(f"  {y}: {e}")
    raise SystemExit("Couldn't download the population grid.")


def main():
    os.makedirs(OUT, exist_ok=True)
    for pkg, mod in (("numpy", None), ("tifffile", None), ("imagecodecs", None), ("pillow", "PIL")):
        need(pkg, mod)
    import numpy as np
    import tifffile
    from PIL import Image
    path, year = download()
    z = zipfile.ZipFile(path)
    name = next(n for n in z.namelist() if n.lower().endswith(".tif"))
    print(f"  reading {name}")
    with z.open(name) as fh:
        data = io.BytesIO(fh.read())
    with tifffile.TiffFile(data) as tf:
        page = tf.pages[0]
        H, W = page.shape[:2]
        geo = page.geotiff_tags or {}
        tie = (geo.get("ModelTiepoint") or [0, 0, 0, -180, 90, 0])
        scale = (geo.get("ModelPixelScale") or [360 / W, 180 / H, 0])
        lon0, lat0, dx, dy = tie[3], tie[4], scale[0], scale[1]
        print(f"  {W} x {H} cells, from {lon0}, {lat0}, {dx * 3600:.0f} arc-seconds")
        out = np.zeros((math.ceil(H / F), math.ceil(W / F)), dtype=np.float64)
        done = 0
        for data, pos, shape in page.segments():
            if data is None:
                continue
            # pos: (separate sample, depth, row, column, contig sample); shape: (depth, rows, columns, samples)
            y0, x0 = int(pos[2]), int(pos[3])
            a = np.asarray(data, dtype=np.float64).reshape(shape[1], shape[2], -1)[:, :, 0]
            a = np.where(np.isfinite(a) & (a > 0), a, 0.0)
            ys = (np.arange(a.shape[0]) + y0) // F
            xs = (np.arange(a.shape[1]) + x0) // F
            ok_y, ok_x = (ys < out.shape[0]) & (np.arange(a.shape[0]) + y0 < H), (xs < out.shape[1]) & (np.arange(a.shape[1]) + x0 < W)
            a = a[ok_y][:, ok_x]
            np.add.at(out, (ys[ok_y][:, None], xs[ok_x][None, :]), a)
            done += 1
            if done % 2000 == 0:
                print(f"  {done} pieces", flush=True)
    total = out.sum()
    mx = float(out.max())
    img = np.round(np.log10(1 + out) / math.log10(1 + mx) * 255).astype(np.uint8)
    # the grid starts at lon0, lat0 (top-left); pad to the whole world if it doesn't cover it all
    full = np.zeros((round(180 / (dy * F)), round(360 / (dx * F))), dtype=np.uint8)
    r0, c0 = round((90 - lat0) / (dy * F)), round((lon0 + 180) / (dx * F))
    full[r0:r0 + img.shape[0], c0:c0 + img.shape[1]] = img[:full.shape[0] - r0, :full.shape[1] - c0]
    Image.fromarray(full, "L").save(os.path.join(OUT, "popgrid.png"), optimize=True)
    # a lighter copy for phones: 4x4 cells added together (10 arc-minutes), same log scale
    small_people = full_people = None
    lin = np.where(full > 0, 10 ** (full / 255 * math.log10(1 + mx)) - 1, 0.0)
    h4, w4 = full.shape[0] // 4, full.shape[1] // 4
    small_people = lin[:h4 * 4, :w4 * 4].reshape(h4, 4, w4, 4).sum(axis=(1, 3))
    mx4 = float(small_people.max())
    Image.fromarray(np.round(np.log10(1 + small_people) / math.log10(1 + mx4) * 255).astype(np.uint8), "L").save(os.path.join(OUT, "popgrid_small.png"), optimize=True)
    json.dump(dict(source=f"GHS-POP R2023A, epoch {year} (European Commission, Joint Research Centre), CC BY 4.0",
                   w=full.shape[1], h=full.shape[0], cell_deg=dx * F, max_people=round(mx), people=round(total),
                   small=dict(w=w4, h=h4, cell_deg=dx * F * 4, max_people=round(mx4)),
                   value="pixel = round(log10(1 + people in the cell) / log10(1 + max_people) * 255)"),
              open(os.path.join(OUT, "popgrid.json"), "w"), indent=1)
    print(f"Wrote public_data/popgrid.png: {full.shape[1]} x {full.shape[0]}, {total / 1e9:.2f} billion people, "
          f"{os.path.getsize(os.path.join(OUT, 'popgrid.png')) / 1e6:.1f} MB")


if __name__ == "__main__":
    main()
