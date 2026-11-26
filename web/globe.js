// Sim Horde globe: the world the horde is building, drawn at the quality this device can handle.
// Quality works like a game engine's scalability settings: Low, Medium, High, Epic, or Auto, which
// picks from the graphics card and then watches the frame rate, stepping down to stay smooth.
import * as THREE from "/vendor/three.min.js";

const TIERS = {
  low:    { label: "Low",    tex: 1024, seg: 40,  dpr: 1,    light: false, atmo: false, stars: 0,    spec: false, aa: false, layers: ["countries_low"], fps: 30 },
  medium: { label: "Medium", tex: 2048, seg: 72,  dpr: 1.25, light: true,  atmo: true,  stars: 0,    spec: false, aa: true,  layers: ["countries"], fps: 60 },
  high:   { label: "High",   tex: 4096, seg: 128, dpr: 1.5,  light: true,  atmo: true,  stars: 1800, spec: true,  aa: true,  layers: ["countries", "admin1"], fps: 60 },
  epic:   { label: "Epic",   tex: 8192, seg: 192, dpr: 2,    light: true,  atmo: true,  stars: 4500, spec: true,  aa: true,  layers: ["countries", "admin1", "us_counties"], fps: 60 },
};
const ORDER = ["low", "medium", "high", "epic"];
const CA = { lon: -119.4, lat: 37.2, box: [-125, 32, -113.8, 42.4] };
const store = { get: (k) => { try { return localStorage.getItem(k); } catch (e) { return null; } },
                set: (k, v) => { try { localStorage.setItem(k, v); } catch (e) {} } };
const reduceMotion = matchMedia("(prefers-reduced-motion: reduce)").matches;

/* ------------------------------------------------------------ hardware */
function probeGPU() {
  const c = document.createElement("canvas");
  const gl = c.getContext("webgl2") || c.getContext("webgl");
  if (!gl) return { ok: false, name: "No WebGL", maxTex: 0 };
  const ext = gl.getExtension("WEBGL_debug_renderer_info");
  let raw = ext ? gl.getParameter(ext.UNMASKED_RENDERER_WEBGL) : gl.getParameter(gl.RENDERER);
  raw = String(raw || "");
  let name = raw.replace(/\((TM|R)\)/gi, "");
  const m = name.match(/^ANGLE \((.*)\)$/);
  if (m) {
    const parts = m[1].split(",").map((x) => x.trim());
    name = (parts[1] || parts[0]).replace(/^ANGLE Metal Renderer:\s*/i, "").replace(/\s*\(0x[0-9a-f]+\).*$/i, "").replace(/\s+(Direct3D|OpenGL|Vulkan).*$/i, "");
  }
  name = name.replace(/\s+/g, " ").trim();
  const maxTex = gl.getParameter(gl.MAX_TEXTURE_SIZE);
  const lose = gl.getExtension("WEBGL_lose_context"); if (lose) lose.loseContext();
  return { ok: true, name: (name && !/^(webkit webgl|unknown)/i.test(name)) ? name : "this device", raw, maxTex };
}

function tierFor(gpu) {
  const s = gpu.raw + " " + gpu.name;
  let t = "medium";
  if (/swiftshader|llvmpipe|software|microsoft basic|mali-[gt]?[0-7]\d\b|adreno\D*[1-5]\d\d\b|powervr/i.test(s)) t = "low";
  else if (/rtx\s?(40|50)\d\d|rx\s?[79]\d{3}|apple m[2-9] (max|ultra)|radeon pro w7/i.test(s)) t = "epic";
  else if (/rtx\s?(20|30)\d\d|rx\s?6\d{3}|apple m\d|arc a7|rtx a\d/i.test(s)) t = "high";
  const mem = navigator.deviceMemory || 8;
  const small = matchMedia("(pointer: coarse)").matches && Math.min(screen.width, screen.height) < 800;
  if (mem <= 4 && ORDER.indexOf(t) > 1) t = "medium";
  if (small && t === "epic") t = "high";
  while (TIERS[t].tex > gpu.maxTex && t !== "low") t = ORDER[ORDER.indexOf(t) - 1];
  return t;
}

