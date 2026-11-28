// The backtest card: how well the world, run from 2015's real conditions and events, matched what happened by 2024.
(() => {
  const box = document.getElementById("backtest"); if (!box) return;
  const esc = (s) => String(s ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
  const word = (r) => (r == null ? "not enough data" : r >= 0.7 ? "strong" : r >= 0.5 ? "good" : r >= 0.3 ? "moderate" : r >= 0.1 ? "weak" : "none");
  fetch("/backtest.json", { cache: "no-store" }).then((r) => (r.ok ? r.json() : null)).then((b) => {
    if (!b || !b.change || b.incomplete) return;
    // the honest number: change from 2019 to 2024, which the tuning never saw (older runs only have the full period)
    const c = (b.test && b.test.after) || b.change, before = b.test && b.test.before, e = b.emigration || {}, last = (b.per_year || []).slice(-1)[0];
    const lede = box.querySelector(".bt-lede");
    if (b.test && lede) lede.textContent = `The world was started from every country's real conditions in 2015 and given what really happened year by year: incomes, jobs, prices, wars, coups, sanctions, mass protests, economic collapses and the pandemic. How strongly each kind of event weighs on people was tuned on 2015 to 2019 only. These scores are for 2019 to 2024, which the tuning never saw.`;
    const better = c.mae < c.mae_no_change;
    const card = (big, label, text) => `<div class="bt-card"><b>${big}</b><span>${label}</span><p>${text}</p></div>`;
    document.getElementById("btCards").innerHTML =
      card(c.rank != null ? c.rank.toFixed(2) : "–", `Change in happiness: a ${word(c.rank)} match`,
        `Did countries get happier or less happy the way they really did? Rank match across ${c.countries} countries (1 would be perfect, 0 no better than chance).` + (before ? ` Before tuning: ${before.rank != null ? before.rank.toFixed(2) : "–"}.` : ""))
      + card(`${Math.round(c.direction * 100)}%`, "Direction right",
        `Of the ${c.direction_countries} countries whose happiness really moved by 0.3 points or more, how many the simulation moved the same way.` + (before ? ` Before tuning: ${Math.round(before.direction * 100)}%.` : ""))
      + card(c.mae.toFixed(2), better ? "Points off, better than 'no change'" : "Points off, not yet better than 'no change'",
        `Average error in each country's change, against ${c.mae_no_change.toFixed(2)} for simply guessing nothing changed.` + (before ? ` Before tuning: ${before.mae.toFixed(2)}.` : ""))
      + card(e.rank != null ? e.rank.toFixed(2) : "–", `Emigration: a ${word(e.rank)} match`,
        `Across ${e.countries || 0} countries people really left, how well the simulation ranks where people most wanted to go.`);
    const miss = (c.biggest_misses || []).slice(0, 3).map((x) => `${esc(x.name)} (simulated ${x.sim > 0 ? "+" : ""}${x.sim.toFixed(1)}, real ${x.real > 0 ? "+" : ""}${x.real.toFixed(1)})`).join(", ");
    document.getElementById("btNote").innerHTML = `${b.people.toLocaleString()} simulated people in ${b.countries} countries, run ${esc(b.made)} with ${esc(b.weights_from)}.`
      + (last ? ` In ${last.year} the simulated countries were ${last.mae.toFixed(2)} points off real surveys on average.` : "")
      + (miss ? ` Biggest misses: ${miss}.` : "")
      + ` <a href="https://github.com/locastil/Sim-Horde/blob/main/backtest.py">The code and the list of events are public</a>.`;
    box.hidden = false;
  }).catch(() => {});
})();
