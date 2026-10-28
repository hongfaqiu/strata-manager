/**
 * Approximate speed / time-to-first-token / memory for a catalog (or community) quant on this machine.
 *
 * Every number comes from a measurement published in Strata's docs (pinned below), never from Manager itself:
 * the UI must label the result 「估算」 and name the reference hardware. Rules:
 * - Mac (Metal): resident when the unified memory reaches MAC.md's "Recommended from" (else the experts stream
 *   from the SSD; it slows down, it does not fail). Resident speeds are the M5 Max 128 GB runs (an upper bound for
 *   chips with less memory bandwidth); streaming speeds are the M4 32 GB / M1 Max 34 GB runs (more memory = a bigger
 *   expert arena, MAC.md: "The arena's size matters most", so a 48 GB Mac sits toward the upper end).
 * - PC: the RTX 5070 12 GB / RX 9070 XT 16 GB / R9700 32 GB / RTX 3060 12 GB tables of MODELS.md and QWEN36.md.
 *   NVIDIA cards with 20 GB or more use the big-card measurements of the same quant when there are any (a bigger card
 *   caches more experts, so the 12 GB table is far too low there): RTX 4090 24 GB (upstream community benchmarks) and
 *   modified RTX 4080 SUPER 32 GB (Strata Arena leaderboard + upstream community run). Quants without a big-card run
 *   fall back to the next smaller tier as a lower bound.
 *   VRAM alone does not separate cards of very different memory bandwidth, so a few GPU names (from nvidia-smi) pick
 *   their own measured table first: RTX 5090 (desktop, 32 GB), RTX 3060 and RTX 4060 Ti (low-bandwidth cards that
 *   measured well below the RTX 5070 12 GB table). A quant without a run on a slow card shows no speed rather than
 *   borrowing a faster card's figure; on the 5090 it falls back to the VRAM tiers as a lower bound.
 * - A smaller size is not slower than a bigger one on the same card (MODELS.md: Q2_0 "fastest"; every same-machine
 *   comparison upstream: RTX 5070, RTX 3060, RTX 3090, RTX 4070 Ti SUPER, RX 9070 XT). So when a big-card tier has no
 *   run of a size, the nearest bigger size measured on that tier is its lower bound (flagged `inferredFrom`) instead of
 *   the 12 GB table, which showed Q2_0 "≥ 76" under IQ3_XXS "≥ 108" on a 32 GB card. Only when this machine has at
 *   least the reference's VRAM; a smaller card keeps the old path.
 *   "RAM ≥ experts + 10 GB" (MODELS.md "Will it fit?") else the low-RAM mode (much slower, no published number).
 *   Less VRAM than the reference → the figure is an upper bound; more → a lower bound (MODELS.md: more VRAM is faster).
 * - Time to first token = 4,096 prompt tokens / the measured prompt rate (range over the published rates).
 * - IQ3_S streaming on a Mac has no measurement: extrapolated from IQ3_XXS by expert bytes (43 → 50 GB), flagged.
 * Community GSQ-RCO files share the official tensor layout, so they use the same family's figures
 * (SC117's IQ3_S was reported at 94-109 tok/s on an M5 Max, like the official IQ3_S; Strata issue #2898).
 */
import type { RuntimePackagePlatform } from './local-runtime-package';

