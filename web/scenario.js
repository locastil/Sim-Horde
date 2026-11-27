// Personal scenarios: the visitor picks events from menus; the whole world then runs in a Web Worker on this
// device twice (as it would have gone, and with the events), using the same random numbers for both.
(() => {
  const $ = (id) => document.getElementById(id);
  const esc = (s) => String(s ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
  const small = matchMedia("(pointer: coarse)").matches || Math.min(screen.width, screen.height) < 700;
  const BUDGET = small ? 50000 : 150000;          // simulated people on this device

  // ------------------------------------------------------------ what each kind of event does to people's days
  // p: pressures (stress, irr = irritation, leave = urge to emigrate, kind = rudeness); f: conditions (pov, dens, unemp, ineq, young, net)
  // nb: what spills over to neighbouring countries; calm: ends the fighting and unrest already going on.
  const TYPES = {
    war:       { label: "War", hint: "Fighting in these countries; refugees strain their neighbours.", p: { stress: 0.35, irr: 0.8, leave: 2.0, kind: 0.25 }, nb: { stress: 0.04 } },
    unrest:    { label: "Mass protests", hint: "Streets full of angry crowds.", p: { stress: 0.05, irr: 0.6, kind: 0.05 } },
    crackdown: { label: "A crackdown", hint: "Curfews, arrests and fear.", p: { stress: 0.1, irr: 0.3 } },
    coup:      { label: "A coup", hint: "The government is overthrown.", p: { stress: 0.12, leave: 0.5 } },
    sanctions: { label: "Sanctions", hint: "Shortages and lost jobs.", p: { stress: 0.05, leave: 0.3 }, f: { unemp: 0.1 } },
    tradewar:  { label: "A trade war", hint: "Tariffs push prices up and some jobs away.", p: { stress: 0.03 }, f: { unemp: 0.05 } },
    prices:    { label: "Prices shoot up", hint: "Inflation squeezes everyone's budget.", p: { stress: 0.08 } },
    recession: { label: "A recession", hint: "Jobs disappear and more people fall into poverty.", p: { stress: 0.05 }, f: { unemp: 0.35, pov: 0.1 } },
    pandemic:  { label: "A pandemic", hint: "People stay home, see fewer others, and some lose work.", p: { stress: 0.05, leave: -0.3 }, f: { dens: -0.4, unemp: 0.15 } },
    disaster:  { label: "A natural disaster", hint: "Homes lost, families displaced.", p: { stress: 0.18, leave: 0.6 }, f: { pov: 0.15 } },
    robots:    { label: "Hacked robots turn on people", hint: "Machines in homes and streets become a danger: a national emergency.", p: { stress: 0.3, irr: 0.5, leave: 0.9, kind: 0.15 }, nb: { stress: 0.03 } },
    cash:      { label: "Cash support for the poorest", hint: "Fewer people in poverty.", p: { stress: -0.04 }, f: { pov: -0.3 } },
    jobs:      { label: "A jobs boom", hint: "Work for anyone who wants it.", f: { unemp: -0.35 } },
    peace:     { label: "Peace and calm", hint: "Wars and unrest already going on there end.", calm: true, p: { stress: -0.03 } },
    connect:   { label: "Stronger communities", hint: "People know their neighbours and are kinder to strangers.", p: { kind: -0.1 }, f: { net: 0.3 } },
  };
  const STRENGTH = { mild: 0.5, serious: 1, severe: 1.7 };
  const REGIONS = ["Africa", "Americas", "Asia", "Europe", "Oceania"];

  let base = null, live = null, events = [], worker = null, running = false;
  let res = null;     // {months: [{month, normal, scenario}], fit}

  // ------------------------------------------------------------ the form
  const byCode = () => new Map(base.nations.map((n) => [n.c, n]));
  function newEvent(type = "pandemic", where = "all", countries = [], strength = "serious", start = 2, months = 6) {
    return { type, where, countries, strength, start, months };
  }
  function whereCodes(e) {
    if (e.where === "all") return base.nations.map((n) => n.c);
    if (REGIONS.includes(e.where)) return base.nations.filter((n) => n.region === e.where).map((n) => n.c);
    return e.countries;
  }
  function render() {
    const ol = $("events");
    if (!events.length) { ol.innerHTML = `<li class="sc-empty">No events yet: your world will simply carry on. Add one, or start from an example.</li>`; estimate(); return; }
    const opts = (o, v) => Object.entries(o).map(([k, t]) => `<option value="${k}"${k === v ? " selected" : ""}>${esc(t)}</option>`).join("");
    const N = byCode();
    ol.innerHTML = events.map((e, i) => `<li class="sc-ev" data-i="${i}">
      <div class="sc-row">
        <label>What happens<select data-k="type">${opts(Object.fromEntries(Object.entries(TYPES).map(([k, t]) => [k, t.label])), e.type)}</select></label>
        <label>Where<select data-k="where">${opts({ all: "Everywhere", ...Object.fromEntries(REGIONS.map((r) => [r, r])), pick: "Countries I choose" }, e.where)}</select></label>
        <label>How hard<select data-k="strength">${opts({ mild: "Mild", serious: "Serious", severe: "Severe" }, e.strength)}</select></label>
        <label>Starts<select data-k="start">${Array.from({ length: 12 }, (_, m) => `<option value="${m + 1}"${m + 1 === e.start ? " selected" : ""}>Month ${m + 1}</option>`).join("")}</select></label>
        <label>Lasts<select data-k="months">${[1, 2, 3, 6, 12, 24, 60].map((m) => `<option value="${m}"${m === e.months ? " selected" : ""}>${m < 12 ? `${m} month${m > 1 ? "s" : ""}` : `${m / 12} year${m > 12 ? "s" : ""}`}</option>`).join("")}</select></label>
        <button type="button" class="sc-del" data-del aria-label="Remove this event">Remove</button>
      </div>
      <p class="sc-hint">${esc(TYPES[e.type].hint)}</p>
      ${e.where === "pick" ? `<div class="sc-pick">
        <ul class="sc-chips">${e.countries.map((c) => `<li><span>${esc(N.get(c) ? N.get(c).name : c)}</span><button type="button" data-rm="${c}" aria-label="Remove ${esc(N.get(c) ? N.get(c).name : c)}">×</button></li>`).join("")}</ul>
        <label class="sc-addc"><span class="sr">Add a country</span><input list="countryList" placeholder="Type a country and press Enter" data-addc></label>
      </div>` : ""}
    </li>`).join("");
    estimate();
  }
  function onEvent(ev) {
    const li = ev.target.closest(".sc-ev"); if (!li) return;
    const e = events[Number(li.dataset.i)];
    const k = ev.target.dataset.k;
    if (k && ev.type === "change") { e[k] = ["start", "months"].includes(k) ? Number(ev.target.value) : ev.target.value; render(); return; }
    if (ev.type === "click" && ev.target.hasAttribute("data-del")) { events.splice(Number(li.dataset.i), 1); render(); return; }
    if (ev.type === "click" && ev.target.dataset.rm) { e.countries = e.countries.filter((c) => c !== ev.target.dataset.rm); render(); return; }
    if (ev.target.hasAttribute("data-addc") && (ev.type === "change" || (ev.type === "keydown" && ev.key === "Enter"))) {
      ev.preventDefault();
      const v = ev.target.value.trim().toLowerCase();
      const n = base.nations.find((x) => x.name.toLowerCase() === v) || base.nations.find((x) => x.name.toLowerCase().startsWith(v));
      if (n && !e.countries.includes(n.c)) { e.countries.push(n.c); render(); li.parentNode.children[Number(li.dataset.i)].querySelector("[data-addc]").focus(); }
    }
  }
  const PRESETS = {
    pandemic: () => [newEvent("pandemic", "all", [], "serious", 2, 12), newEvent("recession", "all", [], "mild", 4, 12)],
    war: () => [newEvent("war", "pick", codes(["Russia", "Ukraine"]), "severe", 2, 24), newEvent("prices", "Europe", [], "serious", 3, 12)],
    recession: () => [newEvent("recession", "all", [], "serious", 2, 18), newEvent("prices", "all", [], "mild", 2, 12)],
    robots: () => [newEvent("robots", "pick", codes(["United States", "Japan", "South Korea", "China"]), "serious", 2, 3), newEvent("crackdown", "pick", codes(["United States"]), "mild", 2, 6)],
    kind: () => [newEvent("peace", "all", [], "serious", 1, 60), newEvent("cash", "all", [], "serious", 2, 60), newEvent("connect", "all", [], "serious", 2, 60)],
  };
  function listNames(cs) {
    const N = byCode(), n = cs.map((c) => (N.get(c) || {}).name || c);
    if (!n.length) return "nowhere yet";
    return "in " + (n.length <= 3 ? n.join(n.length === 2 ? " and " : ", ") : `${n.slice(0, 3).join(", ")} and ${n.length - 3} more`);
  }
  function codes(names) { return names.map((nm) => (base.nations.find((n) => n.name === nm) || {}).c).filter(Boolean); }

  function nationsFor() {
    const tot = base.nations.reduce((a, n) => a + n.pop, 0);
    const G = (live && live.nations) || {};
    return base.nations.map((n) => {
      const g = G[n.num] || {}, conflict = g.conflict != null ? g.conflict : n.conflict, protests = g.protests != null ? g.protests : n.protests;
      const p = { stress: 0, irr: 0, leave: 0, kind: 0 };
      if (protests) { p.stress += 0.05; p.irr += 0.6; p.kind += 0.05; }
      if (conflict) { p.stress += 0.35; p.irr += 0.8; p.leave += 2.0; p.kind += 0.25; }
      return { c: n.c, agents: Math.max(60, Math.round((n.pop / tot) * BUDGET)), feat: n.feat, base: p, b: n.b };
    });
  }
  function estimate() {
    const months = Number($("years").value) * 12 + 2;
    const secs = months * (small ? 2.2 : 4.5);
    $("est").textContent = `About ${secs < 90 ? Math.round(secs / 10) * 10 + " seconds" : Math.round(secs / 60) + " minutes"} on a typical ${small ? "phone" : "computer"}. Keep this page open while it runs.`;
  }

  // ------------------------------------------------------------ running it
  function run() {
    if (running) return;
    const yrs = Number($("years").value), months = yrs * 12;
    const ev = events.map((e) => ({ type: e.type, where: whereCodes(e), strength: STRENGTH[e.strength], start: e.start, months: e.months })).filter((e) => e.where.length);
    const effects = Object.fromEntries(Object.entries(TYPES).map(([k, t]) => [k, { p: t.p, f: t.f, nb: t.nb, calm: t.calm }]));
    res = { months: [], fit: null, yrs, events: JSON.parse(JSON.stringify(events)) };
    location.hash = "s=" + encode();
    worker && worker.terminate();
    worker = new Worker("/scenario/runner.js");
    running = true; $("run").disabled = true; $("stop").hidden = false; $("out").hidden = false;
    $("headline").textContent = "Running your world…"; $("subline").textContent = "";
    $("table").querySelector("tbody").innerHTML = "";
    const total = months + 1;
    worker.onmessage = (m) => {
      const d = m.data;
      if (d.error) { finish(); $("headline").textContent = "That didn't run: " + d.error; return; }
      if (d.done) { finish(); draw(true); return; }
      if (d.progress != null) {
        $("bar").style.width = Math.round(((d.month + d.progress) / total) * 100) + "%";
        $("progress").textContent = d.month === 0 ? "Settling everyone into ordinary life…" : `Month ${d.month} of ${months}`;
        return;
      }
      if (d.normal) {
        if (d.month === 0) { res.fit = fitFrom(d.normal); return; }
        res.months.push(d);
        draw(false);
      }
    };
    worker.postMessage({ nations: nationsFor(), theta: base.theta, months, events: ev, effects, seed: 1 + Math.floor(Math.random() * 1e6) });
  }
  function finish() { running = false; $("run").disabled = false; $("stop").hidden = true; $("bar").style.width = "100%"; $("progress").textContent = ""; }
  $("stop").addEventListener("click", () => { if (worker) worker.postMessage({ stop: true }); });

  // the simulation's happiness, lined up with real life-satisfaction surveys (as the shared world does)
  function fitFrom(nat) {
    const G = (live && live.nations) || {}, pts = [];
    for (const n of base.nations) {
      const s = G[n.num] && G[n.num].survey, r = nat[n.c];
      if (s != null && r) pts.push([r.happy, s, Math.sqrt(n.pop)]);
    }
    if (pts.length < 10) return { a: 0, b: 1 };
    const W = pts.reduce((a, p) => a + p[2], 0), mx = pts.reduce((a, p) => a + p[0] * p[2], 0) / W, my = pts.reduce((a, p) => a + p[1] * p[2], 0) / W;
    let sxy = 0, sxx = 0; for (const [x, y, w] of pts) { sxy += w * (x - mx) * (y - my); sxx += w * (x - mx) ** 2; }
    const b = Math.max(0.3, Math.min(3, sxx > 0 ? sxy / sxx : 1));
    return { a: my - b * mx, b };
  }
  const H = (raw) => { const f = res.fit || { a: 0, b: 1 }; return Math.max(0, Math.min(10, f.a + f.b * raw)); };
  function worldHappy(nat) {
    let s = 0, w = 0;
    for (const n of base.nations) { const r = nat[n.c]; if (r) { s += H(r.happy) * n.pop; w += n.pop; } }
    return w ? s / w : 0;
  }

  // ------------------------------------------------------------ results
  const nf = new Intl.NumberFormat(undefined, { maximumFractionDigits: 2, minimumFractionDigits: 2 });
  const sgn = (x) => (x > 0 ? "+" : x < 0 ? "−" : "") + nf.format(Math.abs(x));
  function draw(final) {
    const last = res.months[res.months.length - 1]; if (!last) return;
    const wn = worldHappy(last.normal), ws = worldHappy(last.scenario), dw = ws - wn;
    const yrsDone = (last.month / 12);
    const when = last.month % 12 === 0 ? `${yrsDone} year${yrsDone > 1 ? "s" : ""}` : `${last.month} months`;
    $("headline").textContent = Math.abs(dw) < 0.02
      ? `After ${when}, the world is about as happy as it would have been.`
      : `After ${when}, the world is ${dw < 0 ? "less" : "more"} happy than it would have been: ${nf.format(ws)} instead of ${nf.format(wn)} out of 10.`;
    const rows = base.nations.map((n) => {
      const a = last.normal[n.c], b = last.scenario[n.c];
      return a && b ? { n, hn: H(a.happy), hs: H(b.happy), d: H(b.happy) - H(a.happy), ln: a.leave, ls: b.leave } : null;
    }).filter(Boolean);
    const worse = rows.filter((r) => r.d < -0.05).length, better = rows.filter((r) => r.d > 0.05).length;
    $("subline").textContent = (final ? "" : "Still running. ") + `${worse} countr${worse === 1 ? "y is" : "ies are"} noticeably less happy, ${better} happier.`
      + (res.fit && res.fit.b !== 1 ? " Happiness is lined up with real survey results, as in the shared world." : "");
    rows.sort((x, y) => Math.abs(y.d) - Math.abs(x.d));
    $("table").querySelector("tbody").innerHTML = rows.slice(0, 15).map((r) => `<tr><th scope="row">${esc(r.n.name)}</th><td class="num">${nf.format(r.hn)}</td><td class="num">${nf.format(r.hs)}</td>`
      + `<td class="num ${r.d < 0 ? "down" : r.d > 0 ? "up" : ""}">${sgn(r.d)}</td><td class="num">${Math.round(r.ln)} → ${Math.round(r.ls)}</td></tr>`).join("");
    chart(); map(rows);
  }

  function chart() {
    const svg = $("chart"), W = svg.clientWidth || 600, Hh = svg.clientHeight || 260, pad = { l: 40, r: 12, t: 12, b: 26 };
    const ms = res.months, total = res.yrs * 12;
    const a = ms.map((m) => worldHappy(m.normal)), b = ms.map((m) => worldHappy(m.scenario));
    let lo = Math.min(...a, ...b), hi = Math.max(...a, ...b); const span = Math.max(0.2, hi - lo); lo -= span * 0.15; hi += span * 0.15;
    const x = (i) => pad.l + ((i + 1) / total) * (W - pad.l - pad.r), y = (v) => pad.t + (1 - (v - lo) / (hi - lo)) * (Hh - pad.t - pad.b);
    const line = (arr) => arr.map((v, i) => `${i ? "L" : "M"}${x(i).toFixed(1)},${y(v).toFixed(1)}`).join("");
    const ticks = [lo + (hi - lo) * 0.2, lo + (hi - lo) * 0.5, lo + (hi - lo) * 0.8];
    const yrs = Array.from({ length: res.yrs }, (_, k) => k + 1);
    const bands = res.events.map((e) => `<rect x="${x(e.start - 1.5).toFixed(1)}" y="${pad.t}" width="${Math.max(2, x(Math.min(total, e.start - 1 + e.months) - 1) - x(e.start - 1.5)).toFixed(1)}" height="${Hh - pad.t - pad.b}" class="ev"/>`).join("");
    svg.setAttribute("viewBox", `0 0 ${W} ${Hh}`);
    svg.innerHTML = bands
      + ticks.map((t) => `<line x1="${pad.l}" x2="${W - pad.r}" y1="${y(t)}" y2="${y(t)}" class="grid"/><text x="${pad.l - 6}" y="${y(t) + 4}" class="ax" text-anchor="end">${t.toFixed(2)}</text>`).join("")
      + yrs.map((k) => `<text x="${x(k * 12 - 1)}" y="${Hh - 6}" class="ax" text-anchor="end">Year ${k}</text>`).join("")
      + `<path d="${line(a)}" class="l-normal"/><path d="${line(b)}" class="l-yours"/>`;
  }

  let feats = null, mapRows = null;
  async function loadMap() {
    if (feats) return feats;
    const d = await fetch("/geo/countries_low.json").then((r) => r.json());
    feats = d.f.map(([num, rings]) => [num, rings.map((flat) => { const o = []; let x = 0, y = 0; for (let i = 0; i < flat.length; i += 2) { x += flat[i]; y += flat[i + 1]; o.push([x / d.q, y / d.q]); } return o; })]);
    return feats;
  }
  function divColor(d) {
    const t = Math.max(-1, Math.min(1, d / 0.6));
    const mix = (c1, c2, f) => c1.map((v, i) => Math.round(v + (c2[i] - v) * f));
    const mid = [226, 231, 236], bad = [224, 72, 47], good = [17, 132, 91];
    return `rgb(${(t < 0 ? mix(mid, bad, -t) : mix(mid, good, t)).join(",")})`;
  }
  async function map(rows) {
    mapRows = new Map(rows.map((r) => [r.n.num, r]));
    const F = await loadMap(), cv = $("map"), r = cv.getBoundingClientRect(), dpr = Math.min(2, devicePixelRatio || 1);
    cv.width = r.width * dpr; cv.height = r.width * 0.5 * dpr; cv.style.height = r.width * 0.5 + "px";
    const ctx = cv.getContext("2d"), W = cv.width, Hh = cv.height;
    ctx.clearRect(0, 0, W, Hh);
    for (const [num, rings] of F) {
      const row = mapRows.get(num);
      ctx.fillStyle = row ? divColor(row.d) : "#d5dce3"; ctx.strokeStyle = "rgba(255,255,255,.7)"; ctx.lineWidth = 0.6 * dpr;
      for (const ring of rings) {
        if (Math.max(...ring.map((p) => p[0])) - Math.min(...ring.map((p) => p[0])) > 300) continue;
        ctx.beginPath(); ring.forEach(([lo, la], i) => { const X = ((lo + 180) / 360) * W, Y = ((90 - la) / 180) * Hh; i ? ctx.lineTo(X, Y) : ctx.moveTo(X, Y); });
        ctx.closePath(); ctx.fill(); ctx.stroke();
      }
    }
  }
  $("map").addEventListener("pointermove", (e) => {
    if (!feats || !mapRows) return;
    const cv = $("map"), r = cv.getBoundingClientRect(), lo = ((e.clientX - r.left) / r.width) * 360 - 180, la = 90 - ((e.clientY - r.top) / r.height) * 180;
    const inside = (ring) => { let c = false; for (let i = 0, j = ring.length - 1; i < ring.length; j = i++) { const [xi, yi] = ring[i], [xj, yj] = ring[j]; if ((yi > la) !== (yj > la) && lo < ((xj - xi) * (la - yi)) / (yj - yi) + xi) c = !c; } return c; };
    const hit = feats.find(([num, rings]) => mapRows.has(num) && rings.some(inside));
    const tip = $("mapTip");
    if (!hit) { tip.hidden = true; return; }
    const row = mapRows.get(hit[0]);
    tip.innerHTML = `<b>${esc(row.n.name)}</b><br>${nf.format(row.hn)} → ${nf.format(row.hs)} (${sgn(row.d)})`;
    tip.style.left = e.clientX - r.left + "px"; tip.style.top = e.clientY - r.top + "px"; tip.hidden = false;
  });
  $("map").addEventListener("pointerleave", () => { $("mapTip").hidden = true; });

  // ------------------------------------------------------------ sharing
  function encode() {
    const s = JSON.stringify({ y: Number($("years").value), e: events.map((e) => [e.type, e.where, e.countries, e.strength, e.start, e.months]) });
    return btoa(unescape(encodeURIComponent(s))).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
  }
  function decode(h) {
    try {
      const s = JSON.parse(decodeURIComponent(escape(atob(h.replace(/-/g, "+").replace(/_/g, "/")))));
      if (s.y) $("years").value = String(s.y);
      return (s.e || []).filter((x) => TYPES[x[0]]).slice(0, 12).map((x) => newEvent(x[0], x[1], (x[2] || []).filter((c) => byCode().has(c)), STRENGTH[x[3]] ? x[3] : "serious", Number(x[4]) || 1, Number(x[5]) || 6));
    } catch (e) { return null; }
  }
  $("share").addEventListener("click", async () => {
    const url = location.origin + location.pathname + "#s=" + encode();
    try { await navigator.clipboard.writeText(url); $("shareNote").textContent = "Link copied. Whoever opens it can run the same scenario."; }
    catch (e) { $("shareNote").textContent = url; }
  });

  // ------------------------------------------------------------ start
  (async () => {
    [base, live] = await Promise.all([fetch("/scenario/base.json").then((r) => r.json()), fetch("/api/v1/globe").then((r) => r.json()).catch(() => null)]);
    const dl = document.createElement("datalist"); dl.id = "countryList";
    dl.innerHTML = base.nations.map((n) => `<option value="${esc(n.name)}">`).join(""); document.body.appendChild(dl);
    const h = location.hash.match(/s=([\w-]+)/);
    events = (h && decode(h[1])) || [];
    render();
    for (const t of ["change", "click", "keydown"]) $("events").addEventListener(t, onEvent);
    $("addEvent").addEventListener("click", () => { events.push(newEvent()); render(); });
    document.querySelectorAll("[data-preset]").forEach((b) => b.addEventListener("click", () => { events = PRESETS[b.dataset.preset](); render(); }));
    $("years").addEventListener("change", estimate);
    $("run").addEventListener("click", run);
    // what the scenario assistant (agent.js) uses to read and change the plan
    window.simScenario = {
      types: TYPES, regions: REGIONS, nations: base.nations,
      get: () => events, set: (e) => { events = e; render(); }, make: newEvent,
      years: (y) => { if (y) { $("years").value = String(y); estimate(); } return Number($("years").value); },
      run: () => { run(); $("out").scrollIntoView({ behavior: "smooth", block: "start" }); }, running: () => running,
      whereText: (e) => e.where === "all" ? "everywhere" : REGIONS.includes(e.where) ? `in ${e.where}` : listNames(e.countries),
    };
    window.dispatchEvent(new Event("simscenario:ready"));
    addEventListener("resize", () => { if (res && res.months.length) draw(!running); });
  })();
})();
