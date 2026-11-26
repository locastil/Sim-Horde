// "Help from this device": runs pieces of the shared world in this browser. No install.
// Only runs while this page is open and visible and the person has pressed Start. Pauses on low battery.
(() => {
  const $ = (id) => document.getElementById(id);
  const box = $("helpBox");
  if (!box) return;
  const store = { get: (k) => { try { return localStorage.getItem(k); } catch (e) { return null; } },
                  set: (k, v) => { try { localStorage.setItem(k, v); } catch (e) {} } };
  const post = (path, body) => fetch("/api/v1/" + path, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) })
    .then(async (r) => ({ code: r.status, body: await r.json().catch(() => ({})) }));

  const phone = matchMedia("(pointer: coarse)").matches;
  const device = /iPad|Tablet|Android(?!.*Mobile)/i.test(navigator.userAgent) ? "tablet" : phone ? "phone" : "browser";
  const CAP = 45000;                    // people per piece this device will take (every piece is built to fit)
  let running = false, busy = false, worker = null, kernel = null, done = 0, kudos = 0, restMs = 3000;
  let key = store.get("simhorde.browserKey");

  const btn = $("helpStart"), status = $("helpStatus"), bar = $("helpBar"), stats = $("helpStats"), pace = $("helpPace");
  const setStatus = (t) => { status.textContent = t; };
  const setBar = (f) => { bar.style.width = Math.round(f * 100) + "%"; };
  const showStats = () => { stats.textContent = done ? `${done} piece${done === 1 ? "" : "s"} of the world simulated here, ${kudos.toFixed(1)} kudos` : ""; };

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
    if (document.hidden) { setStatus("Paused while this page isn't on screen."); return false; }
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
        if (!job || job.kind !== "world") { setStatus("Waiting for the next month of the world to open..."); setBar(0); await sleep(15000); continue; }
        const n = job.payload.nations.reduce((a, x) => a + x.agents, 0);
        setStatus(`Simulating ${job.payload.nations.length} countr${job.payload.nations.length === 1 ? "y" : "ies"} (${n.toLocaleString()} people) for a month...`);
        const res = await runPiece(job);
        const s = await post("world/result", { key, kernel, client: "browser", job: job.id, out: res.out, secs: res.secs });
        if (s.code === 200) {
          done++; kudos += s.body.kudos || 0; showStats();
          setStatus(`Done in ${res.secs.toFixed(1)}s` + (s.body.world_advanced ? ". The world moved on to the next month." : ". Getting the next piece..."));
        } else setStatus(`That piece wasn't accepted (${s.body.error || s.code}). Trying another...`);
      } catch (e) {
        setStatus(`${e.message}. Trying again shortly.`);
        await sleep(10000);
      } finally { busy = false; setBar(0); }
      await sleep(restMs);
    }
  }

  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

  async function start() {
    if (!window.Worker || !window.crypto || !crypto.subtle) { setStatus("This browser is too old to help, sorry."); return; }
    running = true; btn.textContent = "Stop helping"; btn.setAttribute("aria-pressed", "true");
    setStatus("Starting...");
    try { kernel = kernel || (await fingerprint()); } catch (e) { setStatus("Couldn't load the world model. Check your connection."); stop(); return; }
    worker = worker || new Worker("/worker/runner.js");
    store.set("simhorde.helping", "1");
    loop();
  }
  function stop() {
    running = false; btn.textContent = "Start helping"; btn.setAttribute("aria-pressed", "false");
    store.set("simhorde.helping", "0");
    if (worker && busy) { worker.terminate(); worker = null; }
    setBar(0);
    if (!status.textContent.startsWith("A newer")) setStatus(done ? "Stopped. Thanks for helping." : "Not running.");
  }

  btn.addEventListener("click", () => (running ? stop() : start()));
  pace.addEventListener("change", () => { restMs = { gentle: 20000, normal: 3000, full: 0 }[pace.value] || 3000; store.set("simhorde.pace", pace.value); });
  const p0 = store.get("simhorde.pace"); if (p0) { pace.value = p0; pace.dispatchEvent(new Event("change")); }
  const nm = store.get("simhorde.browserName"); if (nm) $("helpName").value = nm;
  $("helpDevice").textContent = device === "browser" ? "this computer" : `this ${device}`;
  document.addEventListener("visibilitychange", () => { if (!document.hidden && running) setStatus("Back on screen: carrying on."); });
})();