export const PERFORMANCE_DOCS_REVISION = '9de04cd44e927a9a3df6bbc0e94fc1be8b844ba4';
const doc = (file: string, anchor = '') => `https://github.com/Niko1221/Strata/blob/${PERFORMANCE_DOCS_REVISION}/docs/${file}${anchor}`;
/** Upstream community benchmark folders (bench/results), pinned to the commit that has all of them. */
export const PERFORMANCE_BENCH_REVISION = '5e8a4cca7d690ac60ca37eb09e7d0e010099ad6d';
const bench = (folder: string) => `https://github.com/Niko1221/Strata/tree/${PERFORMANCE_BENCH_REVISION}/bench/results/${folder}`;
const ARENA_URL = 'https://strata-manager.cosfoc.com/leaderboard';
export const PERFORMANCE_SOURCES = {
  macM5Max: doc('MAC.md', '#measured-m5-max-128-gb-macos-272'),
  macStream: doc('MAC.md', '#m4-mac-mini-32-gb-experts-streamed-from-the-ssd'),
  macMemory: doc('MAC.md', '#what-you-need'),
  pcRtx5070: doc('MODELS.md', '#which-model-sizes-versions-and-what-fits'),
  pcFit: doc('MODELS.md', '#will-it-fit'),
  pcR9700: doc('MODELS.md', '#unsloths-files-ud-iq4_xs-to-q8_0'),
  qwen36: doc('MODELS.md', '#qwen36-35b-a3b'),
  pcRtx4090: bench('2026-10-03-community-rtx4090-iq3s-140k-code'),
  pcNvidia32: ARENA_URL,
  pcRtx5090: bench('2026-10-05-community-rtx-5090-9700x-iq3s'),
  pcRtx3060Bench: bench('2026-10-09-community-rtx-3060-0141'),
  pcRtx4060Ti: bench('2026-10-05-community-e5-2673v3-rtx-4060ti'),
} as const;
export type PerformanceBasis = 'macM5Max' | 'macStream' | 'macStreamExtrapolated' | 'pcRtx5070' | 'pcRtx4090' | 'pcNvidia32' | 'pcRtx5090' | 'pcRtx3060Bench' | 'pcRtx4060Ti' | 'pcRx9070xt' | 'pcR9700' | 'pcRtx3060' | 'none';
export type PerformanceMode = 'macResident' | 'macStreaming' | 'macUnsupported' | 'gpu' | 'lowRam' | 'tooSmall' | 'unknown';
export interface Range { low: number; high: number }
export interface PerformanceHardware {
  platform: RuntimePackagePlatform; memoryGB?: number; vramGB?: number; gpuVendor?: 'nvidia' | 'amd' | 'other';
  /** nvidia-smi / adapter name of the card the VRAM came from (picks a card-specific table when there is one). */
  gpuName?: string;
}
export interface PerformanceEstimate {
  mode: PerformanceMode;
  /** Generated tokens per second. */
  decode?: Range;
  /** Seconds to the first token after a 4K-token prompt. */
  ttft4k?: Range;
  /** 'upper': this machine is likely slower than the reference (less VRAM / bandwidth); 'lower': likely faster. */
  bound?: 'upper' | 'lower';
  /** Memory needed: Mac unified memory (resident), PC system RAM (experts + 10 GB). */
  memoryGB?: number;
  /** Mac: unified memory from which the pack stays resident. */
  residentFromGB?: number;
  /** Reference VRAM of the measurement (PC). */
  referenceVramGB?: number;
  basis: PerformanceBasis;
  extrapolated: boolean;
  /** No run of this size on the reference: the figure is the lower bound from this bigger size on the same reference. */
  inferredFrom?: string;
  source?: string;
}

const r = (low: number, high: number): Range => ({ low, high });
const ttft = (lowRate: number, highRate: number): Range => ({ low: Math.round(4096 / highRate * 10) / 10, high: Math.round(4096 / lowRate * 10) / 10 });

