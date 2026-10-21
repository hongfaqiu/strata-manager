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
  it('formats ranges without false precision', () => {
    expect(formatRange({ low: 7.9, high: 14.1 })).toBe('8–14');
    expect(formatRange({ low: 2.6, high: 4.5 }, undefined, 1)).toBe('2.6–4.5');
    expect(formatRange({ low: 60, high: 60 })).toBe('≈ 60');
    expect(formatRange({ low: 60, high: 80 }, 'lower')).toBe('≥ 60');
  });
});
