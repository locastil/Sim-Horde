// The World Exchange: the simulated world's markets, trade laws and headlines, live.
// Everything here comes from /api/v1/markets and /api/v1/globe; nothing is real-world price data.
(() => {
  const $ = (id) => document.getElementById(id);
  const root = $("xchg");
  if (!root) return;
  const MONTHS = ["January", "February", "March", "April", "May", "June", "July", "August", "September", "October", "November", "December"];
  const label = (e) => `${MONTHS[e % 12]}, Year ${Math.floor(e / 12) + 1}`;
  const epochOf = (s) => { const m = /^(\w+), Year (\d+)/.exec(s || ""); return m ? (Number(m[2]) - 1) * 12 + MONTHS.indexOf(m[1]) : -1; };
  const esc = (s) => String(s ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
  const nf = new Intl.NumberFormat("en-US", { maximumFractionDigits: 0 });
  const nf2 = new Intl.NumberFormat("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 2 });
  const pct = (x) => x == null ? "–" : `${x > 0 ? "+" : x < 0 ? "−" : ""}${Math.abs(x * 100).toFixed(1)}%`;
  const dir = (x) => x == null || Math.abs(x) < 0.0005 ? "flat" : x > 0 ? "up" : "down";
  const still = matchMedia("(prefers-reduced-motion: reduce)").matches;

  const KIND = {
    MARKETS: ["Markets", "mkt"], TARIFF: ["Tariffs", "trade"], DEAL: ["Trade deal", "trade"], SANCTIONS: ["Sanctions", "trade"],
    BAN: ["Export ban", "trade"], TRADE: ["Trade", "trade"],
    PROTEST: ["Protests", "pol"], CRACKDOWN: ["Crackdown", "pol"], COUP: ["Coup", "pol"], CONFLICT: ["Conflict", "pol"],
    WAR: ["War", "pol"], PEACE: ["Ceasefire", "pol"], BORDER: ["Border", "pol"], ELECTION: ["Election", "pol"],
    TRANSITION: ["Transition", "pol"], BACKSLIDING: ["Backsliding", "pol"], OPENING: ["Opening up", "pol"],
  };
  const state = { m: null, g: null, range: 60, movers: "up", feed: "all", sort: "m1", desc: true, q: "", last: {} };

  // ------------------------------------------------------------ small charts
  function path(vals, w, h, pad = 2) {
    if (!vals.length) return { d: "", pts: [] };
    const lo = Math.min(...vals), hi = Math.max(...vals), span = hi - lo || 1;
    const pts = vals.map((v, i) => [pad + (i / Math.max(1, vals.length - 1)) * (w - 2 * pad), pad + (1 - (v - lo) / span) * (h - 2 * pad)]);
    return { d: pts.map((p, i) => `${i ? "L" : "M"}${p[0].toFixed(1)},${p[1].toFixed(1)}`).join(""), pts, lo, hi };
  }
  const spark = (vals, cls) => {
    const { d } = path(vals, 96, 28);
    return `<svg class="spark ${cls}" viewBox="0 0 96 28" aria-hidden="true"><path d="${d}"/></svg>`;
  };

  function bigChart(svg, tip, series, opts = {}) {
    const W = 640, H = 220;
    const vals = series.map((p) => p[1]);
    const { d, pts, lo, hi } = path(vals, W, H, 6);
    const up = vals.length < 2 || vals[vals.length - 1] >= vals[0];
    svg.setAttribute("viewBox", `0 0 ${W} ${H}`);
    svg.classList.toggle("down", !up);
    svg.innerHTML = d ? `<defs><linearGradient id="${svg.id}G" x1="0" x2="0" y1="0" y2="1"><stop offset="0" stop-opacity=".28"/><stop offset="1" stop-opacity="0"/></linearGradient></defs>`
      + `<path class="area" fill="url(#${svg.id}G)" d="${d}L${W - 6},${H}L6,${H}Z"/><path class="line" d="${d}"/>`
      + `<text class="axis" x="10" y="16">${nf.format(hi)}</text><text class="axis" x="10" y="${H - 8}">${nf.format(lo)}</text>`
      + `<line class="cross" x1="0" x2="0" y1="0" y2="${H}" hidden/><circle class="dot" r="4" hidden/>` : "";
    const cross = svg.querySelector(".cross"), dot = svg.querySelector(".dot");
    const move = (ev) => {
      if (!pts.length) return;
      const r = svg.getBoundingClientRect();
      const x = ((ev.touches ? ev.touches[0].clientX : ev.clientX) - r.left) / r.width * W;
      const i = Math.max(0, Math.min(pts.length - 1, Math.round((x - 6) / (W - 12) * (pts.length - 1))));
      const [px, py] = pts[i];
      cross.setAttribute("x1", px); cross.setAttribute("x2", px); cross.hidden = false; cross.removeAttribute("hidden");
      dot.setAttribute("cx", px); dot.setAttribute("cy", py); dot.removeAttribute("hidden");
      const first = vals[0];
      tip.innerHTML = `<b>${nf2.format(vals[i])}</b><span>${esc(label(series[i][0]))}</span><span class="${dir(vals[i] / first - 1)}">${pct(vals[i] / first - 1)} over this view</span>`;
      tip.hidden = false;
      tip.style.left = `${(px / W) * 100}%`;
    };
    const leave = () => { tip.hidden = true; cross && cross.setAttribute("hidden", ""); dot && dot.setAttribute("hidden", ""); };
    svg.onmousemove = move; svg.ontouchmove = move; svg.onmouseleave = leave; svg.ontouchend = leave;
  }

  // ------------------------------------------------------------ pieces of the screen
  function renderTape(rows) {
    const items = rows.filter((r) => r.m1 != null).sort((a, b) => Math.abs(b.m1) - Math.abs(a.m1)).slice(0, 40)
      .map((r) => `<button type="button" class="tick ${dir(r.m1)}" data-num="${r.num}" title="${esc(r.name)}"><b>${esc(r.t)}</b> ${nf2.format(r.i)} <span>${pct(r.m1)}</span></button>`).join("");
    $("tape").innerHTML = items + (still ? "" : `<span aria-hidden="true" class="tape-dup">${items}</span>`);
  }

  function renderIndex(m) {
    const w = m.world;
    $("wIdx").textContent = nf2.format(w.i);
    const c = $("wChg");
    c.textContent = `${pct(w.m1)} this month · ${pct(w.m12)} this year`;
    c.className = `x-chg ${dir(w.m1)}`;
    const h = state.range ? w.h.slice(-state.range - 1) : w.h;
    bigChart($("wChart"), $("wTip"), h);
  }

  function renderMovers(rows) {
    const sorted = rows.filter((r) => r.m1 != null).sort((a, b) => (state.movers === "up" ? b.m1 - a.m1 : a.m1 - b.m1)).slice(0, 5);
    $("movers").innerHTML = sorted.map((r) => `<li><button type="button" data-num="${r.num}">
        <span class="mv-name"><b>${esc(r.t)}</b><span>${esc(r.name)}</span></span>${spark(r.h.slice(-13), dir(r.m1))}
        <span class="mv-num">${nf2.format(r.i)}<span class="${dir(r.m1)}">${pct(r.m1)}</span></span></button></li>`).join("");
  }

  function feedItems() {
    const out = [], seen = new Set();
    const add = (list) => (list || []).forEach((e) => { const k = e[3]; if (!seen.has(k)) { seen.add(k); out.push(e); } });
    add(state.m && state.m.events); add(state.g && state.g.events);
    return out.sort((a, b) => epochOf(b[0]) - epochOf(a[0]));
  }

  function renderFeed() {
    const byName = new Map(Object.entries(state.m.nations).map(([num, r]) => [r.name, num]));
    const items = feedItems().filter((e) => state.feed === "all" || (KIND[e[2]] || ["", "pol"])[1] === state.feed).slice(0, 10);
    $("feed").innerHTML = items.length ? items.map((e) => {
      const [tag, cls] = KIND[e[2]] || [e[2].toLowerCase(), "pol"];
      const num = byName.get(e[1]);
      const fresh = state.last.feed && !state.last.feed.has(e[3]) ? " fresh" : "";
      return `<li class="${fresh}"><div class="f-meta"><span class="chip ${cls}">${esc(tag)}</span><span>${esc(e[0])}</span>`
        + (num ? `<button type="button" class="f-country" data-num="${num}">${esc(e[1])}</button>` : "") + `</div><p>${esc(e[3])}</p></li>`;
    }).join("") : `<li class="empty"><p>Nothing here yet this month. The feed fills as the world moves.</p></li>`;
    state.last.feed = new Set(feedItems().map((e) => e[3]));
  }

  function openCountry(num) {
    const r = state.m && state.m.nations[num];
    if (!r) return;
    const dlg = $("xCountry");
    $("cName").textContent = r.name;
    $("cTicker").textContent = `${r.t} · ${r.region} · ${r.gov}`;
    $("cIdx").textContent = nf2.format(r.i);
    const c = $("cChg"); c.textContent = `${pct(r.m1)} this month · ${pct(r.m12)} this year`; c.className = `x-chg ${dir(r.m1)}`;
    const e0 = state.m.epoch - r.h.length;
    bigChart($("cChart"), $("cTip"), r.h.map((v, i) => [e0 + i, v]));
    $("cFacts").innerHTML = `<div><dt>Happiness</dt><dd>${r.happy != null ? r.happy.toFixed(1) + " / 10" : "–"}</dd></div>`
      + `<div><dt>Trade</dt><dd>${r.open != null ? Math.round(r.open) + "% of GDP" : "–"}${r.real_open ? " (World Bank)" : " (estimated)"}</dd></div>`
      + `<div><dt>Trades most with</dt><dd>${r.partners.slice(0, 3).map(esc).join(", ") || "–"}</dd></div>`;
    const ev = feedItems().filter((e) => e[1] === r.name).slice(0, 3);
    $("cEvents").innerHTML = ev.length ? ev.map((e) => `<li><span class="chip ${(KIND[e[2]] || ["", "pol"])[1]}">${esc((KIND[e[2]] || [e[2]])[0])}</span><span class="c-date">${esc(e[0])}</span><p>${esc(e[3])}</p></li>`).join("")
      : "";
    state.open = num;
    if (!dlg.open) dlg.showModal();
  }

  function render() {
    const m = state.m;
    if (!m || !m.world) return;
    root.hidden = false;
    const rows = Object.entries(m.nations).map(([num, r]) => Object.assign({ num }, r));
    renderTape(rows); renderIndex(m); renderMovers(rows); renderFeed();
    if (state.open && $("xCountry").open) openCountry(state.open);
  }

  async function tick() {
    try {
      const [m, g] = await Promise.all([fetch("/api/v1/markets", { cache: "no-store" }).then((r) => r.json()),
                                       fetch("/api/v1/globe", { cache: "no-store" }).then((r) => r.json()).catch(() => null)]);
      if (m && m.world) { state.m = m; state.g = g; render(); }
    } catch (e) { /* the world's server is away for a moment: keep what's on screen */ }
  }

  // ------------------------------------------------------------ interaction
  root.addEventListener("click", (ev) => {
    const t = ev.target.closest("[data-num]");
    if (t && !t.closest("dialog")) { openCountry(t.dataset.num); return; }
    const rb = ev.target.closest("[data-range]");
    if (rb) { state.range = Number(rb.dataset.range); root.querySelectorAll("[data-range]").forEach((b) => b.setAttribute("aria-pressed", String(b === rb))); renderIndex(state.m); return; }
    const mv = ev.target.closest("[data-movers]");
    if (mv) { state.movers = mv.dataset.movers; root.querySelectorAll("[data-movers]").forEach((b) => b.setAttribute("aria-selected", String(b === mv))); renderMovers(Object.entries(state.m.nations).map(([num, r]) => Object.assign({ num }, r))); return; }
    const fd = ev.target.closest("[data-feed]");
    if (fd) { state.feed = fd.dataset.feed; root.querySelectorAll("[data-feed]").forEach((b) => b.setAttribute("aria-selected", String(b === fd))); renderFeed(); return; }
  });
  $("cClose").addEventListener("click", () => $("xCountry").close());
  $("xCountry").addEventListener("click", (ev) => { if (ev.target === ev.currentTarget) ev.currentTarget.close(); });

  tick();
  setInterval(() => { if (!document.hidden) tick(); }, 20000);
})();
