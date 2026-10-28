import { describe, expect, it } from 'vitest';
import { estimatePerformance, formatRange } from '../src/model-performance';

describe('performance estimates (doc-referenced, labelled 估算)', () => {
  it('Mac 48 GB streams the experts from the SSD: slower, with the M4/M1 Max figures', () => {
    const q2 = estimatePerformance('qwen', 'Q2_0', { platform: 'macos', memoryGB: 48 });
    expect(q2).toMatchObject({ mode: 'macStreaming', basis: 'macStream', memoryGB: 46, residentFromGB: 64 });
    expect(q2.decode).toEqual({ low: 7.9, high: 14.1 });
    const s = estimatePerformance('qwen', 'IQ3_S', { platform: 'macos', memoryGB: 48 });
    expect(s).toMatchObject({ mode: 'macStreaming', extrapolated: true, basis: 'macStreamExtrapolated' });
  });
  it('Mac with enough memory is resident and bounded by the M5 Max 128 GB measurement', () => {
    const e = estimatePerformance('qwen', 'Q2_0', { platform: 'macos', memoryGB: 64 });
    expect(e).toMatchObject({ mode: 'macResident', basis: 'macM5Max', bound: 'upper' });
    expect(formatRange(e.decode, e.bound)).toBe('≤ 120');
    expect(estimatePerformance('swift', 'IQ3_S', { platform: 'macos', memoryGB: 128 }).mode).toBe('macUnsupported');
  });
  it('PC: RAM rule first, then the closest published GPU reference', () => {
    expect(estimatePerformance('qwen', 'IQ3_S', { platform: 'windows', memoryGB: 32, vramGB: 12, gpuVendor: 'nvidia' })).toMatchObject({ mode: 'lowRam', memoryGB: 60 });
    const nv = estimatePerformance('qwen', 'Q2_0', { platform: 'windows', memoryGB: 64, vramGB: 12, gpuVendor: 'nvidia' });
    expect(nv).toMatchObject({ mode: 'gpu', basis: 'pcRtx5070', referenceVramGB: 12, bound: undefined });
    expect(formatRange(nv.decode)).toBe('76–94');
    expect(nv.ttft4k).toEqual({ low: 2.6, high: 4.5 });
    expect(estimatePerformance('qwen', 'Q2_0', { platform: 'windows', memoryGB: 64, vramGB: 8, gpuVendor: 'nvidia' }).bound).toBe('upper');
    expect(estimatePerformance('qwen', 'IQ3_S', { platform: 'linux', memoryGB: 96, vramGB: 32, gpuVendor: 'amd' }).basis).toBe('pcR9700');
    expect(estimatePerformance('qwen36', 'UD-Q6_K_XL', { platform: 'windows', memoryGB: 64 })).toMatchObject({ mode: 'gpu', basis: 'none' });
  });
  it('NVIDIA: the reference follows the VRAM tier, never above what a slower card of that tier measured', () => {
    const pc = (vramGB: number, quant = 'IQ3_S', memoryGB = 63.7) => estimatePerformance('qwen', quant, { platform: 'windows', memoryGB, vramGB, gpuVendor: 'nvidia' });
    // Feedback: modified RTX 4080 SUPER 32 GB + 64 GB measures ~95-100 tok/s (leaderboard 85-98, upstream 85-104);
    // v0.2.28 said "≥ 85". A range now: the RTX 5090 has its own table (by name, below).
    const big = pc(32);
    expect(big).toMatchObject({ mode: 'gpu', basis: 'pcNvidia32', referenceVramGB: 32, bound: undefined, memoryGB: 60 });
    expect(formatRange(big.decode, big.bound)).toBe('85–104');
    expect(big.source).toContain('leaderboard');
    expect(formatRange(pc(31.8).decode, pc(31.8).bound)).toBe('85–104');
    // RTX 4090 24 GB: the 4090 community runs (76-102), no bound.
    const r4090 = pc(24);
    expect(r4090).toMatchObject({ basis: 'pcRtx4090', bound: undefined });
    expect(formatRange(r4090.decode, r4090.bound)).toBe('76–102');
    expect(formatRange(pc(24, 'IQ3_XXS').decode)).toBe('108–128');
    // A 32 GB card without a 32 GB run of this size: the 24 GB figure as a lower bound.
    expect(pc(32, 'IQ3_XXS')).toMatchObject({ basis: 'pcRtx4090', bound: 'lower' });
    // A 20 GB card sits below the 24 GB reference: an upper bound.
    expect(pc(20)).toMatchObject({ basis: 'pcRtx4090', bound: 'upper' });
    // 12 GB (RTX 3060 / 5070) and 16 GB keep the RTX 5070 table: nothing gets faster than before.
    const small = pc(12);
    expect(small).toMatchObject({ basis: 'pcRtx5070', bound: undefined });
    expect(formatRange(small.decode)).toBe('46–53');
    expect(pc(16)).toMatchObject({ basis: 'pcRtx5070', bound: 'lower' });
    // No 24 / 32 GB run of the 2-bit sizes or the Coder: the RTX 5070 lower bound, as before.
    expect(pc(32, 'Q2_0')).toMatchObject({ basis: 'pcRtx5070', bound: 'lower' });
    expect(estimatePerformance('coder', 'IQ1_M', { platform: 'windows', memoryGB: 64, vramGB: 32, gpuVendor: 'nvidia' }).basis).toBe('pcRtx5070');
    // RAM still comes first; AMD and Mac are unchanged.
    expect(pc(32, 'IQ3_S', 48).mode).toBe('lowRam');
    expect(estimatePerformance('qwen', 'IQ3_S', { platform: 'linux', memoryGB: 96, vramGB: 32, gpuVendor: 'amd' })).toMatchObject({ basis: 'pcR9700', bound: undefined });
    expect(estimatePerformance('qwen', 'IQ3_S', { platform: 'macos', memoryGB: 128 })).toMatchObject({ basis: 'macM5Max', bound: undefined });
  });
  it('NVIDIA: a few card names pick their own measured table (memory bandwidth differs within a VRAM tier)', () => {
    const pc = (gpuName: string, vramGB: number, quant = 'IQ3_S', family = 'qwen') => estimatePerformance(family, quant, { platform: 'windows', memoryGB: 64, vramGB, gpuVendor: 'nvidia', gpuName });
    const range = (estimate: ReturnType<typeof pc>) => formatRange(estimate.decode, estimate.bound);
    // RTX 5090 desktop: measured 127-171 on IQ3_S, well above the 4080 SUPER 32 GB.
    expect(pc('NVIDIA GeForce RTX 5090', 32)).toMatchObject({ basis: 'pcRtx5090', bound: undefined, referenceVramGB: 32 });
    expect(range(pc('NVIDIA GeForce RTX 5090', 32))).toBe('127–171');
    expect(pc('NVIDIA GeForce RTX 5090', 32).source).toContain('rtx-5090');
    expect(range(pc('NVIDIA GeForce RTX 5090', 32, 'IQ3_XXS'))).toBe('172–181');
    expect(range(pc('NVIDIA GeForce RTX 5090', 32, 'IQ2_XS'))).toBe('165–179');
    // No 5090 run of Q2_0: falls back to the VRAM tiers as a lower bound.
    expect(pc('NVIDIA GeForce RTX 5090', 32, 'Q2_0')).toMatchObject({ basis: 'pcRtx5070', bound: 'lower' });
    // The 24 GB laptop 5090 is not the desktop card: VRAM tiers.
    expect(pc('NVIDIA GeForce RTX 5090 Laptop GPU', 24).basis).toBe('pcRtx4090');
    // A 4080 SUPER (modified 32 GB) keeps the 32 GB range.
    expect(range(pc('NVIDIA GeForce RTX 4080 SUPER', 32))).toBe('85–104');
    // RTX 3060 12 GB: measured 18-21 on IQ3_S where the RTX 5070 table said 46-53.
    expect(pc('NVIDIA GeForce RTX 3060', 12)).toMatchObject({ basis: 'pcRtx3060Bench', bound: undefined });
    expect(range(pc('NVIDIA GeForce RTX 3060', 12))).toBe('18–21');
    expect(range(pc('NVIDIA GeForce RTX 3060', 12, 'Q2_0'))).toBe('37–45');
    expect(range(pc('NVIDIA GeForce RTX 3060', 12, 'IQ3_XXS'))).toBe('24–27');
    expect(pc('NVIDIA GeForce RTX 3060', 12).source).toContain('rtx-3060');
    // RTX 4060 Ti 16 GB: 30-35 on IQ3_S; a size it was not measured on shows no figure, not the 5070's.
    expect(range(pc('NVIDIA GeForce RTX 4060 Ti', 16))).toBe('30–35');
    expect(pc('NVIDIA GeForce RTX 4060 Ti', 16, 'IQ2_XS')).toMatchObject({ mode: 'gpu', basis: 'none' });
    expect(pc('NVIDIA GeForce RTX 4060 Ti', 16, 'IQ2_XS').decode).toBeUndefined();
    // Other names (RTX 5070, 5060 Ti, 4070 Ti SUPER ...) keep the VRAM tiers; Coder and AMD ignore the name.
    expect(pc('NVIDIA GeForce RTX 5070', 12)).toMatchObject({ basis: 'pcRtx5070', bound: undefined });
    expect(pc('NVIDIA GeForce RTX 5060 Ti', 16)).toMatchObject({ basis: 'pcRtx5070', bound: 'lower' });
    expect(pc('NVIDIA GeForce RTX 3060', 12, 'IQ1_M', 'coder').basis).toBe('pcRtx5070');
    expect(estimatePerformance('qwen', 'IQ3_S', { platform: 'linux', memoryGB: 96, vramGB: 32, gpuVendor: 'amd', gpuName: 'RTX 5090' }).basis).toBe('pcR9700');
  });
  it('formats ranges without false precision', () => {
    expect(formatRange({ low: 7.9, high: 14.1 })).toBe('8–14');
    expect(formatRange({ low: 2.6, high: 4.5 }, undefined, 1)).toBe('2.6–4.5');
    expect(formatRange({ low: 60, high: 60 })).toBe('≈ 60');
    expect(formatRange({ low: 60, high: 80 }, 'lower')).toBe('≥ 60');
  });
});
