// Air and sea traffic on the zoomed-out globe. An illustration driven by the simulation, not real tracking:
// flights link each country's main city to its main trading partners, and stop where there's fighting;
// ships follow the real main sea lanes, thin out when the world economy shrinks, and reroute around the
// Cape of Good Hope when there's fighting by the Red Sea, or stay out of the Gulf when fighting closes Hormuz.
import * as THREE from "/vendor/three.min.js";

const D = Math.PI / 180;
function vec(lon, lat, r) {                       // same mapping as the globe's texture
  const phi = (lon + 180) * D, la = lat * D;
  return new THREE.Vector3(-Math.cos(phi) * Math.cos(la) * r, Math.sin(la) * r, Math.sin(phi) * Math.cos(la) * r);
}
function slerp(a, b, f, out) {                    // a, b unit vectors
  const w = Math.acos(Math.max(-1, Math.min(1, a.dot(b))));
  if (w < 1e-6) return out.copy(a);
  const s = Math.sin(w), A = Math.sin((1 - f) * w) / s, B = Math.sin(f * w) / s;
  return out.set(a.x * A + b.x * B, a.y * A + b.y * B, a.z * A + b.z * B);
}

// Main sea lanes, as waypoints (lon, lat) through open water.
const ASIA_SUEZ = [[121.8, 30.8], [120.2, 24.5], [114.6, 21.8], [110, 10], [104.2, 1.2], [100, 4], [95, 6.2], [80.6, 5.2], [60, 12], [48, 12.4],
  [43.4, 12.6], [38, 20], [32.6, 29.6], [32.4, 31.4], [25, 34], [12, 37.4], [0, 37], [-5.6, 35.95], [-10, 37], [-10, 43.5], [-5, 48.5], [-2, 50.1], [2, 51.2], [3.8, 51.95]];
const ASIA_CAPE = [[121.8, 30.8], [120.2, 24.5], [114.6, 21.8], [110, 10], [104.2, 1.2], [100, 4], [95, 6.2], [80.6, 5.2], [60, -10], [55, -25], [35, -37], [18.5, -35.6],
  [5, -20], [-5, 0], [-20, 20], [-15, 37], [-10, 43.5], [-5, 48.5], [-2, 50.1], [2, 51.2], [3.8, 51.95]];
const PACIFIC = [[121.8, 30.8], [126, 31.2], [140, 33], [180, 42], [-140, 38], [-118.5, 33.3]];
const KOREA_JAPAN = [[129.3, 34.9], [129, 33.2], [131.5, 30.8], [140, 33], [180, 42], [-140, 44], [-124.8, 47.5]];
const ATLANTIC = [[-2, 50.1], [-20, 48], [-50, 42], [-70.5, 40.2], [-73.8, 40.4]];
const PANAMA = [[-73.8, 40.4], [-72, 30], [-73.6, 20.4], [-77, 14], [-79.9, 9.6], [-79.5, 8.3], [-82, 6], [-100, 14], [-112, 20], [-118, 30], [-118.5, 33.3]];
const GULF = [[50.5, 27.2], [56.3, 26.4], [57.5, 24.5], [62, 20], [75, 6], [80.6, 5.2], [95, 6.2], [100, 4], [104.2, 1.2], [110, 10], [114.6, 21.8], [120.2, 24.5], [121.8, 30.8]];
const GULF_WEST = [[50.5, 27.2], [56.3, 26.4], [57.5, 24.5], [62, 20], [60, 12], [48, 12.4], [43.4, 12.6], [38, 20], [32.6, 29.6], [32.4, 31.4], [25, 34], [12, 37.4], [0, 37], [-5.6, 35.95], [-10, 37], [-10, 43.5], [-5, 48.5], [-2, 50.1], [2, 51.2], [3.8, 51.95]];
const BRAZIL = [[-46.2, -24.3], [-41, -24.2], [-38, -20], [-30, -5], [-20, 20], [-15, 37], [-10, 43.5], [-5, 48.5], [-2, 50.1], [2, 51.2], [3.8, 51.95]];
const BRAZIL_ASIA = [[-46.2, -24.3], [-30, -32], [18.5, -35.6], [35, -37], [55, -25], [80, -5], [95, 6.2], [100, 4], [104.2, 1.2], [110, 10], [114.6, 21.8], [120.2, 24.5], [121.8, 30.8]];
const WEST_AFRICA = [[3.3, 5.8], [-5, 0], [-20, 20], [-15, 37], [-10, 43.5], [-5, 48.5], [-2, 50.1], [2, 51.2], [3.8, 51.95]];
const AUSTRALIA = [[151.5, -34], [155, -25], [154, -12], [150, -2], [135, 8], [127, 15], [123, 22.5], [122.6, 26], [121.8, 30.8]];
const LANES = [
  { p: ASIA_SUEZ, w: 10, via: "suez" }, { p: ASIA_CAPE, w: 2, via: "cape" }, { p: PACIFIC, w: 8 }, { p: KOREA_JAPAN, w: 4 }, { p: ATLANTIC, w: 7 },
  { p: PANAMA, w: 4 }, { p: GULF, w: 6, via: "hormuz" }, { p: GULF_WEST, w: 3, via: "hormuz+suez" }, { p: BRAZIL, w: 3 }, { p: BRAZIL_ASIA, w: 3 },
  { p: WEST_AFRICA, w: 2 }, { p: AUSTRALIA, w: 4 },
];

