(() => {
  const $ = (id) => document.getElementById(id);
  const api = (p) => fetch("/api/v1/" + p, { cache: "no-store" }).then((r) => { if (!r.ok) throw new Error(r.status); return r.json(); });
  const fmt = new Intl.NumberFormat("en-US");
  const esc = (s) => String(s ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));

  function ago(s) {
    if (s < 45) return "just now";
    if (s < 3600) return Math.round(s / 60) + " min ago";
    if (s < 86400) return Math.round(s / 3600) + " h ago";
    return Math.round(s / 86400) + " d ago";
  }
  function big(n) {
    if (n >= 1e12) return (n / 1e12).toFixed(1) + " trillion";
    if (n >= 1e9) return (n / 1e9).toFixed(1) + " billion";
    if (n >= 1e6) return (n / 1e6).toFixed(n >= 1e8 ? 0 : 1) + " million";
    return fmt.format(Math.round(n));
  }
  const plural = (n, one, many) => `${fmt.format(n)} ${n === 1 ? one : many}`;
  const hw = (g) => esc((g || "").replace(/^NVIDIA /, "").replace(/GeForce /, ""));

  /* ---------- map ---------- */
  let shapes = null, pop = {};
  const paths = {};
  function drawMap(data) {
    const g = $("counties");
    let x0 = 1e9, x1 = -1e9, y0 = 1e9, y1 = -1e9;
    const k = Math.cos((37.2 * Math.PI) / 180);
    data.counties.forEach((c) => c.rings.forEach((r) => r.forEach(([lon, lat]) => {
      x0 = Math.min(x0, lon * k); x1 = Math.max(x1, lon * k); y0 = Math.min(y0, lat); y1 = Math.max(y1, lat);
    })));
    const s = Math.min(980 / (x1 - x0), 1060 / (y1 - y0));
    const ox = (1000 - (x1 - x0) * s) / 2, oy = (1080 - (y1 - y0) * s) / 2;
    const P = ([lon, lat]) => `${(ox + (lon * k - x0) * s).toFixed(1)},${(oy + (y1 - lat) * s).toFixed(1)}`;
    const frag = document.createDocumentFragment();
    data.counties.forEach((c) => {
      const p = document.createElementNS("http://www.w3.org/2000/svg", "path");
      p.setAttribute("d", c.rings.map((r) => "M" + r.map(P).join("L") + "Z").join(""));
      p.dataset.name = c.name;
      p.setAttribute("tabindex", "0");
      p.setAttribute("aria-label", c.name + " County");
      paths[c.name] = p;
      pop[c.name] = c.pop;
      frag.appendChild(p);
    });
    g.appendChild(frag);
    const tip = $("tip"), fig = document.querySelector(".hero-map");
    const show = (e, p) => {
      const n = p.dataset.name, v = p.dataset.rude;
      tip.innerHTML = `<b>${esc(n)}</b><br>` + (v ? `${(v * 100).toFixed(1)}% of encounters went badly` : "No result yet");
      const fr = fig.getBoundingClientRect();
      const r = e && e.clientX ? { x: e.clientX, y: e.clientY } : (() => { const b = p.getBoundingClientRect(); return { x: b.left + b.width / 2, y: b.top + b.height / 2 }; })();
      tip.style.left = r.x - fr.left + "px";
      tip.style.top = r.y - fr.top + "px";
      tip.hidden = false;
      p.classList.add("on");
    };
    const hide = (p) => { tip.hidden = true; p.classList.remove("on"); };
    g.addEventListener("pointermove", (e) => { if (e.target.dataset.name) show(e, e.target); });
    g.addEventListener("pointerout", (e) => { if (e.target.dataset.name) hide(e.target); });
    g.addEventListener("focusin", (e) => show(null, e.target));
    g.addEventListener("focusout", (e) => hide(e.target));
  }

  const KIND = [14, 124, 120], MID = [232, 236, 239], RUDE = [224, 72, 47];
  const mix = (a, b, t) => a.map((v, i) => Math.round(v + (b[i] - v) * t));
  function colorFor(t) {   // t in [-1, 1]
    const c = t < 0 ? mix(MID, KIND, -t) : mix(MID, RUDE, t);
    return `rgb(${c[0]},${c[1]},${c[2]})`;
  }

  let lastRun = null;
  function paint(m) {
    if (!m.run) return;
    if (m.run !== lastRun) {
      let sw = 0, sv = 0;
      for (const [n, v] of Object.entries(m.rude)) { const w = pop[n] || 1; sw += w; sv += w * v; }
      const mean = sv / sw;
      for (const [n, v] of Object.entries(m.rude)) {
        const p = paths[n];
        if (!p) continue;
        const t = Math.max(-1, Math.min(1, Math.log(v / mean) / 0.6));
        p.style.fill = colorFor(t);
        p.dataset.rude = v;
      }
      if (lastRun === null) requestAnimationFrame(() => requestAnimationFrame(() => $("counties").classList.add("live")));
      lastRun = m.run;
    }
    if (m.caption) { $("mapCaption").innerHTML = m.caption; return; }
    $("mapCaption").innerHTML = `Run ${fmt.format(m.run)}, finished ${ago(m.ago)} by <b>${esc(m.worker)}</b> on ${hw(m.gpu)}. Statewide, ${(m.civ * 100).toFixed(1)}% of encounters were civil.`;
  }

  /* ---------- live sentence ---------- */
  function liveLine(s) {
    const el = $("liveLine");
    if (!s.workers_online && !s.runs_done) {
      el.innerHTML = `<span class="live-dot off"></span>No GPUs are connected yet. Be the first.`;
      return;
    }
    const on = s.workers_online;
    const gpus = on ? `<b>${plural(on, "GPU is", "GPUs are")}</b> working right now` + (s.vram_online ? `, with ${s.vram_online} GB of memory between them` : "") : "No GPUs are connected this minute";
    el.innerHTML = `<span class="live-dot${on ? "" : " off"}"></span>${gpus}. Together volunteers have finished <b>${fmt.format(s.runs_done)}</b> of ${fmt.format(s.runs_goal)} runs for the ${esc(s.campaign)}, simulating <b>${big(s.person_days)}</b> person-days.`;
    if (s.avg_secs) $("avgTime").textContent = `${Math.round(s.avg_secs)} seconds on average so far, across everyone's hardware`;
    if (s.agents) $("jobSize").textContent = `${fmt.format(s.agents)} simulated people over ${s.days} days`;
  }

  function recent(s) {
    const tb = $("recent").tBodies[0];
    if (!s.recent.length) return;
    tb.innerHTML = s.recent.map((r) => `<tr>
      <td>${fmt.format(r.id)}${r.check ? '<span class="badge chk">Re-run</span>' : ""}${r.verified && !r.check ? '<span class="badge ok">Verified</span>' : ""}</td>
      <td class="who">${esc(r.worker)}</td>
      <td class="hw">${hw(r.gpu)}</td>
      <td class="num score${r.score < 0 ? " neg" : ""}">${r.score.toFixed(3)}</td>
      <td class="num">${r.secs < 120 ? r.secs.toFixed(0) + " s" : (r.secs / 60).toFixed(1) + " min"}</td>
      <td>${ago(r.ago)}</td></tr>`).join("");
  }

  function leaders(b) {
    const tb = $("leaders").tBodies[0];
    if (!b.workers.length) return;
    tb.innerHTML = b.workers.map((w, i) => `<tr>
      <td class="num">${i + 1}</td>
      <td class="who">${esc(w.name)}${w.online ? '<span class="badge on">Online</span>' : ""}</td>
      <td class="hw">${hw(w.gpu)}</td>
      <td class="num">${fmt.format(w.jobs)}</td>
      <td class="num">${w.hours.toFixed(1)}</td>
      <td class="num"><b>${fmt.format(Math.round(w.kudos))}</b></td></tr>`).join("");
  }

  /* ---------- progress chart ---------- */
  function chart(p) {
    const svg = $("chart"), pts = p.points;
    const W = 1000, H = 320, L = 52, R = 20, T = 16, B = 38;
    if (!pts.length) {
      svg.innerHTML = `<text x="${W / 2}" y="${H / 2}" text-anchor="middle">The chart fills in as runs come back.</text>`;
      return;
    }
    const n = Math.max(pts[pts.length - 1][0], 10);
    const lo = Math.max(-1, Math.min(0, ...pts.map((q) => q[1])));
    const hi = 1;
    const X = (i) => L + ((i - 1) / Math.max(1, n - 1)) * (W - L - R);
    const Y = (v) => T + ((hi - Math.max(lo, v)) / (hi - lo)) * (H - T - B);
    let g = "";
    for (let v = Math.ceil(lo * 4) / 4; v <= hi + 1e-9; v += 0.25) {
      g += `<line x1="${L}" x2="${W - R}" y1="${Y(v)}" y2="${Y(v)}" stroke="${v === 0 ? "#9FB0BF" : "#E3E9EE"}"/>`;
      g += `<text x="${L - 10}" y="${Y(v) + 4}" text-anchor="end">${v.toFixed(2)}</text>`;
    }
    g += `<text x="${L}" y="${H - 10}">Run 1</text><text x="${W - R}" y="${H - 10}" text-anchor="end">Run ${fmt.format(n)}</text>`;
    g += pts.map((q) => `<circle cx="${X(q[0]).toFixed(1)}" cy="${Y(q[1]).toFixed(1)}" r="2.6" fill="#9FB0BF" fill-opacity=".7"/>`).join("");
    let d = "";
    pts.forEach((q, i) => { d += (i ? `H${X(q[0]).toFixed(1)}V` : `M${X(q[0]).toFixed(1)},`) + Y(q[2]).toFixed(1); });
    g += `<path d="${d}" fill="none" stroke="#1F4BFF" stroke-width="2.5"/>`;
    const last = pts[pts.length - 1];
    g += `<circle cx="${X(last[0])}" cy="${Y(last[2])}" r="5" fill="#1F4BFF"/>`;
    g += `<text x="${Math.min(X(last[0]), W - R - 4)}" y="${Y(last[2]) - 12}" text-anchor="end" style="fill:#0F1B2A;font-weight:650">Best so far ${last[2].toFixed(3)}</text>`;
    svg.innerHTML = g;
  }

  let worldKey = null;
  function worldPanel(g) {
    const box = $("worldNews");
    if (!g || !g.date) { box.hidden = true; return; }
    box.hidden = false;
    $("worldDate").textContent = g.date;
    const nat = Object.keys(g.nations).length;
    $("worldStats").innerHTML = `${fmt.format(nat)} countries and ${big(g.people)} people, simulated as ${fmt.format(g.simulated)} (one for every ${fmt.format(g.scale)}). `
      + (g.civ ? `${(g.civ * 100).toFixed(1)}% of encounters went well this month. ` : "")
      + `${plural(g.conflicts || 0, "armed conflict", "armed conflicts")} under way. Next month: ${g.month_progress[0]} of ${g.month_progress[1]} pieces done.`;
    $("worldEvents").innerHTML = g.events.length ? g.events.slice(0, 8).map((e) => `<li><span>${esc(e[0])} · ${esc(e[2].toLowerCase())}</span>${esc(e[3])}</li>`).join("")
      : "<li>The first month is still being simulated. Headlines appear as soon as volunteers finish it.</li>";
  }
  async function tick() {
    try {
      const [s, m, g] = await Promise.all([api("stats"), api("map"), api("globe").catch(() => ({ date: null }))]);
      liveLine(s); recent(s); paint(m);
      worldPanel(g);
      if (g && g.date && Object.keys(g.nations).length) {
        const key = g.epoch;
        if (key !== worldKey) { worldKey = key; if (globe) globe.setWorld(g); lastWorld = g; }
      } else if (m.run && m.run !== (lastMap && lastMap.run)) { lastMap = m; if (globe) globe.setRun(m); }
      const cap = document.querySelector("#globe figcaption");
      if (cap) cap.textContent = g && g.date ? `${g.date} in the simulated world. Every country runs on its own real statistics. Drag to turn it; point at a country.`
                                             : "California shows the newest volunteer run. Drag to turn it.";
    } catch (e) {
      $("liveLine").innerHTML = `<span class="live-dot off"></span>The coordinator isn't answering right now. This page will keep trying.`;
    }
  }
  async function slow() {
    try { const [p, b] = await Promise.all([api("progress"), api("leaderboard")]); chart(p); leaders(b); } catch (e) {}
  }

  let globe = null, lastMap = null, lastWorld = null;
  import("/globe.js").then((m) => { globe = m.mountGlobe(document.getElementById("globe")); if (shapes) globe.setCounties(shapes); if (lastWorld) globe.setWorld(lastWorld); else if (lastMap) globe.setRun(lastMap); }).catch((e) => console.warn("globe", e));
  api("counties").then((d) => { shapes = d; drawMap(d); if (globe) globe.setCounties(d); tick(); }).catch(() => tick());
  slow();
  setInterval(tick, 8000);
  setInterval(slow, 30000);
})();