/** MAC.md "What you need" (needs about / recommended from); IQ2_XS: +8.4 GB like Q2_0, flagged. */
const MAC_MEMORY: Record<string, { needs: number; residentFrom: number; extrapolated?: boolean }> = {
  Q2_0: { needs: 46, residentFrom: 64 }, IQ2_XS: { needs: 48, residentFrom: 66, extrapolated: true },
  IQ3_XXS: { needs: 55, residentFrom: 74 }, IQ3_S: { needs: 63, residentFrom: 96 }, 'UD-Q4_K_XL': { needs: 91, residentFrom: 128 },
};
/** MAC.md M5 Max 128 GB: decode (MTP, prompt1 / story), 4K prompt rate. */
const MAC_RESIDENT: Record<string, { decode: Range; prompt: number }> = {
  Q2_0: { decode: r(108.2, 119.5), prompt: 1430 }, IQ3_XXS: { decode: r(97.0, 108.9), prompt: 1260 },
  IQ3_S: { decode: r(94.1, 98.2), prompt: 1320 }, 'UD-Q4_K_XL': { decode: r(73.7, 94.0), prompt: 1150 },
};
/** MAC.md streaming: M1 Max 34 GB (7.9 tok/s, 186 tok/s prompt) and M4 32 GB (tables, release-build re-run). */
const MAC_STREAM: Record<string, { decode: Range; prompt: Range; extrapolated?: boolean }> = {
  Q2_0: { decode: r(7.9, 14.1), prompt: r(80, 186) },
  IQ3_XXS: { decode: r(7.7, 10.0), prompt: r(62.5, 89) },
  IQ3_S: { decode: r(6.6, 8.6), prompt: r(54, 77), extrapolated: true },
};
/** MODELS.md "Will it fit?": experts per size (GB); RAM need = experts + 10. Unsloth: "RAM for all of them in RAM". */
const PC_RAM: Record<string, Record<string, number>> = {
  qwen: { Q2_0: 44, IQ2_XS: 45.5, IQ3_XXS: 53, IQ3_S: 60 },
  swift: { IQ2_XS: 45.5, IQ3_XXS: 53, IQ3_S: 60 },
  coder: { IQ1_M: 33 },
  unsloth: { 'UD-IQ4_XS': 72, 'UD-Q4_K_XL': 88, 'UD-Q5_K_XL': 108, 'UD-Q6_K_XL': 118, Q8_0: 136 },
  qwen36: { 'UD-Q4_K_XL': 32, 'UD-Q6_K_XL': 44, Q8_0: 52 },
};
interface PcRef { basis: PerformanceBasis; vram: number; decode: Range; prompt: Range; bound?: 'lower'; inferredFrom?: string; source?: string }
/** MODELS.md RTX 5070 12 GB + 64 GB (short chat / 128K context; 4K prompt 910-1,580 tok/s). */
const RTX5070: Record<string, PcRef> = Object.fromEntries(Object.entries({ Q2_0: [76, 94], IQ2_XS: [63, 79], IQ3_XXS: [49, 62], IQ3_S: [46, 53], IQ1_M: [43, 55] })
  .map(([quant, [low, high]]) => [quant, { basis: 'pcRtx5070' as const, vram: 12, decode: r(low!, high!), prompt: r(910, 1580) }]));
/**
 * RTX 4090 24 GB, Strata 0.1.38, one card (bench/results 2026-10-03-community-rtx4090-iq3{s-140k,xxs-200k}-{code,ru}):
 * decode medians at 4K / 32K / 128K prompts, IQ3_S 76.1-102.5 (code and Russian prose), IQ3_XXS 108.4-127.9 (code);
 * 4K prompt 1,844-2,084 tok/s.
 */
const RTX4090: Record<string, PcRef> = {
  IQ3_XXS: { basis: 'pcRtx4090', vram: 24, decode: r(108, 128), prompt: r(1844, 1880) },
  IQ3_S: { basis: 'pcRtx4090', vram: 24, decode: r(76, 102), prompt: r(2058, 2084) },
};
/**
 * 32 GB NVIDIA other than an RTX 5090, IQ3_S: the modified RTX 4080 SUPER 32 GB + 64 GB rows of the Strata Arena
 * leaderboard (decode 84.9-97.9 at 4K-128K prompts, 262K / 512K context; prefill 2,174-2,401 tok/s) and the upstream
 * RTX 4080 SUPER 32 GB run (bench/results 2026-10-04-community-rtx-4080s-iq3s: decode 85.3-103.9, engine 0.1.38/0.1.39).
 * A range, not a floor: the 5090 has its own table below.
 */
const NVIDIA32: Record<string, PcRef> = {
  IQ3_S: { basis: 'pcNvidia32', vram: 32, decode: r(85, 104), prompt: r(2174, 2401) },
};
/**
 * Desktop RTX 5090 32 GB, one card, decode medians at 4K-262K prompts and the 4K prompt rate:
 * IQ3_S 127.2-170.5, 4K prompt 2,473-3,072 (bench/results 2026-10-02-community-rtx-5090-iq3s, 2026-10-05-community-
 * rtx-5090-9700x-iq3s); IQ3_XXS 171.7-181.2, 4K 3,775 (2026-10-04-community-rtx-5090-9700x); IQ2_XS 165.0-179.4,
 * 4K 4,270 (2026-09-30-community-rtx-5090).
 */