/* ------------------------------------------------------------ map texture */
const geoCache = {};
function loadLayer(name) {
  if (!geoCache[name]) geoCache[name] = fetch(`/geo/${name}.json`).then((r) => r.json()).then((d) => decode(d));
  return geoCache[name];
}
function decode(d) {
  const q = d.q;
  return d.f.map(([name, rings]) => [name, rings.map((flat) => {
    const out = new Float32Array(flat.length); let x = 0, y = 0;
    for (let i = 0; i < flat.length; i += 2) { x += flat[i]; y += flat[i + 1]; out[i] = x / q; out[i + 1] = y / q; }
    return out;
  })]);
}
function hash(s) { let h = 2166136261; for (let i = 0; i < s.length; i++) { h ^= s.charCodeAt(i); h = Math.imul(h, 16777619); } return ((h >>> 0) % 1000) / 1000; }

function tracePath(ctx, ring, W, H, shift) {
  let prev = ring[0];
  let ox = 0;
  ctx.moveTo(((prev + 180) / 360) * W + shift, ((90 - ring[1]) / 180) * H);
  for (let i = 2; i < ring.length; i += 2) {
    let lon = ring[i] + ox;
    if (lon - prev > 180) { ox -= 360; lon -= 360; } else if (prev - lon > 180) { ox += 360; lon += 360; }
    prev = lon;
    ctx.lineTo(((lon + 180) / 360) * W + shift, ((90 - ring[i + 1]) / 180) * H);
  }
  ctx.closePath();
}
function drawRing(ctx, ring, W, H) {
  let mn = 1e9, mx = -1e9, prev = ring[0], ox = 0;
  for (let i = 0; i < ring.length; i += 2) {
    let lon = ring[i] + ox;
    if (lon - prev > 180) { ox -= 360; lon -= 360; } else if (prev - lon > 180) { ox += 360; lon += 360; }
    prev = lon; mn = Math.min(mn, lon); mx = Math.max(mx, lon);
  }
  tracePath(ctx, ring, W, H, 0);
  if (mn < -180) tracePath(ctx, ring, W, H, W);
  if (mx > 180) tracePath(ctx, ring, W, H, -W);
}

async function paintBase(tier, W, H) {
  const T = TIERS[tier];
  const cv = document.createElement("canvas"); cv.width = W; cv.height = H;
  const ctx = cv.getContext("2d");
  const sea = ctx.createLinearGradient(0, 0, 0, H);
  sea.addColorStop(0, "#0d1a2e"); sea.addColorStop(0.5, "#10233d"); sea.addColorStop(1, "#0d1a2e");
  ctx.fillStyle = sea; ctx.fillRect(0, 0, W, H);
  const spec = T.spec ? document.createElement("canvas") : null;
  let sctx = null;
  if (spec) { spec.width = W / 2; spec.height = H / 2; sctx = spec.getContext("2d"); sctx.fillStyle = "#fff"; sctx.fillRect(0, 0, W / 2, H / 2); sctx.fillStyle = "#000"; }
  const lw = W / 4096;
  for (const layer of T.layers) {
    const feats = await loadLayer(layer);
    for (const [name, rings] of feats) {
      ctx.beginPath(); for (const r of rings) drawRing(ctx, r, W, H);
      if (layer.startsWith("countries")) {
        const v = hash(name);
        const L = tier === "low" ? 30 : 21;
        ctx.fillStyle = `hsl(${212 + v * 14}, ${16 + v * 8}%, ${L + v * 6}%)`; ctx.fill("evenodd");
        if (sctx) { sctx.beginPath(); for (const r of rings) drawRing(sctx, r, W / 2, H / 2); sctx.fill("evenodd"); }
        { ctx.strokeStyle = "rgba(150,175,205,.55)"; ctx.lineWidth = Math.max(0.6, 1.1 * lw); ctx.stroke(); }
      } else if (layer === "admin1") {
        const v = hash(name);
        ctx.fillStyle = `hsla(${210 + v * 20}, 22%, ${24 + v * 7}%, .55)`; ctx.fill("evenodd");
        ctx.strokeStyle = "rgba(140,165,195,.28)"; ctx.lineWidth = Math.max(0.4, 0.7 * lw); ctx.stroke();
      } else {
        ctx.strokeStyle = "rgba(140,165,195,.22)"; ctx.lineWidth = Math.max(0.3, 0.45 * lw); ctx.stroke();
      }
    }
  }
  return { cv, spec };
}

