// The idea desk on the Model lab page: pitch an idea for the simulation and Claude (an AI) thinks it through with
// you; ideas that hold up go to the developer's private inbox. Runs on the coordinator (ideas.py). The conversation
// lives only in this page: reload to start over. Two pitches per person a day.
(() => {
  const $ = (id) => document.getElementById(id);
  const form = $("ideaForm"), log = $("ideaLog"), box = $("ideaText"), send = $("ideaSend"), note = $("ideaNote");
  if (!form) return;
  const esc = (s) => String(s ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
  // light formatting for the replies: paragraphs, bullet lists, **bold**
  const fmt = (t) => esc(t).split(/\n{2,}/).map((p) => {
    const lines = p.split("\n");
    if (lines.every((l) => /^\s*([-*•]|\d+\.)\s+/.test(l))) return `<ul>${lines.map((l) => `<li>${l.replace(/^\s*([-*•]|\d+\.)\s+/, "")}</li>`).join("")}</ul>`;
    return `<p>${lines.join("<br>")}</p>`;
  }).join("").replace(/\*\*(.+?)\*\*/g, "<b>$1</b>");
  const msgs = [];
  let busy = false, over = false;
  function add(role, html) {
    const li = document.createElement("li"); li.className = role; li.innerHTML = html;
    log.appendChild(li); li.scrollIntoView({ block: "nearest", behavior: "smooth" }); return li;
  }
  async function go(text) {
    if (busy || over) return;
    text = text.trim().slice(0, 800); if (!text) return;
    busy = true; send.disabled = true; box.value = ""; note.textContent = "";
    msgs.push({ role: "user", text }); add("me", esc(text));
    const wait = add("bot thinking", "<p>Thinking it through…</p>");
    try {
      const r = await fetch("/api/v1/ideas/chat", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ messages: msgs }) });
      const d = await r.json().catch(() => ({}));
      wait.remove();
      if (!r.ok || d.error) {
        msgs.pop(); add("bot err", `<p>${esc(d.error || "The idea desk couldn't answer just now. Try again in a moment.")}</p>`);
        if (r.status === 429 || r.status === 503) over = true;
      } else {
        msgs.push({ role: "assistant", text: d.reply }); add("bot", fmt(d.reply));
        if (d.filed) add("bot filed", "<p>Passed to the developer, with Claude's notes and this conversation.</p>");
        if (d.done || d.filed) over = true;
      }
    } catch (e) {
      wait.remove(); msgs.pop(); add("bot err", "<p>Couldn't reach the idea desk. Check your connection and try again.</p>");
    }
    busy = false; send.disabled = over; box.disabled = over;
    if (over) note.textContent = "This pitch is finished. Reload the page to start another (two a day).";
  }
  form.addEventListener("submit", (e) => { e.preventDefault(); go(box.value); });
  box.addEventListener("keydown", (e) => { if (e.key === "Enter" && !e.shiftKey) { e.preventDefault(); go(box.value); } });
  box.addEventListener("input", () => { const n = box.value.length; note.textContent = n > 650 ? `${800 - n} characters left` : ""; });
})();
