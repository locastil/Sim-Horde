// Where the simulated people live, and how they feel: lights over every town of 5,000 people or more (GeoNames),
// each country's people shared out among its towns by size, so the glow from space is the same people you see
// close up; coloured like the happiness meter (red where people are unhappy, teal where they're
// happy). Countries at war dim and flicker. It shows where the world's people are, not each simulated person.
import * as THREE from "/vendor/three.min.js";

const D = Math.PI / 180;
const BUDGET = { low: 20000, medium: 60000, high: 160000, epic: 320000 };   // lights on screen: a strong card draws far more
// countries the horde simulates in more detail (more simulated people) get more lights
const DETAIL = { Low: 0.6, Medium: 0.75, High: 0.9, Ultra: 1 };

// the same colours as the happiness meter under the globe. The scale reads the 0-10 life rating as it is: red
// at 3 or below, amber around 4.5, yellow at 6 (middling), green only at 7.5 and up (very few countries), teal at 9
// (a little more saturated than the meter, since small lights on a dark globe read paler)
const STOPS = [[3.0, [1.0, 0.24, 0.18]], [4.5, [1.0, 0.5, 0.12]], [6.0, [1.0, 0.8, 0.15]], [7.5, [0.25, 0.9, 0.5]], [9.0, [0.1, 0.78, 1.0]]];
function moodColor(h) {
  if (h == null) return [0.85, 0.85, 0.8];
  if (h <= STOPS[0][0]) return STOPS[0][1];
  for (let i = 1; i < STOPS.length; i++) if (h <= STOPS[i][0]) {
    const [a, ca] = STOPS[i - 1], [b, cb] = STOPS[i], f = (h - a) / (b - a);
    return ca.map((v, k) => v + f * (cb[k] - v));
  }
  return STOPS[STOPS.length - 1][1];
}

// is a point on this country's land? (rings are flat lon, lat, lon, lat... arrays, as the globe loads them)
function landTest(rings) {
  if (!rings || !rings.length) return null;                 // no outline on this map (small territories)
  const boxes = rings.map((r) => { let a = 180, b = -180, c = 90, d = -90; for (let i = 0; i < r.length; i += 2) { a = Math.min(a, r[i]); b = Math.max(b, r[i]); c = Math.min(c, r[i + 1]); d = Math.max(d, r[i + 1]); } return [a, b, c, d]; });
  return (x, y) => {
    for (let k = 0; k < rings.length; k++) {
      const [a, b, c, d] = boxes[k]; if (x < a || x > b || y < c || y > d) continue;
      const r = rings[k]; let inside = false;
      for (let i = 0, j = r.length - 2; i < r.length; j = i, i += 2) {
        const xi = r[i], yi = r[i + 1], xj = r[j], yj = r[j + 1];
        if ((yi > y) !== (yj > y) && x < ((xj - xi) * (y - yi)) / (yj - yi) + xi) inside = !inside;
      }
      if (inside) return true;
    }
    return false;
  };
}

function put(arr, i, lon, lat, r) {
  const phi = (lon + 180) * D, la = lat * D, c = Math.cos(la);
  arr[i * 3] = -Math.cos(phi) * c * r; arr[i * 3 + 1] = Math.sin(la) * r; arr[i * 3 + 2] = Math.sin(phi) * c * r;
}
const gauss = () => { let u = 0; while (!u) u = Math.random(); return Math.sqrt(-2 * Math.log(u)) * Math.cos(2 * Math.PI * Math.random()); };

// a soft round glow, so the dots blend into lit areas instead of looking like squares
function glowTexture() {
  const c = document.createElement("canvas"); c.width = c.height = 32;
  const g = c.getContext("2d"), r = g.createRadialGradient(16, 16, 0, 16, 16, 16);
  r.addColorStop(0, "rgba(255,255,255,1)"); r.addColorStop(0.45, "rgba(255,255,255,.9)"); r.addColorStop(0.7, "rgba(255,255,255,.25)"); r.addColorStop(1, "rgba(255,255,255,0)");
  g.fillStyle = r; g.fillRect(0, 0, 32, 32);
  return new THREE.CanvasTexture(c);
}

