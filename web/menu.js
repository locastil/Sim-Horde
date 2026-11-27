// The main menu on phones: the Menu button opens and closes the list of pages.
(() => {
  const btn = document.querySelector(".menu-btn"), list = document.getElementById("mainLinks");
  if (!btn || !list) return;
  const set = (open) => { list.classList.toggle("open", open); btn.setAttribute("aria-expanded", String(open)); btn.textContent = open ? "Close" : "Menu"; };
  btn.addEventListener("click", () => set(!list.classList.contains("open")));
  list.addEventListener("click", (e) => { if (e.target.closest("a")) set(false); });
  document.addEventListener("keydown", (e) => { if (e.key === "Escape" && list.classList.contains("open")) { set(false); btn.focus(); } });
  document.addEventListener("click", (e) => { if (!e.target.closest(".top nav")) set(false); });
})();
