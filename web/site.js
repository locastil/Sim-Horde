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

  /* ---------- live sentence ---------- */
  function liveLine(s) {
    const el = $("liveLine");
    if (!s.workers_online && !s.runs_done) {
      el.innerHTML = `<span class="live-dot off"></span>No devices are powering the world yet. Be the first.`;
      return;
    }
    const on = s.workers_online;
    const gpus = on ? `<b>${plural(on, "device is", "devices are")}</b> powering the world right now` + (s.vram_online ? `, with ${s.vram_online} GB of memory between them` : "") : "No devices are powering the world this minute";
    el.innerHTML = `<span class="live-dot${on ? "" : " off"}"></span>${gpus}. Together volunteers have finished <b>${fmt.format(s.runs_done)}</b> of ${fmt.format(s.runs_goal)} runs for the ${esc(s.campaign)}, simulating <b>${big(s.person_days)}</b> person-days.`;
    if (s.avg_secs) $("avgTime").textContent = `${Math.round(s.avg_secs)} seconds on average so far, across everyone's hardware for California tuning jobs`;
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
    const fit = g.fit && g.fit.r != null ? ` Simulated happiness lines up with real life-satisfaction surveys at r = ${g.fit.r.toFixed(2)} across ${g.fit.n} countries.` : "";
    $("worldStats").innerHTML = `${nat ? fmt.format(nat) + " countries" : "Every country"} and ${big(g.people)} people, simulated as ${fmt.format(g.simulated_detail || g.simulated)}${g.simulated_detail > g.simulated ? " with all the detail volunteers added" : ` (one for every ${fmt.format(g.scale)})`}. `
      + (g.happiness ? `Average happiness ${g.happiness.toFixed(1)} out of 10. ` : "")
      + `${plural(g.conflicts || 0, "armed conflict", "armed conflicts")} under way.` + fit;
    const lv = (g.levels || []).filter((l) => l.nations > 0 && l.name !== "Low");
    if (lv.length) $("worldStats").innerHTML += ` Detail last month: ` + lv.reverse().map((l) => `${l.name} for ${plural(l.nations, "country", "countries")}`).join(", ")
      + `, Low for the rest.`;
    $("worldEvents").innerHTML = g.events.length ? g.events.slice(0, 8).map((e) => `<li><span>${esc(e[0])} · ${esc(e[2].toLowerCase())}</span>${esc(e[3])}</li>`).join("")
      : "<li>The first month is still being simulated. Headlines appear as soon as volunteers finish it.</li>";
  }
  async function tick() {
    try {
      const [s, g] = await Promise.all([api("stats"), api("globe").catch(() => ({ date: null }))]);
      liveLine(s); recent(s); worldPanel(g);
      if (g && g.date && Object.keys(g.nations).length && g.epoch !== worldKey) {
        worldKey = g.epoch; lastWorld = g; if (globe) globe.setWorld(g);
      }
      const cap = $("globeCap");
      if (cap) cap.textContent = g && g.date ? `${g.date}. Drag to turn it; point at a country, or double-click one to see its streets. White dots are flights, amber are ships.` : "The world starts when the first volunteer connects.";
    } catch (e) {
      $("liveLine").innerHTML = `<span class="live-dot off"></span>The coordinator isn't answering right now. This page will keep trying.`;
    }
  }
  async function slow() {
    try { const [p, b] = await Promise.all([api("progress"), api("leaderboard")]); chart(p); leaders(b); } catch (e) {}
  }

  let globe = null, lastWorld = null;
  import("/globe.js").then((m) => { globe = m.mountGlobe(document.getElementById("globe")); if (lastWorld) globe.setWorld(lastWorld); }).catch((e) => console.warn("globe", e));
  tick();
  slow();
  setInterval(tick, 8000);
  setInterval(slow, 30000);
})();