// every town of 5,000+ (the same list the close-up names come from), fetched once and shared
let TOWNS = null, townsP = null;
// the United States county by county, when the finer levels have run it: each county's simulated happiness, and
// its centre, so a US town takes the colour of its nearest county (/api/v1/us_counties)
let COUNTY = null, countyP = null, countyStamp = 0;
export function loadCounties() {
  if (!countyP) countyP = fetch("/api/v1/us_counties").then((r) => r.json()).then((j) => {
    if (!j || !j.pts || !j.pts.length) return null;
    const grid = new Map();
    for (const [f, la, lo, h] of j.pts) { const k = Math.floor(lo) + ":" + Math.floor(la); if (!grid.has(k)) grid.set(k, []); grid.get(k).push([lo, la, h]); }
    COUNTY = { grid, level: j.level }; countyStamp++; return COUNTY;
  }).catch(() => null);
  return countyP;
}
function countyHappy(lon, lat) {
  if (!COUNTY) return null;
  let best = null, bd = 1e9;
  for (let dx = -1; dx <= 1; dx++) for (let dy = -1; dy <= 1; dy++)
    for (const [lo, la, h] of COUNTY.grid.get((Math.floor(lon) + dx) + ":" + (Math.floor(lat) + dy)) || []) {
      const d = (lo - lon) * (lo - lon) * Math.cos(lat * D) ** 2 + (la - lat) * (la - lat);
      if (d < bd) { bd = d; best = h; }
    }
  return best;
}

// where people actually live: the GHS-POP population grid (European Commission JRC, CC BY 4.0), people per
// ~4.6 km cell (2.5 arc-minutes; 10 on phones), so the lights show suburbs, sprawl and scattered homes as they are.
// The close-up layer (local.js, osm.js) takes its density from the same grid, so zooming in splits the same glow.
let GRID = null, gridP = null, gridStamp = 0;
export function loadGrid(small) {
  if (!gridP) gridP = (async () => {
    try {
      const test = /[?&]popgrid=test\b/.test(location.search) ? "_test" : "";        // a stand-in grid, for checking the drawing only
      const meta = await fetch(`/geo/popgrid${test}.json`).then((r) => (r.ok ? r.json() : null));
      const m = meta && (small ? meta.small : meta);
      if (!m) return null;
      const img = await new Promise((ok, no) => { const i = new Image(); i.onload = () => ok(i); i.onerror = no; i.src = test ? "/geo/popgrid_test.png" : small ? "/geo/popgrid_small.png" : "/geo/popgrid.png"; });
      const c = document.createElement("canvas"); c.width = m.w; c.height = m.h;
      const x = c.getContext("2d", { willReadFrequently: true }); x.drawImage(img, 0, 0);
      const rgba = x.getImageData(0, 0, m.w, m.h).data, v = new Uint8Array(m.w * m.h);
      for (let i = 0; i < v.length; i++) v[i] = rgba[i * 4];
      GRID = { w: m.w, h: m.h, cd: m.cell_deg, v, L: Math.log10(1 + m.max_people) / 255 }; gridStamp++;
      return GRID;
    } catch (e) { return null; }
  })();
  return gridP;
}
const cellPeople = (b) => (b ? Math.pow(10, b * GRID.L) - 1 : 0);
// how bright a cell glows by how many live in it: a few scattered homes are a faint haze, a farm town a clear
// glow, a city full strength (by headcount, so empty desert with one ranch stays dark-ish rather than lit up)
let LUM = null;
function lum() {
  LUM = new Float32Array(256);
  for (let b = 1; b < 256; b++) { const t = Math.max(0, Math.min(1, (Math.log10(cellPeople(b) + 1) - 0.5) / 4.2)); LUM[b] = 0.035 + 0.965 * Math.pow(t, 1.5); }
}
// people per km² at a point, from the grid (null until it's loaded)
export function gridDensity(lon, lat) {
  if (!GRID) return null;
  const r = Math.floor((90 - lat) / GRID.cd), c = Math.floor((((lon + 180) % 360) + 360) % 360 / GRID.cd);
  if (r < 0 || r >= GRID.h) return 0;
  const km2 = GRID.cd * 111.32 * Math.max(0.05, Math.cos(lat * D)) * GRID.cd * 110.57;
  return cellPeople(GRID.v[r * GRID.w + c]) / km2;
}

