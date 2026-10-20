import { describe, expect, it } from 'vitest';
import { gpuCards, gpuSetName, gpuSummary, isUnifiedGpuName, splitGpuNames, unifiedGpu } from '../src/gpu-summary';

const GiB = 1024 ** 3;
// Xiaohongshu report: two 22 GB RTX 2080 Ti cards, upstream joins their names with " + ".
const dual = {
  hardware_static: { gpu_name: 'NVIDIA GeForce RTX 2080 Ti + NVIDIA GeForce RTX 2080 Ti', gpu_count: 2 },
  hardware: { gpu_mem_used: 38.4 * GiB, gpu_mem_total: 44 * GiB, gpus: [
    { index: 0, util: 52, mem_used: 19.6 * GiB, mem_total: 22 * GiB, temp: 61, power: 120 },
    { index: 1, util: 47, mem_used: 18.8 * GiB, mem_total: 22 * GiB, temp: 58, power: 113 },
  ] },
};

describe('multi-GPU naming', () => {
  it('collapses identical cards into one counted name instead of repeating it', () => {
    expect(gpuSetName(dual)).toBe('2× NVIDIA GeForce RTX 2080 Ti');
    expect(gpuSummary(['A', 'B', 'B'])).toBe('A + 2× B');
    expect(gpuSummary(['RTX 4090', 'RTX 3090'])).toBe('RTX 4090 + RTX 3090');
    expect(gpuSummary(['RTX 4090'])).toBe('RTX 4090');
  });
  it('keeps every card with its own VRAM, load and temperature', () => {
    const cards = gpuCards(dual);
    expect(cards).toHaveLength(2);
    expect(cards.map(card => card.name)).toEqual(['NVIDIA GeForce RTX 2080 Ti', 'NVIDIA GeForce RTX 2080 Ti']);
    expect(cards[1]).toMatchObject({ index: 1, util: 47, memTotal: 22 * GiB, temp: 58 });
  });
  it('handles single cards, missing per-card data and odd names', () => {
    expect(gpuSetName({ hardware_static: { gpu_name: 'RTX 4090' }, hardware: {} })).toBe('RTX 4090');
    expect(gpuSetName({ hardware_static: { gpu_name: 'RTX 4090' }, hardware: { gpus: [{ index: 0 }, { index: 1 }] } })).toBe('2× RTX 4090');
    expect(gpuSetName({})).toBeNull();
    expect(splitGpuNames(' A +  + B ')).toEqual(['A', 'B']);
    expect(gpuCards({ hardware_static: { gpu_name: 'A' }, hardware: { gpus: [{}, {}] } }).map(card => card.name)).toEqual([null, null]);
  });
});

describe('Apple Silicon unified GPU', () => {
  const m5 = { name: 'Apple M5 Pro', vendor: 'apple', cores: 20, unifiedMemory: true, memoryBytes: 48 * GiB, gpuBudgetBytes: 36 * GiB, gpuBudgetEstimated: false, metal: 4, source: 'system_profiler' };
  it('is found by vendor and the unified flag, not by a chip list', () => {
    expect(unifiedGpu({ gpuDetails: [m5] })?.name).toBe('Apple M5 Pro');
    expect(unifiedGpu({ gpuDetails: [{ ...m5, name: 'Apple M9 Hyper' }] })?.name).toBe('Apple M9 Hyper');
    expect(unifiedGpu({ gpuDetails: [{ ...m5, vendor: 'amd', unifiedMemory: false, name: 'AMD Radeon Pro 5500M' }] })).toBeUndefined();
    expect(unifiedGpu({})).toBeUndefined();
    expect(unifiedGpu(undefined)).toBeUndefined();
  });
  it('recognizes the upstream telemetry name of a running service', () => {
    expect(isUnifiedGpuName('Apple M5 Pro')).toBe(true);
    expect(isUnifiedGpuName('Apple M1 Max')).toBe(true);
    expect(isUnifiedGpuName('NVIDIA GeForce RTX 4090')).toBe(false);
    expect(isUnifiedGpuName(undefined)).toBe(false);
  });
});
