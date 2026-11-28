// The scenario assistant: turns plain English ("a severe war between Russia and Ukraine for two years,
// then a pandemic in Europe") into the scenario plan below it, and changes the plan when asked.
// Quick commands (run it, milder, worse, start over, help) are handled here in the browser. Anything else is a
// description: it goes to the scenario sandbox (sandbox.py), where Claude turns it into events on the model's ten
// levers. While the sandbox is closed, the built-in reader below sets up the preset events instead.
(() => {
  const $ = (id) => document.getElementById(id);
  const esc = (s) => String(s ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
  let S = null;

  // ------------------------------------------------------------ vocabulary
  const KINDS = [
    ["peace", /\b(peace|ceasefire|cease-fire|truce|end(s|ing)? (the |all )?(war|fighting|conflict)s?|calm)\b/],
    ["robots", /\b(robots?|androids?|machines?|drones? (turn|attack|go rogue)|ai (uprising|takeover|attack)|hack(ed|ing)? (robots?|machines?|firmware))\b/],
    ["pandemic", /\b(pandemic|epidemic|virus|plague|outbreak|flu|disease|lockdowns?|covid|contagion)\b/],
    ["disaster", /\b(earthquakes?|hurricanes?|typhoons?|cyclones?|floods?|flooding|tsunamis?|wildfires?|fires|volcan\w*|droughts?|famine|disasters?|heat ?waves?|storms?)\b/],
    ["coup", /\b(coup|overthrow\w*|junta|military takeover)\b/],
    ["crackdown", /\b(crackdowns?|martial law|curfews?|police state|mass arrests?|authoritarian)\b/],
    ["unrest", /\b(protests?|riots?|unrest|uprising|revolt|demonstrations?|strikes?|civil disorder)\b/],
    ["war", /\b(wars?|invade[sd]?|invasion|conflict|fighting|battles?|attacks?|bomb\w*|civil war|military (strike|operation)|nuclear)\b/],
    ["sanctions", /\b(sanction\w*|embargo\w*|blockade)\b/],
    ["tradewar", /\b(trade war|tariffs?|trade dispute|protectionism)\b/],
    ["prices", /\b(inflation|prices?|cost of living|hyperinflation|price spike|oil shock|energy crisis)\b/],
    ["recession", /\b(recession|depression|crash|unemployment|layoffs?|financial crisis|economic (crisis|collapse|downturn)|downturn)\b/],
    ["wealthtax", /\b(billionaires?'?s? tax|millionaires?'?s? tax|wealth tax|tax(es|ing)? (on )?the (very )?(rich|wealthy|richest|billionaires?|super-?rich)|tax the (rich|wealthy|billionaires?))\b/],
    ["ubi", /\b(ubi|universal basic income|basic income|universal income|universal (cash|payments?)|cash for (every ?one|every ?body|all)|every ?(one|body) gets (paid|money|cash|a (check|cheque|payment))|(payments?|checks?|cheques?|cash|money) (to|for) (every ?one|every ?body|every adult|all (adults|citizens|people)))\b/],
    ["cash", /\b(cash (support|transfers?|payments?)|stimulus|welfare|end(ing)? poverty|less poverty|help(ing)? the poor(est)?)\b/],
    ["jobs", /\b(jobs? (boom|guarantee|program)|full employment|hiring boom|more jobs|economic boom|boom)\b/],
    ["connect", /\b(communit(y|ies)|kind(er|ness)|neighbou?rs?|volunteer\w*|friendl(y|ier)|civil(ity)?|connected)\b/],
  ];
  const ALIASES = {
    "us": "United States", "u.s.": "United States", "usa": "United States", "u.s.a.": "United States", "america": "United States", "the states": "United States", "american": "United States", "americans": "United States",
    "uk": "United Kingdom", "u.k.": "United Kingdom", "britain": "United Kingdom", "great britain": "United Kingdom", "england": "United Kingdom", "scotland": "United Kingdom", "wales": "United Kingdom", "british": "United Kingdom",
    "russian": "Russia", "ukrainian": "Ukraine", "chinese": "China", "prc": "China", "japanese": "Japan", "korea": "South Korea", "south korean": "South Korea", "north korean": "North Korea", "dprk": "North Korea",
    "uae": "United Arab Emirates", "emirates": "United Arab Emirates", "drc": "Democratic Republic of the Congo", "dr congo": "Democratic Republic of the Congo", "congo": "Democratic Republic of the Congo",
    "czechia": "Czech Republic", "holland": "Netherlands", "dutch": "Netherlands", "burma": "Myanmar", "persia": "Iran", "iranian": "Iran", "israeli": "Israel", "palestinian": "Palestine", "gaza": "Palestine",
    "turkiye": "Turkey", "türkiye": "Turkey", "turkish": "Turkey", "german": "Germany", "french": "France", "italian": "Italy", "spanish": "Spain", "mexican": "Mexico", "canadian": "Canada", "brazilian": "Brazil",
    "indian": "India", "pakistani": "Pakistan", "saudi": "Saudi Arabia", "ksa": "Saudi Arabia", "egyptian": "Egypt", "nigerian": "Nigeria", "australian": "Australia", "aussie": "Australia", "kiwi": "New Zealand",
    "taiwanese": "Taiwan", "vietnamese": "Vietnam", "filipino": "Philippines", "ivory coast": "Ivory Coast", "cote d'ivoire": "Ivory Coast", "eswatini": "Swaziland", "north macedonia": "Republic of Macedonia",
    "venezuelan": "Venezuela", "cuban": "Cuba", "syrian": "Syria", "iraqi": "Iraq", "afghan": "Afghanistan", "polish": "Poland", "greek": "Greece", "swedish": "Sweden", "norwegian": "Norway",
  };
  const GROUPS = {
    "middle east": ["Bahrain", "Egypt", "Iran", "Iraq", "Israel", "Jordan", "Kuwait", "Lebanon", "Oman", "Palestine", "Qatar", "Saudi Arabia", "Syria", "Turkey", "United Arab Emirates", "Yemen"],
    "latin america": ["Argentina", "Bolivia", "Brazil", "Chile", "Colombia", "Costa Rica", "Cuba", "Dominican Republic", "Ecuador", "El Salvador", "Guatemala", "Honduras", "Mexico", "Nicaragua", "Panama", "Paraguay", "Peru", "Uruguay", "Venezuela"],
    "south america": ["Argentina", "Bolivia", "Brazil", "Chile", "Colombia", "Ecuador", "Guyana", "Paraguay", "Peru", "Suriname", "Uruguay", "Venezuela"],
    "north america": ["Canada", "Mexico", "United States"],
    "european union": ["Austria", "Belgium", "Bulgaria", "Croatia", "Cyprus", "Czech Republic", "Denmark", "Estonia", "Finland", "France", "Germany", "Greece", "Hungary", "Ireland", "Italy", "Latvia", "Lithuania", "Luxembourg", "Malta", "Netherlands", "Poland", "Portugal", "Romania", "Slovakia", "Slovenia", "Spain", "Sweden"],
    "eu": "european union",
    "southeast asia": ["Brunei", "Cambodia", "Indonesia", "Laos", "Malaysia", "Myanmar", "Philippines", "Singapore", "Thailand", "Vietnam", "East Timor"],
    "east asia": ["China", "Japan", "South Korea", "North Korea", "Taiwan", "Mongolia", "Hong Kong"],
    "south asia": ["India", "Pakistan", "Bangladesh", "Sri Lanka", "Nepal", "Bhutan", "Afghanistan", "Maldives"],
    "scandinavia": ["Denmark", "Norway", "Sweden", "Finland", "Iceland"],
    "the balkans": ["Albania", "Bosnia and Herzegovina", "Bulgaria", "Croatia", "Montenegro", "Republic of Macedonia", "Serbia", "Slovenia"],
    "sahel": ["Mali", "Niger", "Burkina Faso", "Chad", "Mauritania", "Sudan"],
    "west africa": ["Nigeria", "Ghana", "Ivory Coast", "Senegal", "Mali", "Burkina Faso", "Niger", "Guinea", "Sierra Leone", "Liberia", "Togo", "Benin", "The Gambia", "Guinea-Bissau", "Mauritania"],
    "east africa": ["Kenya", "Ethiopia", "Tanzania", "Uganda", "Rwanda", "Burundi", "Somalia", "South Sudan", "Eritrea", "Djibouti"],
    "g7": ["Canada", "France", "Germany", "Italy", "Japan", "United Kingdom", "United States"],
    "nato": ["United States", "Canada", "United Kingdom", "France", "Germany", "Italy", "Spain", "Poland", "Netherlands", "Belgium", "Norway", "Denmark", "Turkey", "Greece", "Portugal", "Romania", "Czech Republic", "Hungary", "Finland", "Sweden"],
  };
  const REGION_WORDS = { africa: "Africa", african: "Africa", europe: "Europe", european: "Europe", asia: "Asia", asian: "Asia", "the americas": "Americas", americas: "Americas", oceania: "Oceania", "the pacific": "Oceania", pacific: "Oceania" };
  const NUM = { one: 1, a: 1, an: 1, two: 2, three: 3, four: 4, five: 5, six: 6, seven: 7, eight: 8, nine: 9, ten: 10, eleven: 11, twelve: 12, eighteen: 18, "twenty-four": 24, half: 0.5 };
  const num = (w) => (w in NUM ? NUM[w] : Number(w));
  const STR = { mild: /\b(mild|small|minor|slight|light|limited|brief|little)\b/, severe: /\b(severe|massive|huge|catastrophic|major|extreme|devastating|terrible|full[- ]scale|deadly|brutal|global|enormous|apocalyptic)\b/ };

  function placeIndex() {
    const names = S.nations.map((n) => n.name).sort((a, b) => b.length - a.length);
    return { names, byName: new Map(S.nations.map((n) => [n.name.toLowerCase(), n.c])) };
  }
  let P = null;
  function findPlaces(t) {
    // returns {where, countries} or null. "For everyone" names who gets something (a basic income), not where.
    t = t.replace(/\b(for|to|gives?|giving|pays?|paying|covers?|covering) (every ?one|every ?body|every adult|all (adults|citizens|people|residents))\b/g, " ");
    if (/\b(everywhere|worldwide|world-wide|global(ly)?|whole (world|planet)|all (countries|nations)|the world|every country|planet|every ?one|every ?body|all people|all humans|humanity|mankind|the whole population)\b/.test(t)) return { where: "all", countries: [] };
    const found = new Set(); let rest = " " + t + " ";
    const take = (name) => { const c = P.byName.get(name.toLowerCase()); if (c) found.add(c); };
    for (const [g, list] of Object.entries(GROUPS)) {
      const re = new RegExp(`\\b${g.replace(/[.]/g, "\\.")}\\b`);
      if (re.test(rest)) { (typeof list === "string" ? GROUPS[list] : list).forEach(take); rest = rest.replace(re, " "); }
    }
    for (const nm of P.names) {
      const re = new RegExp(`(^|[^a-z])${nm.toLowerCase().replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}([^a-z]|$)`);
      if (re.test(rest)) { take(nm); rest = rest.replace(re, " "); }
    }
    for (const [a, nm] of Object.entries(ALIASES).sort((x, y) => y[0].length - x[0].length)) {
      const re = new RegExp(`(^|[^a-z])${a.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}([^a-z]|$)`);
      if (re.test(rest)) { take(nm); rest = rest.replace(re, " "); }
    }
    if (found.size) return { where: "pick", countries: [...found] };
    for (const [w, r] of Object.entries(REGION_WORDS)) if (new RegExp(`\\b${w}\\b`).test(rest)) return { where: r, countries: [] };
    return null;
  }
  function findTiming(t) {
    const o = {};
    let m = t.match(/\b(?:in|from|starting(?: in)?|after|at|by)\s+(?:month\s+)?(\d+|one|two|three|four|five|six|seven|eight|nine|ten|eleven|twelve)(?:\s+months?)?(?:\s+in)?\b/);
    if (m && /month|after/.test(m[0])) o.start = Math.max(1, Math.min(12, Math.round(num(m[1])) + (/after/.test(m[0]) ? 1 : 0)));
    if (/\b(right away|immediately|at once|from the start|straight away|now)\b/.test(t)) o.start = 1;
    if (/\b(later|halfway|mid-?way|in the middle of the (run|year|simulation))\b/.test(t)) o.start = 6;
    m = t.match(/\b(?:for|lasting|lasts?|over)\s+(?:about\s+|around\s+)?(\d+|a|an|one|two|three|four|five|six|seven|eight|nine|ten|eleven|twelve|eighteen|half(?: a)?)\s+(months?|years?|weeks?)/);
    if (m) {
      const n = num(m[1].replace(" a", "")) || 1;
      o.months = /year/.test(m[2]) ? Math.round(n * 12) : /week/.test(m[2]) ? 1 : Math.round(n);
    }
    if (/\b(forever|permanent\w*|for good|never ends?|the whole time)\b/.test(t)) o.months = 60;
    if (o.months) o.months = [1, 2, 3, 6, 12, 24, 60].reduce((a, b) => (Math.abs(b - o.months) < Math.abs(a - o.months) ? b : a));
    return o;
  }
  function findYears(t) {
    const m = t.match(/\b(?:run(?: it)?|simulate|go|play(?: it)?(?: out)?|over|watch)\s+(?:for\s+)?(\d+|one|two|three|four|five)\s+years?\b/) || t.match(/\b(\d+|one|two|three|four|five)[- ]years? (run|simulation|long)\b/);
    if (!m) return null;
    const y = num(m[1]); return [1, 2, 3, 5].reduce((a, b) => (Math.abs(b - y) < Math.abs(a - y) ? b : a));
  }
  const strengthOf = (t) => (STR.severe.test(t) ? "severe" : STR.mild.test(t) ? "mild" : null);

  // ------------------------------------------------------------ talking
  const log = [];
  function say(who, html) {
    log.push([who, html]);
    const li = document.createElement("li"); li.className = who; li.innerHTML = html;
    $("chatLog").appendChild(li); li.scrollIntoView({ block: "nearest", behavior: "smooth" });
  }
  function monthsText(m) { return m < 12 ? `${m} month${m > 1 ? "s" : ""}` : m === 60 ? "5 years (or to the end)" : `${m / 12} year${m > 12 ? "s" : ""}`; }
  function planText() {
    const ev = S.get();
    if (!ev.length) return "Your plan is empty: the world will simply carry on as it would have.";
    const items = ev.map((e) => `<li><b>${esc(S.kindOf(e).label)}</b> ${esc(S.whereText(e))}, ${e.strength}, from month ${e.start} for ${monthsText(e.months)}.</li>`).join("");
    return `<ol>${items}</ol>Running for ${S.years()} year${S.years() > 1 ? "s" : ""}.`;
  }
  function confirmLine() { return `<div class="ag-actions"><button type="button" data-say="run it">Run it</button><button type="button" data-say="make it milder">Milder</button><button type="button" data-say="make it worse">Worse</button><button type="button" data-say="start over">Start over</button></div>`; }

  // the same event, in the same places, at the same time, only once
  function dedupe(list) {
    const seen = new Set();
    return list.filter((e) => { const k = [e.type, e.where, (e.countries || []).slice().sort().join(","), e.start, e.months].join("|"); if (seen.has(k)) return false; seen.add(k); return true; });
  }

  function handle(raw, onlyLocal) {
    const t = " " + raw.toLowerCase().replace(/[“”]/g, '"').replace(/[’]/g, "'").replace(/\s+/g, " ").trim() + " ";
    let ev = S.get().slice();
    const last = ev[ev.length - 1];

    if (/\b(assassinat\w*|kill(ing)? (the )?(president|prime minister|king|leader|pope|ceo)|murder|genocide|ethnic cleansing|massacre of)\b/.test(t)) {
      return `I won't simulate harm aimed at real, named people or groups. I can set up what a country goes through instead: a coup, a war, unrest or a crackdown. For example: "a coup in ${esc(S.nations[Math.floor(Math.random() * S.nations.length)].name)}".`;
    }
    if (/^\s*(help|what can you do|how does this work|\?)\s*$/.test(t)) return helpText();
    if (/\b(start over|clear( it| all| everything)?|reset|scrap (it|that)|new scenario|empty)\b/.test(t) && t.trim().split(" ").length <= 5) { S.set([]); return "Cleared. What should happen?"; }
    const y = findYears(t);
    if (/^\s*(run( it)?|go|do it|yes|yep|yeah|ok(ay)?|sure|start|looks good|perfect|run the (sim|simulation)|let'?s (go|see)|play)\b[ !.]*$/.test(t) || /\b(run it|run the simulation|let'?s run|go ahead)\b/.test(t)) {
      if (y) S.years(y);
      if (S.running()) return "It's already running: the results are filling in below.";
      S.run();
      return `Running it on your device now${ev.length ? "" : " (with no events, as a baseline)"}. The results fill in below as each month finishes.`;
    }
    // changes to the plan as it stands
    if (last && /\b(milder|weaker|softer|less (severe|bad|intense)|tone it down|smaller|gentler)\b/.test(t)) {
      ev.forEach((e) => (e.strength = e.strength === "severe" ? "serious" : "mild")); S.set(ev); return "Toned down.<br>" + planText() + confirmLine();
    }
    if (last && /\b(worse|stronger|harsher|more (severe|intense|extreme)|bigger|crank it up|make it (bad|terrible))\b/.test(t)) {
      ev.forEach((e) => (e.strength = e.strength === "mild" ? "serious" : "severe")); S.set(ev); return "Made worse.<br>" + planText() + confirmLine();
    }
    if (onlyLocal) return null;                  // anything else is a description, for the sandbox
    // "not the poorest, everyone": the cash goes to everyone, rich or poor (a basic income), wherever it was
    const cashEv = ev.filter((e) => e.type === "cash");
    if (cashEv.length && /\b(not (just |only )?(for )?the poor(est)?|universal|rich (and|or) poor|every ?(one|body)|all (adults|citizens|people))\b/.test(t)
        && !/\b(everywhere|worldwide|every country|all countries|the whole world)\b/.test(t) && !KINDS.some(([k, re]) => !["cash", "ubi"].includes(k) && re.test(t))) {
      cashEv.forEach((e) => (e.type = "ubi")); S.set(dedupe(ev));
      const wait = ev.find((e) => e.where === "pick" && !e.countries.length);
      return "Changed it to a basic income for everyone, rich or poor.<br>" + planText() + (wait ? `<br><br>Where should the ${esc(S.kindOf(wait).label.toLowerCase())} happen? Name countries, a region, or say "everywhere".` : confirmLine());
    }
    const rm = t.match(/\b(remove|drop|delete|cancel|no more|get rid of|without)\b/);
    if (rm && last) {
      const kinds = KINDS.filter(([, re]) => re.test(t)).map(([k]) => k);
      const pl = findPlaces(t.slice(rm.index));
      if (kinds.length) { ev = ev.filter((e) => !kinds.includes(e.type)); S.set(ev); return "Removed.<br>" + planText() + confirmLine(); }
      if (pl && pl.where === "pick") {
        ev.forEach((e) => { if (e.where === "pick") e.countries = e.countries.filter((c) => !pl.countries.includes(c)); });
        S.set(ev.filter((e) => e.where !== "pick" || e.countries.length)); return "Taken out.<br>" + planText() + confirmLine();
      }
      if (/\b(last|that)\b/.test(t)) { ev.pop(); S.set(ev); return "Removed the last one.<br>" + planText() + confirmLine(); }
    }
    if (last && /^\s*(also |and )?(add|include|plus|and)\b/.test(t) && !KINDS.some(([, re]) => re.test(t))) {
      const pl = findPlaces(t);
      if (pl && pl.where === "pick") {
        const tgt = [...ev].reverse().find((e) => e.where === "pick") || last;   // the latest event that names countries
        tgt.where = "pick"; tgt.countries = [...new Set([...(tgt.countries || []), ...pl.countries])]; S.set(ev);
        return "Added.<br>" + planText() + confirmLine();
      }
    }
    if (last && !KINDS.some(([, re]) => re.test(t))) {          // timing or place changes to the latest event
      const tm = findTiming(t), pl = findPlaces(t), st = strengthOf(t);
      if (tm.start || tm.months || pl || st || y) {
        if (tm.start) last.start = tm.start; if (tm.months) last.months = tm.months;
        if (pl) { last.where = pl.where; last.countries = pl.countries; }
        if (st) last.strength = st; if (y) S.years(y);
        S.set(ev); return "Changed.<br>" + planText() + confirmLine();
      }
    }

    // an answer to "where should it happen?": events still waiting for a place take it, even when the answer
    // names the event again ("cash support for everyone"), instead of adding another copy
    const waiting = ev.filter((e) => e.where === "pick" && !e.countries.length);
    if (waiting.length) {
      const pl = findPlaces(t), named = KINDS.filter(([, re]) => re.test(t)).map(([k]) => k);
      const fits = waiting.filter((e) => !named.length || named.includes(e.type));
      if (pl && fits.length && named.every((k) => waiting.some((e) => e.type === k))) {
        const tm = findTiming(t), st = strengthOf(t);
        for (const e of fits) { e.where = pl.where; e.countries = pl.countries; if (tm.start) e.start = tm.start; if (tm.months) e.months = tm.months; if (st) e.strength = st; }
        S.set(dedupe(ev)); return "Got it.<br>" + planText() + confirmLine();
      }
    }

    // new events: one per clause
    const hasKind = (x) => KINDS.some(([, re]) => re.test(x));
    const clauses0 = t.split(/\b(?:partly |partially |mostly )?(?:paid for|paid|funded|financed|covered) (?:in part )?by\b|\bthen\b|;|\. |\bafter that\b|\bfollowed by\b|\balso\b|\bplus\b|\bwhile\b|\bmeanwhile\b|, and\b|\band (?=(?:a|an|then|later)\b)/);
    const clauses = [];
    for (const c of clauses0) {                // "peace in X and cash support in Y": split on "and" only when both sides name an event
      const parts = c.split(/\band\b/); let cur = parts[0];
      for (const p of parts.slice(1)) { if (hasKind(cur) && hasKind(p)) { clauses.push(cur); cur = p; } else cur += " and " + p; }
      clauses.push(cur);
    }
    const added = []; let prevStart = last ? last.start : 0, prevMonths = last ? last.months : 0;
    for (const c of clauses) {
      const kinds = KINDS.filter(([, re]) => re.test(c)).map(([k]) => k);
      if (!kinds.length) continue;
      let kind = kinds[0];
      if (kinds.includes("war") && kinds.includes("robots")) kind = "robots";
      if (kinds.includes("peace")) kind = "peace";
      const pl = findPlaces(c) || (added.length ? { where: added[added.length - 1].where, countries: added[added.length - 1].countries } : null) || { where: ["pandemic", "recession", "prices", "tradewar"].includes(kind) ? "all" : "pick", countries: [] };
      const tm = findTiming(c);
      const followOn = /\bthen\b|after that|followed by/.test(t) && added.length;
      const start = tm.start || (followOn ? Math.min(12, prevStart + Math.min(prevMonths, 6)) : 2);
      const e = S.make(kind, pl.where, pl.countries, strengthOf(c) || "serious", start, tm.months || ({ war: 24, robots: 3, pandemic: 12, recession: 18, disaster: 3, coup: 3, unrest: 6, crackdown: 6, sanctions: 24, tradewar: 24, prices: 12, cash: 60, ubi: 60, wealthtax: 60, jobs: 24, peace: 60, connect: 60 })[kind]);
      added.push(e); prevStart = e.start; prevMonths = e.months;
    }
    if (added.length) {
      const fresh = /\b(instead|new|start over|what if|imagine|suppose)\b/.test(t) && !/\b(also|add|and then)\b/.test(t);
      // a new event replaces one of the same kind that never got a place
      if (!fresh) ev = ev.filter((e) => !(e.where === "pick" && !e.countries.length && added.some((a) => a.type === e.type)));
      ev = dedupe((fresh ? [] : ev).concat(added));
      if (y) S.years(y);
      const lastEnd = Math.max(...ev.map((e) => e.start + Math.min(e.months, 60)));
      if (!y) { const need = lastEnd + 5; S.years([1, 2, 3, 5].find((k) => k * 12 >= need) || 5); }   // long enough to see it play out
      S.set(ev);
      const missing = added.filter((e) => e.where === "pick" && !e.countries.length);
      const ask = missing.length ? `<br><br>Where should the ${esc(S.kindOf(missing[0]).label.toLowerCase())} happen? Name countries, a region, or say "everywhere".` : "";
      return (fresh ? "Here's your world:" : ev.length > added.length ? "Added to the plan:" : "Here's your world:") + planText() + (ask || confirmLine());
    }
    if (y) { S.years(y); return planText() + confirmLine(); }
    const pl = findPlaces(t);
    if (pl && last && last.where === "pick" && !last.countries.length) { last.where = pl.where; last.countries = pl.countries; S.set(ev); return "Got it.<br>" + planText() + confirmLine(); }
    return `I didn't catch an event in that. I understand things like wars, protests, coups, crackdowns, sanctions, trade wars, price spikes, recessions, pandemics, natural disasters, hacked robots, peace, cash support for the poorest, a basic income for everyone, a tax on the very rich, a jobs boom and kinder communities, plus where, how hard, when and for how long. ${helpExamples()}`;
  }
  function helpExamples() {
    const ex = ["Brazil passes a basic income for everyone, paid for by a billionaires' tax", "a four-day work week across Europe", "a severe war between India and Pakistan for two years", "social media is banned in the United States"];
    return `Try: ${ex.map((x) => `<button type="button" class="ag-ex" data-say="${esc(x)}">${esc(x)}</button>`).join(" ")}`;
  }
  function helpText() {
    return `Tell me what happens, where, how hard and for how long, in your own words. I'll turn it into a plan you can check before anything runs. You can then say things like "make it milder", "add Japan", "remove the recession", "start in month 6" or "run it for 5 years". ${helpExamples()}`;
  }

  // ------------------------------------------------------------ the sandbox
  let sandboxClosed = false, busy = false;
  function codesFor(where) {
    const w = (where || []).map((x) => String(x).trim()).filter(Boolean);
    if (!w.length || w.some((x) => /^(everywhere|world|worldwide|all)$/i.test(x))) return { where: "all", countries: [] };
    const r = S.regions.find((x) => w.length === 1 && x.toLowerCase() === w[0].toLowerCase());
    if (r) return { where: r, countries: [] };
    const out = new Set();
    for (const name of w) {
      const l = name.toLowerCase().replace(/^the /, "");
      const c = P.byName.get(l) || P.byName.get((ALIASES[l] || "").toLowerCase()) || (GROUPS[l] && null);
      if (c) out.add(c);
      else if (GROUPS[l]) (typeof GROUPS[l] === "string" ? GROUPS[GROUPS[l]] : GROUPS[l]).forEach((n) => { const k = P.byName.get(n.toLowerCase()); if (k) out.add(k); });
    }
    return { where: "pick", countries: [...out] };
  }
  async function remote(text) {
    const plan = S.get().map((e) => ({ label: S.kindOf(e).label, where: S.whereText(e), strength: e.strength, start: e.start, months: e.months,
                                       levers: e.type === "custom" ? S.leverText(e.custom) : undefined }));
    let r, d;
    try {
      r = await fetch("/api/v1/scenario/translate", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ text, plan, years: S.years() }) });
      d = await r.json();
    } catch (e) { return "I couldn't reach the sandbox just now. Try again in a moment."; }
    if (r.status === 503) { sandboxClosed = true; return null; }
    if (!r.ok) return esc(d.error || "That didn't work. Try again in a moment.");
    const ev = (d.events || []).map((x) => {
      const pl = codesFor(x.where);
      const e = S.make("custom", pl.where, pl.countries, "serious", x.start, x.months);
      e.custom = S.safeCustom({ label: x.label, hint: x.explain, p: x.p, f: x.f, nb: x.nb ? { stress: x.nb } : undefined, calm: x.calm });
      return e;
    });
    S.set(ev); if (d.years) S.years(d.years);
    const missing = ev.find((e) => e.where === "pick" && !e.countries.length);
    return esc(d.reply || "Here's your world.") + planText()
      + (missing ? `<br><br>I couldn't place the ${esc(S.kindOf(missing).label.toLowerCase())}: add its countries in the plan below, or tell me where.` : confirmLine());
  }

  async function send(text) {
    text = String(text || "").trim().slice(0, 2000);
    if (!text || busy) return;
    say("me", esc(text));
    let reply = null;
    try { reply = handle(text, true); } catch (e) { console.warn(e); }
    if (reply == null && !sandboxClosed) {
      busy = true; $("chatIn").disabled = true;
      const li = document.createElement("li"); li.className = "ag ag-wait"; li.textContent = "Working out how that changes people's lives…"; $("chatLog").appendChild(li);
      try { reply = await remote(text); } catch (e) { console.warn(e); reply = "Something went wrong. Try again in a moment."; }
      li.remove(); busy = false; $("chatIn").disabled = false; $("chatIn").focus();
    }
    if (reply == null) {                         // the sandbox is closed: the built-in reader sets up preset events
      try { reply = handle(text); } catch (e) { reply = "Something went wrong reading that. Try saying it a different way."; console.warn(e); }
    }
    setTimeout(() => say("ag", reply), 120);
  }

  function start() {
    S = window.simScenario; P = placeIndex();
    $("chatForm").addEventListener("submit", (e) => { e.preventDefault(); const v = $("chatIn").value; $("chatIn").value = ""; send(v); });
    $("chatLog").addEventListener("click", (e) => { const b = e.target.closest("[data-say]"); if (b) send(b.dataset.say); });
    say("ag", S.get().length ? "This scenario came from a shared link:" + planText() + confirmLine()
      : `What should happen to the world? Describe anything in your own words (a policy, a disaster, a new technology, a war) and I'll turn it into a plan you can check before it runs. ${helpExamples()}`);
  }
  if (window.simScenario) start(); else addEventListener("simscenario:ready", start, { once: true });
})();
