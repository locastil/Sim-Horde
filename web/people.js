// Where the simulated people live: soft lights over every country's cities and the towns around them,
// brighter and wider the more people live there. Countries at war dim and flicker (blackouts, people
// fleeing). It shows where the world's people are, not individual simulated people.
import * as THREE from "/vendor/three.min.js";

const D = Math.PI / 180;
const BUDGET = { low: 6000, medium: 14000, high: 26000, epic: 40000 };   // dots on screen

function put(arr, i, lon, lat, r) {
  const phi = (lon + 180) * D, la = lat * D, c = Math.cos(la);
  arr[i * 3] = -Math.cos(phi) * c * r; arr[i * 3 + 1] = Math.sin(la) * r; arr[i * 3 + 2] = Math.sin(phi) * c * r;
}
const gauss = () => { let u = 0; while (!u) u = Math.random(); return Math.sqrt(-2 * Math.log(u)) * Math.cos(2 * Math.PI * Math.random()); };

// a soft round glow, so the dots blend into lit areas instead of looking like squares
function glowTexture() {
  const c = document.createElement("canvas"); c.width = c.height = 32;
  const g = c.getContext("2d"), r = g.createRadialGradient(16, 16, 0, 16, 16, 16);
  r.addColorStop(0, "rgba(255,255,255,1)"); r.addColorStop(0.35, "rgba(255,255,255,.55)"); r.addColorStop(1, "rgba(255,255,255,0)");
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
        places.push({ lon, lat, people, cp, war: !!g.conflict });
        total += people;
      }
    }
    if (!places.length) return;
    const budget = BUDGET[tier] || BUDGET.medium;
    const pos = [], col = [], base = [];
    const warm = [1.0, 0.86, 0.55], hot = [1.0, 0.95, 0.82];
    for (const p of places) {
      const n = Math.max(1, Math.round((p.people / total) * budget));
      // the city itself: a bright core
      pos.push([p.lon, p.lat]); const b0 = Math.min(1, 0.45 + Math.log10(p.cp + 10) / 9);
      col.push(hot.map((v) => v * b0)); base.push(p.war);
      // its people: towns and suburbs spreading out, wider for bigger places
      const spread = Math.min(3.2, 0.12 + Math.sqrt(p.people / 1e6) * 0.22);   // degrees
      for (let k = 1; k < n; k++) {
        const r = Math.abs(gauss()) * spread, a = Math.random() * Math.PI * 2;
        const la = p.lat + r * Math.sin(a), lo = p.lon + (r * Math.cos(a)) / Math.max(0.2, Math.cos(p.lat * D));
        pos.push([lo, la]);
        const b = 0.28 + 0.5 * Math.exp(-r / (spread * 0.6)) * Math.random() + 0.12 * Math.random();
        col.push(warm.map((v) => v * b)); base.push(p.war);
      }
    }
    const P = new Float32Array(pos.length * 3), Cc = new Float32Array(pos.length * 3);
    pos.forEach(([lo, la], i) => { put(P, i, lo, la, 1.0018); Cc.set(col[i], i * 3); if (base[i]) flick.push(i); });
    const geo = new THREE.BufferGeometry();
    geo.setAttribute("position", new THREE.BufferAttribute(P, 3));
    geo.setAttribute("color", new THREE.BufferAttribute(Cc, 3));
    geo.userData.base = Cc.slice();
    const big = tier === "epic" || tier === "high";
    pts = new THREE.Points(geo, new THREE.PointsMaterial({ size: big ? 3.0 : 2.5, sizeAttenuation: false, map: glowTexture(), vertexColors: true,
      transparent: true, opacity: 0.6, depthWrite: false, blending: THREE.AdditiveBlending }));
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