const RTX5090: Record<string, PcRef> = {
  IQ2_XS: { basis: 'pcRtx5090', vram: 32, decode: r(165, 179), prompt: r(4270, 4270) },
  IQ3_XXS: { basis: 'pcRtx5090', vram: 32, decode: r(172, 181), prompt: r(3775, 3775) },
  IQ3_S: { basis: 'pcRtx5090', vram: 32, decode: r(127, 171), prompt: r(2473, 3072) },
};
/**
 * RTX 3060 12 GB + 64 GB DDR4, engine 0.1.41, Windows (bench/results 2026-10-09-community-rtx-3060-0141): decode
 * ranges over the 4K-128K sweep, 4K prompt rate. Its 360 GB/s card runs at about 40% of the RTX 5070 table.
 */
const RTX3060: Record<string, PcRef> = {
  Q2_0: { basis: 'pcRtx3060Bench', vram: 12, decode: r(37, 45), prompt: r(882, 882) },
  IQ2_XS: { basis: 'pcRtx3060Bench', vram: 12, decode: r(38, 46), prompt: r(829, 829) },
  IQ3_XXS: { basis: 'pcRtx3060Bench', vram: 12, decode: r(24, 27), prompt: r(681, 681) },
  IQ3_S: { basis: 'pcRtx3060Bench', vram: 12, decode: r(18, 21), prompt: r(568, 568) },
};
/**
 * RTX 4060 Ti 16 GB (288 GB/s) on a PCIe 3.0 x8 / DDR3 PC (bench/results 2026-10-05-community-e5-2673v3-rtx-4060ti):
 * decode medians on the 0.1.39 path and with the later expert-tier changes, 3,454-token prompt rate.
 */
const RTX4060TI: Record<string, PcRef> = {
  Q2_0: { basis: 'pcRtx4060Ti', vram: 16, decode: r(48, 56), prompt: r(715, 715) },
  IQ3_S: { basis: 'pcRtx4060Ti', vram: 16, decode: r(30, 35), prompt: r(439, 439) },
};
/** Card-specific table by nvidia-smi name; undefined = use the VRAM tiers. */
function namedNvidiaTable(name: string | undefined): Record<string, PcRef> | undefined {
  if (!name) return undefined;
  if (/\bRTX\s*5090\b/i.test(name) && !/laptop|mobile/i.test(name)) return RTX5090;
  if (/\bRTX\s*3060\b/i.test(name)) return RTX3060;
  if (/\bRTX\s*4060\s*Ti\b/i.test(name)) return RTX4060TI;
  return undefined;
}
/** MODELS.md RX 9070 XT 16 GB + 47 GB (32K prompt rate). */
const RX9070XT: Record<string, PcRef> = {
  Q2_0: { basis: 'pcRx9070xt', vram: 16, decode: r(48, 60), prompt: r(1160, 1160) },
  // bench/results 2026-10-02-community-rx9070xt-windows: engine 0.1.35, decode 45.2 short / 45-46 at 4K-32K, 4K prompt 370.
  IQ3_S: { basis: 'pcRx9070xt', vram: 16, decode: r(45, 46), prompt: r(370, 601), source: bench('2026-10-02-community-rx9070xt-windows') },
  IQ2_XS: { basis: 'pcRx9070xt', vram: 16, decode: r(36, 52), prompt: r(1110, 1110) },
  IQ1_M: { basis: 'pcRx9070xt', vram: 16, decode: r(33, 44), prompt: r(1420, 1420) },
};
/** MODELS.md Unsloth table, AMD R9700 32 GB (story / code, 32K prompt); IQ3_S row for comparison. */
const R9700: Record<string, PcRef> = {
  IQ3_S: { basis: 'pcR9700', vram: 32, decode: r(75, 95), prompt: r(1110, 1320) },
  // bench/results 2026-10-03-community-r9700-windows: engine 0.1.38, decode medians 87.5-99.8 at 4K-248K, 4K prompt 856.
  IQ2_XS: { basis: 'pcR9700', vram: 32, decode: r(88, 100), prompt: r(856, 1232), source: bench('2026-10-03-community-r9700-windows') },
  'UD-Q4_K_XL': { basis: 'pcR9700', vram: 32, decode: r(63, 87), prompt: r(1110, 1320) },
  'UD-Q5_K_XL': { basis: 'pcR9700', vram: 32, decode: r(57, 82), prompt: r(810, 1260) },
  'UD-Q6_K_XL': { basis: 'pcR9700', vram: 32, decode: r(54, 76), prompt: r(1020, 1020) },
  Q8_0: { basis: 'pcR9700', vram: 32, decode: r(53, 74), prompt: r(1230, 1300) },
};
/** MODELS.md / QWEN36.md Qwen3.6 UD-Q4_K_XL: R9700 117.8 (pp4096 6,223), RTX 3060 59.7 (pp2048 2,022). */
const QWEN36: Record<'amd' | 'nvidia', PcRef> = {
  amd: { basis: 'pcR9700', vram: 32, decode: r(117.8, 117.8), prompt: r(6223, 6223) },
  nvidia: { basis: 'pcRtx3060', vram: 12, decode: r(59.7, 59.7), prompt: r(2022, 2022) },
};

