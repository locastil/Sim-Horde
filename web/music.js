// The site's song: "Burn It Down" by Linkin Park, played through the band's official YouTube video.
// Nothing loads until the visitor presses play (no autoplay, no YouTube cookies before then), and the
// song itself is never copied onto this site: it streams from YouTube, which licenses it.
(() => {
  const VIDEO = "dxytyRy-O1k";
  // a small "Soundtrack" line in the footer, not a floating button
  const box = document.createElement("div");
  box.className = "music";
  box.innerHTML = `<button type="button" class="music-btn" aria-expanded="false">
      <svg viewBox="0 0 24 24" width="13" height="13" aria-hidden="true"><path d="M9 18V5l11-2v13" fill="none" stroke="currentColor" stroke-width="2" stroke-linejoin="round"/><circle cx="6" cy="18" r="3" fill="currentColor"/><circle cx="17" cy="16" r="3" fill="currentColor"/></svg>
      <span>Soundtrack: Linkin Park, "Burn It Down"</span></button>
    <div class="music-player" hidden></div>`;
  const foot = document.querySelector("footer .wrap") || document.querySelector("footer") || document.body;
  foot.appendChild(box);
  const btn = box.querySelector(".music-btn"), player = box.querySelector(".music-player");
  btn.addEventListener("click", () => {
    const open = player.hidden;
    if (open && !player.firstChild) {
      player.innerHTML = `<iframe src="https://www.youtube-nocookie.com/embed/${VIDEO}?autoplay=1&rel=0" title="Linkin Park: Burn It Down (official video)"
        allow="autoplay; encrypted-media; picture-in-picture" allowfullscreen loading="lazy"></iframe>
`;
    }
    if (!open) player.innerHTML = "";                     // closing stops the song
    player.hidden = !open;
    btn.setAttribute("aria-expanded", String(open));
    btn.querySelector("span").textContent = open ? "Stop the soundtrack" : 'Soundtrack: Linkin Park, "Burn It Down"';
  });
})();
