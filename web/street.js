// Street view: zoom from the globe into a country's cities, with real streets and 3D buildings
// (OpenStreetMap, via OpenFreeMap) and traffic, flights and crowds driven by the simulated month there.
// The vehicles and people are an illustration of the simulation's numbers (how busy, how happy, protests or
// fighting), not tracked one by one. Opened with:  window.dispatchEvent(new CustomEvent("simhorde:street", {detail: {num}}))
(() => {
  const STYLE = "https://tiles.openfreemap.org/styles/liberty";
  const still = matchMedia("(prefers-reduced-motion: reduce)").matches;
  const small = () => Math.min(innerWidth, innerHeight) < 700;
  const esc = (s) => String(s ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
  let lib = null, cities = null, ui = null, map = null, run = null;

  function loadLib() {
    if (window.maplibregl) return Promise.resolve(window.maplibregl);
    return new Promise((res, rej) => {
      const l = document.createElement("link"); l.rel = "stylesheet"; l.href = "/vendor/maplibre-gl.css"; document.head.appendChild(l);
      const s = document.createElement("script"); s.src = "/vendor/maplibre-gl.js"; s.onload = () => res(window.maplibregl); s.onerror = rej;
      document.head.appendChild(s);
    });
  }
  const getJSON = (u) => fetch(u, { cache: "no-store" }).then((r) => r.json()).catch(() => null);

  // ------------------------------------------------------------ what the simulation says about this place
  function mood(nv, mk) {
    const h = nv && nv.happiness != null ? nv.happiness : 5.5;
    const growth = mk && mk.growth != null ? mk.growth : 2;
    let busy = Math.max(0.4, Math.min(1.15, 0.8 + 0.04 * growth + 0.03 * (h - 5.5)));
    if (nv && nv.conflict) busy *= 0.35;                   // people stay off the streets
    if (nv && nv.protests) busy *= 0.8;                    // roads blocked
    return { h, busy, protests: !!(nv && nv.protests), conflict: !!(nv && nv.conflict), stag: mk && mk.flags && mk.flags.includes("stagflation") };
  }
  function happyColor(h) {
    const stops = [[3.0, [232, 76, 61]], [4.5, [240, 140, 64]], [5.6, [242, 200, 92]], [6.6, [96, 200, 150]], [7.6, [30, 170, 190]]];   // same as the globe
    if (h <= stops[0][0]) return `rgb(${stops[0][1]})`;
    for (let i = 1; i < stops.length; i++) {
      if (h <= stops[i][0]) {
        const [a, ca] = stops[i - 1], [b, cb] = stops[i], f = (h - a) / (b - a);
        return `rgb(${ca.map((v, k) => Math.round(v + f * (cb[k] - v))).join(",")})`;
      }
    }
    return `rgb(${stops[stops.length - 1][1]})`;
  }
  const gauss = () => { let u = 0, v = 0; while (!u) u = Math.random(); while (!v) v = Math.random(); return Math.sqrt(-2 * Math.log(u)) * Math.cos(2 * Math.PI * v); };

  // ------------------------------------------------------------ geometry
  const R = 6371000;
  const rad = (d) => d * Math.PI / 180;
  function dist(a, b) {
    const x = rad(b[0] - a[0]) * Math.cos(rad((a[1] + b[1]) / 2)), y = rad(b[1] - a[1]);
    return Math.sqrt(x * x + y * y) * R;
  }
  function line(coords) {                     // a polyline with its running length, for moving things along it
    const cum = [0];
    for (let i = 1; i < coords.length; i++) cum.push(cum[i - 1] + dist(coords[i - 1], coords[i]));
    return { c: coords, cum, len: cum[cum.length - 1] };
  }
  function at(l, s) {                          // point and heading s metres along a polyline
    s = Math.max(0, Math.min(l.len, s));
    let i = 1; while (i < l.cum.length - 1 && l.cum[i] < s) i++;
    const a = l.c[i - 1], b = l.c[i], seg = l.cum[i] - l.cum[i - 1] || 1, f = (s - l.cum[i - 1]) / seg;
    return [[a[0] + f * (b[0] - a[0]), a[1] + f * (b[1] - a[1])], Math.atan2(-(b[1] - a[1]), (b[0] - a[0]) * Math.cos(rad(a[1])))];
  }
  function greatCircle(a, b, f) {
    const [l1, p1, l2, p2] = [rad(a[0]), rad(a[1]), rad(b[0]), rad(b[1])];
    const d = 2 * Math.asin(Math.sqrt(Math.sin((p2 - p1) / 2) ** 2 + Math.cos(p1) * Math.cos(p2) * Math.sin((l2 - l1) / 2) ** 2)) || 1e-9;
    const A = Math.sin((1 - f) * d) / Math.sin(d), B = Math.sin(f * d) / Math.sin(d);
    const x = A * Math.cos(p1) * Math.cos(l1) + B * Math.cos(p2) * Math.cos(l2);
    const y = A * Math.cos(p1) * Math.sin(l1) + B * Math.cos(p2) * Math.sin(l2);
    const z = A * Math.sin(p1) + B * Math.sin(p2);
    return [Math.atan2(y, x) * 180 / Math.PI, Math.atan2(z, Math.sqrt(x * x + y * y)) * 180 / Math.PI];
  }

  // ------------------------------------------------------------ the moving things
  const SPEED = { motorway: 27, trunk: 22, primary: 15, secondary: 12, tertiary: 10, minor: 8, service: 5 };
  const CAR_COLORS = ["#f4f6f8", "#c9d1d9", "#3a4a5c", "#11151c", "#8b97a5", "#b23a2e", "#1f4bff", "#e7e2d4"];

  function harvest(m) {
    const src = Object.entries(m.getStyle().sources).find(([, v]) => v.type === "vector");
    if (!src) return { roads: [], walks: [], airport: null };
    const id = src[0];
    const roads = [], walks = [], seen = new Set();
    let feats = [];
    try { feats = m.querySourceFeatures(id, { sourceLayer: "transportation" }); } catch (e) {}
    for (const f of feats) {
      const cls = f.properties.class;
      const g = f.geometry;
      const parts = g.type === "LineString" ? [g.coordinates] : g.type === "MultiLineString" ? g.coordinates : [];
      for (const c of parts) {
        if (c.length < 2) continue;
        const key = cls + c[0].join() + c[c.length - 1].join();
        if (seen.has(key)) continue; seen.add(key);
        const l = line(c);
        if (l.len < 25) continue;
        l.cls = cls;
        if (SPEED[cls] && cls !== "service") roads.push(l);
        if (cls === "minor" || cls === "path" || cls === "service" || cls === "track") walks.push(l);
      }
    }
    let airport = null;
    try {
      const a = m.querySourceFeatures(id, { sourceLayer: "aerodrome_label" })[0];
      if (a && a.geometry.type === "Point") airport = a.geometry.coordinates;
    } catch (e) {}
    // only the streets on screen (with a margin), so the traffic and people are where you're looking
    const b = m.getBounds(), padX = (b.getEast() - b.getWest()) * 0.15, padY = (b.getNorth() - b.getSouth()) * 0.15;
    const seen_ = (l) => l.c.some(([x, y]) => x > b.getWest() - padX && x < b.getEast() + padX && y > b.getSouth() - padY && y < b.getNorth() + padY);
    const R2 = roads.filter(seen_), W2 = walks.filter(seen_);
    return { roads: (R2.length > 20 ? R2 : roads).slice(0, 1500), walks: (W2.length > 20 ? W2 : walks).slice(0, 1500), airport };
  }

  function makeCars(roads, n) {
    if (!roads.length) return [];
    const w = roads.map((r) => r.len * ({ motorway: 3, trunk: 2.5, primary: 2, secondary: 1.5, tertiary: 1.2 }[r.cls] || 0.6));
    const tot = w.reduce((a, b) => a + b, 0);
    const out = [];
    for (let k = 0; k < n; k++) {
      let x = Math.random() * tot, i = 0; while (i < w.length - 1 && (x -= w[i]) > 0) i++;
      const r = roads[i];
      out.push({ r, s: Math.random() * r.len, dir: Math.random() < 0.5 ? 1 : -1, v: SPEED[r.cls] * (0.7 + Math.random() * 0.5),
                 col: CAR_COLORS[(Math.random() * CAR_COLORS.length) | 0], side: Math.random() < 0.5 ? -1 : 1 });
    }
    return out;
  }
  function makePeople(walks, n, md, center) {
    const out = [];
    for (let k = 0; k < n && walks.length; k++) {
      const r = walks[(Math.random() * walks.length) | 0];
      out.push({ r, s: Math.random() * r.len, dir: Math.random() < 0.5 ? 1 : -1, v: 1.0 + Math.random() * 0.6, off: (Math.random() - 0.5) * 14,
                 col: happyColor(Math.max(0, Math.min(10, md.h + 1.6 * gauss()))) });
    }
    if (md.protests && center) {                            // a crowd gathers in the center
      for (let k = 0; k < (small() ? 120 : 220); k++) {
        const a = Math.random() * 6.283, d = 40 * Math.sqrt(Math.random());
        out.push({ fixed: [center[0] + d * Math.cos(a) / 111320 / Math.cos(rad(center[1])), center[1] + d * Math.sin(a) / 110540], jig: Math.random() * 6.283,
                   col: happyColor(Math.max(0, Math.min(10, md.h - 2 + 1.2 * gauss()))) });
      }
    }
    return out;
  }
  function makeFlights(home, dests, n) {
    const out = [];
    if (!dests.length) return out;
    for (let k = 0; k < n; k++) {
      const d = dests[k % dests.length];
      out.push({ a: home, b: d, f: Math.random(), dir: k % 2 ? 1 : -1, period: 90 + Math.random() * 60, trail: [] });
    }
    return out;
  }

  // ------------------------------------------------------------ the view
  function build() {
    const el = document.createElement("div");
    el.className = "street"; el.hidden = true;
    el.setAttribute("role", "dialog"); el.setAttribute("aria-modal", "true"); el.setAttribute("aria-labelledby", "stTitle");
    el.innerHTML = `<div class="st-map" id="stMap"></div><canvas class="st-fx" id="stFx" aria-hidden="true"></canvas>
      <div class="st-bar">
        <div class="st-name"><b id="stTitle"></b><span id="stSub"></span></div>
        <label class="st-city"><span class="sr">City</span><select id="stCity"></select></label>
        <button type="button" class="st-close" id="stClose">Back to the globe</button>
      </div>
      <div class="st-layers" role="group" aria-label="Show">
        <button type="button" data-l="cars" aria-pressed="true">Traffic</button><button type="button" data-l="people" aria-pressed="true">People</button><button type="button" data-l="planes" aria-pressed="true">Flights</button>
      </div>
      <p class="st-note" id="stNote"></p>`;
    document.body.appendChild(el);
    el.querySelector("#stClose").addEventListener("click", close);
    el.addEventListener("keydown", (e) => { if (e.key === "Escape") close(); });
    el.querySelectorAll("[data-l]").forEach((b) => b.addEventListener("click", () => {
      const on = b.getAttribute("aria-pressed") !== "true"; b.setAttribute("aria-pressed", String(on)); if (run) run.show[b.dataset.l] = on;
    }));
    el.querySelector("#stCity").addEventListener("change", (e) => { if (run && e.target.value !== "") flyTo(run.cities[Number(e.target.value)], false); });
    return el;
  }

  // Real ground under the streets: cloud-free satellite imagery (Sentinel-2, EOX) and hills and valleys in 3D
  // (open elevation tiles), with the map's roads, labels and 3D buildings on top.
  function naturalGround(m) {
    try {
      const layers = m.getStyle().layers;
      const before = (layers.find((l) => l.type === "line" && /road|highway|transport|tunnel|bridge/.test(l.id)) || layers.find((l) => l.type === "symbol") || {}).id;
      m.addSource("s2", { type: "raster", tileSize: 256, maxzoom: 15,
        tiles: ["https://tiles.maps.eox.at/wmts/1.0.0/s2cloudless-2020_3857/default/g/{z}/{y}/{x}.jpg"],
        attribution: '<a href="https://s2maps.eu">Sentinel-2 cloudless</a> by EOX IT Services GmbH (contains modified Copernicus Sentinel data 2020)' });
      m.addLayer({ id: "s2", type: "raster", source: "s2", paint: { "raster-opacity": ["interpolate", ["linear"], ["zoom"], 9, 1, 14, 0.95, 17, 0.8], "raster-saturation": 0.1 } }, before);
      m.addSource("dem", { type: "raster-dem", encoding: "terrarium", tileSize: 256, maxzoom: 14,
        tiles: ["https://s3.amazonaws.com/elevation-tiles-prod/terrarium/{z}/{x}/{y}.png"], attribution: "Elevation: Terrain Tiles (Mapzen, AWS Open Data)" });
      m.addLayer({ id: "relief", type: "hillshade", source: "dem", paint: { "hillshade-exaggeration": 0.35, "hillshade-shadow-color": "#1d2a1a" } }, before);
      m.setTerrain({ source: "dem", exaggeration: 1.3 });
    } catch (e) { console.warn("street view ground", e); }
  }

  function flyTo(c, intro) {
    run.city = c;
    map.flyTo({ center: [c[2], c[1]], zoom: small() ? 16.4 : 16.9, pitch: 55, bearing: -25 + Math.random() * 50, duration: intro ? 7000 : 3500, essential: true });
  }

  function close() {
    if (!ui) return;
    ui.hidden = true; ui.classList.remove("st-in");
    document.documentElement.classList.remove("st-open");
    if (run) { cancelAnimationFrame(run.raf); run = null; }
    if (map) { map.remove(); map = null; }
    if (ui.returnTo) ui.returnTo.focus();
  }

  // the nearest listed city to a point, anywhere: [country number, index in its list]
  function nearestCity(lon, lat, only) {
    let best = null, bd = 1e9;
    for (const [num, list] of Object.entries(cities.cities)) if (!only || only[num]) list.forEach((c, i) => {
      const dx = (c[2] - lon) * Math.cos(rad(lat)), dy = c[1] - lat, d = dx * dx + dy * dy;
      if (d < bd) { bd = d; best = [num, i]; }
    });
    return best;
  }

  async function open(num, at) {
    ui = ui || build();
    ui.returnTo = document.activeElement;
    [lib, cities] = await Promise.all([lib || loadLib(), cities || getJSON("/geo/cities.json")]);
    const [g, m] = await Promise.all([getJSON("/api/v1/globe"), getJSON("/api/v1/markets")]);
    if (!lib || !cities) return;
    const known = g && g.nations;                                          // only countries the simulation runs
    if ((!num || !cities.cities[num] || (known && !known[num])) && at) num = (nearestCity(at.lon, at.lat, known) || [])[0];
    if (!num || !(cities.cities[num] || []).length) return;
    // in full screen only the full-screen element shows, so the street view has to open inside it
    const host = document.fullscreenElement || document.body;
    if (ui.parentNode !== host) host.appendChild(ui);
    ui.hidden = false;
    requestAnimationFrame(() => ui.classList.add("st-in"));         // fade in over the globe, as if zooming through it
    document.documentElement.classList.add("st-open");

    const list0 = cities.cities[num];
    const start = at ? { center: [at.lon, at.lat], zoom: 3.7 } : { center: [list0[0][2], list0[0][1]], zoom: 4.2 };
    map = new lib.Map({ container: "stMap", style: STYLE, ...start, pitch: 0, maxPitch: 75, attributionControl: { compact: true } });
    run = { num: null, cities: list0, city: list0[0], md: mood(null, null), show: { cars: true, people: true, planes: true }, cars: [], people: [], flights: [], partners: [], raf: 0, last: performance.now() };

    // which country you're looking at, and what the simulation says about it (changes as you pan across borders)
    function setCountry(n) {
      if (!run || n === run.num || !cities.cities[n]) return;
      const nv = g && g.nations && g.nations[n], mk = m && m.nations && m.nations[n];
      const list = cities.cities[n], name = (nv && nv.name) || (mk && mk.name) || "";
      const md = mood(nv, mk);
      Object.assign(run, { num: n, cities: list, md, flights: [] });
      run.partners = ((mk && mk.partners) || []).map((pn) => {
        const e = m && Object.entries(m.nations).find(([, r]) => r.name === pn);
        const cc = e && cities.cities[e[0]]; return cc ? [cc[0][2], cc[0][1]] : null;
      }).filter(Boolean);
      ui.querySelector("#stTitle").textContent = name;
      ui.querySelector("#stSub").textContent = [nv ? `Happiness ${md.h.toFixed(1)}` : "", md.conflict ? "armed conflict" : "", md.protests ? "protests" : "",
                                                md.stag ? "stagflation" : "", nv && nv.detail ? `simulated at ${nv.detail} detail` : ""].filter(Boolean).join(" · ");
      ui.querySelector("#stCity").innerHTML = `<option value="">Go to a city</option>` + list.map((c, i) => `<option value="${i}">${esc(c[0])}</option>`).join("");
      ui.querySelector("#stNote").textContent = `Streets and buildings: OpenStreetMap; ground: satellite imagery. The traffic, people and flights are an illustration of ${name}'s simulated month: `
        + `how busy (${Math.round(md.busy * 100)}% of normal), how happy (each person's color), ${md.protests ? "a protest in the center, " : ""}${md.conflict ? "streets emptied by fighting, " : ""}`
        + `and flights to its main trading partners. They aren't tracked one by one. Zoom out all the way to go back to the globe.`;
    }
    setCountry(num);
    ui.querySelector("#stClose").focus({ preventScroll: true });
    let armed = false;
    map.on("moveend", () => {
      if (!run || !map) return;
      const c = map.getCenter(), near = nearestCity(c.lng, c.lat, g && g.nations);
      if (near && map.getZoom() >= 4.5) { setCountry(near[0]); run.city = cities.cities[near[0]][near[1]]; }
    });
    map.on("zoomend", () => {                                           // zoomed all the way out: back to the globe, looking at the same place
      if (!armed || !map || map.getZoom() >= 3.2) return;
      const c = map.getCenter();
      close();
      window.dispatchEvent(new CustomEvent("simhorde:focus", { detail: { lon: c.lng, lat: c.lat } }));
    });
    const fx = ui.querySelector("#stFx"), ctx = fx.getContext("2d");
    const resize = () => { const r = ui.getBoundingClientRect(), d = Math.min(2, devicePixelRatio || 1); fx.width = r.width * d; fx.height = r.height * d; ctx.setTransform(d, 0, 0, d, 0, 0); };
    resize(); addEventListener("resize", resize);

    const reseed = () => {
      if (!run || !map) return;
      const { roads, walks, airport } = harvest(map);
      const k = small() ? 0.55 : 1;
      const md = run.md;
      run.cars = makeCars(roads, Math.round(420 * md.busy * k));
      run.people = makePeople(walks, Math.round(520 * md.busy * k), md, [run.city[2], run.city[1]]);
      const home = airport || [run.city[2], run.city[1]];
      if (!run.flights.length || run.home !== home.join()) {
        run.home = home.join();
        run.flights = makeFlights(home, run.partners.length ? run.partners : [[home[0] + 8, home[1] + 3]], Math.round((small() ? 6 : 10) * Math.max(0.5, md.busy)));
      }
    };
    let t = 0;
    map.on("idle", () => { clearTimeout(t); t = setTimeout(reseed, 150); });
    map.once("load", () => {
      naturalGround(map);
      if (at) {
        try { map.setProjection({ type: "globe" }); } catch (e) {}              // the same round Earth you were just looking at
        map.easeTo({ zoom: 5.2, duration: 1200 });
        setTimeout(() => (armed = true), 1500);
      } else { setTimeout(() => flyTo(list0[0], true), 600); setTimeout(() => (armed = true), 8000); }
    });

    const frame = (now) => {
      if (!run || !map) return;
      const dt = Math.min(0.1, (now - run.last) / 1000); run.last = now;
      const r = ui.getBoundingClientRect(); ctx.clearRect(0, 0, r.width, r.height);
      const z = map.getZoom();
      const c0 = map.getCenter(), p0 = map.project(c0), p1 = map.project([c0.lng + 0.001, c0.lat]);
      const pxm = Math.hypot(p1.x - p0.x, p1.y - p0.y) / (0.001 * 111320 * Math.cos(rad(c0.lat)));      // pixels per metre here
      const step = still ? 0 : dt;
      if (run.show.cars && z >= 12) {
        const L = Math.max(7, 4.6 * pxm), W = Math.max(3.4, 1.9 * pxm);
        for (const c of run.cars) {
          c.s += c.dir * c.v * step;
          if (c.s > c.r.len || c.s < 0) { c.dir *= -1; c.s = Math.max(0, Math.min(c.r.len, c.s)); }
          const [ll, hd] = at(c.r, c.s), p = map.project(ll);
          if (p.x < -20 || p.y < -20 || p.x > r.width + 20 || p.y > r.height + 20) continue;
          const a = hd + (c.dir < 0 ? Math.PI : 0) - rad(map.getBearing());
          ctx.save(); ctx.translate(p.x, p.y); ctx.rotate(a); ctx.translate(0, c.side * W * 0.8);
          ctx.fillStyle = "rgba(10,14,20,.55)"; ctx.fillRect(-L / 2 - 1, -W / 2 - 1, L + 2, W + 2);
          ctx.fillStyle = c.col; ctx.fillRect(-L / 2, -W / 2, L, W);
          if (pxm > 0.8) { ctx.fillStyle = "rgba(255,240,180,.9)"; ctx.fillRect(L / 2 - 1, -W / 2, 1, W); }
          ctx.restore();
        }
      }
      if (run.show.people && z >= 14.5) {
        const s = Math.max(2.8, 0.55 * pxm);
        for (const q of run.people) {
          let ll;
          if (q.fixed) { q.jig += step * 3; ll = [q.fixed[0] + Math.sin(q.jig) * 2e-6, q.fixed[1]]; }
          else {
            q.s += q.dir * q.v * step;
            if (q.s > q.r.len || q.s < 0) { q.dir *= -1; q.s = Math.max(0, Math.min(q.r.len, q.s)); }
            const [pt, hd] = at(q.r, q.s); ll = [pt[0] + Math.sin(hd) * q.off / 111320, pt[1] + Math.cos(hd) * q.off / 110540];
          }
          const p = map.project(ll);
          if (p.x < -5 || p.y < -5 || p.x > r.width + 5 || p.y > r.height + 5) continue;
          ctx.fillStyle = q.col; ctx.strokeStyle = "rgba(10,14,20,.6)"; ctx.lineWidth = 1;
          ctx.beginPath(); ctx.arc(p.x, p.y, s, 0, 6.283); ctx.fill(); ctx.stroke();
        }
      }
      if (run.show.planes) {
        for (const f of run.flights) {
          f.f += f.dir * step / f.period; if (f.f > 1 || f.f < 0) { f.dir *= -1; f.f = Math.max(0, Math.min(1, f.f)); f.trail = []; }
          const ll = greatCircle(f.a, f.b, f.f), nx = greatCircle(f.a, f.b, Math.max(0, Math.min(1, f.f + f.dir * 0.002)));
          const p = map.project(ll), q = map.project(nx);
          f.trail.push([p.x, p.y]); if (f.trail.length > 40) f.trail.shift();
          if (f.trail.length > 2) {
            ctx.strokeStyle = "rgba(255,255,255,.35)"; ctx.lineWidth = 1.2; ctx.beginPath();
            f.trail.forEach(([x, y], i) => (i ? ctx.lineTo(x, y) : ctx.moveTo(x, y))); ctx.stroke();
          }
          if (p.x < -30 || p.y < -30 || p.x > r.width + 30 || p.y > r.height + 30) continue;
          const a = Math.atan2(q.y - p.y, q.x - p.x), S = z > 12 ? 13 : 9;
          ctx.save(); ctx.translate(p.x, p.y); ctx.rotate(a);
          ctx.fillStyle = "#fff"; ctx.strokeStyle = "rgba(11,22,38,.7)"; ctx.lineWidth = 1;
          ctx.beginPath(); ctx.moveTo(S, 0); ctx.lineTo(-S * 0.6, S * 0.55); ctx.lineTo(-S * 0.3, 0); ctx.lineTo(-S * 0.6, -S * 0.55); ctx.closePath(); ctx.fill(); ctx.stroke();
          ctx.restore();
        }
      }
      run.raf = requestAnimationFrame(frame);
    };
    run.raf = requestAnimationFrame(frame);
  }

  window.simhordeStreet = () => run && { cars: run.cars.length, people: run.people.length, flights: run.flights.length, zoom: map && map.getZoom() };
  addEventListener("simhorde:street", (e) => {
    const d = e.detail || {};
    if (map) return;                                                      // already open
    open(d.num != null ? String(d.num) : null, d.lon != null ? { lon: d.lon, lat: d.lat } : null).catch((err) => console.warn("street view", err));
  });
})();
