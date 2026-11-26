// Sim Horde world kernel for web browsers: the same model as world_kernel.py (run_shard), line for line,
// so phones, tablets and any computer with a browser can run a piece of the shared world.
// Input and output are plain numbers; nothing here can run code it's sent.
"use strict";

const WORLD_DEFAULT = { base: -2.6, w_trait: 0.9, w_stress: 1.0, w_irr: 1.2, hit: 0.45, social: 0.02, w_pov: 0.8, w_dens: 0.3,
  w_unemp: 0.6, w_ineq: 0.5, w_young: 0.2, w_net: 0.1 };
const WORLD_RANGES = { base: [-3.6, -1.6], w_trait: [0.3, 1.6], w_stress: [0.2, 2.2], w_irr: [0.1, 2.6], hit: [0.1, 0.9],
  social: [0.0, 0.06], w_pov: [0.0, 2.5], w_dens: [-1.0, 1.5], w_unemp: [0.0, 2.0], w_ineq: [-1.0, 2.0], w_young: [-1.0, 1.5], w_net: [-1.0, 1.5] };
const FEATURES = ["pov", "dens", "unemp", "ineq", "young", "net"];
const PRESSURE = ["stress", "irr", "leave", "kind"];
const STATE_TAG = "f16v1:";
const MAX_AGENTS = 4000000;

// ---- random numbers (a small, fast, seedable generator) -------------------------------------------
function rng(seed) {
  let a = (seed >>> 0) ^ 0x9e3779b9, b = (seed * 2654435761) >>> 0 || 1, c = 0x6d2b79f5, d = 0x1b873593;
  const next = () => {                        // sfc32
    a >>>= 0; b >>>= 0; c >>>= 0; d >>>= 0;
    const t = (a + b | 0) + d | 0; d = d + 1 | 0; a = b ^ b >>> 9; b = c + (c << 3) | 0; c = c << 21 | c >>> 11; c = c + t | 0;
    return (t >>> 0) / 4294967296;
  };
  for (let i = 0; i < 12; i++) next();
  let spare = null;
  const normal = () => {
    if (spare !== null) { const s = spare; spare = null; return s; }
    let u, v, r;
    do { u = next() * 2 - 1; v = next() * 2 - 1; r = u * u + v * v; } while (r >= 1 || r === 0);
    const f = Math.sqrt(-2 * Math.log(r) / r); spare = v * f; return u * f;
  };
  const poisson = (lam) => {                  // Knuth: fine for the small means used here
    const L = Math.exp(-lam); let k = 0, p = 1;
    do { k++; p *= next(); } while (p > L);
    return k - 1;
  };
  return { next, normal, poisson };
}

// ---- float16 state, matching numpy's '<f2' ---------------------------------------------------------
const f32 = new Float32Array(1), u32 = new Uint32Array(f32.buffer);
function toHalf(v) {
  f32[0] = v; const x = u32[0];
  const sign = (x >>> 16) & 0x8000; let e = ((x >>> 23) & 0xff) - 112; let m = x & 0x7fffff;
  if (e <= 0) { if (e < -10) return sign; m |= 0x800000; const s = 14 - e; const r = (m >> s) + ((m >> (s - 1)) & 1); return sign | r; }
  if (e >= 31) return sign | 0x7c00;
  let h = sign | (e << 10) | (m >> 13);
  if (m & 0x1000) h++;                        // round to nearest
  return h;
}
function fromHalf(h) {
  const s = h & 0x8000 ? -1 : 1, e = (h >> 10) & 0x1f, m = h & 0x3ff;
  if (e === 0) return s * m * Math.pow(2, -24);
  if (e === 31) return m ? NaN : s * Infinity;
  return s * (1 + m / 1024) * Math.pow(2, e - 15);
}
function packState(arrs) {
  const n = arrs[0].length, bytes = new Uint8Array(n * 4 * 2), dv = new DataView(bytes.buffer);
  let o = 0;
  for (const a of arrs) for (let i = 0; i < n; i++, o += 2) dv.setUint16(o, toHalf(a[i]), true);
  let bin = "";
  for (let i = 0; i < bytes.length; i += 0x8000) bin += String.fromCharCode.apply(null, bytes.subarray(i, i + 0x8000));
  return STATE_TAG + btoa(bin);
}
function unpackState(s, N) {
  if (!s.startsWith(STATE_TAG)) throw new Error("unknown state format");
  const bin = atob(s.slice(STATE_TAG.length));
  if (bin.length !== N * 4 * 2) throw new Error("state doesn't match the shard");
  const out = [new Float32Array(N), new Float32Array(N), new Float32Array(N), new Float32Array(N)];
  for (let k = 0, o = 0; k < 4; k++) for (let i = 0; i < N; i++, o += 2) {
    const v = fromHalf(bin.charCodeAt(o) | (bin.charCodeAt(o + 1) << 8));
    if (!Number.isFinite(v)) throw new Error("state has non-numbers");
    out[k][i] = v;
  }
  return out;
}

