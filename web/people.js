// Where the simulated people live, and how they feel: a light on each of a country's cities and a few of the
// towns around them, coloured like the happiness meter (red where people are unhappy, teal where they're
// happy). Countries at war dim and flicker. It shows where the world's people are, not each simulated person.
import * as THREE from "/vendor/three.min.js";

const D = Math.PI / 180;
const BUDGET = { low: 2500, medium: 5000, high: 8000, epic: 12000 };    // lights on screen

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

export function addPeople(world, tier, data) {
  const group = new THREE.Group();
  world.add(group);
  let pts = null, flick = [], t = 0;
  const still = matchMedia("(prefers-reduced-motion: reduce)").matches;

  function clear() {
    for (const o of [...group.children]) { group.remove(o); o.geometry && o.geometry.dispose(); if (o.material) { o.material.map && o.material.map.dispose(); o.material.dispose(); } }
    pts = null; flick = [];
  }

  function setData({ globe, cities }) {
    clear();
    const G = (globe && globe.nations) || {}, C = (cities && cities.cities) || {};
    // how many people each listed city stands for: the country's population, shared out by city size
    const places = [];
    let total = 0;
    for (const [num, list] of Object.entries(C)) {
      const g = G[num] || {}, pop = g.pop || list.reduce((a, c) => a + c[3], 0) * 3;
      const csum = list.reduce((a, c) => a + c[3], 0) || 1;
      for (const [, lat, lon, cp] of list) {
        const people = pop * (cp / csum);                    // includes the towns and countryside nearest each city
        places.push({ lon, lat, people, cp, war: !!g.conflict, mood: moodColor(g.happiness) });
        total += people;
      }
    }
    if (!places.length) return;
    const budget = BUDGET[tier] || BUDGET.medium;
    const pos = [], col = [], base = [];
    for (const p of places) {
      const n = Math.max(1, Math.round((p.people / total) * budget));
      // the city itself: a bright core
      pos.push([p.lon, p.lat]); const b0 = Math.min(1, 0.55 + Math.log10(p.cp + 10) / 12);
      col.push(p.mood.map((v) => v * b0)); base.push(p.war);
      // its people: towns and suburbs spreading out, wider for bigger places
      const spread = Math.min(1.6, 0.08 + Math.sqrt(p.people / 1e6) * 0.1);    // degrees
      for (let k = 1; k < n; k++) {
        const r = Math.abs(gauss()) * spread, a = Math.random() * Math.PI * 2;
        const la = p.lat + r * Math.sin(a), lo = p.lon + (r * Math.cos(a)) / Math.max(0.2, Math.cos(p.lat * D));
        pos.push([lo, la]);
        const b = 0.45 + 0.4 * Math.random();
        col.push(p.mood.map((v) => v * b)); base.push(p.war);
      }
    }
    const P = new Float32Array(pos.length * 3), Cc = new Float32Array(pos.length * 3);
    pos.forEach(([lo, la], i) => { put(P, i, lo, la, 1.0018); Cc.set(col[i], i * 3); if (base[i]) flick.push(i); });
    const geo = new THREE.BufferGeometry();
    geo.setAttribute("position", new THREE.BufferAttribute(P, 3));
    geo.setAttribute("color", new THREE.BufferAttribute(Cc, 3));
    geo.userData.base = Cc.slice();
    const big = tier === "epic" || tier === "high";
    pts = new THREE.Points(geo, new THREE.PointsMaterial({ size: big ? 2.6 : 2.2, sizeAttenuation: false, map: glowTexture(), vertexColors: true,
      transparent: true, opacity: 0.95, depthWrite: false }));
    group.add(pts);
    // war: lights at about half strength
    for (const i of flick) for (let k = 0; k < 3; k++) Cc[i * 3 + k] *= 0.45;
    geo.attributes.color.needsUpdate = true;
  }

  function update(dt) {
    if (!pts || !flick.length || still) return;
    t += dt;
    if (t < 0.25) return;                                    // blackouts flicker a few times a second
    t = 0;
    const c = pts.geometry.attributes.color.array, b = pts.geometry.userData.base;
    for (let n = 0; n < Math.min(80, flick.length); n++) {
      const i = flick[(Math.random() * flick.length) | 0], f = Math.random() < 0.3 ? 0.05 : 0.45;
      for (let k = 0; k < 3; k++) c[i * 3 + k] = b[i * 3 + k] * f;
    }
    pts.geometry.attributes.color.needsUpdate = true;
  }

  if (data) setData(data);
  return { setData, update, dispose: () => { clear(); world.remove(group); } };
}
