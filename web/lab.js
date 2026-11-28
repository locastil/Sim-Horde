// Model lab: renders lab.json, the record of every variable tried in the simulation and how it was tested.
(function () {
  const $ = (id) => document.getElementById(id);
  const esc = (s) => String(s).replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" }[c]));
  const sign = (v) => (v > 0 ? "+" : v < 0 ? "−" : "±") + Math.abs(v).toFixed(v !== 0 && Math.abs(v) < 0.1 ? 3 : 2);
  const GROUPS = [
    ["kept", "Added after testing", "Nothing has been added yet."],
    ["passed", "Passed the full test, being added", ""],
    ["testing", "Being tested now", ""],
    ["next", "Next in line for the full test", ""],
    ["rejected", "Tested and rejected", ""],
    ["set_aside", "Set aside after the quick check", ""],
  ];
  function quick(q) {
    if (!q) return "–";
    const parts = [];
    if (q.happiness != null) parts.push(`<span>Happiness <b class="${q.happiness > 0.015 ? "up" : ""}">${sign(q.happiness)}</b></span>`);
    if (q.migration != null) parts.push(`<span>Migration <b class="${q.migration > 0.05 ? "up" : ""}">${sign(q.migration)}</b></span>`);
    return parts.join("") + (q.note ? `<i>${esc(q.note)}</i>` : "");
  }
  function full(f) {
    if (!f) return "";
    const row = (label, pairs) => pairs ? `<span>${label}: ${pairs.map(([a, b]) => `${a.toFixed(3)} → <b class="${b - a > 0.01 ? "up" : b - a < -0.005 ? "down" : ""}">${b.toFixed(3)}</b>`).join(", ")}</span>` : "";
    return `<div class="lab-full"><em>Full test, on unseen countries</em>${row("Happiness", f.happiness)}${row("Migration", f.migration)}</div>`;
  }
  fetch("/lab.json", { cache: "no-cache" }).then((r) => r.json()).then((L) => {
    $("labList").innerHTML = GROUPS.map(([key, title, empty]) => {
      const list = L.items.filter((i) => i.status === key);
      if (!list.length && !empty) return "";
      return `<div class="lab-group lab-${key}"><h3>${title} <span class="lab-count">${list.length}</span></h3>` +
        (list.length ? `<ul class="lab-items">${list.map((i) => `<li>
          <div class="lab-name"><b>${esc(i.name)}</b><span>${esc(i.what)}</span><small>${esc(i.source)}</small></div>
          <div class="lab-score"><em>Quick check</em>${quick(i.quick)}</div>
          <div class="lab-why">${esc(i.why)}${full(i.full)}${i.live ? `<div class="lab-live"><em>In the live world since ${esc(i.live.since)}</em><span>${esc(i.live.note)}</span></div>` : ""}</div></li>`).join("")}</ul>` : `<p class="lab-note">${empty}</p>`) + "</div>";
    }).join("") + (L.migration_baseline ? `<p class="lab-note">${esc(L.migration_baseline.text)}</p>` : "") + `<p class="lab-note">Last updated ${esc(L.updated)}.</p>`;
    const inv = $("labInventory");
    if (inv && L.inventory) inv.innerHTML = L.inventory.map((g) => `<div class="lab-inv"><h3>${esc(g.title)}</h3>${g.note ? `<p class="lab-note">${esc(g.note)}</p>` : ""}` +
      `<table><thead><tr><th scope="col">Variable</th><th scope="col">Source</th><th scope="col">What it does</th></tr></thead><tbody>` +
      g.rows.map(([v, src, does]) => `<tr><th scope="row">${esc(v)}</th><td>${esc(src)}</td><td>${esc(does)}</td></tr>`).join("") + "</tbody></table></div>").join("");
    $("labFixes").innerHTML = (L.fixes || []).map((f) => `<li><time>${esc(f.date)}</time> ${esc(f.text)}</li>`).join("");
  }).catch(() => { $("labList").innerHTML = '<p class="lab-note">The lab results did not load. Reload the page to try again.</p>'; });
})();
