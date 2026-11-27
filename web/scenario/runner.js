// Runs a personal scenario on this device, month by month: an experimental sandbox, one world with the
// visitor's events in it. Nothing is sent anywhere.
importScripts("/worker/kernel.js");

let stop = false;
onmessage = (ev) => {
  const m = ev.data;
  if (m.stop) { stop = true; return; }
  stop = false;
  run(m).catch((e) => postMessage({ error: String(e && e.message || e) }));
};

const KEYS = ["stress", "irr", "leave", "kind"];
function addTo(dst, src, k = 1) { for (const key of Object.keys(src)) dst[key] = (dst[key] || 0) + src[key] * k; }

async function run({ nations, theta, months, events, effects, seed }) {
  // nations: [{c, agents, feat, base: {pressure}, b: [borders]}]
  const idx = new Map(nations.map((n, i) => [n.c, i]));
  let stA = null, stB = null;
  // two quiet months first, so everyone has settled into ordinary life before anything happens
  for (let w = 0; w < 2 && !stop; w++) {
    const r = runShard({ nations: nations.map((n) => ({ code: n.c, agents: n.agents, feat: n.feat, pressure: n.base })), theta, days: 30, seed: seed * 7919 + w, state: stA },
                       (f) => postMessage({ month: 0, progress: (w + f) / 2 }));
    stA = r.state;
    if (w === 1) postMessage({ month: 0, scenario: r.nations });
  }
  stB = stA;
  for (let month = 1; month <= months && !stop; month++) {
    const featB = nations.map((n) => Object.assign({}, n.feat));
    const presB = nations.map((n) => Object.assign({}, n.base));
    for (const e of events) {
      if (month < e.start || month >= e.start + e.months) continue;
      const fx = effects[e.type]; if (!fx) continue;
      const s = e.strength;
      for (const c of e.where) {
        const i = idx.get(c); if (i == null) continue;
        if (fx.calm) { for (const k of KEYS) presB[i][k] = Math.min(presB[i][k], 0); }
        if (fx.p) addTo(presB[i], fx.p, s);
        if (fx.f) addTo(featB[i], fx.f, s);
        if (fx.nb) for (const b of nations[i].b || []) { const j = idx.get(b); if (j != null && !e.where.includes(b)) addTo(presB[j], fx.nb, s); }
      }
    }
    const clampAll = (o) => { for (const k of Object.keys(o)) o[k] = Math.max(-9.5, Math.min(9.5, Math.round(o[k] * 10000) / 10000)); return o; };
    const jobB = { nations: nations.map((n, i) => ({ code: n.c, agents: n.agents, feat: clampAll(featB[i]), pressure: clampAll(presB[i]) })), theta, days: 30, seed: seed * 1009 + month, state: stB };
    const err = checkWorldJob(jobB); if (err) throw new Error(err);
    const t0 = Date.now();
    const b = runShard(jobB, (f) => postMessage({ month, progress: f }));
    stB = b.state;
    postMessage({ month, scenario: b.nations, secs: (Date.now() - t0) / 1000 });
  }
  postMessage({ done: true, stopped: stop });
}
