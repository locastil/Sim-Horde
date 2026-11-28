// Where the simulated people live, and how they feel: a light on each of a country's cities and a few of the
// towns around them, coloured like the happiness meter (red where people are unhappy, teal where they're
// happy). Countries at war dim and flicker. It shows where the world's people are, not each simulated person.
import * as THREE from "/vendor/three.min.js";

const D = Math.PI / 180;
const BUDGET = { low: 6000, medium: 20000, high: 60000, epic: 120000 };   // lights on screen: a strong card draws far more
// countries the horde simulates in more detail (more simulated people) get more lights
const DETAIL = { Low: 0.35, Medium: 0.55, High: 0.8, Ultra: 1 };

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
  let pts = null, t = 0;
  const still = matchMedia("(prefers-reduced-motion: reduce)").matches;

  function clear() {
    for (const o of [...group.children]) { group.remove(o); o.geometry && o.geometry.dispose(); if (o.material) { o.material.map && o.material.map.dispose(); o.material.dispose(); } }
    pts = null;
  }

  function setData({ globe, cities, shapes }) {
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
        places.push({ lon, lat, people, cp, war: !!g.conflict, mood: moodColor(g.happiness), detail: DETAIL[g.detail] || 0.35, land: landTest(shapes && shapes.get(num)) });
        total += people;
      }
    }
    if (!places.length) return;
    const budget = BUDGET[tier] || BUDGET.medium;
    const pos = [], col = [], base = [], tpos = [], tcol = [], tbase = [];
    for (const p of places) {
      const n = Math.max(1, Math.round((p.people / total) * budget * p.detail));
      // the city itself: a bright core
      pos.push([p.lon, p.lat]); const b0 = Math.min(1, 0.55 + Math.log10(p.cp + 10) / 12);
      col.push(p.mood.map((v) => v * b0)); base.push(p.war);
      // its people: towns and suburbs, thick near the city and thinning out, wider for bigger places
      const spread = Math.min(2.6, 0.1 + Math.sqrt(p.people / 1e6) * 0.17);    // degrees
      for (let k = 1; k < n; k++) {
        let r, lo, la, tries = 0;
        do {                                                   // towns only on the country's own land, never at sea
          r = spread * Math.pow(Math.random(), 1.8) * 1.6; const a = Math.random() * Math.PI * 2;
          la = p.lat + r * Math.sin(a); lo = p.lon + (r * Math.cos(a)) / Math.max(0.2, Math.cos(p.lat * D));
        } while (!p.land(lo, la) && ++tries < 6);
        if (tries >= 6) continue;
        tpos.push([lo, la]);
        const b = 0.35 + 0.45 * Math.random() * Math.exp(-r / spread);
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
    pts = [layer(tpos, tcol, tbase, big ? 1.7 : 1.5), layer(pos, col, base, big ? 2.8 : 2.3)];
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
