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
    // Feedback: modified RTX 4080 SUPER 32 GB + 64 GB measured ~100 tok/s (leaderboard 85-94), Manager said "≥ 46".
    const big = pc(32);
    expect(big).toMatchObject({ mode: 'gpu', basis: 'pcNvidia32', referenceVramGB: 32, bound: 'lower', memoryGB: 60 });
    expect(formatRange(big.decode, big.bound)).toBe('≥ 85');
    expect(big.source).toContain('leaderboard');
    // RTX 5090 32 GB: measured 127-170, the lower bound stays honest.
    expect(formatRange(pc(31.8).decode, pc(31.8).bound)).toBe('≥ 85');
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
  it('formats ranges without false precision', () => {
    expect(formatRange({ low: 7.9, high: 14.1 })).toBe('8–14');
    expect(formatRange({ low: 2.6, high: 4.5 }, undefined, 1)).toBe('2.6–4.5');
    expect(formatRange({ low: 60, high: 60 })).toBe('≈ 60');
    expect(formatRange({ low: 60, high: 80 }, 'lower')).toBe('≥ 60');
  });
});