export function loadTowns() {
  if (!townsP) townsP = fetch("/geo/towns.json").then((r) => r.json()).then((j) => (TOWNS = j.towns)).catch(() => null);
  return townsP;
}

// Where every country's people live, as places with a share of its people each: every town of 5,000+ when
// the towns are in (each takes its country's people in proportion to its size, and the countryside around
// it), otherwise the country's main cities. The far-off lights (here) and the close-up people (local.js,
// osm.js) both use this list, so zooming in splits the same glow into the same people.
const placesMemo = new WeakMap();
export function townPlaces(d) {
  const key = d.globe || d;
  const hit = placesMemo.get(key);
  if (hit && hit.towns === !!TOWNS && hit.cities === d.cities && hit.county === countyStamp) return hit.v;
  const { globe, cities, shapes } = d;
  const G = (globe && globe.nations) || {}, C = (cities && cities.cities) || {};
  const places = [];
  let total = 0;
  // with the towns in: each town takes its country's people in proportion to its size (and the countryside
  // around it). A town belongs to the country of the nearest listed city whose land it's on.
  const townBased = new Set();
  if (TOWNS) {
    // which country a town is in: the countries whose outline box holds it, smallest first, tested against
    // the outline itself; places with no outline (small territories) go to the nearest listed city's country
    const boxes = [], near = [];
    for (const [num, list] of Object.entries(C)) {
      const rings = shapes && shapes.get(num), L = landTest(rings);
      if (L) {
        let a = 180, b = -180, c = 90, e = -90;
        for (const r of rings) for (let i = 0; i < r.length; i += 2) { a = Math.min(a, r[i]); b = Math.max(b, r[i]); c = Math.min(c, r[i + 1]); e = Math.max(e, r[i + 1]); }
        boxes.push([num, a, b, c, e, (b - a) * (e - c), L]);
      } else for (const ct of list) near.push([num, ct[2], ct[1]]);
    }
    boxes.sort((p, q) => p[5] - q[5]);
    const owner = (lo, la) => {
      for (const [num, a, b, c, e, , L] of boxes) if (lo >= a && lo <= b && la >= c && la <= e && L(lo, la)) return num;
      let best = null, bd = 0.6;                                  // within ~60 km of a small place's city
      for (const [num, x, y] of near) { const d = Math.hypot(x - lo, y - la); if (d < bd) { bd = d; best = num; } }
      return best;
    };
    const lands = {}; for (const bx of boxes) lands[bx[0]] = bx[6];
    const byNum = {};
    for (const [, la, lo, tp] of TOWNS) { const num = owner(lo, la); if (num) (byNum[num] = byNum[num] || []).push([lo, la, tp]); }
    for (const [num, ts] of Object.entries(byNum)) {
      const g = G[num] || {}; if (!g.pop) continue;
      const tsum = ts.reduce((a, t) => a + t[2], 0) || 1;
      townBased.add(num);
      for (const [lo, la, tp] of ts) {
        const people = g.pop * (tp / tsum);
        const ch = num === "840" ? countyHappy(lo, la) : null;          // a US town: its county's colour, when counties ran
        places.push({ num, lon: lo, lat: la, people, cp: tp, town: true, war: !!g.conflict, mood: moodColor(ch != null ? ch : g.happiness), detail: DETAIL[g.detail] || 0.6, land: lands[num] || (() => true), outline: !!lands[num] });
        total += people;
      }
    }
  }
  // countries with no towns listed (or before the towns arrive): the country's people shared out by city size
  for (const [num, list] of Object.entries(C)) {
    if (townBased.has(num)) continue;
    const g = G[num] || {}, pop = g.pop || list.reduce((a, c) => a + c[3], 0) * 3;
    const csum = list.reduce((a, c) => a + c[3], 0) || 1;
    for (const [, lat, lon, cp] of list) {
      const people = pop * (cp / csum);                    // includes the towns and countryside nearest each city
      places.push({ num, lon, lat, people, cp, war: !!g.conflict, mood: moodColor(g.happiness), detail: DETAIL[g.detail] || 0.6, land: landTest(shapes && shapes.get(num)) || (() => true), outline: !!(shapes && shapes.get(num) && shapes.get(num).length) });
      total += people;
    }
  }
  // how far each place's people spread (degrees): towns sit close together, so each one's spread is small; a
  // country shown only by its big cities spreads wide. Without a coastline to keep them on land (small
  // territories like Hong Kong), they stay close.
  for (const p of places) p.spread = p.town ? Math.min(p.outline ? 0.6 : 0.1, 0.03 + Math.sqrt(p.people / 1e6) * 0.09)
    : Math.min(p.outline ? 2.6 : 0.12, 0.1 + Math.sqrt(p.people / 1e6) * 0.17);
  const v = { places, total };
  placesMemo.set(key, { towns: !!TOWNS, cities: d.cities, county: countyStamp, v });
  return v;
}