function path(points, r) {                         // a polyline sampled on the sphere every ~1 degree, with running length
  const pts = [], cum = [0], t = new THREE.Vector3();
  for (let i = 1; i < points.length; i++) {
    const a = vec(points[i - 1][0], points[i - 1][1], 1), b = vec(points[i][0], points[i][1], 1);
    const n = Math.max(2, Math.ceil(a.angleTo(b) / D));
    for (let k = i === 1 ? 0 : 1; k <= n; k++) pts.push(slerp(a, b, k / n, t).clone().multiplyScalar(r));
  }
  for (let i = 1; i < pts.length; i++) cum.push(cum[i - 1] + pts[i].distanceTo(pts[i - 1]));
  return { pts, cum, len: cum[cum.length - 1] };
}
function along(p, s, out) {
  let lo = 0, hi = p.cum.length - 1;
  while (hi - lo > 1) { const m = (lo + hi) >> 1; if (p.cum[m] < s) lo = m; else hi = m; }
  const f = (s - p.cum[lo]) / ((p.cum[hi] - p.cum[lo]) || 1);
  return out.copy(p.pts[lo]).lerp(p.pts[hi], f);
}

const COUNTS = { low: [90, 70], medium: [160, 110], high: [260, 160], epic: [420, 240] };   // [planes, ships]

