// The real roads, from OpenStreetMap (served by OpenFreeMap), drawn on the globe itself: motorways from far out,
// then smaller roads as you zoom in, down to every street and its name. The simulated cars drive them, and at the
// closest zoom the simulated people walk their pavements. How many there are comes from the simulation (where its
// people live, how busy and how happy each country is).
import * as THREE from "/vendor/three.min.js";

const D = Math.PI / 180, R = 1.000035;
const START = 0.5, NAMES = 0.0009, PEOPLE_Z = 13;           // camera heights (earth radius = 1)
const BUDGET = { low: [800, 120], medium: [2000, 300], high: [3500, 600], epic: [6000, 1000] };   // [people, cars] per tile
const CLASS = {                                              // colour, cars per km, drawn width weight
  motorway: [[1, 0.78, 0.45], 9], trunk: [[1, 0.78, 0.45], 7], primary: [[0.96, 0.88, 0.68], 5], secondary: [[0.9, 0.86, 0.74], 3.5],
  tertiary: [[0.7, 0.76, 0.88], 2.5], minor: [[0.6, 0.67, 0.8], 1.2], service: [[0.45, 0.52, 0.66], 0.4], track: [[0.4, 0.46, 0.56], 0], path: [[0.38, 0.44, 0.54], 0],
};

// ---- a small reader for Mapbox vector tiles (protobuf), only for the layers used here
function reader(buf) {
  let p = 0;
  const varint = () => { let r = 0, s = 1, b; do { b = buf[p++]; r += (b & 0x7f) * s; s *= 128; } while (b >= 128); return r; };
  return {
    get pos() { return p; }, set pos(v) { p = v; }, varint,
    bytes() { const n = varint(), o = p; p += n; return [o, p]; },
    str() { const [a, b] = this.bytes(); return new TextDecoder().decode(buf.subarray(a, b)); },
    skip(wt) { if (wt === 0) varint(); else if (wt === 1) p += 8; else if (wt === 2) { const n = varint(); p += n; } else if (wt === 5) p += 4; },
    f32() { const v = new DataView(buf.buffer, buf.byteOffset + p, 4).getFloat32(0, true); p += 4; return v; },
    f64() { const v = new DataView(buf.buffer, buf.byteOffset + p, 8).getFloat64(0, true); p += 8; return v; },
  };
}
const zz = (n) => (n % 2 ? -(n + 1) / 2 : n / 2);
export function decode(buf, want) {
  const r = reader(buf), layers = {};
  while (r.pos < buf.length) {
    const key = r.varint(), tag = key >> 3, wt = key & 7;
    if (tag !== 3) { r.skip(wt); continue; }
    const [a, b] = r.bytes(), save = r.pos;
    const L = { name: "", keys: [], values: [], feats: [], extent: 4096 };
    r.pos = a;
    while (r.pos < b) {                                       // the layer name comes first in practice, but don't rely on it
      const k = r.varint(), t = k >> 3, w = k & 7;
      if (t === 1) L.name = r.str();
      else if (t === 2) { const [fa, fb] = r.bytes(); L.feats.push([fa, fb]); }
      else if (t === 3) L.keys.push(r.str());
      else if (t === 4) {
        const [va, vb] = r.bytes(), sp = r.pos; r.pos = va; let v = null;
        while (r.pos < vb) { const kk = r.varint(), tt = kk >> 3; if (tt === 1) v = r.str(); else if (tt === 2) v = r.f32(); else if (tt === 3) v = r.f64(); else if (tt === 4 || tt === 5) v = r.varint(); else if (tt === 6) v = zz(r.varint()); else if (tt === 7) v = !!r.varint(); else r.skip(kk & 7); }
        L.values.push(v); r.pos = sp;
      } else if (t === 5) L.extent = r.varint();
      else r.skip(w);
    }
    r.pos = save;
    if (!want.includes(L.name)) continue;
    const out = [];
    for (const [fa, fb] of L.feats) {
      r.pos = fa; const props = {}; let type = 0, geom = null;
      while (r.pos < fb) {
        const k = r.varint(), t = k >> 3, w = k & 7;
        if (t === 2) { const [ta, tb] = r.bytes(), sp = r.pos; r.pos = ta; while (r.pos < tb) { const ki = r.varint(), vi = r.varint(); props[L.keys[ki]] = L.values[vi]; } r.pos = sp; }
        else if (t === 3) type = r.varint();
        else if (t === 4) { const [ga, gb] = r.bytes(), sp = r.pos; r.pos = ga; geom = []; while (r.pos < gb) geom.push(r.varint()); r.pos = sp; }
        else r.skip(w);
      }
      if (!(type === 2 || (type === 3 && L.name === "landuse")) || !geom) continue;   // lines, and land-use areas
      const lines = []; let x = 0, y = 0, cur = null;
      for (let i = 0; i < geom.length;) {
        const c = geom[i++], id = c & 7, n = c >> 3;
        if (id === 1 || id === 2) for (let j = 0; j < n; j++) {
          x += zz(geom[i++]); y += zz(geom[i++]);
          if (id === 1) { cur = [x / L.extent, y / L.extent]; lines.push(cur); } else cur.push(x / L.extent, y / L.extent);
        }
      }
      out.push({ props, lines });
    }
    layers[L.name] = out;
  }
  return layers;
}