// teal = kinder than the state, coral = ruder (same ramp as the flat map)
const KIND = [26, 190, 170], MID = [214, 222, 230], RUDE = [255, 110, 84];
function ramp(t) { const a = t < 0 ? KIND : RUDE, k = Math.abs(t); return `rgb(${MID.map((v, i) => Math.round(v + (a[i] - v) * k)).join(",")})`; }

/* ------------------------------------------------------------ the globe */
export function mountGlobe(root, opts = {}) {
  const canvasWrap = root.querySelector(".gl");
  const hud = root.querySelector(".hud");
  const tip = root.querySelector(".gtip");
  const gpu = probeGPU();
  if (!gpu.ok) { root.classList.add("nogl"); hud.querySelector(".hw").textContent = "This browser can't draw 3D graphics."; return; }
  const autoTier = tierFor(gpu);
  const urlQ = new URLSearchParams(location.search).get("quality");
  let mode = (urlQ && (TIERS[urlQ] || urlQ === "auto")) ? urlQ : (store.get("simhorde.quality") || "auto");
  let tier = mode === "auto" ? autoTier : mode;

  let renderer, scene, camera, world, tilt, earth, tex, specTex, base, caShapes = null, caVals = null, raf = 0, built = 0;
  let lon = CA.lon, lat = CA.lat, vLon = reduceMotion ? 0 : 0.035, vLat = 0, dragging = false, zoom = 4.0;
  let visible = true, frames = 0, tAcc = 0, lowWindows = 0, lastT = performance.now(), fps = 0, dprScale = 1;

  function setHud() {
    hud.querySelector(".hw").textContent = gpu.name;
    hud.querySelector(".q").textContent = TIERS[tier].label + (mode === "auto" ? " (auto)" : "");
    hud.querySelectorAll("button[data-q]").forEach((b) => b.setAttribute("aria-pressed", String(b.dataset.q === mode)));
  }

  async function build() {
    const myBuild = ++built;
    const T = TIERS[tier];
    root.classList.add("loading");
    if (renderer) { cancelAnimationFrame(raf); renderer.dispose(); renderer.domElement.remove(); scene.traverse((o) => { o.geometry && o.geometry.dispose(); o.material && o.material.dispose(); }); tex && tex.dispose(); specTex && specTex.dispose(); }
    const W = Math.min(T.tex, gpu.maxTex), H = W / 2;
    const painted = await paintBase(tier, W, H);
    if (myBuild !== built) return;
    base = painted.cv;
    const live = document.createElement("canvas"); live.width = W; live.height = H; live.getContext("2d").drawImage(base, 0, 0);

    renderer = new THREE.WebGLRenderer({ antialias: T.aa, alpha: true, powerPreference: "high-performance" });
    renderer.setPixelRatio(Math.min(devicePixelRatio || 1, T.dpr) * dprScale);
    canvasWrap.appendChild(renderer.domElement);
    scene = new THREE.Scene();
    camera = new THREE.PerspectiveCamera(32, 1, 0.1, 200);
    tilt = new THREE.Group(); world = new THREE.Group(); tilt.add(world); scene.add(tilt);

    tex = new THREE.CanvasTexture(live); tex.colorSpace = THREE.SRGBColorSpace;
    tex.anisotropy = T.spec ? renderer.capabilities.getMaxAnisotropy() : 1;
    let mat;
    if (T.light) {
      mat = new THREE.MeshPhongMaterial({ map: tex, shininess: 22, specular: new THREE.Color(T.spec ? 0x1c3354 : 0x0c121b) });
      if (painted.spec) { specTex = new THREE.CanvasTexture(painted.spec); mat.specularMap = specTex; }
      scene.add(new THREE.AmbientLight(0xffffff, 1.15));
      const sun = new THREE.DirectionalLight(0xffffff, 2.1); sun.position.set(-3, 2, 4); scene.add(sun);
    } else {
      mat = new THREE.MeshBasicMaterial({ map: tex });
    }
    earth = new THREE.Mesh(new THREE.SphereGeometry(1, T.seg, T.seg / 2), mat);
    world.add(earth);
    if (T.atmo) {
      const atmo = new THREE.Mesh(new THREE.SphereGeometry(1.07, T.seg / 2, T.seg / 4), new THREE.ShaderMaterial({
        side: THREE.BackSide, transparent: true, depthWrite: false, blending: THREE.AdditiveBlending,
        uniforms: { k: { value: tier === "epic" ? 0.85 : 0.65 } },
        vertexShader: "varying vec3 n; varying vec3 p; void main(){ n = normalize(normalMatrix*normal); vec4 mv = modelViewMatrix*vec4(position,1.0); p = mv.xyz; gl_Position = projectionMatrix*mv; }",
        fragmentShader: "uniform float k; varying vec3 n; varying vec3 p; void main(){ float f = pow(clamp(0.62 - dot(n, vec3(0.0, 0.0, 1.0)), 0.0, 1.0), 2.4); gl_FragColor = vec4(0.32, 0.56, 1.0, 1.0) * f * k; }",
      }));
      scene.add(atmo);
      const rim = new THREE.Mesh(new THREE.SphereGeometry(1.003, T.seg, T.seg / 2), new THREE.ShaderMaterial({
        transparent: true, depthWrite: false, blending: THREE.AdditiveBlending,
        vertexShader: "varying vec3 n; varying vec3 p; void main(){ n = normalize(normalMatrix*normal); vec4 mv = modelViewMatrix*vec4(position,1.0); p = mv.xyz; gl_Position = projectionMatrix*mv; }",
        fragmentShader: "varying vec3 n; varying vec3 p; void main(){ float f = pow(1.0 - abs(dot(n, normalize(-p))), 2.6); gl_FragColor = vec4(0.45, 0.68, 1.0, 1.0) * f * 0.55; }",
      }));
      scene.add(rim);
    }
    if (T.stars) {
      const g = new THREE.BufferGeometry(), n = T.stars, pos = new Float32Array(n * 3);
      for (let i = 0; i < n; i++) { const u = Math.random() * 2 - 1, a = Math.random() * 6.283, r = 40 + Math.random() * 20, s = Math.sqrt(1 - u * u);
        pos[i * 3] = r * s * Math.cos(a); pos[i * 3 + 1] = r * u; pos[i * 3 + 2] = r * s * Math.sin(a); }
      g.setAttribute("position", new THREE.BufferAttribute(pos, 3));
      scene.add(new THREE.Points(g, new THREE.PointsMaterial({ color: 0xbfd4ff, size: tier === "epic" ? 0.11 : 0.09, transparent: true, opacity: 0.8, depthWrite: false })));
    }
    resize();
    if (caShapes && caVals) paintCA();
    setHud();
    root.classList.remove("loading");
    frames = 0; tAcc = 0; lowWindows = 0; lastT = performance.now();
    raf = requestAnimationFrame(loop);
  }

  function resize() {
    if (!renderer) return;
    const r = canvasWrap.getBoundingClientRect();
    renderer.setSize(r.width, r.height, false);
    camera.aspect = r.width / Math.max(1, r.height); camera.updateProjectionMatrix();
  }

  let lastFrame = 0;
  function loop(now) {
    raf = requestAnimationFrame(loop);
    if (!visible) return;
    const minGap = 1000 / TIERS[tier].fps - 2;
    if (now - lastFrame < minGap) return;
    const dt = Math.min(0.05, (now - (lastFrame || now)) / 1000); lastFrame = now;
    if (!dragging) { lon += vLon * dt * 60 * 0.12; lat += (CA.lat - 8 - lat) * 0.004 * dt * 60; vLon += ((reduceMotion ? 0 : 0.035) - vLon) * 0.02; }
    lat = Math.max(-70, Math.min(75, lat));
    tilt.rotation.x = lat * Math.PI / 180;
    world.rotation.y = -(lon + 90) * Math.PI / 180;
    camera.position.set(0, 0, zoom); camera.lookAt(0, 0, 0);
    renderer.render(scene, camera);
    // frame-rate governor (Auto only): first lower the resolution, then the tier
    frames++; tAcc += now - lastT; lastT = now;
    if (tAcc > 2000) {
      fps = Math.round((frames * 1000) / tAcc); frames = 0; tAcc = 0;
      hud.querySelector(".fps").textContent = `${fps} fps`;
      const target = TIERS[tier].fps * 0.66;
      if (mode === "auto" && fps < target && !document.hidden) {
        if (++lowWindows >= 2) {
          lowWindows = 0;
          if (dprScale > 0.75) { dprScale = 0.75; renderer.setPixelRatio(Math.min(devicePixelRatio || 1, TIERS[tier].dpr) * dprScale); resize(); }
          else if (tier !== "low") { tier = ORDER[ORDER.indexOf(tier) - 1]; dprScale = 1; note(`Dropped to ${TIERS[tier].label} to keep it smooth`); build(); }
        }
      } else lowWindows = 0;
    }
  }

  let noteT = 0;
  function note(msg) {
    const el = hud.querySelector(".note"); el.textContent = msg; el.hidden = false;
    clearTimeout(noteT); noteT = setTimeout(() => (el.hidden = true), 4000);
  }

  /* --- live California */
  function paintCA() {
    if (!tex || !caShapes) return;
    const cv = tex.image, ctx = cv.getContext("2d"), W = cv.width, H = cv.height;
    const [x0, y0, x1, y1] = CA.box;
    const px = ((x0 + 180) / 360) * W, py = ((90 - y1) / 180) * H, pw = ((x1 - x0) / 360) * W, ph = ((y1 - y0) / 180) * H;
    ctx.drawImage(base, px, py, pw, ph, px, py, pw, ph);
    let sw = 0, sv = 0;
    for (const c of caShapes) { const v = caVals && caVals[c.name]; if (v) { sw += c.pop; sv += c.pop * v; } }
    const mean = sv / Math.max(1, sw);
    for (const c of caShapes) {
      const v = caVals && caVals[c.name];
      ctx.beginPath(); for (const r of c.flat) drawRing(ctx, r, W, H);
      ctx.fillStyle = v ? ramp(Math.max(-1, Math.min(1, Math.log(v / mean) / 0.6))) : "#5d6b80"; ctx.fill();
      ctx.strokeStyle = "rgba(10,20,35,.55)"; ctx.lineWidth = Math.max(0.6, W / 6000); ctx.stroke();
    }
    tex.needsUpdate = true;
  }
  function setCounties(data) {
    caShapes = data.counties.map((c) => ({ name: c.name, pop: c.pop, rings: c.rings, flat: c.rings.map((r) => Float32Array.from(r.flat())) }));
    paintCA();
  }
  function setRun(m) { if (m && m.rude) { caVals = m.rude; paintCA(); } }

  /* --- input */
  const el = canvasWrap;
  let px0 = 0, py0 = 0, moved = 0;
  el.addEventListener("pointerdown", (e) => { dragging = true; moved = 0; px0 = e.clientX; py0 = e.clientY; el.setPointerCapture(e.pointerId); });
  el.addEventListener("pointermove", (e) => {
    if (dragging) {
      const dx = e.clientX - px0, dy = e.clientY - py0; px0 = e.clientX; py0 = e.clientY; moved += Math.abs(dx) + Math.abs(dy);
      const k = 0.2 * (zoom / 4.0); lon -= dx * k; lat += dy * k; vLon = -dx * k * 0.6;
    } else hover(e);
  });
  el.addEventListener("pointerup", () => { dragging = false; });
  el.addEventListener("pointerleave", () => { tip.hidden = true; });
  el.addEventListener("wheel", (e) => { e.preventDefault(); zoom = Math.max(1.9, Math.min(6, zoom * (1 + Math.sign(e.deltaY) * 0.08))); }, { passive: false });
  el.addEventListener("keydown", (e) => {
    const s = 6; if (e.key === "ArrowLeft") lon -= s; else if (e.key === "ArrowRight") lon += s; else if (e.key === "ArrowUp") lat += s; else if (e.key === "ArrowDown") lat -= s;
    else if (e.key === "+" || e.key === "=") zoom = Math.max(1.9, zoom * 0.9); else if (e.key === "-") zoom = Math.min(6, zoom * 1.1); else return;
    e.preventDefault(); vLon = 0;
  });

  const ray = new THREE.Raycaster(), v2 = new THREE.Vector2();
  function hover(e) {
    if (!earth || !caShapes) return;
    const r = el.getBoundingClientRect();
    v2.set(((e.clientX - r.left) / r.width) * 2 - 1, -((e.clientY - r.top) / r.height) * 2 + 1);
    ray.setFromCamera(v2, camera);
    const hit = ray.intersectObject(earth)[0];
    if (!hit) { tip.hidden = true; return; }
    const p = earth.worldToLocal(hit.point.clone()).normalize();
    const la = Math.asin(p.y) * 180 / Math.PI, phi = Math.atan2(p.z, -p.x) * 180 / Math.PI, lo = ((phi - 180 + 540) % 360) - 180;
    let found = null;
    if (lo > CA.box[0] && lo < CA.box[2] && la > CA.box[1] && la < CA.box[3]) {
      for (const c of caShapes) if (c.rings.some((ring) => inside(lo, la, ring))) { found = c; break; }
    }
    if (found) {
      const v = caVals && caVals[found.name];
      tip.innerHTML = `<b>${found.name} County</b><br>${v ? (v * 100).toFixed(1) + "% of encounters went badly" : "No result yet"}`;
    } else if (Math.abs(la) < 80) {
      tip.innerHTML = `<b>Not simulated yet</b><br>Waiting for more GPUs`;
    }
    tip.style.left = e.clientX - r.left + "px"; tip.style.top = e.clientY - r.top + "px"; tip.hidden = false;
  }
  function inside(x, y, ring) {
    let c = false;
    for (let i = 0, j = ring.length - 1; i < ring.length; j = i++) {
      const [xi, yi] = ring[i], [xj, yj] = ring[j];
      if ((yi > y) !== (yj > y) && x < ((xj - xi) * (y - yi)) / (yj - yi) + xi) c = !c;
    }
    return c;
  }

  hud.querySelectorAll("button[data-q]").forEach((b) => b.addEventListener("click", () => {
    mode = b.dataset.q; store.set("simhorde.quality", mode);
    const next = mode === "auto" ? autoTier : mode; dprScale = 1;
    if (next !== tier) { tier = next; build(); } else setHud();
  }));
  new ResizeObserver(resize).observe(canvasWrap);
  new IntersectionObserver((es) => { visible = es[0].isIntersecting; }).observe(root);
  document.addEventListener("visibilitychange", () => { lastT = performance.now(); frames = 0; tAcc = 0; });

  setHud();
  build();
  return { setCounties, setRun };
}
