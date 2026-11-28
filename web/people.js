// Where the simulated people live, and how they feel: lights over every town of 5,000 people or more (GeoNames),
// each country's people shared out among its towns by size, so the glow from space is the same people you see
// close up; coloured like the happiness meter (red where people are unhappy, teal where they're
// happy). Countries at war dim and flicker. It shows where the world's people are, not each simulated person.
import * as THREE from "/vendor/three.min.js";

const D = Math.PI / 180;
const BUDGET = { low: 20000, medium: 60000, high: 160000, epic: 320000 };   // lights on screen: a strong card draws far more
// countries the horde simulates in more detail (more simulated people) get more lights
const DETAIL = { Low: 0.6, Medium: 0.75, High: 0.9, Ultra: 1 };

// the same colours as the happiness meter under the globe
// (a little more saturated than the meter, since small lights on a dark globe read paler)
const STOPS = [[3.0, [1.0, 0.24, 0.18]], [4.5, [1.0, 0.5, 0.12]], [5.6, [1.0, 0.8, 0.15]], [6.6, [0.25, 0.9, 0.5]], [7.6, [0.1, 0.78, 1.0]]];
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
  if (hit && hit.towns === !!TOWNS && hit.cities === d.cities) return hit.v;
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
        places.push({ num, lon: lo, lat: la, people, cp: tp, town: true, war: !!g.conflict, mood: moodColor(g.happiness), detail: DETAIL[g.detail] || 0.6, land: lands[num] || (() => true), outline: !!lands[num] });
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
  placesMemo.set(key, { towns: !!TOWNS, cities: d.cities, v });
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

  let last = null;
  function setData(d) {
    last = d;
    if (!TOWNS) loadTowns().then(() => { if (TOWNS && last === d) setData(d); });
    clear();
    const { places, total } = townPlaces(d);
    if (!places.length) return;
    const budget = BUDGET[tier] || BUDGET.medium;
    const pos = [], col = [], base = [], tpos = [], tcol = [], tbase = [];
    for (const p of places) {
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
  return { setFade: (f) => { group.visible = f > 0.01; for (const o of group.children) o.material.opacity = 0.95 * f; }, setData, update, dispose: () => { clear(); world.remove(group); } };
}