// ---- the guard: only numbers, only known names, only sane sizes --------------------------------------
function checkWorldJob(p) {
  if (!p || !Array.isArray(p.nations) || p.nations.length < 1 || p.nations.length > 400) return "bad nation list";
  let tot = 0;
  for (const n of p.nations) {
    if (typeof n.code !== "string" || n.code.length > 8 || !Number.isInteger(n.agents) || n.agents < 50 || n.agents > 500000) return "bad nation entry";
    tot += n.agents;
    for (const [d, keys] of [[n.feat, FEATURES], [n.pressure, PRESSURE]]) {
      if (!d || typeof d !== "object") return "bad conditions";
      for (const [k, v] of Object.entries(d)) {
        if (!keys.includes(k)) return "bad conditions";
        if (typeof v !== "number" || !Number.isFinite(v) || Math.abs(v) > 10) return "condition out of range";
      }
    }
  }
  if (tot > MAX_AGENTS) return "too many people for one job";
  if (!p.theta || typeof p.theta !== "object") return "unknown weights";
  for (const [k, v] of Object.entries(p.theta)) {
    const r = WORLD_RANGES[k];
    if (!r) return "unknown weights";
    if (typeof v !== "number" || v < r[0] - 1e-9 || v > r[1] + 1e-9) return `weight ${k} out of range`;
  }
  if (!Number.isInteger(p.days) || p.days < 1 || p.days > 120 || !Number.isInteger(p.seed)) return "bad days or seed";
  if (p.state != null && (typeof p.state !== "string" || p.state.length > 80000000)) return "bad state";
  return null;
}

const sig = (x) => 1 / (1 + Math.exp(-x));
const clamp = (x, lo, hi) => (x < lo ? lo : x > hi ? hi : x);

