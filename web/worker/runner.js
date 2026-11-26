// Runs a piece of the world off the page's main thread, so the page (and the phone) stays responsive.
importScripts("kernel.js");
onmessage = (ev) => {
  const { id, payload } = ev.data;
  const err = checkWorldJob(payload);
  if (err) { postMessage({ id, error: err }); return; }
  const t0 = Date.now();
  try {
    let last = 0;
    const out = runShard(payload, (f) => { const now = Date.now(); if (now - last > 250) { last = now; postMessage({ id, progress: f }); } });
    postMessage({ id, out, secs: (Date.now() - t0) / 1000 });
  } catch (e) {
    postMessage({ id, error: String(e && e.message || e) });
  }
};