const tileX = (lon, z) => ((lon + 180) / 360) * (1 << z);
const tileY = (lat, z) => ((1 - Math.log(Math.tan(lat * D) + 1 / Math.cos(lat * D)) / Math.PI) / 2) * (1 << z);
const lonOf = (x, z) => (x / (1 << z)) * 360 - 180;
const latOf = (y, z) => Math.atan(Math.sinh(Math.PI * (1 - (2 * y) / (1 << z)))) / D;
function put(arr, i, lon, lat) {
  const phi = (lon + 180) * D, la = lat * D, c = Math.cos(la);
  arr[i * 3] = -Math.cos(phi) * c * R; arr[i * 3 + 1] = Math.sin(la) * R; arr[i * 3 + 2] = Math.sin(phi) * c * R;
}
function rng(a) { return () => { a |= 0; a = (a + 0x6d2b79f5) | 0; let t = Math.imul(a ^ (a >>> 15), 1 | a); t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t; return ((t ^ (t >>> 14)) >>> 0) / 4294967296; }; }
// a point s km along a road, and its direction; i is a hint for where to start looking
function at(rd, s, i = 1) {
  const c = rd.cum; i = Math.max(1, Math.min(c.length - 1, i));
  while (i < c.length - 1 && c[i] < s) i++;
  while (i > 1 && c[i - 1] > s) i--;
  const f = (s - c[i - 1]) / Math.max(1e-9, c[i] - c[i - 1]), p = rd.pts, a = (i - 1) * 2, b = i * 2;
  return [p[a] + (p[b] - p[a]) * f, p[a + 1] + (p[b + 1] - p[a + 1]) * f, (p[b] - p[a]) * Math.cos(p[a + 1] * D), p[b + 1] - p[a + 1], i];
}