// ---- one shard of the world for a stretch of days (world_kernel.run_shard) ---------------------------
function runShard(job, onProgress) {
  const nations = job.nations, th = Object.assign({}, WORLD_DEFAULT, job.theta), R = rng(job.seed);
  const K = nations.length, sizes = nations.map((n) => n.agents), N = sizes.reduce((a, b) => a + b, 0);
  const nat = new Int32Array(N), start = new Int32Array(K);
  for (let k = 0, o = 0; k < K; o += sizes[k], k++) { start[k] = o; nat.fill(k, o, o + sizes[k]); }
  const F = {}, P = {};
  for (const f of FEATURES) F[f] = nations.map((n) => n.feat[f] || 0);
  for (const p of PRESSURE) P[p] = nations.map((n) => Number(n.pressure[p] || 0));
  let trait, stress, irr, conn;
  if (job.state) [trait, stress, irr, conn] = unpackState(job.state, N);
  else {
    trait = new Float32Array(N); stress = new Float32Array(N); irr = new Float32Array(N); conn = new Float32Array(N);
    for (let i = 0; i < N; i++) { trait[i] = R.normal(); stress[i] = 0.4 + 0.2 * R.next(); conn[i] = 0.5 + 0.2 * R.next(); }
  }
  const cond = new Float64Array(K), home = new Float64Array(K), meet = new Float64Array(K);
  for (let k = 0; k < K; k++) {
    cond[k] = th.w_pov * F.pov[k] + th.w_dens * F.dens[k] + th.w_unemp * F.unemp[k] + th.w_ineq * F.ineq[k]
      + th.w_young * F.young[k] + th.w_net * F.net[k] + P.kind[k];
    home[k] = clamp(0.45 + 0.18 * F.pov[k] + 0.12 * F.unemp[k] + 0.08 * F.ineq[k] + P.stress[k], 0.05, 2.5);
    meet[k] = 2.0 + 3.0 * (F.dens[k] + 1.0) / 2.0;
  }
  const kindN = new Float64Array(K), rudeN = new Float64Array(K), leaveN = new Float64Array(K);
  const gotR = new Float32Array(N), gotK = new Float32Array(N), rudeA = new Uint8Array(N), kindA = new Uint8Array(N), part = new Int32Array(N);
  const days = job.days;
  for (let d = 0; d < days; d++) {
    gotR.fill(0); gotK.fill(0);
    for (let i = 0; i < N; i++) {
      const k = nat[i];
      const m = Math.min(12, R.poisson(meet[k]));
      part[i] = start[k] + Math.min(sizes[k] - 1, Math.floor(R.next() * sizes[k]));
      const p = sig(th.base + th.w_trait * trait[i] * 0.5 + th.w_stress * (stress[i] - 0.5) + th.w_irr * irr[i] + cond[k]);
      let r = 0;
      for (let j = 0; j < m; j++) if (R.next() < p) r++;
      rudeA[i] = r; kindA[i] = m - r;
      rudeN[k] += r; kindN[k] += m - r;
    }
    for (let i = 0; i < N; i++) { gotR[part[i]] += rudeA[i]; gotK[part[i]] += kindA[i]; }
    for (let i = 0; i < N; i++) {
      const k = nat[i];
      irr[i] = clamp(irr[i] * 0.75 + 0.08 * th.hit * gotR[i] * (1.2 - conn[i]) - th.social * gotK[i] + 0.05 * P.irr[k], 0, 3);
      conn[i] = clamp(conn[i] + 0.02 * (0.45 + 0.05 * gotK[i] - 0.12 * gotR[i] - conn[i]), 0.05, 1.0);
      stress[i] = clamp(stress[i] + 0.03 * (home[k] + 0.25 * irr[i] - 0.3 * (conn[i] - 0.5) - stress[i]) + 0.03 * R.normal(), 0, 3);
      leaveN[k] += sig(-11.2 + 2.0 * stress[i] + 1.0 * F.pov[k] + P.leave[k]);
    }
    if (onProgress) onProgress((d + 1) / days);
  }
  const sS = new Float64Array(K), sI = new Float64Array(K), sC = new Float64Array(K), sH = new Float64Array(K);
  for (let i = 0; i < N; i++) {
    const k = nat[i];
    const hostile = rudeN[k] / Math.max(1, kindN[k] + rudeN[k]);
    const h = 10 * sig(0.55 - 1.6 * (stress[i] - 0.5) + 1.3 * (conn[i] - 0.5) - 0.7 * irr[i] - 3.0 * (hostile - 0.12)
      - 0.9 * F.pov[k] - 0.3 * F.unemp[k] - 1.2 * P.stress[k]);
    sS[k] += stress[i]; sI[k] += irr[i]; sC[k] += conn[i]; sH[k] += h;
  }
  const r4 = (x, p) => Math.round(x * 10 ** p) / 10 ** p;
  const out = {};
  for (let k = 0; k < K; k++) {
    const n = sizes[k], tot = kindN[k] + rudeN[k];
    out[nations[k].code] = { happy: r4(sH[k] / n, 4), civ: r4(kindN[k] / Math.max(1, tot), 5), stress: r4(sS[k] / n, 4),
      irr: r4(sI[k] / n, 4), conn: r4(sC[k] / n, 4), leave: r4(leaveN[k] / n / days * 365 * 1000, 3) };
  }
  return { nations: out, state: packState([trait, stress, irr, conn]) };
}

if (typeof module !== "undefined") module.exports = { runShard, checkWorldJob, packState, unpackState, toHalf, fromHalf };
