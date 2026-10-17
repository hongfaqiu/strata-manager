// Server-side reputation. A run counts on the leaderboard as soon as its in-app run evidence verifies
// (src/evidence.js); runs without or with failing evidence stay pending. Cross-validation against other machines
// on the same model + quant + hardware + parameters is applied afterwards: runs far from their peers are flagged and
// dropped, and an install whose runs are mostly flagged is excluded until a maintainer reviews it.
import { median } from './stats.js';
import { vramTier, ramTier } from './schema.js';

export const TRUST = Object.freeze({
  minPeers: 2,           // peers needed for a MAD comparison; fewer falls back to corroboration
  madK: 3.5,             // |x - median| <= madK * 1.4826 * MAD ...
  floorPct: 0.12,        // ... but never tighter than 12% of the median (identical peers have MAD 0)
  corroboratePct: 0.2,   // a single peer within 20% corroborates
  outlierRatio: 1.8,     // a run this far above/below its peers' median is flagged
  maxFlagRate: 0.34,     // more flagged runs than this (with at least minFlagRuns) marks the install 'flagged'
  minFlagRuns: 3,
});
const DAY = 86_400_000;

/** Same configuration identity as the leaderboard rows (group + hardware tier + launch parameters). */
export const configKey = s => JSON.stringify([s.family, s.quant, s.gpu_name ?? 'CPU', vramTier(s.vram_gb), ramTier(s.ram_gb),
  s.ctx, s.kv, s.parallel, s.pool_workers, s.expert_cache, s.pcie_frac, s.gpu_count, s.vision ? 1 : 0]);

/** Per-run plausibility flag that needs no peers: first token faster than the reported prefill speed permits. */
export function selfFlag(s) {
  if (s.kind !== 'context' || !s.prefill_8k || !s.ttft_8k_ms) return null;
  const minimumMs = (8192 * 0.5) / s.prefill_8k * 1000 * 0.6;
  return s.ttft_8k_ms < minimumMs ? 'ttft_fast' : null;
}

/**
 * Evaluates every install. `subs` are non-hidden submissions inside retention (any kind) with `evidence_status`;
 * `installs` carry key_id and the maintainer override.
 * Returns { installs: Map<key_id, verdict>, flags: Map<submission id, flag|null>, counts(s) -> boolean }.
 */
export function evaluate(installs, subs) {
  const override = new Map(installs.map(i => [i.key_id, i.override ?? null]));
  const flags = new Map();
  const byInstall = new Map();
  for (const s of subs) {
    if (override.get(s.install_hash) === 'ban') continue;
    if (!byInstall.has(s.install_hash)) byInstall.set(s.install_hash, []);
    byInstall.get(s.install_hash).push(s);
    flags.set(s.id, selfFlag(s));
  }
  // Machine medians per configuration (latest three unflagged runs), the unit peers are compared on.
  const configs = new Map();
  for (const [key, runs] of byInstall) {
    const perConfig = new Map();
    for (const s of runs) {
      if (s.kind !== 'context' || s.decode_8k === null || s.decode_8k === undefined || flags.get(s.id)) continue;
      const ck = configKey(s);
      if (!perConfig.has(ck)) perConfig.set(ck, []);
      perConfig.get(ck).push(s);
    }
    for (const [ck, list] of perConfig) {
      const latest = list.sort((a, b) => b.received_at - a.received_at).slice(0, 3);
      if (!configs.has(ck)) configs.set(ck, new Map());
      configs.get(ck).set(key, { value: median(latest.map(r => r.decode_8k)), runs: list });
    }
  }
  const peerStats = new Map();
  const stats = key => { if (!peerStats.has(key)) peerStats.set(key, { compared: 0, consistent: 0, corroborated: 0 }); return peerStats.get(key); };
  for (const machines of configs.values()) {
    for (const [key, mine] of machines) {
      const peers = [...machines].filter(([k]) => k !== key).map(([, m]) => m.value);
      const v = stats(key);
      if (!peers.length) continue;
      const m = median(peers);
      for (const run of mine.runs) if (run.decode_8k > m * TRUST.outlierRatio || run.decode_8k < m / TRUST.outlierRatio) flags.set(run.id, 'peer_outlier');
      if (peers.length >= TRUST.minPeers) {
        const mad = median(peers.map(p => Math.abs(p - m)));
        v.compared++;
        if (Math.abs(mine.value - m) <= Math.max(TRUST.madK * 1.4826 * mad, TRUST.floorPct * m)) v.consistent++;
      } else if (peers.some(p => Math.abs(p - mine.value) <= TRUST.corroboratePct * Math.max(p, mine.value))) {
        v.corroborated++;
      }
    }
  }
  const out = new Map();
  for (const inst of installs) {
    const key = inst.key_id, runs = byInstall.get(key) ?? [], v = stats(key);
    const days = new Set(runs.map(r => Math.floor(r.received_at / DAY))).size;
    const flagged = runs.filter(r => flags.get(r.id)).length, verified = runs.filter(r => r.evidence_status === 'verified').length;
    const flagRate = runs.length ? flagged / runs.length : 0, verifiedRate = runs.length ? verified / runs.length : 0;
    // Peer agreement nudges the score; without peers it is neutral.
    const agreement = v.compared ? v.consistent / v.compared : v.corroborated ? 1 : 0.5;
    let trust = Math.round(Math.max(0, Math.min(1, 0.7 * verifiedRate + 0.3 * agreement - flagRate)) * 100) / 100;
    let status;
    if (inst.override === 'ban') { status = 'banned'; trust = 0; }
    else if (inst.override === 'trust') status = 'trusted';
    else if ((runs.length >= TRUST.minFlagRuns && flagRate > TRUST.maxFlagRate) || (v.compared >= 2 && v.consistent / v.compared < 0.5)) status = 'flagged';
    else if (verified > 0) status = 'verified';
    else status = 'pending';
    out.set(key, { status, trust, runs: runs.length, verified, days, flagged, consistent: v.consistent, compared: v.compared, corroborated: v.corroborated });
  }
  /** A run counts when it is unflagged and either verified by evidence (install not flagged) or the maintainer trusts the install. */
  const counts = s => {
    if (s.seed) return true;
    const st = out.get(s.install_hash)?.status;
    if (flags.get(s.id) || st === 'banned' || st === 'flagged') return false;
    return st === 'trusted' || s.evidence_status === 'verified';
  };
  return { installs: out, flags, counts };
}
