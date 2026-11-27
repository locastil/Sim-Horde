// Sim Horde globe: the world the horde is building, drawn at the quality this device can handle.
// Quality works like a game engine's scalability settings: Low, Medium, High, Epic, or Auto, which
// picks from the graphics card and then watches for stutter: it lowers the resolution, then the
// tier, when frames start running late, and steps back up once there's been headroom for a while.
// Auto tops out at High on computers and Medium at 30 fps on phones and tablets, and drops to Low
// while this device is helping simulate, so the simulation gets the graphics chip.
import * as THREE from "/vendor/three.min.js";
import { addTraffic } from "/traffic.js";
import { addPeople } from "/people.js";

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

/* ------------------------------------------------------------ switching the browser's graphics card */
function fillGpuHelp(box, current) {
  const ua = navigator.userAgent;
  const ol = box.querySelector(".gh-steps");
  const li = (html) => { const e = document.createElement("li"); e.innerHTML = html; ol.appendChild(e); };
  if (/Windows/.test(ua)) {
    const edge = /Edg\//.test(ua), firefox = /Firefox\//.test(ua);
    const browser = edge ? "Edge" : firefox ? "Firefox" : "Chrome";
    const exe = edge ? "C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe"
      : firefox ? "C:\\Program Files\\Mozilla Firefox\\firefox.exe"
      : "C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe";
    li(`<a class="gh-btn" href="ms-settings:display-advancedgraphics">Open Windows graphics settings</a> (allow it if your browser asks).`);
    li(`If ${browser} isn't listed, click <b>Browse</b> next to <i>Add desktop app</i> and paste this path: ` +
       `<span class="gh-path"><code>${exe}</code><button type="button" class="gh-copy">Copy</button></span>`);
    li(`Click <b>${browser}</b> in the list. Set <b>GPU preference</b> to <b>Specific GPU</b> and pick your card. ` +
       `If you only see <i>Power saving</i> and <i>High performance</i>, Windows is choosing for you: plugging your monitor into the card you want is the way to switch.`);
    li(`Quit ${browser} completely and open sim-horde.org again. The top left should name the new card instead of ${current}.`);
    const cp = box.querySelector(".gh-copy");
    if (cp) cp.addEventListener("click", async () => {
      try { await navigator.clipboard.writeText(exe); cp.textContent = "Copied"; } catch { cp.textContent = "Select and copy it"; }
    });
  } else if (/Mac OS X/.test(ua)) {
    li("Connect your display to the external graphics card, then reopen the browser on that display. macOS gives apps the card that drives their screen.");
  } else {
    li("Most Linux browsers draw on the card driving the screen. Connect your display to the card you want, or start the browser with your driver's offload setting (for NVIDIA: <code>__NV_PRIME_RENDER_OFFLOAD=1</code>).");
  }
}

