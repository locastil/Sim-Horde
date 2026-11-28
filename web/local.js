// Close up on the globe: the simulated people and their cars, drawn as tiny dots on the globe itself.
// Nothing switches to a map. The ground is divided into cells; each cell's dots come from a fixed seed, so the
// same place always shows the same people, and zooming blends one level of cells into the next instead of
// swapping them. Where a dot stands for many people (zoomed out), the label says how many.
// It's an illustration of the simulation: where its people live, how happy they are, how busy the roads are.
import * as THREE from "/vendor/three.min.js";

const D = Math.PI / 180, KX = 111.32, KY = 110.57, R = 1.00003;
const BUDGET = { low: [6000, 900], medium: [14000, 2000], high: [30000, 4000], epic: [50000, 7000] };   // [people, cars] per level
const DMAX = 9000;                              // people per km² that the densest dots are planned for
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
function landTest(rings) {
  if (!rings || !rings.length) return () => true;
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
function rng(a) { return () => { a |= 0; a = (a + 0x6d2b79f5) | 0; let t = Math.imul(a ^ (a >>> 15), 1 | a); t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t; return ((t ^ (t >>> 14)) >>> 0) / 4294967296; }; }
const hash = (a, b, c) => (Math.imul(a, 73856093) ^ Math.imul(b, 19349663) ^ Math.imul(c, 83492791)) | 0;
function put(arr, i, lon, lat) {
  const phi = (lon + 180) * D, la = lat * D, c = Math.cos(la);
  arr[i * 3] = -Math.cos(phi) * c * R; arr[i * 3 + 1] = Math.sin(la) * R; arr[i * 3 + 2] = Math.sin(phi) * c * R;
}
function dotTexture() {
  const c = document.createElement("canvas"); c.width = c.height = 16;
  const g = c.getContext("2d"), r = g.createRadialGradient(8, 8, 0, 8, 8, 8);
  r.addColorStop(0, "rgba(255,255,255,1)"); r.addColorStop(0.55, "rgba(255,255,255,.85)"); r.addColorStop(1, "rgba(255,255,255,0)");
  g.fillStyle = r; g.fillRect(0, 0, 16, 16);
  return new THREE.CanvasTexture(c);
}

export function addLocal(world, tier) {
  const group = new THREE.Group(); world.add(group);
  const [PB, CB] = BUDGET[tier] || BUDGET.medium;
  const tex = dotTexture();
  const still = matchMedia("(prefers-reduced-motion: reduce)").matches;
  let cities = [], buckets = new Map(), ready = false, t = 0, lastScale = "";
  const cells = new Map();                                   // "L:i:j" -> generated dots, kept while nearby
  const levels = new Map();                                  // L -> { key, pPts, cPts, meta }

  // every city stands for its share of its country's people: a dense core and a wide spread of suburbs and towns
  function setData({ globe, cities: C, shapes }) {
    const G = (globe && globe.nations) || {}, list = (C && C.cities) || {};
    cities = []; buckets = new Map(); cells.clear();
    const lands = new Map();
    for (const [num, rows] of Object.entries(list)) {
      const g = G[num] || {}, csum = rows.reduce((a, c) => a + c[3], 0) || 1, pop = g.pop || csum * 3;
      if (!lands.has(num)) lands.set(num, landTest(shapes && shapes.get(num)));
      rows.forEach(([, lat, lon, cp], k) => {
        const people = pop * (cp / csum);
        const s2 = 8 + Math.sqrt(people / 1000) * 0.7, s1 = Math.max(1.5, 1 + Math.sqrt(cp / 1000) * 0.18);
        const c = { lon, lat, people, cp, s1, s2, mood: moodColor(g.happiness), war: !!g.conflict, protest: !!g.protests,
                    land: lands.get(num), angle: (hash(+num, k, 7) >>> 0) / 4294967296 * Math.PI / 2, id: hash(+num, k, 1) };
        cities.push(c);
        const bk = Math.floor(lon / 5) + ":" + Math.floor(lat / 5);
        if (!buckets.has(bk)) buckets.set(bk, []); buckets.get(bk).push(c);
      });
    }
    for (const lv of levels.values()) drop(lv);
    levels.clear(); ready = cities.length > 0;
  }
  function near(lon, lat, km) {
    const out = [], dLat = km / KY, dLon = km / (KX * Math.max(0.15, Math.cos(lat * D)));
    for (let x = Math.floor((lon - dLon) / 5); x <= Math.floor((lon + dLon) / 5); x++)
      for (let y = Math.floor((lat - dLat) / 5); y <= Math.floor((lat + dLat) / 5); y++) {
        const b = buckets.get((((x + 36) % 72 + 72) % 72 - 36) + ":" + y); if (b) out.push(...b);
      }
    return out;
  }
  // people per km² at a point, and the city that contributes the most
  function density(cs, lon, lat) {
    let d = 0, best = null, bw = 0;
    for (const c of cs) {
      const dx = (lon - c.lon) * KX * Math.cos(lat * D), dy = (lat - c.lat) * KY, r2 = dx * dx + dy * dy;
      const w = c.people * (0.35 * Math.exp(-r2 / (2 * c.s1 * c.s1)) / (6.283 * c.s1 * c.s1) + 0.65 * Math.exp(-r2 / (2 * c.s2 * c.s2)) / (6.283 * c.s2 * c.s2));
      d += w; if (w > bw) { bw = w; best = c; }
    }
    return [d, best];
  }

  const cellDeg = (L) => 360 / Math.pow(2, L);
  function cell(L, i, j, perP, perC) {
    const key = L + ":" + i + ":" + j;
    let c = cells.get(key); if (c) { c.used = t; return c; }
    const s = cellDeg(L), lon0 = i * s - 180, lat0 = j * s - 90, mid = lat0 + s / 2;
    const wkm = s * KX * Math.max(0.05, Math.cos(mid * D)), hkm = s * KY, area = wkm * hkm;
    const cs = near(lon0 + s / 2, mid, Math.hypot(wkm, hkm) / 2 + 40);
    const rnd = rng(hash(L, i, j));
    const P = [], Cr = [];
    if (cs.length) {
      let sum = 0, mx = 0;                                   // how many people live here: a 5 x 5 sample of the cell
      for (let a = 0; a < 5; a++) for (let b = 0; b < 5; b++) { const [d] = density(cs, lon0 + (a + 0.5) * s / 5, lat0 + (b + 0.5) * s / 5); sum += d; mx = Math.max(mx, d); }
      const people = (sum / 25) * area;
      const ppd = Math.max(1, Math.ceil((DMAX * area) / perP));            // people per dot at this level
      const cpd = Math.max(1, Math.ceil((DMAX * 0.05 * area) / perC));
      const want = Math.min(perP * 2, Math.floor(people / ppd + rnd()));
      mx = Math.max(mx * 1.4, 1e-9);
      for (let n = 0, tries = 0; n < want && tries < want * 8; tries++) {
        const lo = lon0 + rnd() * s, la = lat0 + rnd() * s, [d, ct] = density(cs, lo, la);
        if (rnd() * mx > d || !ct || !ct.land(lo, la)) continue;
        n++;
        const b = (0.45 + 0.55 * rnd()) * (ct.war ? 0.45 : 1);
        P.push(lo, la, ct.mood[0] * b, ct.mood[1] * b, ct.mood[2] * b, rnd() * 6.283, 0.3 + rnd());
        // cars: on a street grid laid out around the nearest city, fewer where there's fighting
        if (rnd() < Math.min(1, (0.05 * ppd) / cpd) * (ct.war ? 0.3 : 1)) {
          const ca = Math.cos(ct.angle), sa = Math.sin(ct.angle), cl = Math.cos(la * D);
          const x = (lo - ct.lon) * KX * cl, y = (la - ct.lat) * KY;
          let u = x * ca + y * sa, v = -x * sa + y * ca, axis = rnd() < 0.5;
          const step = 0.16; if (axis) v = Math.round(v / step) * step; else u = Math.round(u / step) * step;
          Cr.push(ct.lon, ct.lat, u, v, axis ? 1 : 0, ct.angle, (0.04 + rnd() * 0.04) * (rnd() < 0.5 ? -1 : 1), rnd() * 10, rnd() < 0.5 ? 1 : 0);
        }
      }
      // protests: crowds in the city centre
      for (const ct of cs) if (ct.protest && Math.abs(ct.lon - (lon0 + s / 2)) < s && Math.abs(ct.lat - mid) < s) {
        const crowd = Math.min(perP / 4, Math.round((ct.cp * 0.01) / ppd));
        for (let n = 0; n < crowd; n++) {
          const r = Math.abs(rnd() * rnd()) * 0.6, a = rnd() * 6.283, lo = ct.lon + (r * Math.cos(a)) / (KX * Math.cos(ct.lat * D)), la = ct.lat + (r * Math.sin(a)) / KY;
          if (lo < lon0 || lo >= lon0 + s || la < lat0 || la >= lat0 + s) continue;
          P.push(lo, la, 1, 0.92, 0.7, rnd() * 6.283, 0.2);
        }
      }
      c = { P: new Float32Array(P), C: new Float32Array(Cr), ppd, used: t };
    } else c = { P: new Float32Array(0), C: new Float32Array(0), ppd: 1, used: t };
    cells.set(key, c);
    if (cells.size > 700) {                                  // forget the cells furthest back in time
      const old = [...cells.entries()].sort((a, b) => a[1].used - b[1].used).slice(0, 200);
      for (const [k] of old) cells.delete(k);
    }
    return c;
  }

  function drop(lv) { for (const o of [lv.pPts, lv.cPts]) if (o) { group.remove(o); o.geometry.dispose(); o.material.dispose(); } }
  function points(n, size) {
    const g = new THREE.BufferGeometry();
    g.setAttribute("position", new THREE.BufferAttribute(new Float32Array(n * 3), 3));
    g.setAttribute("color", new THREE.BufferAttribute(new Float32Array(n * 3), 3));
    const p = new THREE.Points(g, new THREE.PointsMaterial({ size, sizeAttenuation: false, map: tex, vertexColors: true, transparent: true, opacity: 0, depthWrite: false }));
    p.frustumCulled = false; group.add(p); return p;
  }
  // build one level's dots from the cells around the view
  function level(L, lon, lat, halfW, halfH) {
    const s = cellDeg(L), cl = Math.max(0.1, Math.cos(lat * D));
    const i0 = Math.floor((lon - halfW / cl + 180) / s), i1 = Math.floor((lon + halfW / cl + 180) / s);
    const j0 = Math.max(0, Math.floor((lat - halfH + 90) / s)), j1 = Math.floor((lat + halfH + 90) / s);
    const key = [i0, i1, j0, j1].join();
    let lv = levels.get(L);
    if (lv && lv.key === key) { for (const c of lv.list) c.used = t; return lv; }
    const ncell = Math.max(1, (i1 - i0 + 1) * (j1 - j0 + 1));
    const perP = Math.max(40, Math.floor(PB / Math.max(9, ncell * 0.6))), perC = Math.max(8, Math.floor(CB / Math.max(9, ncell * 0.6)));
    const list = [];
    for (let i = i0; i <= i1; i++) for (let j = j0; j <= j1; j++) list.push(cell(L, ((i % (1 << L)) + (1 << L)) % (1 << L), j, perP, perC));
    const np = list.reduce((a, c) => a + c.P.length / 7, 0), nc = list.reduce((a, c) => a + c.C.length / 9, 0);
    if (lv) drop(lv);
    lv = { key, list, ppd: list.find((c) => c.P.length)?.ppd || list[0].ppd, pPts: points(np, 1.6), cPts: points(nc, 2.0), first: true };
    // static colours and the walkers' starting places
    const pc = lv.pPts.geometry.attributes.color.array, pp = lv.pPts.geometry.attributes.position.array;
    let k = 0;
    for (const c of list) for (let q = 0; q < c.P.length; q += 7, k++) { put(pp, k, c.P[q], c.P[q + 1]); pc[k * 3] = c.P[q + 2]; pc[k * 3 + 1] = c.P[q + 3]; pc[k * 3 + 2] = c.P[q + 4]; }
    lv.pPts.geometry.attributes.position.needsUpdate = lv.pPts.geometry.attributes.color.needsUpdate = true;
    levels.set(L, lv);
    return lv;
  }

  // alt: camera height over the ground (earth radius = 1); width: half the view across, in km
  function update(dt, lon, lat, alt, aspect, tagEl) {
    t += dt;
    const on = ready && alt < 0.14;
    group.visible = on;
    if (!on) { if (tagEl && lastScale) { tagEl.hidden = true; lastScale = ""; } return 1; }
    const halfKm = alt * 6371 * Math.tan(16 * D), halfH = (halfKm * 1.35) / KY, halfW = (halfKm * aspect * 1.35) / KX;
    const f = Math.log2((360 * 3) / Math.max(1e-6, (2 * halfKm * aspect) / KX));   // continuous level: about 3 cells across
    const La = Math.floor(f), frac = f - La, show = new Set([La, La + 1]);
    for (const [L, lv] of levels) if (!show.has(L)) { drop(lv); levels.delete(L); }
    const fade = Math.min(1, (0.14 - alt) / 0.05);
    let tagPpd = 1;
    for (const L of show) {
      const lv = level(L, lon, lat, halfW, halfH), op = (L === La ? 1 - frac : frac) * fade;
      lv.pPts.material.opacity = 0.95 * op; lv.cPts.material.opacity = op;
      lv.pPts.visible = lv.cPts.visible = op > 0.01;
      if (L === (frac < 0.5 ? La : La + 1)) tagPpd = lv.ppd;
      // walkers wander a little when you're close enough to see it
      if (!still && alt < 0.004 && lv.pPts.visible) {
        const pp = lv.pPts.geometry.attributes.position.array; let k = 0;
        for (const c of lv.list) for (let q = 0; q < c.P.length; q += 7, k++) {
          const a = c.P[q + 5] + t * 0.05 * c.P[q + 6], r = 0.025 * Math.sin(t * 0.3 * c.P[q + 6] + c.P[q + 5]);
          put(pp, k, c.P[q] + (r * Math.cos(a)) / (KX * Math.cos(c.P[q + 1] * D)), c.P[q + 1] + (r * Math.sin(a)) / KY);
        }
        lv.pPts.geometry.attributes.position.needsUpdate = true;
      }
      // cars drive along their street, fading out where they turn off
      if (lv.cPts.visible || lv.first) {
        lv.first = false;
        const cp = lv.cPts.geometry.attributes.position.array, cc = lv.cPts.geometry.attributes.color.array; let k = 0;
        for (const c of lv.list) for (let q = 0; q < c.C.length; q += 9, k++) {
          const [clon, clat, u0, v0, axis, ang, sp, ph, tail] = c.C.subarray(q, q + 9);
          const seg = 0.9, run = (((still ? 0 : t) * sp + ph) % seg + seg) % seg, glow = Math.sin((run / seg) * Math.PI);
          const u = axis ? u0 + run - seg / 2 : u0, v = axis ? v0 : v0 + run - seg / 2;
          const x = u * Math.cos(ang) - v * Math.sin(ang), y = u * Math.sin(ang) + v * Math.cos(ang);
          const la = clat + y / KY;
          put(cp, k, clon + x / (KX * Math.cos(la * D)), la);
          const g = Math.min(1, glow * 1.6);
          if (tail) { cc[k * 3] = g; cc[k * 3 + 1] = 0.25 * g; cc[k * 3 + 2] = 0.2 * g; } else { cc[k * 3] = g; cc[k * 3 + 1] = 0.93 * g; cc[k * 3 + 2] = 0.75 * g; }
        }
        lv.cPts.geometry.attributes.position.needsUpdate = lv.cPts.geometry.attributes.color.needsUpdate = true;
      }
    }
    if (tagEl) {
      const txt = tagPpd <= 1 ? "Close up: each dot is one person, white and red dots are cars (illustrative)" : `Close up: each dot is about ${tagPpd.toLocaleString()} people, white and red dots are cars (illustrative)`;
      if (txt !== lastScale) { tagEl.textContent = txt; lastScale = txt; }
      tagEl.hidden = fade < 0.3;
    }
    return 1 - fade;                                         // how much of the far-off city lights to keep
  }

  return { setData, update, dispose: () => { for (const lv of levels.values()) drop(lv); world.remove(group); tex.dispose(); } };
}