// sim: { density(lon, lat) -> [people per km², nearest city {mood, war, iso}], vehicles(city) -> per 1,000 people or null, tex }
export function addOSM(world, tier, sim) {
  const group = new THREE.Group(); world.add(group);
  const [PB, CB] = BUDGET[tier] || BUDGET.medium;
  const still = matchMedia("(prefers-reduced-motion: reduce)").matches;
  const mats = new Map();                                    // zoom level -> its materials and how faded in it is
  const matsFor = (z) => {
    if (!mats.has(z)) mats.set(z, { op: 0,
      line: new THREE.LineBasicMaterial({ vertexColors: true, transparent: true, opacity: 0, depthWrite: false }),
      people: new THREE.PointsMaterial({ size: 3.0, sizeAttenuation: false, map: sim.tex, vertexColors: true, transparent: true, opacity: 0, depthWrite: false }),
      car: new THREE.PointsMaterial({ size: z >= 12 ? 3.8 : 3.0, sizeAttenuation: false, map: sim.tex, vertexColors: true, transparent: true, opacity: 0, depthWrite: false }) });
    return mats.get(z);
  };
  let template = null, t = 0, credit = null, shown = null;   // shown: the zoom level whose tiles are all in
  const tiles = new Map();                                   // "z:x:y" -> { state, objs, ... }
  window.simhordeStreets = () => [...tiles.values()].map((T) => [T.z, T.state, T.walkers && T.walkers.length, T.drivers && T.drivers.length]);   // for checking
  fetch("https://tiles.openfreemap.org/planet").then((r) => r.json()).then((j) => (template = j.tiles[0])).catch(() => {});

  // a few downloads at a time, nearest first; a tile that fails is tried again a little later
  let inflight = 0; const queue = [];
  function pump() {
    while (inflight < 6 && queue.length) {
      const [T, z, x, y] = queue.shift();
      if (T.used < t - 2) { T.state = "skipped"; continue; }          // scrolled away before its turn
      inflight++; fetchTile(T, z, x, y);
    }
  }
  function load(z, x, y, T) {
    T = T || { z, used: t }; T.state = "loading";
    tiles.set(z + ":" + x + ":" + y, T);
    queue.push([T, z, x, y]); pump();
  }
  function fetchTile(T, z, x, y) {
    const n = 1 << z, xx = ((x % n) + n) % n;
    fetch(template.replace("{z}", z).replace("{x}", xx).replace("{y}", y)).then((r) => (r.ok ? r.arrayBuffer() : Promise.reject()))
      .then((ab) => build(T, z, x, y, decode(new Uint8Array(ab), z >= 14 ? ["transportation", "transportation_name"] : ["transportation"])))
      .catch(() => { T.state = "failed"; T.failedAt = t; })
      .finally(() => { inflight--; pump(); });
  }

  function build(T, z, x, y, L) {
    const M = matsFor(z), LL = (u, v) => [lonOf(x + u, z), latOf(y + v, z)];
    const segs = [], rgb = [], roads = [];
    let totalLen = 0;
    for (const f of L.transportation || []) {
      const cls = f.props.class, C = CLASS[cls];
      if (!C || f.props.brunnel === "tunnel") continue;
      for (const line of f.lines) {
        const pts = []; for (let i = 0; i < line.length; i += 2) pts.push(...LL(line[i], line[i + 1]));
        let len = 0; const cum = [0];
        for (let i = 2; i < pts.length; i += 2) {
          len += Math.hypot((pts[i] - pts[i - 2]) * 111.32 * Math.cos(pts[i + 1] * D), (pts[i + 1] - pts[i - 1]) * 110.57); cum.push(len);
          segs.push(pts[i - 2], pts[i - 1], pts[i], pts[i + 1]); rgb.push(C[0]);
        }
        if (len <= 0) continue;
        roads.push({ pts, cum, len, cls, cars: C[1] }); totalLen += len;
      }
    }
    const P = new Float32Array(segs.length / 4 * 6), Cc = new Float32Array(segs.length / 4 * 6);
    for (let k = 0; k < segs.length / 4; k++) {
      put(P, k * 2, segs[k * 4], segs[k * 4 + 1]); put(P, k * 2 + 1, segs[k * 4 + 2], segs[k * 4 + 3]);
      Cc.set(rgb[k], k * 6); Cc.set(rgb[k], k * 6 + 3);
    }
    const lg = new THREE.BufferGeometry(); lg.setAttribute("position", new THREE.BufferAttribute(P, 3)); lg.setAttribute("color", new THREE.BufferAttribute(Cc, 3));
    const lines = new THREE.LineSegments(lg, M.line); lines.frustumCulled = false; lines.renderOrder = 1;

    const rnd = rng(z * 7919 + x * 92821 + y * 68917), lon0 = lonOf(x, z), lat0 = latOf(y + 1, z), lon1 = lonOf(x + 1, z), lat1 = latOf(y, z);
    const walkers = [], drivers = [];
    let ppd = null, cpd = 1;
    // how many people live in this tile, by the simulation, and the local time of day there
    const area = (lon1 - lon0) * 111.32 * Math.cos(((lat0 + lat1) / 2) * D) * (lat1 - lat0) * 110.57;
    let dsum = 0, dmax = 1;
    for (let a = 0; a < 4; a++) for (let b = 0; b < 4; b++) { const dd = sim.density(lon0 + (a + 0.5) * (lon1 - lon0) / 4, lat0 + (b + 0.5) * (lat1 - lat0) / 4)[0]; dsum += dd; dmax = Math.max(dmax, dd); }
    const people = (dsum / 16) * area;
    const hour = ((new Date().getUTCHours() + new Date().getUTCMinutes() / 60 + (lon0 + lon1) / 30) % 24 + 24) % 24;
    // people on the pavements, close up only. Most people are indoors: only a share are out, more by day than at night
    if (z >= PEOPLE_Z && roads.length) {
      ppd = Math.max(1, Math.ceil(people / PB));
      const outShare = hour < 6 ? 0.02 : hour < 8 ? 0.08 : hour < 19 ? 0.13 : hour < 23 ? 0.07 : 0.03;
      const nP = Math.min(PB, Math.round(people / ppd)), nOut = Math.max(1, Math.round(nP * outShare)), pick = () => { let r = rnd() * totalLen; for (const rd of roads) if ((r -= rd.len) <= 0) return rd; return roads[roads.length - 1]; };
      for (let n = 0, tries = 0; n < nP && tries < nP * 6; tries++) {
        const rd = pick(); if (rd.cls === "motorway" || rd.cls === "trunk") continue;
        const [lo, la, dx, dy] = at(rd, rnd() * rd.len), [d, ct] = sim.density(lo, la);
        if (!ct || rnd() * (dmax * 1.3 + 50) > d + 50) continue;
        const home = n >= nOut;                                 // at home: set back from the street, a dimmer, still light
        const side = (rnd() < 0.5 ? -1 : 1) * (home ? 0.02 + rnd() * 0.05 : 0.009), nl = Math.hypot(dx, dy) || 1, b = (home ? 0.28 + 0.12 * rnd() : 0.8 + 0.2 * rnd()) * (ct.war ? 0.45 : 1);
        walkers.push({ lo: lo - (dy / nl) * side / (111.32 * Math.cos(la * D)), la: la + (dx / nl) * side / 110.57, dx: dx / nl, dy: dy / nl, ph: rnd() * 6.28, sp: home ? 0 : 0.3 + rnd(), c: ct.mood.map((v) => v * b) });
        n++;
      }
    }
    // cars: as many as are really on the road at this hour for this many people (a few in a hundred at rush hour,
    // almost none at night, about 1.3 people a car), on the same scale as the people dots when they show
    if (roads.length) {
      const driving = hour < 5 ? 0.003 : hour < 7 ? 0.012 : hour < 9.5 ? 0.04 : hour < 16 ? 0.02 : hour < 19 ? 0.04 : hour < 22 ? 0.012 : 0.005;
      const weight = roads.map((rd) => { if (!rd.cars) return 0; const m = at(rd, rd.len / 2), [d, ct] = sim.density(m[0], m[1]); rd.war = ct && ct.war; return rd.len * rd.cars * (0.3 + Math.min(1, Math.sqrt(d / 800))) * (rd.war ? 0.3 : 1); });
      const wsum = weight.reduce((a, b) => a + b, 0) || 1, spd = z >= 12 ? 1 : Math.pow(2, 12 - z) * 0.6;   // faster when far out, so you can see them move
      // scaled by how many vehicles people there own (the driving shares above are for about 600 per 1,000 people)
      const [, here] = sim.density((lon0 + lon1) / 2, (lat0 + lat1) / 2), owned = sim.vehicles(here);
      const cars = ((people * driving) / 1.3) * Math.min(1.5, (owned == null ? 150 : owned) / 600);
      cpd = ppd || Math.max(1, Math.ceil(cars / CB));
      const total = cars / cpd;
      roads.forEach((rd, k) => {
        const m = Math.floor((total * weight[k]) / wsum + rnd());
        for (let i = 0; i < m; i++) drivers.push({ rd, s: rnd() * rd.len, i: 1, v: (rd.cars > 4 ? 0.09 : 0.05) * spd * (0.7 + rnd() * 0.6) * (i % 2 ? -1 : 1), tail: i % 2 });
      });
    }
    const pg = new THREE.BufferGeometry(), pc = new Float32Array(walkers.length * 3);
    walkers.forEach((w, i) => pc.set(w.c, i * 3));
    pg.setAttribute("position", new THREE.BufferAttribute(new Float32Array(walkers.length * 3), 3)); pg.setAttribute("color", new THREE.BufferAttribute(pc, 3));
    const ppts = new THREE.Points(pg, M.people); ppts.frustumCulled = false; ppts.renderOrder = 2;
    const cg = new THREE.BufferGeometry();
    cg.setAttribute("position", new THREE.BufferAttribute(new Float32Array(drivers.length * 3), 3)); cg.setAttribute("color", new THREE.BufferAttribute(new Float32Array(drivers.length * 3), 3));
    const cpts = new THREE.Points(cg, M.car); cpts.frustumCulled = false; cpts.renderOrder = 3;

    // street names, closest zoom only: one label per named street, at the middle of its longest piece
    const named = new Map();
    for (const f of L.transportation_name || []) {
      const name = f.props["name:latin"] || f.props.name; if (!name || f.props.class === "path") continue;
      for (const line of f.lines) {
        const pts = []; for (let i = 0; i < line.length; i += 2) pts.push(...LL(line[i], line[i + 1]));
        let len = 0; for (let i = 2; i < pts.length; i += 2) len += Math.hypot((pts[i] - pts[i - 2]) * Math.cos(pts[i + 1] * D), pts[i + 1] - pts[i - 1]);
        const prev = named.get(name);
        if (!prev || prev.len < len) named.set(name, { name, pts, len, major: ["motorway", "trunk", "primary", "secondary"].includes(f.props.class) });
      }
    }
    for (const o of [lines, ppts, cpts]) { o.visible = false; group.add(o); }
    Object.assign(T, { state: "ready", objs: [lines, ppts, cpts], walkers, drivers, names: [...named.values()], ppd, cpd });
  }
  function drop(T) { if (T.objs) for (const o of T.objs) { group.remove(o); o.geometry.dispose(); } }

  // the tile zoom that puts about five tiles across the view
  const zoomFor = (lat, halfKm, aspect) => Math.max(5, Math.min(14, Math.floor(Math.log2((40075 * Math.cos(lat * D) * 5) / (2.5 * halfKm * Math.max(1, aspect))))));
  function cover(z, lon, lat, halfKm, aspect) {
    const dLat = (halfKm * 1.25) / 110.57, dLon = (halfKm * aspect * 1.25) / (111.32 * Math.max(0.1, Math.cos(lat * D)));
    const x0 = Math.floor(tileX(lon - dLon, z)), x1 = Math.floor(tileX(lon + dLon, z));
    const y0 = Math.max(0, Math.floor(tileY(Math.min(85, lat + dLat), z))), y1 = Math.min((1 << z) - 1, Math.floor(tileY(Math.max(-85, lat - dLat), z)));
    const out = [];
    for (let x = x0; x <= x1; x++) for (let y = y0; y <= y1; y++) if (out.length < 40) out.push([x, y]);
    return out;
  }

  const v = new THREE.Vector3(), v2 = new THREE.Vector3(), pool = [];
  // returns how far the real people have taken over from the simulated dots (0 to 1)
  function update(dt, lon, lat, alt, aspect, camera, box) {
    t += dt;
    const on = alt < START && template;
    group.visible = !!on;
    if (!on) { if (box) box.hidden = true; return 0; }
    const halfKm = alt * 6371 * Math.tan(16 * D), z = zoomFor(lat, halfKm, aspect);
    // load this zoom's tiles; keep showing the last complete zoom until they're all in, then fade across
    const need = cover(z, lon, lat, halfKm, aspect);
    let ready = 0;
    for (const [x, y] of need) { const k = z + ":" + x + ":" + y; let T = tiles.get(k); if (!T) { load(z, x, y); T = tiles.get(k); }
      T.used = t;
      if (T.state === "skipped" || (T.state === "failed" && t - T.failedAt > 4 && (T.tries = (T.tries || 0) + 1) < 4)) load(z, x, y, T);
      if (T.state !== "loading") ready++; }
    if (ready === need.length) shown = z;
    const keep = shown != null && shown !== z ? cover(shown, lon, lat, halfKm, aspect) : [];
    for (const [x, y] of keep) { const T = tiles.get(shown + ":" + x + ":" + y); if (T) T.used = t; }
    const fadeIn = Math.min(1, (START - alt) / (START * 0.3));
    for (const [zz, M] of mats) {
      M.op += ((zz === shown ? 1 : 0) - M.op) * Math.min(1, dt * 4);
      const o = M.op * fadeIn; M.line.opacity = 0.85 * o; M.people.opacity = 0.95 * o; M.car.opacity = o;
    }
    if (tiles.size > 150) for (const [k, T] of [...tiles].sort((a, b) => a[1].used - b[1].used).slice(0, tiles.size - 110)) { drop(T); tiles.delete(k); }

    const live = [];
    for (const T of tiles.values()) {
      if (!T.objs) continue;
      const op = matsFor(T.z).op, vis = T.used === t && op > 0.01;
      for (const o of T.objs) o.visible = vis;
      if (vis) live.push(T);
    }
    for (const T of live) {
      if (T.walkers.length) {
        const pa = T.objs[1].geometry.attributes.position.array;
        T.walkers.forEach((w, i) => { const r = still || !w.sp ? 0 : 0.006 * Math.sin(t * 0.35 * w.sp + w.ph); put(pa, i, w.lo + (w.dx * r) / (111.32 * Math.cos(w.la * D)), w.la + (w.dy * r) / 110.57); });
        T.objs[1].geometry.attributes.position.needsUpdate = true;
      }
      const ca = T.objs[2].geometry.attributes.position.array, cc = T.objs[2].geometry.attributes.color.array;
      T.drivers.forEach((q, i) => {
        if (!still) { q.s += q.v * dt; if (q.s > q.rd.len) { q.s -= q.rd.len; q.i = 1; } else if (q.s < 0) { q.s += q.rd.len; q.i = q.rd.cum.length - 1; } }
        const p = at(q.rd, q.s, q.i); q.i = p[4];
        const g = Math.min(1, Math.sin((q.s / q.rd.len) * Math.PI) * 4);   // fade where the road ends
        put(ca, i, p[0], p[1]);
        if (q.tail) { cc[i * 3] = g; cc[i * 3 + 1] = 0.25 * g; cc[i * 3 + 2] = 0.2 * g; } else { cc[i * 3] = g; cc[i * 3 + 1] = 0.97 * g; cc[i * 3 + 2] = 0.88 * g; }
      });
      T.objs[2].geometry.attributes.position.needsUpdate = T.objs[2].geometry.attributes.color.needsUpdate = true;
    }

    // street names along the streets, the bigger roads first, never on top of each other
    const close = live.filter((T) => T.z >= 14);
    if (box) {
      const nop = Math.max(0, Math.min(1, (NAMES - alt) / 0.0002)) * (mats.get(14) ? mats.get(14).op : 0);
      if (!credit) { credit = document.createElement("i"); credit.className = "credit"; credit.textContent = "Roads: © OpenStreetMap contributors, OpenFreeMap. Vehicles per person: WHO via Our World in Data"; box.appendChild(credit); }
      box.hidden = false;
      for (const el of pool) el.hidden = true;
      box.style.opacity = 1;
      if (nop > 0.01) {
        const W = box.clientWidth, H = box.clientHeight, taken = [];
        let n = 0;
        const all = close.flatMap((T) => T.names).sort((a, b) => b.major - a.major || b.len - a.len), done = new Set();
        const project = (lo, la, out) => { const a = new Float32Array(3); put(a, 0, lo, la); out.set(a[0], a[1], a[2]); world.localToWorld(out); out.project(camera); return [(out.x + 1) / 2 * W, (1 - out.y) / 2 * H]; };
        for (const s of all) {
          if (n >= 70) break; if (done.has(s.name)) continue;
          const m = Math.floor(s.pts.length / 4) * 2, j = Math.min(s.pts.length - 2, m + 2);
          const [ax, ay] = project(s.pts[m], s.pts[m + 1], v), [bx, by] = project(s.pts[j], s.pts[j + 1], v2);
          const x = (ax + bx) / 2, y = (ay + by) / 2;
          if (x < 0 || x > W || y < 0 || y > H) continue;
          let ang = Math.atan2(by - ay, bx - ax) * 180 / Math.PI; if (ang > 90) ang -= 180; if (ang < -90) ang += 180;
          const w = s.name.length * (s.major ? 7 : 6), h = 14, rad = Math.abs(ang * D), bw = Math.abs(w * Math.cos(rad)) + h * Math.abs(Math.sin(rad)), bh = Math.abs(w * Math.sin(rad)) + h * Math.abs(Math.cos(rad));
          if (taken.some((r) => Math.abs(r[0] - x) < (r[2] + bw) / 2 && Math.abs(r[1] - y) < (r[3] + bh) / 2)) continue;
          taken.push([x, y, bw, bh]); done.add(s.name);
          let el = pool[n]; if (!el) { el = document.createElement("span"); box.appendChild(el); pool.push(el); }
          if (el.textContent !== s.name) el.textContent = s.name;
          el.className = s.major ? "major" : ""; el.style.opacity = nop;
          el.style.transform = `translate(${x.toFixed(1)}px, ${y.toFixed(1)}px) translate(-50%, -50%) rotate(${ang.toFixed(1)}deg)`; el.hidden = false;
          n++;
        }
      }
    }
    let take = 0; for (const [zz, M] of mats) if (zz >= PEOPLE_Z) take += M.op;
    return Math.min(1, take) * fadeIn;
  }
  return { update, carScale: () => { const T = [...tiles.values()].find((T) => T.used === t && T.cpd); return T ? T.cpd : null; }, scale: () => { const T = [...tiles.values()].find((T) => T.used === t && T.ppd); return T ? T.ppd : null; } };
}