/** Qwen-family sizes from smallest to biggest (Unsloth / Coder / Qwen3.6 have their own tables). */
const SIZE_ORDER = ['Q2_0', 'IQ2_XS', 'IQ3_XXS', 'IQ3_S'];
/** The nearest bigger size measured on these references, as this size's lower bound; needs at least the reference VRAM. */
function fromBigger(tables: Record<string, PcRef>[], quant: string, vram: number | undefined): PcRef | undefined {
  const index = SIZE_ORDER.indexOf(quant);
  if (index < 0) return undefined;
  for (const bigger of SIZE_ORDER.slice(index + 1)) for (const table of tables) {
    const ref = table[bigger];
    if (ref && (vram === undefined || vram >= ref.vram - 1)) return { ...ref, bound: 'lower', inferredFrom: bigger };
  }
  return undefined;
}

function pcReference(family: string, quant: string, vendor: PerformanceHardware['gpuVendor'], vram: number | undefined, gpuName?: string): PcRef | undefined {
  if (family === 'qwen36') return quant === 'UD-Q4_K_XL' ? QWEN36[vendor === 'amd' ? 'amd' : 'nvidia'] : undefined;
  if (family === 'unsloth') return R9700[quant];
  if (family === 'qwen' || family === 'swift' || family === 'coder') {
    const v = vram ?? 0;
    if (vendor === 'amd') {
      // The 32 GB tier first (its own run, else its bigger size as a lower bound), then the 16 GB card.
      for (const table of v >= 24 ? [R9700, RX9070XT] : [RX9070XT]) {
        const ref = table[quant] ?? (family === 'coder' ? undefined : fromBigger([table], quant, vram));
        if (ref) return ref;
      }
      return RTX5070[quant];
    }
    if (family === 'coder') return RTX5070[quant];
    const named = namedNvidiaTable(gpuName);
    // A slower named card shows its own runs (or its own bigger size as a lower bound), never a faster card's figure.
    if (named?.[quant]) return named[quant];
    if (named && named !== RTX5090) return fromBigger([named], quant, undefined);
    const big = named ? [named] : v >= 28 ? [NVIDIA32, RTX4090] : v >= 20 ? [RTX4090] : [];
    for (const table of big) if (table[quant]) return table[quant];
    return fromBigger(big, quant, vram) ?? RTX5070[quant];
  }
  return undefined;
}

