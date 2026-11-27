// Runs a personal scenario on this device: two copies of the world side by side, month by month.
// One carries on normally, the other gets the visitor's events. Both use the same random numbers,
// so the difference between them is the scenario's doing, not luck. Nothing is sent anywhere.
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
    if (w === 1) postMessage({ month: 0, normal: r.nations, scenario: r.nations });
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
    const jobA = { nations: nations.map((n) => ({ code: n.c, agents: n.agents, feat: n.feat, pressure: n.base })), theta, days: 30, seed: seed * 1009 + month, state: stA };
    const jobB = { nations: nations.map((n, i) => ({ code: n.c, agents: n.agents, feat: clampAll(featB[i]), pressure: clampAll(presB[i]) })), theta, days: 30, seed: seed * 1009 + month, state: stB };
    for (const j of [jobA, jobB]) { const err = checkWorldJob(j); if (err) throw new Error(err); }
    const t0 = Date.now();
    const a = runShard(jobA, (f) => postMessage({ month, progress: f / 2 }));
    if (stop) break;
    const b = runShard(jobB, (f) => postMessage({ month, progress: 0.5 + f / 2 }));
    stA = a.state; stB = b.state;
    postMessage({ month, normal: a.nations, scenario: b.nations, secs: (Date.now() - t0) / 1000 });
  }
  postMessage({ done: true, stopped: stop });
}
