import { describe, expect, it } from 'vitest';
import { defaultGpuCards, defaultGpuSet, gpuSetName, isIntegratedGpuName, normalizeMetrics } from '../src';

const GiB = 1024 ** 3;

describe('integrated GPU names (same list as crates/runtime-core/src/igpu.rs)', () => {
  it.each([
    'AMD Radeon(TM) Graphics', 'AMD Radeon Graphics', 'AMD Radeon 780M Graphics', 'AMD Radeon(TM) 760M', 'AMD Radeon 890M',
    'AMD Radeon 680M', 'AMD Radeon(TM) 8060S Graphics', 'AMD Radeon(TM) Vega 8 Graphics', 'Intel(R) UHD Graphics 770',
    'Intel(R) Iris(R) Xe Graphics', 'Intel(R) HD Graphics 630', 'Intel(R) Graphics', 'Intel(R) Arc(TM) Graphics',
    'Intel(R) Arc(TM) 140V GPU (16GB)', 'Intel(R) Arc(TM) 130T GPU',
  ])('%s is integrated', name => expect(isIntegratedGpuName(name)).toBe(true));
  it.each([
    'NVIDIA GeForce RTX 4090', 'AMD Radeon RX 7900 XTX', 'AMD Radeon PRO W7900', 'AMD Radeon RX 6800M', 'AMD Instinct MI300X',
    'AMD Radeon RX Vega 64', 'Intel(R) Arc(TM) A770 Graphics', 'Intel(R) Arc(TM) B580 Graphics', 'Intel(R) Arc(TM) Pro B60 Graphics',
    'Intel(R) Data Center GPU Max 1550', 'Apple M4 Max',
  ])('%s is not integrated', name => expect(isIntegratedGpuName(name)).toBe(false));
});

describe('defaultGpuSet (upstream v0.2.6 59599f69)', () => {
  const rtx = { name: 'NVIDIA GeForce RTX 5070 Laptop GPU', memTotal: 11.9 * GiB };
  const igpu = { name: 'AMD Radeon(TM) Graphics', memTotal: 0.5 * GiB };
  it('drops a small iGPU beside a real card', () => {
    expect(defaultGpuSet([rtx, igpu])).toEqual([rtx]);
    expect(defaultGpuSet([{ name: 'NVIDIA GeForce RTX 4090' }, { name: 'Intel(R) UHD Graphics 770' }])).toHaveLength(1);
    expect(defaultGpuSet([{ name: 'AMD Radeon RX 7900 XTX', memTotal: 24 * GiB }, igpu])).toHaveLength(1);
  });
  it('keeps an iGPU-only machine, unified memory and larger carve-outs', () => {
    expect(defaultGpuSet([igpu])).toEqual([igpu]);
    expect(defaultGpuSet([rtx, { name: 'AMD Radeon(TM) 8060S Graphics', memTotal: 96 * GiB, unified: true }])).toHaveLength(2);
    expect(defaultGpuSet([rtx, { name: 'AMD Radeon 780M Graphics', memTotal: 4 * GiB }])).toHaveLength(2);
    expect(defaultGpuSet([{ name: 'AMD Radeon RX 550', memTotal: 2 * GiB }, igpu])).toHaveLength(2);
  });
  it('honors the manager flag but never empties the set', () => {
    expect(defaultGpuSet([{ name: 'A', integrated: true }, { name: 'B' }]).map(g => g.name)).toEqual(['B']);
    expect(defaultGpuSet([{ name: 'A', integrated: true }])).toHaveLength(1);
  });
});

describe('All GPU totals leave the iGPU out', () => {
  const raw = {
    hardware: { gpus: [
      { index: 0, name: 'NVIDIA GeForce RTX 5070 Laptop GPU', util: 60, mem_used: 6 * GiB, mem_total: 12 * GiB, temp: 66, power: 90 },
      { index: 1, name: 'AMD Radeon(TM) Graphics', util: 4, mem_used: 0.3 * GiB, mem_total: 0.5 * GiB, temp: 80, power: 6 },
    ] },
    hardware_static: { gpu_name: 'NVIDIA GeForce RTX 5070 Laptop GPU + AMD Radeon(TM) Graphics' },
  };
  it('per-card fallback (floating monitor, overview totals)', () => {
    const m = normalizeMetrics(raw);
    expect(m.gpuMemoryTotal).toBe(12 * GiB);
    expect(m.gpuMemoryUsed).toBe(6 * GiB);
    expect(m.gpuUtil).toBe(60);
    expect(m.gpuTemperature).toBe(66);
    expect(m.gpuPower).toBe(90);
  });
  it('card list keeps the iGPU, the All set and count do not', () => {
    expect(defaultGpuCards(raw).map(c => c.index)).toEqual([0]);
    expect(gpuSetName(raw)).toBe('NVIDIA GeForce RTX 5070 Laptop GPU');
    const flagged = { hardware: { gpu_mem_total: 24 * GiB, gpus: [{ index: 0, mem_total: 24 * GiB }, { index: 1, mem_total: 0.5 * GiB, integrated: true }] } };
    expect(defaultGpuCards(flagged).map(c => c.index)).toEqual([0]);
  });
  it('aggregates the engine or the manager computed are kept', () => {
    expect(normalizeMetrics({ hardware: { ...raw.hardware, gpu_mem_total: 99 } }).gpuMemoryTotal).toBe(99);
  });
});