/** Estimate for one family/quant ("community:<id>" callers pass the entry's install family). */
export function estimatePerformance(family: string, quant: string, hardware: PerformanceHardware): PerformanceEstimate {
  if (hardware.platform === 'macos') {
    if (family !== 'qwen' && family !== 'unsloth') return { mode: 'macUnsupported', basis: 'none', extrapolated: false };
    const memory = MAC_MEMORY[quant];
    if (!memory) return { mode: 'unknown', basis: 'none', extrapolated: false };
    const base = { memoryGB: memory.needs, residentFromGB: memory.residentFrom };
    const total = hardware.memoryGB;
    if (total !== undefined && total < 16) return { mode: 'tooSmall', ...base, basis: 'none', extrapolated: !!memory.extrapolated, source: PERFORMANCE_SOURCES.macMemory };
    if (total === undefined || total >= memory.residentFrom) {
      const resident = MAC_RESIDENT[quant];
      if (!resident) return { mode: 'macResident', ...base, basis: 'none', extrapolated: !!memory.extrapolated, source: PERFORMANCE_SOURCES.macMemory };
      return { mode: 'macResident', ...base, decode: resident.decode, ttft4k: ttft(resident.prompt, resident.prompt), bound: total !== undefined && total < 128 ? 'upper' : undefined, basis: 'macM5Max', extrapolated: !!memory.extrapolated, source: PERFORMANCE_SOURCES.macM5Max };
    }
    const stream = MAC_STREAM[quant];
    if (!stream) return { mode: 'macStreaming', ...base, basis: 'none', extrapolated: !!memory.extrapolated, source: PERFORMANCE_SOURCES.macMemory };
    return { mode: 'macStreaming', ...base, decode: stream.decode, ttft4k: ttft(stream.prompt.low, stream.prompt.high), basis: stream.extrapolated ? 'macStreamExtrapolated' : 'macStream', extrapolated: !!stream.extrapolated || !!memory.extrapolated, source: PERFORMANCE_SOURCES.macStream };
  }
  const ram = PC_RAM[family]?.[quant];
  if (ram === undefined) return { mode: 'unknown', basis: 'none', extrapolated: false };
  if (hardware.memoryGB !== undefined && hardware.memoryGB < ram) return { mode: 'lowRam', memoryGB: ram, basis: 'none', extrapolated: false, source: PERFORMANCE_SOURCES.pcFit };
  const ref = pcReference(family, quant, hardware.gpuVendor, hardware.vramGB, hardware.gpuVendor === 'amd' ? undefined : hardware.gpuName);
  if (!ref) return { mode: 'gpu', memoryGB: ram, basis: 'none', extrapolated: false, source: PERFORMANCE_SOURCES.pcFit };
  const vram = hardware.vramGB;
  const bound = vram === undefined ? undefined : vram < ref.vram - 1 ? 'upper' : vram > ref.vram + 1 || ref.bound === 'lower' ? 'lower' : undefined;
  const source = ref.basis === 'pcR9700' ? (family === 'qwen36' ? PERFORMANCE_SOURCES.qwen36 : PERFORMANCE_SOURCES.pcR9700) : ref.basis === 'pcRtx3060' ? PERFORMANCE_SOURCES.qwen36
    : ref.basis === 'pcRtx4090' || ref.basis === 'pcNvidia32' || ref.basis === 'pcRtx5090' || ref.basis === 'pcRtx3060Bench' || ref.basis === 'pcRtx4060Ti' ? PERFORMANCE_SOURCES[ref.basis]
    : PERFORMANCE_SOURCES.pcRtx5070;
  return { mode: 'gpu', memoryGB: ram, decode: ref.decode, ttft4k: ttft(ref.prompt.low, ref.prompt.high), bound, referenceVramGB: ref.vram, basis: ref.basis, extrapolated: false, ...(ref.inferredFrom ? { inferredFrom: ref.inferredFrom } : {}), source: ref.source ?? source };
}

/** "≈ 8–14" / "≤ 120" / "≥ 60" (rounded, no false precision). */
export function formatRange(range: Range | undefined, bound?: 'upper' | 'lower', digits = 0): string | undefined {
  if (!range) return undefined;
  const fmt = (value: number) => value >= 10 || digits === 0 ? String(Math.round(value)) : value.toFixed(digits);
  if (bound === 'upper') return `≤ ${fmt(range.high)}`;
  if (bound === 'lower') return `≥ ${fmt(range.low)}`;
  return fmt(range.low) === fmt(range.high) ? `≈ ${fmt(range.low)}` : `${fmt(range.low)}–${fmt(range.high)}`;
}