export function addTraffic(world, tier, data) {
  const group = new THREE.Group();
  world.add(group);
  const [maxPlanes, maxShips] = COUNTS[tier] || COUNTS.medium;
  const still = matchMedia("(prefers-reduced-motion: reduce)").matches;
  let planes = [], ships = [], pGeo = null, sGeo = null, lines = [];

  function clear() {
    for (const o of [...group.children]) { group.remove(o); o.geometry && o.geometry.dispose(); o.material && o.material.dispose(); }
    lines = [];
  }

  function setData({ globe, markets, cities }) {
    clear();
    const G = (globe && globe.nations) || {}, M = (markets && markets.nations) || {}, C = (cities && cities.cities) || {};
    const fighting = (num) => !!(G[num] && G[num].conflict);
    const growth = markets && markets.world && markets.world.growth != null ? markets.world.growth : 2.5;
    const trade = Math.max(0.45, Math.min(1.25, 1 + 0.06 * (growth - 2.5)));

    // ---- ships
    const redSea = ["887", "818", "232", "262", "706"].some(fighting), hormuz = ["364", "512", "784"].some(fighting);
    const lanes = LANES.map((L) => {
      let w = L.w;
      if (L.via && L.via.includes("suez") && redSea) w *= 0.15;
      if (L.via === "cape" && redSea) w *= 4;
      if (L.via && L.via.includes("hormuz") && hormuz) w *= 0.2;
      return { ...L, w, path: path(L.p, 1.0025) };
    });
    const wsum = lanes.reduce((a, l) => a + l.w, 0);
    const nShips = Math.round(maxShips * trade);
    ships = [];
    for (const l of lanes) {
      const n = Math.round(nShips * l.w / wsum);
      for (let i = 0; i < n; i++) ships.push({ p: l.path, s: Math.random() * l.path.len, dir: Math.random() < 0.5 ? 1 : -1, v: 0.01 * (0.8 + Math.random() * 0.4) });
      const lg = new THREE.BufferGeometry().setFromPoints(l.path.pts);
      group.add(new THREE.Line(lg, new THREE.LineBasicMaterial({ color: 0xffb547, transparent: true, opacity: 0.12 * Math.min(1, l.w / 3), depthWrite: false })));
    }

    // ---- flights: biggest countries to their main trading partners
    const byName = {};
    for (const [num, r] of Object.entries(M)) byName[r.name] = num;
    const top = Object.entries(G).filter(([n]) => C[n] && !fighting(n)).sort((a, b) => (b[1].pop || 0) - (a[1].pop || 0)).slice(0, 70);
    const routes = [], seen = new Set();
    for (const [num] of top) {
      for (const pn of ((M[num] && M[num].partners) || []).slice(0, 3)) {
        const to = byName[pn];
        if (!to || !C[to] || fighting(to)) continue;
        const key = [num, to].sort().join("-"); if (seen.has(key)) continue; seen.add(key);
        const sanc = (M[num] && M[num].flags || []).includes("sanctions") || (M[to] && M[to].flags || []).includes("sanctions");
        routes.push({ a: vec(C[num][0][2], C[num][0][1], 1), b: vec(C[to][0][2], C[to][0][1], 1), w: sanc ? 0.3 : 1 });
      }
    }
    planes = [];
    const wr = routes.reduce((a, r) => a + r.w, 0) || 1, nPlanes = Math.round(maxPlanes * Math.max(0.6, trade));
    for (const r of routes) {
      r.ang = r.a.angleTo(r.b);
      const n = Math.max(r.w >= 1 ? 1 : 0, Math.round(nPlanes * r.w / wr));
      for (let i = 0; i < n; i++) planes.push({ r, f: Math.random(), dir: Math.random() < 0.5 ? 1 : -1, v: 0.035 / Math.max(0.3, r.ang) * (0.85 + Math.random() * 0.3) });
      const pts = []; const t = new THREE.Vector3();
      for (let k = 0; k <= 32; k++) { const f = k / 32; pts.push(slerp(r.a, r.b, f, t).clone().multiplyScalar(1.004 + 0.06 * Math.sin(Math.PI * f) * Math.min(1, r.ang))); }
      group.add(new THREE.Line(new THREE.BufferGeometry().setFromPoints(pts), new THREE.LineBasicMaterial({ color: 0xffffff, transparent: true, opacity: 0.07, depthWrite: false })));
    }

    pGeo = new THREE.BufferGeometry(); pGeo.setAttribute("position", new THREE.BufferAttribute(new Float32Array(Math.max(1, planes.length) * 3), 3));
    sGeo = new THREE.BufferGeometry(); sGeo.setAttribute("position", new THREE.BufferAttribute(new Float32Array(Math.max(1, ships.length) * 3), 3));
    const big = tier === "epic" || tier === "high";
    group.add(new THREE.Points(pGeo, new THREE.PointsMaterial({ color: 0xffffff, size: big ? 3.2 : 2.6, sizeAttenuation: false, transparent: true, opacity: 0.95 })));
    group.add(new THREE.Points(sGeo, new THREE.PointsMaterial({ color: 0xffb547, size: big ? 3.0 : 2.4, sizeAttenuation: false, transparent: true, opacity: 0.95 })));
    update(0);
  }

  const t = new THREE.Vector3();
  function update(dt) {
    if (!pGeo) return;
    const step = still ? 0 : dt;
    const pa = pGeo.attributes.position.array;
    planes.forEach((q, i) => {
      q.f += q.dir * q.v * step;
      if (q.f > 1) { q.f = 0; } else if (q.f < 0) { q.f = 1; }
      slerp(q.r.a, q.r.b, q.f, t).multiplyScalar(1.004 + 0.06 * Math.sin(Math.PI * q.f) * Math.min(1, q.r.ang));
      pa[i * 3] = t.x; pa[i * 3 + 1] = t.y; pa[i * 3 + 2] = t.z;
    });
    pGeo.attributes.position.needsUpdate = true;
    const sa = sGeo.attributes.position.array;
    ships.forEach((q, i) => {
      q.s += q.dir * q.v * step;
      if (q.s > q.p.len) q.s -= q.p.len; else if (q.s < 0) q.s += q.p.len;
      along(q.p, q.s, t);
      sa[i * 3] = t.x; sa[i * 3 + 1] = t.y; sa[i * 3 + 2] = t.z;
    });
    sGeo.attributes.position.needsUpdate = true;
  }

  // ---- Live: real aircraft (OpenSky) and ships (AISStream), moved along their heading between snapshots
  let live = null;
  const LIVE_CAP = { low: 2500, medium: 4500, high: 9000, epic: 9000 }[tier] || 4500;
  function setLive(snap) {
    clear();
    live = null; pGeo = sGeo = null;
    if (!snap) return;
    const step = (arr) => { const k = Math.max(1, Math.ceil(arr.length / LIVE_CAP)); return arr.filter((_, i) => i % k === 0); };
    const P = step(snap.planes || []), S = step(snap.ships || []);
    live = { P, S, pt: (snap.planes_t || snap.t) * 1000, st: snap.t * 1000 };
    pGeo = new THREE.BufferGeometry(); pGeo.setAttribute("position", new THREE.BufferAttribute(new Float32Array(Math.max(1, P.length) * 3), 3));
    sGeo = new THREE.BufferGeometry(); sGeo.setAttribute("position", new THREE.BufferAttribute(new Float32Array(Math.max(1, S.length) * 3), 3));
    const big = tier === "epic" || tier === "high";
    // tracked ones bright; ones out of receiver range (moved along their last heading) dimmer
    const colors = (arr, est, on, off) => { const c = new Float32Array(Math.max(1, arr.length) * 3); arr.forEach((q, i) => c.set(q[est] ? off : on, i * 3)); return new THREE.BufferAttribute(c, 3); };
    pGeo.setAttribute("color", colors(P, 7, [1, 1, 1], [0.42, 0.5, 0.62]));
    sGeo.setAttribute("color", colors(S, 6, [1, 0.71, 0.28], [0.55, 0.42, 0.24]));
    group.add(new THREE.Points(pGeo, new THREE.PointsMaterial({ vertexColors: true, size: big ? 2.4 : 2.0, sizeAttenuation: false, transparent: true, opacity: 0.95 })));
    group.add(new THREE.Points(sGeo, new THREE.PointsMaterial({ vertexColors: true, size: big ? 2.2 : 1.8, sizeAttenuation: false, transparent: true, opacity: 0.95 })));
    liveUpdate(true);
  }
  let lastLive = 0;
  function put(arr, i, lon, lat, r) {
    const phi = (lon + 180) * D, la = lat * D, c = Math.cos(la);
    arr[i * 3] = -Math.cos(phi) * c * r; arr[i * 3 + 1] = Math.sin(la) * r; arr[i * 3 + 2] = Math.sin(phi) * c * r;
  }
  function liveUpdate(force) {
    const now = Date.now();
    if (!force && now - lastLive < 250) return;            // four position updates a second is plenty at this scale
    lastLive = now;
    const pa = pGeo.attributes.position.array, sa = sGeo.attributes.position.array;
    const dp = still ? 0 : Math.min(1200, Math.max(0, (now - live.pt) / 1000));
    live.P.forEach((q, i) => {                            // [lon, lat, alt m, heading, speed m/s, callsign, category]
      const h = q[3] * D, d = q[4] * dp, lat = q[1] + (d * Math.cos(h)) / 111320;
      const lon = q[0] + (d * Math.sin(h)) / (111320 * Math.max(0.05, Math.cos(q[1] * D)));
      put(pa, i, lon, lat, 1.004 + Math.min(13000, Math.max(0, q[2])) / 13000 * 0.012);
    });
    pGeo.attributes.position.needsUpdate = true;
    const ds = still ? 0 : Math.min(1800, Math.max(0, (now - live.st) / 1000));
    live.S.forEach((q, i) => {                            // [lon, lat, course, knots, name, kind]
      const h = q[2] * D, d = q[3] * 0.5144 * ds;
      put(sa, i, q[0] + (d * Math.sin(h)) / (111320 * Math.max(0.05, Math.cos(q[1] * D))), q[1] + (d * Math.cos(h)) / 111320, 1.0025);
    });
    sGeo.attributes.position.needsUpdate = true;
  }

  if (data) setData(data);
  return {
    setData: (d) => { if (!live) setData(d); },
    setLive,
    isLive: () => !!live,
    update: (dt) => (live ? liveUpdate(false) : update(dt)),
    dispose: () => { clear(); world.remove(group); },
  };
}
