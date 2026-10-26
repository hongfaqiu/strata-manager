/**
 * Integrated GPUs and the monitor's default ("All GPUs") set — upstream v0.2.6 `defaultGpuSet` (59599f69).
 * Same rule as crates/runtime-core/src/igpu.rs; keep the two in step.
 *
 * - A *real* card has 4 GB or more of VRAM, or is NVIDIA.
 * - A *small integrated* GPU is AMD or Intel, has under 2 GB of its own memory (size unknown: an integrated-GPU
 *   name), and no unified memory.
 * - When a real card is present, small integrated GPUs leave the default set; an iGPU-only machine keeps them.
 */
export type GpuVendor = 'nvidia' | 'amd' | 'intel' | 'apple';

export function gpuVendorOf(name: unknown): GpuVendor | null {
  const n = typeof name === 'string' ? name.toLowerCase() : '';
  if (/nvidia|geforce|quadro|tesla/.test(n)) return 'nvidia';
  if (/\bamd\b|radeon|instinct/.test(n)) return 'amd';
  if (/intel|iris|uhd graphics/.test(n)) return 'intel';
  if (/^apple\b/.test(n.trim())) return 'apple';
  return null;
}

/**
 * Names AMD and Intel give integrated GPUs: "AMD Radeon(TM) Graphics", "Radeon 760M/780M/890M", "Radeon 8060S",
 * "Vega 8", "Intel(R) UHD/Iris/HD Graphics", "Intel(R) Graphics", "Intel(R) Arc(TM) Graphics", "Arc 140V/130T".
 * Discrete Radeon RX/PRO/Instinct and Intel Arc A/B/Pro cards are not matched.
 */
export function isIntegratedGpuName(name: unknown): boolean {
  if (typeof name !== 'string') return false;
  const n = name.toLowerCase().replace(/\(tm\)|\(r\)/g, '');
  const words = n.split(/[^a-z0-9]+/).filter(Boolean);
  const has = (w: string) => words.includes(w);
  const after = (w: string) => words[words.indexOf(w) + 1];
  if (has('integrated') || has('uhd') || has('iris') || /\bvega [3678]\b/.test(n)) return true;
  if (has('radeon')) {
    const next = after('radeon');
    return next === 'graphics' || /^\d{3,4}[ms]$/.test(next ?? '');
  }
  if (has('arc')) {
    const next = after('arc');
    return next === undefined || next === 'graphics' || /^\d{3,4}[vt]$/.test(next);
  }
  if (has('intel')) return has('graphics') && !has('data') && !has('max') && !has('flex');
  return false;
}

export interface GpuFacts {
  name?: string | null;
  vendor?: string | null;
  /** Own memory in bytes, when known. */
  memTotal?: number | null;
  unified?: boolean;
  /** The manager already marked this card as an integrated GPU outside the All totals. */
  integrated?: boolean;
}
const GIB = 1024 ** 3;
const vramGb = (g: GpuFacts) => typeof g.memTotal === 'number' && Number.isFinite(g.memTotal) && g.memTotal > 0 ? g.memTotal / GIB : null;
const vendorOf = (g: GpuFacts) => (g.vendor ?? gpuVendorOf(g.name))?.toLowerCase() ?? null;

export function isRealGpu(g: GpuFacts): boolean {
  return (vramGb(g) ?? 0) >= 4 || vendorOf(g) === 'nvidia';
}
export function isSmallIntegratedGpu(g: GpuFacts): boolean {
  if (g.unified || !['amd', 'intel'].includes(vendorOf(g) ?? '')) return false;
  const gb = vramGb(g);
  return gb === null ? isIntegratedGpuName(g.name) : gb < 2;
}

/** The cards the "All GPUs" totals and count cover; never empty when `gpus` is not. */
export function defaultGpuSet<T extends GpuFacts>(gpus: readonly T[]): T[] {
  const flagged = gpus.filter(g => !g.integrated);
  const base = flagged.length ? flagged : [...gpus];
  if (!base.some(isRealGpu)) return base;
  const kept = base.filter(g => !isSmallIntegratedGpu(g));
  return kept.length ? kept : base;
}
