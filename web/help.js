// "Help from this device": runs pieces of the shared world in this browser. No install.
// Only runs while this page is open and the person has pressed Start. Pauses when the page is out of sight,
// unless "Run in background" is ticked. Pauses on low battery either way.
(() => {
  const $ = (id) => document.getElementById(id);
  const box = $("helpBox") || $("help");
  if (!box) return;
  const store = { get: (k) => { try { return localStorage.getItem(k); } catch (e) { return null; } },
                  set: (k, v) => { try { localStorage.setItem(k, v); } catch (e) {} } };
  const post = (path, body) => fetch("/api/v1/" + path, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) })
    .then(async (r) => ({ code: r.status, body: await r.json().catch(() => ({})) }));

  const phone = matchMedia("(pointer: coarse)").matches;
  const device = /iPad|Tablet|Android(?!.*Mobile)/i.test(navigator.userAgent) ? "tablet" : phone ? "phone" : "browser";
  // people per piece this device will take: phones and tablets get phone-sized pieces, computers bigger ones
  const CAP = (phone || device === "tablet") ? 45000 : 250000;
  const pieces = new Map();             // detailed pieces this page keeps from month to month (only numbers go back)
  let running = false, busy = false, worker = null, kernel = null, done = 0, kudos = 0, restMs = 3000;
  let key = store.get("simhorde.browserKey");
  const bg = $("bgRun");
  let background = store.get("simhorde.background") === "1";
  // Browsers slow down timers on pages that aren't on screen; a tiny worker keeps the rests between pieces on time.
  let ticker = null, tick = 0;
  try { ticker = new Worker(URL.createObjectURL(new Blob(["onmessage=(e)=>setTimeout(()=>postMessage(e.data),e.data.ms)"], { type: "text/javascript" }))); } catch (e) {}
  const waits = new Map();
  if (ticker) ticker.onmessage = (e) => { const f = waits.get(e.data.n); if (f) { waits.delete(e.data.n); f(); } };

  const btn = $("helpStart"), status = $("helpStatus"), bar = $("helpBar"), stats = $("helpStats"), pace = $("helpPace");
  const setStatus = (t) => { status.textContent = t; };
  const setBar = (f) => { bar.style.width = Math.round(f * 100) + "%"; };
  const showStats = () => { stats.textContent = done ? `${done} piece${done === 1 ? "" : "s"} of the world simulated here, earning ${kudos.toFixed(1)} kudos to run your own scenarios on the horde. Thank you.` : ""; };

  // tells the globe which countries this device is simulating, so it can light them up
  const piece_ = (state, extra) => window.dispatchEvent(new CustomEvent("simhorde:piece", { detail: Object.assign({ state }, extra || {}) }));
  // any "Help from this device" link starts helping and brings the controls into view
  document.querySelectorAll('a[href="#help"]').forEach((a) => a.addEventListener("click", (e) => {
    e.preventDefault(); document.getElementById("room").scrollIntoView({ behavior: "smooth", block: "center" }); if (!running) start();
  }));

  async function fingerprint() {
    const text = await (await fetch("/worker/kernel.js", { cache: "no-store" })).arrayBuffer();
    const h = await crypto.subtle.digest("SHA-256", text);
    return [...new Uint8Array(h)].map((b) => b.toString(16).padStart(2, "0")).join("");
  }

  async function join() {
    const name = ($("helpName").value || "").trim() || `Anonymous ${device}`;
    const r = await post("workers", { name, gpu: `Web browser (${device})`, vram_gb: 0, client: "browser", kernel });
    if (r.code !== 200) throw new Error(r.body.error || "couldn't join");
    key = r.body.key; store.set("simhorde.browserKey", key); store.set("simhorde.browserName", r.body.name);
  }

  async function okToRun() {
    if (document.hidden && !background) { setStatus("Paused while this page isn't on screen. Tick \"Run in background\" to keep going."); return false; }
    if (navigator.getBattery) {
      try {
        const b = await navigator.getBattery();
        if (!b.charging && b.level < 0.3) { setStatus("Paused: battery under 30%. Plug in to keep helping."); return false; }
      } catch (e) {}
    }
    return true;
  }

  function runPiece(job) {
    return new Promise((resolve, reject) => {
      worker.onmessage = (ev) => {
        const m = ev.data;
        if (m.id !== job.id) return;
        if (m.progress != null) { setBar(m.progress); return; }
        if (m.error) reject(new Error(m.error)); else resolve(m);
      };
      worker.postMessage({ id: job.id, payload: job.payload });
    });
  }

  async function loop() {
    while (running) {
      if (!(await okToRun())) { await sleep(5000); continue; }
      busy = true;
      try {
        if (!key) await join();
        const r = await post("jobs/pop", { key, kernel, client: "browser", cap: CAP, gpu: `Web browser (${device})`, status: "ready" });
        if (r.code === 401) { key = null; continue; }
        if (r.code === 426) { setStatus("A newer version of the world model is out. Reload this page to keep helping."); stop(); break; }
        if (r.code !== 200) throw new Error(r.body.error || "the coordinator isn't answering");
        const job = r.body.job;
        if (!job || job.kind !== "world") { piece_("idle"); setStatus("Waiting for the next month of the world to open..."); setBar(0); await sleep(15000); continue; }
        const P = job.payload, piece = typeof P.piece === "string" ? P.piece : null;
        let resumed = false;
        if (piece && typeof P.resume === "string") {
          const have = pieces.get(piece), ep = P.resume.split("@")[1];
          if (have && String(have.epoch) === ep) { P.state = have.state; resumed = true; }
        }
        const n = P.nations.reduce((a, x) => a + x.agents, 0), k = P.nations.length;
        setStatus(piece ? `Simulating ${k} region${k === 1 ? "" : "s"} at ${P.level} detail (${n.toLocaleString()} people) for a month...`
                        : `Simulating ${k} countr${k === 1 ? "y" : "ies"} (${n.toLocaleString()} people) for a month...`);
        piece_("run", { codes: P.nations.map((x) => String(x.code).split("#")[0]), level: P.level || "Low", people: n });
        const res = await runPiece(job);
        if (piece) {
          pieces.delete(piece); pieces.set(piece, { epoch: Number(job.id.slice(1).split(".")[0]), state: res.out.state });
          while (pieces.size > 8) pieces.delete(pieces.keys().next().value);
          res.out = { nations: res.out.nations, resumed };
        }
        const s = await post("world/result", { key, kernel, client: "browser", job: job.id, out: res.out, secs: res.secs });
        if (s.code === 200) {
          done++; kudos += s.body.kudos || 0; showStats(); piece_("done", { advanced: !!s.body.world_advanced });
          setStatus(`Done in ${res.secs.toFixed(1)}s` + (s.body.world_advanced ? ". The world moved on to the next month." : ". Getting the next piece..."));
        } else setStatus(`That piece wasn't accepted (${s.body.error || s.code}). Trying another...`);
      } catch (e) {
        setStatus(`${e.message}. Trying again shortly.`);
        await sleep(10000);
      } finally { busy = false; setBar(0); }
      await sleep(restMs);
    }
  }

  const sleep = (ms) => new Promise((r) => {
    if (ticker && document.hidden) { const n = ++tick; waits.set(n, r); ticker.postMessage({ n, ms }); } else setTimeout(r, ms);
  });

  async function start() {
    if (!window.Worker || !window.crypto || !crypto.subtle) { setStatus("This browser is too old to help, sorry."); return; }
    running = true; btn.textContent = "Stop helping"; btn.setAttribute("aria-pressed", "true"); window.dispatchEvent(new CustomEvent("simhorde:helping", { detail: true }));
    setStatus("Starting...");
    try { kernel = kernel || (await fingerprint()); } catch (e) { setStatus("Couldn't load the world model. Check your connection."); stop(); return; }
    worker = worker || new Worker("/worker/runner.js");
    store.set("simhorde.helping", "1");
    loop();
  }
  function stop() {
    piece_("idle");
    running = false; btn.textContent = "Start helping"; btn.setAttribute("aria-pressed", "false"); window.dispatchEvent(new CustomEvent("simhorde:helping", { detail: false }));
    store.set("simhorde.helping", "0");
    if (worker && busy) { worker.terminate(); worker = null; }
    setBar(0);
    if (!status.textContent.startsWith("A newer")) setStatus(done ? "Stopped in this browser. Thanks for helping." : "This browser isn't helping. (The Sim Horde app, if it's running on this computer, helps on its own.)");
  }

  btn.addEventListener("click", () => (running ? stop() : start()));
  pace.addEventListener("change", () => { restMs = { gentle: 20000, normal: 3000, full: 0 }[pace.value] || 3000; store.set("simhorde.pace", pace.value); });
  const p0 = store.get("simhorde.pace"); if (p0) { pace.value = p0; pace.dispatchEvent(new Event("change")); }
  const nm = store.get("simhorde.browserName"); if (nm) $("helpName").value = nm;
  $("helpDevice").textContent = device === "browser" ? "computer" : device;
  document.addEventListener("visibilitychange", () => { if (!document.hidden && running) setStatus(background ? "Running in the background. You can switch tabs or minimize this window; just leave the tab open." : "Back on screen: carrying on."); });

  // "Run in background": keep going while the person does other things. Ticking it starts helping if it isn't already.
  if (bg) {
    bg.checked = background;
    bg.addEventListener("change", () => {
      background = bg.checked; store.set("simhorde.background", background ? "1" : "0");
      if (background) {
        if (!running) start();
        setStatus(phone || device === "tablet"
          ? "Running in the background while this tab is open. Phones may still pause it when the screen is off or the browser is closed."
          : "Running in the background. You can switch tabs or minimize this window; just leave the tab open.");
      } else if (running && document.hidden) setStatus("Will pause when this page is out of sight.");
    });
  }
  addEventListener("beforeunload", (e) => { if (running && background) { e.preventDefault(); e.returnValue = ""; } });
})();