export function addPeople(world, tier, data) {
  const group = new THREE.Group();
  world.add(group);
  let pts = null, t = 0;
  const still = matchMedia("(prefers-reduced-motion: reduce)").matches;

  function clear() {
    for (const o of [...group.children]) { group.remove(o); o.geometry && o.geometry.dispose(); if (o.material) { o.material.map && o.material.map.dispose(); o.material.dispose(); } }
    pts = null;
  }

  // the glow: the whole population grid painted onto the globe, every ~5 km cell lit by how many live there and
  // coloured by how they rate their lives, so sprawl, suburbs and farm country all show from space at any zoom.
  // Kept apart from the dots (repainted at most every 20 s; a month's change in colour is small).
  let glow = null, glowAt = 0;
  function paintGlow(fcol, fwar, f, fw) {
    const now = performance.now();
    if (glow && now - glowAt < 20000) return;
    glowAt = now;
    if (!LUM) lum();
    const { w, h, v } = GRID, TW = Math.min(w, tier === "epic" ? 8192 : 4096), TH = TW / 2;
    const data = glow ? glow.material.map.image.data : new Uint8Array(TW * TH * 4);
    for (let y = 0; y < TH; y++) {
      const r = Math.floor(((TH - 1 - y) * h) / TH), fr = ((r / f) | 0) * fw;      // texture rows run south to north
      for (let x = 0; x < TW; x++) {
        const c = Math.floor((x * w) / TW), b = v[r * w + c], o = (y * TW + x) * 4;
        if (!b) { data[o] = data[o + 1] = data[o + 2] = data[o + 3] = 0; continue; }
        const fi = fr + ((c / f) | 0), k = LUM[b], m = fwar[fi] ? 0.5 : 1;
        data[o] = 255 * Math.min(1, fcol[fi * 3] * k * m); data[o + 1] = 255 * Math.min(1, fcol[fi * 3 + 1] * k * m);
        data[o + 2] = 255 * Math.min(1, fcol[fi * 3 + 2] * k * m); data[o + 3] = 255;
      }
    }
    if (glow) { glow.material.map.needsUpdate = true; return; }
    const tex = new THREE.DataTexture(data, TW, TH, THREE.RGBAFormat);
    tex.magFilter = THREE.LinearFilter; tex.minFilter = THREE.LinearFilter; tex.needsUpdate = true;
    glow = new THREE.Mesh(new THREE.SphereGeometry(1.0003, 256, 128),
      new THREE.MeshBasicMaterial({ map: tex, transparent: true, opacity: 0.95, blending: THREE.AdditiveBlending, depthWrite: false }));
    world.add(glow);
  }

  let last = null;
  function setData(d) {
    last = d;
    if (!TOWNS) loadTowns().then(() => { if (TOWNS && last === d) setData(d); });
    if (!COUNTY) loadCounties().then((c) => { if (c && last === d) { setData(d); window.dispatchEvent(new Event("simhorde:counties")); } });
    if (!GRID) loadGrid(tier === "low" || tier === "medium").then((g) => { if (g && last === d) { setData(d); window.dispatchEvent(new Event("simhorde:grid")); } });
    clear();
    const { places, total } = townPlaces(d);
    if (!places.length) return;
    const budget = BUDGET[tier] || BUDGET.medium;
    const pos = [], col = [], base = [], tpos = [], tcol = [], tbase = [];
    if (GRID && places.some((p) => p.town)) {
      // lights where the grid says people live, in proportion; each takes the colour of the country of the nearest
      // town (a US town: its county), and the big cities keep a bright core
      const bk = new Map(), key = (lo, la) => Math.floor(lo) + ":" + Math.floor(la);
      for (const p of places) { const k = key(p.lon, p.lat); if (!bk.has(k)) bk.set(k, []); bk.get(k).push(p); }
      const nearest = (lo, la) => {
        for (const R of [1, 3, 8]) {                           // remote places: look further for a town to take the colour from
          let best = null, bd = 1e9;
          for (let dx = -R; dx <= R; dx++) for (let dy = -R; dy <= R; dy++)
            for (const p of bk.get((Math.floor(lo) + dx) + ":" + (Math.floor(la) + dy)) || []) {
              const q = (p.lon - lo) * (p.lon - lo) * Math.cos(la * D) ** 2 + (p.lat - la) * (p.lat - la);
              if (q < bd) { bd = q; best = p; }
            }
          if (best) return best;
        }
        return null;
      };
      const { w, h, cd, v } = GRID;
      let everyone = 0;
      for (let i = 0; i < v.length; i++) if (v[i]) everyone += cellPeople(v[i]);
      const per = budget / everyone;
      // a floor: every populated patch (about 18 km; 37 km on low) shows at least one light, dimmer where few live
      const f = Math.max(1, Math.round((tier === "low" ? 1 / 3 : 1 / 6) / cd)), fw = Math.ceil(w / f), fh = Math.ceil(h / f);
      const fmax = new Uint8Array(fw * fh), lit = new Uint8Array(fw * fh);
      for (let r = 0; r < h; r++) {
        const la0 = 90 - (r + 1) * cd;
        for (let c = 0; c < w; c++) {
          const b = v[r * w + c];
          if (!b) continue;
          const fi = ((r / f) | 0) * fw + ((c / f) | 0); if (b > fmax[fi]) fmax[fi] = b;
          const want = cellPeople(b) * per, n = Math.floor(want) + (Math.random() < want % 1 ? 1 : 0);
          if (!n) continue;
          const lo0 = -180 + c * cd, p = nearest(lo0 + cd / 2, la0 + cd / 2);
          if (!p) continue;
          const bright = 0.4 + 0.6 * (b / 255);
          lit[fi] = 1;
          for (let k = 0; k < n; k++) {
            const lo = lo0 + Math.random() * cd, la = la0 + Math.random() * cd;
            const ch = p.num === "840" ? countyHappy(lo, la) : null, mood = ch != null ? moodColor(ch) : p.mood;
            tpos.push([lo, la]); tcol.push(mood.map((x) => x * bright * (0.75 + 0.25 * Math.random()))); tbase.push(p.war);
          }
        }
      }
      const fcd = cd * f, fcol = new Float32Array(fmax.length * 3), fwar = new Uint8Array(fmax.length);
      for (let fi = 0; fi < fmax.length; fi++) {
        if (!fmax[fi]) continue;
        const lo = -180 + ((fi % fw) + 0.5) * fcd, la = 90 - (((fi / fw) | 0) + 0.5) * fcd;
        const p = nearest(lo, la);
        const ch = p && p.num === "840" ? countyHappy(lo, la) : null, mood = ch != null ? moodColor(ch) : p ? p.mood : [0.75, 0.7, 0.6];
        fcol.set(mood, fi * 3); fwar[fi] = p && p.war ? 1 : 0;
        if (lit[fi]) continue;
        if (!LUM) lum();
        if (LUM[fmax[fi]] < 0.08) continue;                    // the glow already shows the emptiest places
        const bright = 0.15 + 0.6 * LUM[fmax[fi]];
        tpos.push([lo + (Math.random() - 0.5) * fcd, la + (Math.random() - 0.5) * fcd]); tcol.push(mood.map((x) => x * bright)); tbase.push(p ? p.war : false);
      }
      paintGlow(fcol, fwar, f, fw);
      for (const p of places) if (p.cp > 150000) { pos.push([p.lon, p.lat]); col.push(p.mood.map((x) => x * Math.min(1, 0.55 + Math.log10(p.cp + 10) / 12))); base.push(p.war); }
    }
    for (const p of (GRID && places.some((q) => q.town)) ? [] : places) {
      const want = (p.people / total) * budget * p.detail;
      const n = p.town ? Math.floor(want) + (Math.random() < want % 1 ? 1 : 0) : Math.max(1, Math.round(want));
      // the place itself: a bright core (towns: only the bigger ones, so small towns read as soft glow)
      const b0 = Math.min(1, 0.55 + Math.log10(p.cp + 10) / 12);
      const core = !p.town || p.cp > 150000;
      if (core) { pos.push([p.lon, p.lat]); col.push(p.mood.map((v) => v * b0)); base.push(p.war); }
      const spread = p.spread;
      for (let k = core ? 1 : 0; k < n; k++) {
        let r, lo, la, tries = 0;
        do {                                                   // towns only on the country's own land, never at sea
          r = spread * Math.pow(Math.random(), 1.8) * 1.6; const a = Math.random() * Math.PI * 2;
          la = p.lat + r * Math.sin(a); lo = p.lon + (r * Math.cos(a)) / Math.max(0.2, Math.cos(p.lat * D));
        } while (!p.land(lo, la) && ++tries < 6);
        if (tries >= 6) continue;
        tpos.push([lo, la]);
        const b = p.town ? 0.55 + 0.45 * Math.random() * Math.exp(-r / spread) : 0.35 + 0.45 * Math.random() * Math.exp(-r / spread);
        tcol.push(p.mood.map((v) => v * b)); tbase.push(p.war);
      }
    }
    const big = tier === "epic" || tier === "high";
    const layer = (list, colors, wars, size) => {
      const P = new Float32Array(list.length * 3), Cc = new Float32Array(list.length * 3), f = [];
      list.forEach(([lo, la], i) => { put(P, i, lo, la, 1.00004); Cc.set(colors[i], i * 3); if (wars[i]) f.push(i); });
      for (const i of f) for (let k = 0; k < 3; k++) Cc[i * 3 + k] *= 0.45;        // war: lights at about half strength
      const geo = new THREE.BufferGeometry();
      geo.setAttribute("position", new THREE.BufferAttribute(P, 3));
      geo.setAttribute("color", new THREE.BufferAttribute(Cc, 3));
      geo.userData.base = Cc.slice(); geo.userData.flick = f;
      const pt = new THREE.Points(geo, new THREE.PointsMaterial({ size, sizeAttenuation: false, map: glowTexture(), vertexColors: true, transparent: true, opacity: 0.95, depthWrite: false }));
      group.add(pt); return pt;
    };
    pts = [layer(tpos, tcol, tbase, big ? 2.0 : 1.7), layer(pos, col, base, big ? 2.8 : 2.3)];
  }

  function update(dt) {
    if (!pts || still) return;
    t += dt;
    if (t < 0.25) return;                                    // blackouts flicker a few times a second
    t = 0;
    for (const pt of pts) {
      const g = pt.geometry, f = g.userData.flick; if (!f.length) continue;
      const c = g.attributes.color.array, b = g.userData.base;
      for (let n = 0; n < Math.min(200, f.length); n++) {
        const i = f[(Math.random() * f.length) | 0], m = Math.random() < 0.3 ? 0.1 : 1;
        for (let k = 0; k < 3; k++) c[i * 3 + k] = b[i * 3 + k] * m;
      }
      g.attributes.color.needsUpdate = true;
    }
  }

  if (data) setData(data);
  return {
    setFade: (f) => { group.visible = f > 0.01; for (const o of group.children) o.material.opacity = 0.95 * f; if (glow) { glow.visible = f > 0.01; glow.material.opacity = 0.95 * f; } },
    setData, update,
    dispose: () => { clear(); world.remove(group); if (glow) { world.remove(glow); glow.geometry.dispose(); glow.material.map.dispose(); glow.material.dispose(); glow = null; } },
  };
}