/* ------------------------------------------------------------ hardware */
function probeGPU() {
  const c = document.createElement("canvas");
  const opt = { powerPreference: "high-performance" };          // ask for the same card the globe will draw on
  const gl = c.getContext("webgl2", opt) || c.getContext("webgl", opt);
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
const esc = (s) => String(s ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
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

async function paintBase(tier, W, H, world) {
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
        const nv = world && world.nations[name];
        ctx.fillStyle = nv ? happyColor(nv.happiness)
                           : `hsl(${212 + v * 14}, ${16 + v * 8}%, ${L + v * 6}%)`;
        ctx.fill("evenodd");
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
  if (world) {
    const feats = await loadLayer(T.layers[0]);
    for (const [id, rings] of feats) {
      const nv = world.nations[id];
      if (!nv || !(nv.conflict || nv.protests)) continue;
      ctx.beginPath(); for (const r of rings) drawRing(ctx, r, W, H);
      ctx.strokeStyle = nv.conflict ? "rgba(255,60,60,.95)" : "rgba(255,200,80,.9)";
      ctx.lineWidth = Math.max(1.5, (nv.conflict ? 3.2 : 2.2) * lw); ctx.stroke();
    }
  }
  return { cv, spec };
}

// happiness, 0-10: coral (less happy) through amber to teal (happier)
const HAPPY_STOPS = [[3.0, [232, 76, 61]], [4.5, [240, 140, 64]], [5.6, [242, 200, 92]], [6.6, [96, 200, 150]], [7.6, [30, 170, 190]]];
function happyColor(h) {
  const s = HAPPY_STOPS;
  if (h <= s[0][0]) return `rgb(${s[0][1].join(",")})`;
  for (let i = 1; i < s.length; i++) if (h <= s[i][0]) {
    const t = (h - s[i - 1][0]) / (s[i][0] - s[i - 1][0]), a = s[i - 1][1], b = s[i][1];
    return `rgb(${a.map((v, k) => Math.round(v + (b[k] - v) * t)).join(",")})`;
  }
  return `rgb(${s[s.length - 1][1].join(",")})`;
}

/* ------------------------------------------------------------ the globe */
export function mountGlobe(root, opts = {}) {
  const canvasWrap = root.querySelector(".gl");
  const hud = root.querySelector(".hud");
  const tip = root.querySelector(".gtip");
  const gpu = probeGPU();
  if (!gpu.ok) { root.classList.add("nogl"); hud.querySelector(".hw").textContent = "This browser can't draw 3D graphics."; return; }
  const handheld = matchMedia("(pointer: coarse)").matches && Math.min(screen.width, screen.height) < 1100;
  const CEIL = handheld ? "medium" : "high";                     // Auto never goes above this; Epic is a choice
  const capTier = (t) => ORDER[Math.min(ORDER.indexOf(t), ORDER.indexOf(CEIL))];
  const autoTier = capTier(tierFor(gpu));
  let helping = false, ceiling = autoTier, beforeHelp = null;                       // ceiling: the highest tier Auto may climb back to
  const urlQ = new URLSearchParams(location.search).get("quality");
  let mode = (urlQ && (TIERS[urlQ] || urlQ === "auto")) ? urlQ : (store.get("simhorde.quality") || "auto");
  let tier = mode === "auto" ? autoTier : mode;

  let worldData = null, painting = false, repaintQueued = false;
  let traffic = null, people = null, peopleKey = "";
  // the city lights only need redrawing when which countries are at war changes
  const warKey = () => Object.entries((tdata.globe && tdata.globe.nations) || {}).filter(([, n]) => n.conflict).map(([k]) => k).join();
  const refreshPeople = (force) => {
    if (!people || !tdata.globe || !tdata.cities) return;
    const k = warKey(); if (!force && k === peopleKey) return;
    peopleKey = k; people.setData(tdata);
  };
  const tdata = { globe: null, markets: null, cities: null };     // flights and ships: an illustration driven by the simulation
  const refreshTraffic = async () => {
    try {
      const [m, c, b] = await Promise.all([fetch("/api/v1/markets").then((r) => r.json()).catch(() => null), tdata.cities || fetch("/geo/cities.json").then((r) => r.json()),
                                           tdata.base || fetch("/scenario/base.json").then((r) => r.json()).catch(() => null)]);
      if (m) tdata.markets = m; tdata.cities = c; if (b) tdata.base = b;
      if (traffic && tdata.globe) traffic.setData(tdata);
      refreshPeople(false);
    } catch (e) {}
  };
  refreshTraffic(); setInterval(refreshTraffic, 120000);
  let renderer, scene, camera, world, tilt, earth, tex, specTex, base, raf = 0, built = 0;
  let lon = Math.random() * 360 - 180, lat = 15, vLon = reduceMotion ? 0 : 0.035, vLat = 0, dragging = false, zoom = 4.0;
  let visible = true, frames = 0, tAcc = 0, slow = 0, lowWindows = 0, goodWindows = 0, lastT = performance.now(), fps = 0, dprScale = 1;
  let probation = 0, holdUntil = 0;                              // after stepping up: watch closely, and back off if it was too much
  const fpsOf = (t) => (mode === "auto" && handheld) ? 30 : TIERS[t].fps;

  function setHud() {
    hud.querySelector(".hw").textContent = gpu.name;
    hud.querySelector(".q").textContent = TIERS[tier].label + (mode === "auto" ? (helping ? " (auto, helping)" : " (auto)") : "");
    hud.querySelectorAll("button[data-q]").forEach((b) => b.setAttribute("aria-pressed", String(b.dataset.q === mode)));
  }

  async function build() {
    const myBuild = ++built;
    const T = TIERS[tier];
    root.classList.add("loading");
    if (renderer) { cancelAnimationFrame(raf); renderer.dispose(); renderer.domElement.remove(); scene.traverse((o) => { o.geometry && o.geometry.dispose(); o.material && o.material.dispose(); }); tex && tex.dispose(); specTex && specTex.dispose(); }
    const W = Math.min(T.tex, gpu.maxTex), H = W / 2;
    const painted = await paintBase(tier, W, H, worldData);
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
    people = addPeople(world, tier, null); refreshPeople(true);
    traffic = addTraffic(world, tier, tdata.globe && tdata.cities ? tdata : null);
    drawPiece();
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
    setHud();
    root.classList.remove("loading");
    frames = 0; tAcc = 0; slow = 0; lowWindows = 0; lastT = performance.now();
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
    const minGap = 1000 / fpsOf(tier) - 2;
    if (now - lastFrame < minGap) return;
    const dt = Math.min(0.05, (now - (lastFrame || now)) / 1000); lastFrame = now;
    if (!dragging && focus && now < focus.until) {
      const dLon = ((focus.lon - lon + 540) % 360) - 180;
      lon += dLon * Math.min(1, dt * 1.6); lat += (focus.lat - lat) * Math.min(1, dt * 1.6); vLon = 0;
    } else if (!dragging) { lon += vLon * dt * 60 * 0.12; lat += (15 - lat) * 0.004 * dt * 60; vLon += ((reduceMotion ? 0 : 0.035) - vLon) * 0.02; }
    if (pieceGroup) { pulse += dt; pieceGroup.children.forEach((l) => (l.material.opacity = piece && piece.state === "done" ? Math.max(0, 1 - (pulse - piece.doneAt) * 0.8) : 0.55 + 0.4 * Math.sin(pulse * 3))); }
    lat = Math.max(-70, Math.min(75, lat));
    tilt.rotation.x = lat * Math.PI / 180;
    world.rotation.y = -(lon + 90) * Math.PI / 180;
    camera.position.set(0, 0, zoom); camera.lookAt(0, 0, 0);
    if (traffic) traffic.update(dt);
    if (people) people.update(dt);
    renderer.render(scene, camera);
    // smoothness governor (Auto only). It counts late frames rather than averaging, because a
    // choppy 45 fps looks worse than a steady 30. Down: resolution first, then the tier. Up: after
    // ~30 s with no stutter, one step at a time, and straight back down if that step stutters.
    const gap = now - lastT; lastT = now;
    if (gap < 250) {                                             // ignore pauses (tab switches, scrolling away)
      frames++; tAcc += gap;
      if (gap > 1.6 * (1000 / fpsOf(tier))) slow++;
    }
    if (tAcc > 2000) {
      fps = Math.round((frames * 1000) / tAcc);
      const lateShare = slow / Math.max(1, frames);
      frames = 0; tAcc = 0; slow = 0;
      hud.querySelector(".fps").textContent = `${fps} fps`;
      if (mode === "auto" && !document.hidden) {
        if (lateShare > (probation > 0 ? 0.05 : 0.1)) {
          goodWindows = 0;
          if (probation > 0) { probation = 0; holdUntil = now + 300000; stepDown("Back to {t}: that was a bit much"); }
          else if (++lowWindows >= 2) { lowWindows = 0; stepDown("Dropped to {t} to keep it smooth"); }
        } else {
          lowWindows = 0;
          if (probation > 0) probation--;
          if (lateShare < 0.01 && ++goodWindows >= 15 && now > holdUntil) { goodWindows = 0; stepUp(); }
        }
      }
    }
  }

  function setPR() { renderer.setPixelRatio(Math.min(devicePixelRatio || 1, TIERS[tier].dpr) * dprScale); resize(); }
  function stepDown(msg) {
    if (dprScale > 0.75) { dprScale = 0.75; setPR(); return; }
    if (tier === "low") return;
    tier = ORDER[ORDER.indexOf(tier) - 1]; dprScale = 1; note(msg.replace("{t}", TIERS[tier].label)); build();
  }
  function stepUp() {
    if (dprScale < 1) { dprScale = 1; setPR(); probation = 3; return; }
    if (ORDER.indexOf(tier) >= ORDER.indexOf(ceiling)) return;
    tier = ORDER[ORDER.indexOf(tier) + 1]; dprScale = 0.75; probation = 3; build();   // new tier starts at reduced resolution
  }
  // help.js tells the globe when this device starts or stops simulating
  window.addEventListener("simhorde:helping", (e) => {
    if (!!e.detail === helping) return;
    helping = !!e.detail; ceiling = helping ? "low" : autoTier;
    if (helping) beforeHelp = tier;
    if (mode !== "auto") return setHud();
    const next = helping ? "low" : (beforeHelp || autoTier);     // back to where it had settled, not the top
    goodWindows = lowWindows = probation = 0; holdUntil = 0;
    if (next !== tier) { tier = next; dprScale = 1; if (helping) note("Globe on Low while this device helps"); build(); } else setHud();
  });

  let noteT = 0;
  function note(msg) {
    const el = hud.querySelector(".note"); el.textContent = msg; el.hidden = false;
    clearTimeout(noteT); noteT = setTimeout(() => (el.hidden = true), 4000);
  }

  /* --- the world's happiness */
  async function setWorld(g) {
    worldData = { nations: g.nations };
    tdata.globe = g; if (traffic && tdata.cities) traffic.setData(tdata);
    refreshPeople(false);
    if (!tex) return;
    if (painting) { repaintQueued = true; return; }
    painting = true;
    const cv = tex.image;
    const p = await paintBase(tier, cv.width, cv.height, worldData);
    cv.getContext("2d").drawImage(p.cv, 0, 0); base = p.cv; tex.needsUpdate = true;
    painting = false;
    if (repaintQueued) { repaintQueued = false; setWorld({ nations: worldData.nations }); }
  }

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
  let tapT = 0, tapX = 0, tapY = 0;
  const street = (e) => { hover(e); if (hitId != null) window.dispatchEvent(new CustomEvent("simhorde:street", { detail: { num: hitId } })); };
  el.addEventListener("pointerup", (e) => {
    dragging = false;
    if (e.pointerType !== "mouse" && moved < 12) {          // double-tap on phones and tablets
      const now = performance.now();
      if (now - tapT < 350 && Math.hypot(e.clientX - tapX, e.clientY - tapY) < 40) { tapT = 0; street(e); return; }
      tapT = now; tapX = e.clientX; tapY = e.clientY; hover(e);
    }
  });
  el.addEventListener("dblclick", (e) => { e.preventDefault(); street(e); });
  el.addEventListener("pointerleave", () => { tip.hidden = true; });
  el.addEventListener("wheel", (e) => { e.preventDefault(); zoom = Math.max(1.9, Math.min(6, zoom * (1 + Math.sign(e.deltaY) * 0.08))); }, { passive: false });
  el.addEventListener("keydown", (e) => {
    const s = 6; if (e.key === "ArrowLeft") lon -= s; else if (e.key === "ArrowRight") lon += s; else if (e.key === "ArrowUp") lat += s; else if (e.key === "ArrowDown") lat -= s;
    else if (e.key === "+" || e.key === "=") zoom = Math.max(1.9, zoom * 0.9); else if (e.key === "-") zoom = Math.min(6, zoom * 1.1); else return;
    e.preventDefault(); vLon = 0;
  });

  const ray = new THREE.Raycaster(), v2 = new THREE.Vector2();
  let hitId = null;
  function hover(e) {
    hitId = null;
    if (!earth) return;
    const r = el.getBoundingClientRect();
    v2.set(((e.clientX - r.left) / r.width) * 2 - 1, -((e.clientY - r.top) / r.height) * 2 + 1);
    ray.setFromCamera(v2, camera);
    const hit = ray.intersectObject(earth)[0];
    if (!hit) { tip.hidden = true; return; }
    const p = earth.worldToLocal(hit.point.clone()).normalize();
    const la = Math.asin(p.y) * 180 / Math.PI, phi = Math.atan2(p.z, -p.x) * 180 / Math.PI, lo = ((phi - 180 + 540) % 360) - 180;
    if (worldData && hoverFeats) {
      let hit = null;
      for (const [id, rings] of hoverFeats) {
        const nv = worldData.nations[id];
        if (nv && rings.some((r) => insideFlat(lo, la, r))) { hit = nv; hitId = id; break; }
      }
      if (hit) {
        const flags = [hit.conflict ? "armed conflict" : "", hit.protests ? "protests" : ""].filter(Boolean);
        tip.innerHTML = `<b>${esc(hit.name)}</b> <i style="opacity:.6">simulated</i><br>${esc(hit.gov)}: ${esc(hit.ruling)} hold${/^the ruling|^the armed|^the opposition/.test(hit.ruling) ? "s" : ""} power<br>Happiness ${hit.happiness.toFixed(1)} / 10` + (hit.survey != null ? ` <span style="opacity:.6">(surveys: ${hit.survey.toFixed(1)})</span>` : "") + (flags.length ? `<br>${flags.join(", ")}` : "") + (hit.detail && hit.detail !== "Low" ? `<br><span style="opacity:.6">Simulated at ${esc(hit.detail)} detail</span>` : "") + `<br><span style="opacity:.6">Double-click to see its streets</span>`;
      } else if (Math.abs(la) < 80) { tip.hidden = true; return; }
      tip.style.left = e.clientX - r.left + "px"; tip.style.top = e.clientY - r.top + "px"; tip.hidden = false;
      return;
    }
    tip.hidden = true;
  }
  // ---- what this device is simulating right now, lit up on the globe
  let piece = null, pieceGroup = null, focus = null, pulse = 0;
  const tag = document.getElementById("pieceTag");
  const D = Math.PI / 180;
  const v3 = (lo, la, r) => { const phi = (lo + 180) * D, a = la * D; return new THREE.Vector3(-Math.cos(phi) * Math.cos(a) * r, Math.sin(a) * r, Math.sin(phi) * Math.cos(a) * r); };
  async function numsFor(codes) {
    tdata.base = tdata.base || (await fetch("/scenario/base.json").then((r) => r.json()).catch(() => null));
    const by = {}; for (const n of (tdata.base && tdata.base.nations) || []) by[n.c] = n.num;
    return [...new Set(codes.map((c) => by[c]).filter(Boolean))];
  }
  function drawPiece() {
    if (pieceGroup && pieceGroup.parent) pieceGroup.parent.remove(pieceGroup);
    pieceGroup = null;
    if (!piece || !piece.nums || !world || !hoverFeats) return;
    pieceGroup = new THREE.Group();
    const want = new Set(piece.nums);
    for (const [id, rings] of hoverFeats) {
      if (!want.has(id)) continue;
      for (const ring of rings) {                    // rings are flat: lon, lat, lon, lat...
        if (ring.length < 8) continue;
        const pts = []; for (let i = 0; i < ring.length; i += 2) pts.push(v3(ring[i], ring[i + 1], 1.004));
        pieceGroup.add(new THREE.LineLoop(new THREE.BufferGeometry().setFromPoints(pts),
          new THREE.LineBasicMaterial({ color: 0x7ee8ff, transparent: true, opacity: 0.9, depthWrite: false })));
      }
    }
    world.add(pieceGroup);
  }
  function centreOf(nums) {
    let best = null, size = 0;
    for (const [id, rings] of hoverFeats || []) if (nums.includes(id)) for (const r of rings) if (r.length > size) { size = r.length; best = r; }
    if (!best) return null;
    let a = 180, b = -180, c = 90, d = -90;
    for (let i = 0; i < best.length; i += 2) { a = Math.min(a, best[i]); b = Math.max(b, best[i]); c = Math.min(c, best[i + 1]); d = Math.max(d, best[i + 1]); }
    return { lon: (a + b) / 2, lat: Math.max(-50, Math.min(60, (c + d) / 2)) };
  }
  window.addEventListener("simhorde:piece", async (e) => {
    const d = e.detail || {};
    if (d.state === "run") {
      const nums = await numsFor(d.codes || []);
      piece = { state: "run", nums, level: d.level };
      pulse = 0; drawPiece();
      const c = centreOf(nums);
      if (c && !reduceMotion) focus = { lon: c.lon, lat: c.lat, until: performance.now() + 9000 };
      const names = nums.map((n) => (worldData && worldData.nations[n] && worldData.nations[n].name) || null).filter(Boolean);
      if (tag) {
        tag.hidden = false;
        tag.textContent = names.length ? `This ${d.level && d.level !== "Low" ? `${d.level.toLowerCase()}-detail ` : ""}piece: ${names.length <= 3 ? names.join(", ") : `${names.slice(0, 3).join(", ")} and ${names.length - 3} more`}`
          : "Simulating a piece of the world";
      }
    } else if (d.state === "done" && piece) {
      piece.state = "done"; piece.doneAt = pulse;
      if (tag) tag.textContent = d.advanced ? "Sent back. The world moved on to the next month." : "Sent back to the world.";
    } else if (d.state === "idle") {
      piece = null; drawPiece(); if (tag) tag.hidden = true;
    }
  });

  // ---- full screen: the globe and its controls together
  const room = document.getElementById("room"), fsBtn = document.getElementById("fsBtn");
  if (fsBtn && room && room.requestFullscreen) {
    fsBtn.addEventListener("click", () => (document.fullscreenElement ? document.exitFullscreen() : room.requestFullscreen()).catch(() => {}));
    document.addEventListener("fullscreenchange", () => {
      const on = document.fullscreenElement === room;
      fsBtn.textContent = on ? "Exit full screen" : "Full screen"; fsBtn.setAttribute("aria-pressed", String(on));
      setTimeout(resize, 60);
    });
  } else if (fsBtn) fsBtn.hidden = true;

  let hoverFeats = null;
  loadLayer("countries_low").then((f) => { hoverFeats = f; });
  function insideFlat(x, y, ring) {
    let c = false;
    for (let i = 0, j = ring.length - 2; i < ring.length; j = i, i += 2) {
      const xi = ring[i], yi = ring[i + 1], xj = ring[j], yj = ring[j + 1];
      if ((yi > y) !== (yj > y) && x < ((xj - xi) * (y - yi)) / (yj - yi) + xi) c = !c;
    }
    return c;
  }
  function inside(x, y, ring) {
    let c = false;
    for (let i = 0, j = ring.length - 1; i < ring.length; j = i++) {
      const [xi, yi] = ring[i], [xj, yj] = ring[j];
      if ((yi > y) !== (yj > y) && x < ((xj - xi) * (y - yi)) / (yj - yi) + xi) c = !c;
    }
    return c;
  }

  // the browser, not the page, decides which graphics card draws: show how to switch it (computers only)
  const sw = hud.querySelector(".gpu-switch"), swp = root.querySelector(".gpu-help");
  if (sw && swp) {
    if (handheld) sw.hidden = true;
    fillGpuHelp(swp, gpu.name);
    sw.addEventListener("click", () => { const open = swp.hidden; swp.hidden = !open; sw.setAttribute("aria-expanded", String(open)); });
  }
  hud.querySelectorAll("button[data-q]").forEach((b) => b.addEventListener("click", () => {
    mode = b.dataset.q; store.set("simhorde.quality", mode);
    const next = mode === "auto" ? ceiling : mode; dprScale = 1; probation = 0; goodWindows = lowWindows = 0;
    if (next !== tier) { tier = next; build(); } else setHud();
  }));
  new ResizeObserver(resize).observe(canvasWrap);
  new IntersectionObserver((es) => { visible = es[0].isIntersecting; }).observe(root);
  document.addEventListener("visibilitychange", () => { lastT = performance.now(); frames = 0; tAcc = 0; });

  setHud();
  build();
  return { setWorld };
}
