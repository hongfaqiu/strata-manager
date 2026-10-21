import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { gpuCards, gpuSetName } from '../src/gpu-summary';
import { gpuFieldUnavailable, gpuTelemetryDetails, normalizeMetrics } from '../src/metrics';

// Shape of a Windows RX 7900 XTX /metrics response after the manager filled it from ADLX.
const fixture = JSON.parse(readFileSync(new URL('./fixtures/amd-adlx-metrics.json', import.meta.url), 'utf8'));

describe('AMD GPU telemetry filled by the manager (#86)', () => {
  it('reads the standard GPU fields like an NVIDIA reading', () => {
    const metric = normalizeMetrics(fixture);
    expect(metric).toMatchObject({ gpuUtil: 87, gpuMemoryUsed: 21474836480, gpuMemoryTotal: 25769803776, gpuTemperature: 64, gpuPower: 312 });
    expect(gpuCards(fixture)).toEqual([{ index: 0, name: 'AMD Radeon RX 7900 XTX', memUsed: 21474836480, memTotal: 25769803776, util: 87, temp: 64, power: 312 }]);
    expect(gpuSetName(fixture)).toBe('AMD Radeon RX 7900 XTX');
  });

  it('exposes the AMD-only extras and their source', () => {
    expect(gpuTelemetryDetails(fixture)).toEqual({ source: 'amd-adlx', clockMhz: 2500, memClockMhz: 1250, hotspotTemp: 79, fanRpm: 1450 });
    expect(gpuTelemetryDetails({ hardware_static: { gpu_telemetry_source: 'amdgpu-sysfs' } }).source).toBe('amdgpu-sysfs');
  });

  it('labels a field the AMD driver lacks, and leaves other GPUs unchanged', () => {
    const sparse = { hardware: { gpu_util: 5 }, hardware_static: { gpu_telemetry_source: 'amd-adlx' } };
    const details = gpuTelemetryDetails(sparse);
    expect(details).toEqual({ source: 'amd-adlx', clockMhz: null, memClockMhz: null, hotspotTemp: null, fanRpm: null });
    expect(gpuFieldUnavailable(details, true)).toBe('AMD 驱动未提供此项');
    expect(gpuFieldUnavailable(details, false)).toBe('not reported by the AMD driver');
    const nvidia = gpuTelemetryDetails({ hardware: { gpu_util: 50 }, hardware_static: { gpu_name: 'NVIDIA GeForce RTX 4090' } });
    expect(nvidia.source).toBeNull();
    expect(gpuFieldUnavailable(nvidia, true)).toBe('');
    expect(gpuTelemetryDetails({ hardware_static: { gpu_telemetry_source: 'something-else' } }).source).toBeNull();
    expect(gpuTelemetryDetails(null).source).toBeNull();
  });
});
