// Close up on the globe: the simulated people and their cars, drawn as tiny dots on the globe itself.
// Nothing switches to a map. The ground is divided into cells; each cell's dots come from a fixed seed, so the
// same place always shows the same people, and zooming blends one level of cells into the next instead of
// swapping them. Where a dot stands for many people (zoomed out), the label says how many.
// It's an illustration of the simulation: where its people live, how happy they are, how busy the roads are.
import * as THREE from "/vendor/three.min.js";
import { addOSM } from "/osm.js";

const D = Math.PI / 180, KX = 111.32, KY = 110.57, R = 1.00003;
const BUDGET = { low: [6000, 900], medium: [14000, 2000], high: [30000, 4000], epic: [50000, 7000] };   // [people, cars] per level
const DMAX = 4000;                              // people per km² that the densest dots are planned for
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

// registered vehicles per 1,000 people by country (WHO, via Our World in Data), for how busy the roads are
let VEH = {};
fetch("/geo/vehicles.json").then((r) => r.json()).then((j) => (VEH = j.per1000)).catch(() => {});

export function addLocal(world, tier) {
  const group = new THREE.Group(); world.add(group);
  const [PB, CB] = BUDGET[tier] || BUDGET.medium;
  const tex = dotTexture();
  let real = 0, osm = null;                                  // how far the real streets (osm.js) have taken over
  const still = matchMedia("(prefers-reduced-motion: reduce)").matches;
  let cities = [], buckets = new Map(), ready = false, t = 0, lastScale = "";
  const cells = new Map();                                   // "L:i:j" -> generated dots, kept while nearby
  const levels = new Map();                                  // L -> { key, pPts, cPts, meta }

  // every city stands for its share of its country's people: a dense core and a wide spread of suburbs and towns
  function setData({ globe, cities: C, shapes, base }) {
    const iso = {}; for (const n of (base && base.nations) || []) iso[String(Number(n.num))] = n.c;
    const G = (globe && globe.nations) || {}, list = (C && C.cities) || {};
    cities = []; buckets = new Map(); cells.clear();
    const lands = new Map();
    for (const [num, rows] of Object.entries(list)) {
      const g = G[num] || {}, csum = rows.reduce((a, c) => a + c[3], 0) || 1, pop = g.pop || csum * 3;
      if (!lands.has(num)) lands.set(num, landTest(shapes && shapes.get(num)));
      rows.forEach(([name, lat, lon, cp], k) => {
        const people = pop * (cp / csum);
        const s2 = 8 + Math.sqrt(people / 1000) * 0.7, s1 = Math.max(1.5, 1 + Math.sqrt(cp / 1000) * 0.18);
        const c = { name, iso: iso[String(Number(num))], lon, lat, people, cp, s1, s2, mood: moodColor(g.happiness), war: !!g.conflict, protest: !!g.protests,
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

  // the street grid each city's people and cars use, drawn where people actually live:
  // every street when you're close, only the avenues (every fifth street) further out
  function streets(cs, lon0, lat0, s, wkm) {
    return new Float32Array(0);                              // the generated grid is off: only real streets (osm.js) are drawn
    if (wkm > 40) return new Float32Array(0);
    const step = wkm > 8 ? 0.8 : 0.16, out = [];
    for (const c of cs) {
      const ca = Math.cos(c.angle), sa = Math.sin(c.angle), cl = Math.cos(c.lat * D);
      let umin = 1e9, umax = -1e9, vmin = 1e9, vmax = -1e9;
      for (const [lo, la] of [[lon0, lat0], [lon0 + s, lat0], [lon0, lat0 + s], [lon0 + s, lat0 + s]]) {
        const x = (lo - c.lon) * KX * cl, y = (la - c.lat) * KY, u = x * ca + y * sa, v = -x * sa + y * ca;
        umin = Math.min(umin, u); umax = Math.max(umax, u); vmin = Math.min(vmin, v); vmax = Math.max(vmax, v);
      }
      if (Math.min(Math.abs(umin), Math.abs(umax), Math.abs(vmin), Math.abs(vmax)) > 4 * c.s2 && umin * umax > 0 && vmin * vmax > 0) continue;
      const toLL = (u, v) => { const X = u * ca - v * sa, Y = u * sa + v * ca, la = c.lat + Y / KY; return [c.lon + X / (KX * Math.cos(la * D)), la]; };
      for (let axis = 0; axis < 2; axis++) {
        const [a0, a1, b0, b1] = axis ? [umin, umax, vmin, vmax] : [vmin, vmax, umin, umax];
        for (let b = Math.ceil(b0 / step) * step; b <= b1; b += step) {
          const major = Math.abs(b / 0.8 - Math.round(b / 0.8)) < 1e-6;
          for (let a = Math.floor(a0 / step) * step; a < a1; a += step) {
            const [m0, m1] = axis ? toLL(a + step / 2, b) : toLL(b, a + step / 2);
            if (m0 < lon0 || m0 >= lon0 + s || m1 < lat0 || m1 >= lat0 + s) continue;
            const [d, best] = density(cs, m0, m1);
            if (best !== c) continue;
            // streets thin out with the people: fewer and fainter toward the edge of town, never a hard cut-off
            const w = Math.min(1, Math.max(0, (d - (major ? 15 : 40)) / 1200));
            const keep = (hash(c.id ^ Math.round(b / step), Math.floor(a / (step * 4) + 1e-6), axis + 11) >>> 0) / 4294967296;   // whole stretches of road, not scraps
            if (keep > Math.min(1, w * (major ? 3 : 1.6) + 0.02) || !c.land(m0, m1)) continue;
            const p = axis ? toLL(a, b) : toLL(b, a), q = axis ? toLL(a + step, b) : toLL(b, a + step);
            out.push(p[0], p[1], q[0], q[1], (major ? 1 : 0.55) * (0.35 + 0.65 * w));   // brighter where it's busier
          }
        }
      }
    }
    return new Float32Array(out);
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
        const b = (0.7 + 0.3 * rnd()) * (ct.war ? 0.45 : 1);
        let plo = lo, pla = la;
        P.push(plo, pla, ct.mood[0] * b, ct.mood[1] * b, ct.mood[2] * b, rnd() * 6.283, 0.3 + rnd());
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
      c = { P: new Float32Array(P), C: new Float32Array(Cr), Rd: streets(cs, lon0, lat0, s, wkm), ppd, used: t };
    } else c = { P: new Float32Array(0), C: new Float32Array(0), Rd: new Float32Array(0), ppd: 1, used: t };
    cells.set(key, c);
    if (cells.size > 700) {                                  // forget the cells furthest back in time
      const old = [...cells.entries()].sort((a, b) => a[1].used - b[1].used).slice(0, 200);
      for (const [k] of old) cells.delete(k);
    }
    return c;
  }

  function drop(lv) { for (const o of [lv.pPts, lv.cPts, lv.rLines]) if (o) { group.remove(o); o.geometry.dispose(); o.material.dispose(); } }
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
    lv = { key, list, ppd: list.find((c) => c.P.length)?.ppd || list[0].ppd, pPts: points(np, 2.3), cPts: points(nc, 3.2), first: true };
    // static colours and the walkers' starting places
    const pc = lv.pPts.geometry.attributes.color.array, pp = lv.pPts.geometry.attributes.position.array;
    let k = 0;
    for (const c of list) for (let q = 0; q < c.P.length; q += 7, k++) { put(pp, k, c.P[q], c.P[q + 1]); pc[k * 3] = c.P[q + 2]; pc[k * 3 + 1] = c.P[q + 3]; pc[k * 3 + 2] = c.P[q + 4]; }
    lv.pPts.geometry.attributes.position.needsUpdate = lv.pPts.geometry.attributes.color.needsUpdate = true;
    // the streets, as faint lines under the dots
    const nr = list.reduce((a, c) => a + c.Rd.length / 5, 0), rp = new Float32Array(nr * 6), rc = new Float32Array(nr * 6);
    k = 0;
    for (const c of list) for (let q = 0; q < c.Rd.length; q += 5, k++) {
      put(rp, k * 2, c.Rd[q], c.Rd[q + 1]); put(rp, k * 2 + 1, c.Rd[q + 2], c.Rd[q + 3]);
      const w = c.Rd[q + 4]; for (let e = 0; e < 2; e++) { rc[k * 6 + e * 3] = 0.55 * w; rc[k * 6 + e * 3 + 1] = 0.66 * w; rc[k * 6 + e * 3 + 2] = 0.82 * w; }
    }
    const rg = new THREE.BufferGeometry();
    rg.setAttribute("position", new THREE.BufferAttribute(rp, 3)); rg.setAttribute("color", new THREE.BufferAttribute(rc, 3));
    lv.rLines = new THREE.LineSegments(rg, new THREE.LineBasicMaterial({ vertexColors: true, transparent: true, opacity: 0, depthWrite: false }));
    lv.rLines.frustumCulled = false; lv.rLines.renderOrder = 1; lv.pPts.renderOrder = 2; lv.cPts.renderOrder = 3; group.add(lv.rLines);
    levels.set(L, lv);
    return lv;
  }

  // alt: camera height over the ground (earth radius = 1); width: half the view across, in km
  function update(dt, lon, lat, alt, aspect, tagEl, camera, streetBox) {
    t += dt;
    if (!osm && ready) osm = addOSM(world, tier, { tex, vehicles: (ct) => (ct && VEH[ct.iso]) || null, density: (lo, la) => density(near(lo, la, 60), lo, la) });
    real = osm && camera ? osm.update(dt, lon, lat, alt, aspect, camera, streetBox) : 0;   // real roads from further out; real people close up
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
      const syn = 1 - real; lv.pPts.material.opacity = 0.95 * op * syn; lv.cPts.material.opacity = op * syn; lv.rLines.material.opacity = 0.75 * op * syn; lv.rLines.visible = op * syn > 0.01;
      lv.pPts.visible = lv.cPts.visible = op * (1 - real) > 0.01;
      if (L === (frac < 0.5 ? La : La + 1)) tagPpd = lv.ppd;
      // walkers wander a little when you're close enough to see it
      if (!still && alt < 0.004 && lv.pPts.visible) {
        const pp = lv.pPts.geometry.attributes.position.array; let k = 0;
        for (const c of lv.list) for (let q = 0; q < c.P.length; q += 7, k++) {
          const a = c.P[q + 5] + t * 0.05 * c.P[q + 6], r = 0.012 * Math.sin(t * 0.3 * c.P[q + 6] + c.P[q + 5]);
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
          const g = Math.min(1, glow * 2.2);
          if (tail) { cc[k * 3] = g; cc[k * 3 + 1] = 0.25 * g; cc[k * 3 + 2] = 0.2 * g; } else { cc[k * 3] = g; cc[k * 3 + 1] = 0.97 * g; cc[k * 3 + 2] = 0.88 * g; }
        }
        lv.cPts.geometry.attributes.position.needsUpdate = lv.cPts.geometry.attributes.color.needsUpdate = true;
      }
    }
    if (real > 0.5 && osm.scale()) tagPpd = osm.scale();
    if (tagEl) {
      const who = real > 0.5 && alt < 0.005 ? "; bright dots are out on the street, dim ones at home" : real > 0.5 ? " at home in residential areas" : "";
      const txt = (tagPpd <= 1 ? "Close up: each dot is one person" : `Close up: each dot is about ${tagPpd.toLocaleString()} people`) + who + (real > 0.5 || !osm || !osm.carScale() || osm.carScale() <= 1 ? "; white and red dots on the roads are cars" : `; white and red dots on the roads are cars, each about ${osm.carScale().toLocaleString()}`) + " (illustrative)";
      if (txt !== lastScale) { tagEl.textContent = txt; lastScale = txt; }
      tagEl.hidden = fade < 0.3;
    }
    return 1 - fade;                                         // how much of the far-off city lights to keep
  }

  // city names, once you're close enough to see the streets: biggest places first, none overlapping
  const v = new THREE.Vector3(), pool = [];
  // place names: every city and town of 5,000 people or more (GeoNames), all appearing together one scroll
  // step before the close-up dots start. Loaded the first time you zoom in that far.
  const MAJOR = 1e6;
  let towns = null, tbuckets = null, loading = false;
  function loadTowns() {
    if (loading) return; loading = true;
    fetch("/geo/towns.json").then((r) => r.json()).then((j) => {
      tbuckets = new Map();
      for (const [name, lat, lon, pop] of j.towns) {
        const k = Math.floor(lon / 2) + ":" + Math.floor(lat / 2);
        if (!tbuckets.has(k)) tbuckets.set(k, []); tbuckets.get(k).push({ name, lat, lon, pop });
      }
      towns = true;
    }).catch(() => { loading = false; });
  }
  function townsNear(lon, lat, km) {
    const out = [], dLat = km / KY, dLon = km / (KX * Math.max(0.15, Math.cos(lat * D)));
    for (let x = Math.floor((lon - dLon) / 2); x <= Math.floor((lon + dLon) / 2); x++)
      for (let y = Math.floor((lat - dLat) / 2); y <= Math.floor((lat + dLat) / 2); y++) {
        const b = tbuckets.get((((x + 90) % 180 + 180) % 180 - 90) + ":" + y); if (b) out.push(...b);
      }
    return out;
  }
  let credit = null;
  function labels(camera, box, lon, lat, alt, aspect) {
    const op = Math.max(0, Math.min(1, (0.165 - alt) / 0.02)), z = 1 + alt;
    if (alt < 0.4 && !towns) loadTowns();                      // fetch a little early so the names are ready in time
    if (op <= 0 || !towns) { box.hidden = true; return; }
    box.hidden = false; box.style.opacity = op;
    if (!credit) { credit = document.createElement("i"); credit.className = "credit"; credit.textContent = "Place names: GeoNames (CC BY 4.0)"; box.appendChild(credit); }
    const W = box.clientWidth, H = box.clientHeight, halfKm = alt * 6371 * Math.tan(16 * D) * Math.max(1, aspect);
    const list = townsNear(lon, lat, halfKm * 1.3 + 5).sort((a, b) => b.pop - a.pop);
    let n = 0;
    for (const c of list) {
      if (n >= 400) break;
      const pa = new Float32Array(3); put(pa, 0, c.lon, c.lat); v.set(pa[0], pa[1], pa[2]);
      world.localToWorld(v); if (v.z * z < 1.0005) continue;       // over the horizon
      v.project(camera); if (v.z > 1) continue;
      const x = (v.x + 1) / 2 * W, y = (1 - v.y) / 2 * H;
      if (x < -40 || x > W + 40 || y < -20 || y > H + 20) continue;
      const big = c.pop >= MAJOR ? 1 : c.pop >= 2e5 ? 2 : c.pop >= 40000 ? 3 : 4;
      let el = pool[n]; if (!el) { el = document.createElement("span"); box.appendChild(el); pool.push(el); }
      if (el.textContent !== c.name) el.textContent = c.name;
      el.className = "s" + big;
      el.style.transform = `translate(${x.toFixed(1)}px, ${y.toFixed(1)}px) translate(-50%, -50%)`; el.hidden = false;
      n++;
    }
    for (let i = n; i < pool.length; i++) pool[i].hidden = true;
  }

  return { setData, update, labels, dispose: () => { for (const lv of levels.values()) drop(lv); world.remove(group); tex.dispose(); } };
}
