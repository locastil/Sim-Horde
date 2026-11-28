// The real streets, at the closest zoom: roads and their names from OpenStreetMap (served by OpenFreeMap),
// drawn on the globe itself. The simulated people and cars move onto these roads; how many there are still
// comes from the simulation (where its people live, how busy and how happy each country is).
import * as THREE from "/vendor/three.min.js";

const D = Math.PI / 180, Z = 14, R = 1.000035;
const START = 0.0018, FULL = 0.0011, NAMES = 0.0009;       // camera heights (earth radius = 1)
const BUDGET = { low: [300, 60], medium: [700, 160], high: [1200, 320], epic: [2000, 560] };   // [people, cars] per tile
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
function decode(buf, want) {
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
      if (type !== 2 || !geom) continue;                      // lines only
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

const tileX = (lon) => ((lon + 180) / 360) * (1 << Z);
const tileY = (lat) => ((1 - Math.log(Math.tan(lat * D) + 1 / Math.cos(lat * D)) / Math.PI) / 2) * (1 << Z);
const lonOf = (x) => (x / (1 << Z)) * 360 - 180;
const latOf = (y) => Math.atan(Math.sinh(Math.PI * (1 - (2 * y) / (1 << Z)))) / D;
function put(arr, i, lon, lat) {
  const phi = (lon + 180) * D, la = lat * D, c = Math.cos(la);
  arr[i * 3] = -Math.cos(phi) * c * R; arr[i * 3 + 1] = Math.sin(la) * R; arr[i * 3 + 2] = Math.sin(phi) * c * R;
}
function rng(a) { return () => { a |= 0; a = (a + 0x6d2b79f5) | 0; let t = Math.imul(a ^ (a >>> 15), 1 | a); t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t; return ((t ^ (t >>> 14)) >>> 0) / 4294967296; }; }

// sim: { density(lon, lat) -> [people per km², nearest city {mood, war}], tex }
export function addOSM(world, tier, sim) {
  const group = new THREE.Group(); world.add(group);
  const [PB, CB] = BUDGET[tier] || BUDGET.medium;
  const still = matchMedia("(prefers-reduced-motion: reduce)").matches;
  const lineMat = new THREE.LineBasicMaterial({ vertexColors: true, transparent: true, opacity: 0, depthWrite: false });
  const peopleMat = new THREE.PointsMaterial({ size: 2.4, sizeAttenuation: false, map: sim.tex, vertexColors: true, transparent: true, opacity: 0, depthWrite: false });
  const carMat = new THREE.PointsMaterial({ size: 3.4, sizeAttenuation: false, map: sim.tex, vertexColors: true, transparent: true, opacity: 0, depthWrite: false });
  let template = null, t = 0, credit = null;
  const tiles = new Map();                                   // "x:y" -> { state, roads, names, objs }
  fetch("https://tiles.openfreemap.org/planet").then((r) => r.json()).then((j) => (template = j.tiles[0])).catch(() => {});

  function load(x, y) {
    const key = x + ":" + y, T = { state: "loading", used: t };
    tiles.set(key, T);
    fetch(template.replace("{z}", Z).replace("{x}", x).replace("{y}", y)).then((r) => (r.ok ? r.arrayBuffer() : Promise.reject()))
      .then((ab) => build(T, x, y, decode(new Uint8Array(ab), ["transportation", "transportation_name"])))
      .catch(() => { T.state = "failed"; });
  }
  const LL = (x, y, u, v) => [lonOf(x + u), latOf(y + v)];

  function build(T, x, y, L) {
    const segs = [], rgb = [], cand = [], roads = [];
    let totalLen = 0;
    for (const f of L.transportation || []) {
      const cls = f.props.class, C = CLASS[cls];
      if (!C || f.props.brunnel === "tunnel") continue;
      for (const line of f.lines) {
        const pts = []; for (let i = 0; i < line.length; i += 2) pts.push(...LL(x, y, line[i], line[i + 1]));
        let len = 0; const cum = [0];
        for (let i = 2; i < pts.length; i += 2) {
          const dx = (pts[i] - pts[i - 2]) * 111.32 * Math.cos(pts[i + 1] * D), dy = (pts[i + 1] - pts[i - 1]) * 110.57, d = Math.hypot(dx, dy);
          len += d; cum.push(len);
          segs.push(pts[i - 2], pts[i - 1], pts[i], pts[i + 1]); rgb.push(C[0]);
        }
        if (len <= 0) continue;
        roads.push({ pts, cum, len, cls, cars: C[1] });
        totalLen += len;
      }
    }
    // the lines
    const P = new Float32Array(segs.length / 4 * 6), Cc = new Float32Array(segs.length / 4 * 6);
    for (let k = 0; k < segs.length / 4; k++) {
      put(P, k * 2, segs[k * 4], segs[k * 4 + 1]); put(P, k * 2 + 1, segs[k * 4 + 2], segs[k * 4 + 3]);
      const c = rgb[k]; Cc.set(c, k * 6); Cc.set(c, k * 6 + 3);
    }
    const lg = new THREE.BufferGeometry(); lg.setAttribute("position", new THREE.BufferAttribute(P, 3)); lg.setAttribute("color", new THREE.BufferAttribute(Cc, 3));
    const lines = new THREE.LineSegments(lg, lineMat); lines.frustumCulled = false; lines.renderOrder = 1;

    // people on the pavements: as many as the simulation puts here, weighted toward the busier streets
    const rnd = rng(x * 92821 + y * 68917), lon0 = lonOf(x), lat0 = latOf(y + 1), lon1 = lonOf(x + 1), lat1 = latOf(y);
    const area = (lon1 - lon0) * 111.32 * Math.cos(((lat0 + lat1) / 2) * D) * (lat1 - lat0) * 110.57;
    let dsum = 0, dmax = 1; for (let a = 0; a < 4; a++) for (let b = 0; b < 4; b++) { const dd = sim.density(lon0 + (a + 0.5) * (lon1 - lon0) / 4, lat0 + (b + 0.5) * (lat1 - lat0) / 4)[0]; dsum += dd; dmax = Math.max(dmax, dd); }
    const people = (dsum / 16) * area, ppd = Math.max(1, Math.ceil(people / PB));
    const walkers = [], drivers = [];
    if (roads.length) {
      const nP = Math.min(PB, Math.round(people / ppd)), pick = () => {   // a road chosen by its length
        let r = rnd() * totalLen; for (const rd of roads) { if ((r -= rd.len) <= 0) return rd; } return roads[roads.length - 1];
      };
      for (let n = 0, tries = 0; n < nP && tries < nP * 6; tries++) {
        const rd = pick(); if (rd.cls === "motorway" || rd.cls === "trunk") continue;
        const s = rnd() * rd.len, [lo, la, dx, dy] = at(rd, s), [d, ct] = sim.density(lo, la);
        if (!ct || rnd() * (dmax * 1.3 + 50) > d + 50) continue;   // more people where more of the simulation's people live
        const side = (rnd() < 0.5 ? -1 : 1) * 0.009, nl = Math.hypot(dx, dy) || 1;
        const b = (0.7 + 0.3 * rnd()) * (ct.war ? 0.45 : 1);
        walkers.push({ lo: lo - (dy / nl) * side / (111.32 * Math.cos(la * D)), la: la + (dx / nl) * side / 110.57, dx: dx / nl, dy: dy / nl, ph: rnd() * 6.28, sp: 0.3 + rnd(), c: ct.mood.map((v) => v * b) });
        n++;
      }
      // cars: more on the bigger roads, fewer where there's fighting
      const carLen = roads.reduce((a, rd) => a + rd.len * rd.cars, 0);
      for (const rd of roads) {
        if (!rd.cars) continue;
        const mid = at(rd, rd.len / 2), [, ct] = sim.density(mid[0], mid[1]);
        const m = Math.round((CB * rd.len * rd.cars) / Math.max(1, carLen) * (ct && ct.war ? 0.3 : 1) + rnd() * 0.8);
        for (let i = 0; i < m; i++) drivers.push({ rd, s: rnd() * rd.len, v: (rd.cars > 4 ? 0.09 : 0.05) * (0.7 + rnd() * 0.6) * (i % 2 ? -1 : 1), tail: i % 2 });
      }
    }
    const pg = new THREE.BufferGeometry(), pc = new Float32Array(walkers.length * 3);
    walkers.forEach((w, i) => pc.set(w.c, i * 3));
    pg.setAttribute("position", new THREE.BufferAttribute(new Float32Array(walkers.length * 3), 3)); pg.setAttribute("color", new THREE.BufferAttribute(pc, 3));
    const ppts = new THREE.Points(pg, peopleMat); ppts.frustumCulled = false; ppts.renderOrder = 2;
    const cg = new THREE.BufferGeometry();
    cg.setAttribute("position", new THREE.BufferAttribute(new Float32Array(drivers.length * 3), 3)); cg.setAttribute("color", new THREE.BufferAttribute(new Float32Array(drivers.length * 3), 3));
    const cpts = new THREE.Points(cg, carMat); cpts.frustumCulled = false; cpts.renderOrder = 3;

    // street names: one label per named street, at the middle of its longest piece
    const named = new Map();
    for (const f of L.transportation_name || []) {
      const name = f.props["name:latin"] || f.props.name; if (!name || f.props.class === "path") continue;
      for (const line of f.lines) {
        const pts = []; for (let i = 0; i < line.length; i += 2) pts.push(...LL(x, y, line[i], line[i + 1]));
        let len = 0; for (let i = 2; i < pts.length; i += 2) len += Math.hypot((pts[i] - pts[i - 2]) * Math.cos(pts[i + 1] * D), pts[i + 1] - pts[i - 1]);
        const prev = named.get(name);
        if (!prev || prev.len < len) named.set(name, { name, pts, len, major: ["motorway", "trunk", "primary", "secondary"].includes(f.props.class) });
      }
    }
    for (const o of [lines, ppts, cpts]) group.add(o);
    Object.assign(T, { state: "ready", objs: [lines, ppts, cpts], walkers, drivers, names: [...named.values()].sort((a, b) => b.major - a.major || b.len - a.len), ppd });
  }
  // a point s km along a road, and its direction
  function at(rd, s) {
    const c = rd.cum; let i = 1; while (i < c.length - 1 && c[i] < s) i++;
    const f = (s - c[i - 1]) / Math.max(1e-9, c[i] - c[i - 1]), p = rd.pts, a = (i - 1) * 2, b = i * 2;
    const dx = (p[b] - p[a]) * Math.cos(p[a + 1] * D), dy = p[b + 1] - p[a + 1];
    return [p[a] + (p[b] - p[a]) * f, p[a + 1] + (p[b + 1] - p[a + 1]) * f, dx, dy];
  }
  function drop(T) { if (T.objs) for (const o of T.objs) { group.remove(o); o.geometry.dispose(); } }

  const v = new THREE.Vector3(), v2 = new THREE.Vector3(), pool = [];
  // returns how far the real streets have taken over from the simulated grid (0 to 1)
  function update(dt, lon, lat, alt, aspect, camera, box) {
    t += dt;
    const want = Math.max(0, Math.min(1, (START - alt) / (START - FULL)));
    group.visible = want > 0;
    if (want <= 0 || !template) { if (box) box.hidden = true; return 0; }
    const halfKm = alt * 6371 * Math.tan(16 * D), dLat = (halfKm * 1.25) / 110.57, dLon = (halfKm * aspect * 1.25) / (111.32 * Math.cos(lat * D));
    const x0 = Math.floor(tileX(lon - dLon)), x1 = Math.floor(tileX(lon + dLon)), y0 = Math.floor(tileY(lat + dLat)), y1 = Math.floor(tileY(lat - dLat));
    let need = 0, have = 0;
    const visible = [];
    for (let x = x0; x <= x1; x++) for (let y = y0; y <= y1; y++) {
      if (need > 30) break;
      const key = x + ":" + y; need++;
      let T = tiles.get(key); if (!T) { load(x, y); T = tiles.get(key); }
      T.used = t; if (T.state !== "loading") have++;
      if (T.state === "ready") visible.push(T);
    }
    if (tiles.size > 80) for (const [k, T] of [...tiles].sort((a, b) => a[1].used - b[1].used).slice(0, tiles.size - 60)) { drop(T); tiles.delete(k); }
    for (const T of tiles.values()) if (T.objs) { const on = T.used === t; for (const o of T.objs) o.visible = on; }
    const op = want * (need ? have / need : 0);
    lineMat.opacity = 0.9 * op; peopleMat.opacity = 0.95 * op; carMat.opacity = op;

    for (const T of visible) {
      const pa = T.objs[1].geometry.attributes.position.array;
      T.walkers.forEach((w, i) => {
        const r = still ? 0 : 0.006 * Math.sin(t * 0.35 * w.sp + w.ph);
        put(pa, i, w.lo + (w.dx * r) / (111.32 * Math.cos(w.la * D)), w.la + (w.dy * r) / 110.57);
      });
      T.objs[1].geometry.attributes.position.needsUpdate = true;
      const ca = T.objs[2].geometry.attributes.position.array, cc = T.objs[2].geometry.attributes.color.array;
      T.drivers.forEach((q, i) => {
        if (!still) q.s = ((q.s + q.v * dt) % q.rd.len + q.rd.len) % q.rd.len;
        const [lo, la] = at(q.rd, q.s), g = Math.min(1, Math.sin((q.s / q.rd.len) * Math.PI) * 4);   // fade where the road ends
        put(ca, i, lo, la);
        if (q.tail) { cc[i * 3] = g; cc[i * 3 + 1] = 0.25 * g; cc[i * 3 + 2] = 0.2 * g; } else { cc[i * 3] = g; cc[i * 3 + 1] = 0.97 * g; cc[i * 3 + 2] = 0.88 * g; }
      });
      T.objs[2].geometry.attributes.position.needsUpdate = T.objs[2].geometry.attributes.color.needsUpdate = true;
    }

    // street names along the streets, the bigger roads first, never on top of each other
    if (box) {
      const nop = Math.max(0, Math.min(1, (NAMES - alt) / 0.0002)) * op;
      box.hidden = nop <= 0.01;
      if (!credit) { credit = document.createElement("i"); credit.className = "credit"; credit.textContent = "Streets: © OpenStreetMap contributors, OpenFreeMap"; box.appendChild(credit); }
      if (!box.hidden) {
        box.style.opacity = nop;
        const W = box.clientWidth, H = box.clientHeight, taken = [];
        let n = 0;
        const all = visible.flatMap((T) => T.names).sort((a, b) => b.major - a.major || b.len - a.len), done = new Set();
        for (const s of all) {
          if (n >= 70) break; if (done.has(s.name)) continue;
          const m = Math.floor(s.pts.length / 4) * 2, j = Math.min(s.pts.length - 2, m + 2);
          const project = (lo, la, out) => { const a = new Float32Array(3); put(a, 0, lo, la); out.set(a[0], a[1], a[2]); world.localToWorld(out); out.project(camera); return [(out.x + 1) / 2 * W, (1 - out.y) / 2 * H]; };
          const [ax, ay] = project(s.pts[m], s.pts[m + 1], v), [bx, by] = project(s.pts[j], s.pts[j + 1], v2);
          const x = (ax + bx) / 2, y = (ay + by) / 2;
          if (x < 0 || x > W || y < 0 || y > H) continue;
          let ang = Math.atan2(by - ay, bx - ax) * 180 / Math.PI; if (ang > 90) ang -= 180; if (ang < -90) ang += 180;
          const w = s.name.length * (s.major ? 7 : 6), h = 14, rad = Math.abs(ang * D), bw = Math.abs(w * Math.cos(rad)) + h * Math.abs(Math.sin(rad)), bh = Math.abs(w * Math.sin(rad)) + h * Math.abs(Math.cos(rad));
          if (taken.some((r) => Math.abs(r[0] - x) < (r[2] + bw) / 2 && Math.abs(r[1] - y) < (r[3] + bh) / 2)) continue;
          taken.push([x, y, bw, bh]); done.add(s.name);
          let el = pool[n]; if (!el) { el = document.createElement("span"); box.appendChild(el); pool.push(el); }
          if (el.textContent !== s.name) el.textContent = s.name;
          el.className = s.major ? "major" : "";
          el.style.transform = `translate(${x.toFixed(1)}px, ${y.toFixed(1)}px) translate(-50%, -50%) rotate(${ang.toFixed(1)}deg)`; el.hidden = false;
          n++;
        }
        for (let i = n; i < pool.length; i++) pool[i].hidden = true;
      }
    }
    return op;
  }
  return { update, scale: () => { const T = [...tiles.values()].find((T) => T.used === t && T.state === "ready"); return T ? T.ppd : null; } };
}
