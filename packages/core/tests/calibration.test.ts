import { describe, expect, it } from 'vitest';
import { applyCalibrationSettings, calibratedConfigName, calibrationConfigChanged, calibrationHasChange, calibrationProgress, restartCandidatesFromCalibration, sweepPoints, type CalibrationStep } from '../src';

const config = { exe: 'engine/strata.exe', args: ['--native', 'model.gguf', '--pcie-frac', '0.55', '--api-key-env', 'KEY', '--unknown', 'x'], port: 8080 };

describe('quick calibration helpers', () => {
  it('replaces and appends only calibration flags, keeping every other arg', () => {
    const next = applyCalibrationSettings(config, { '--pcie-frac': '0.35', '--spec-min-p': '0.70' }, 'hip');
    expect(next.args).toEqual(['--native', 'model.gguf', '--pcie-frac', '0.35', '--api-key-env', 'KEY', '--unknown', 'x', '--spec-min-p', '0.70']);
    expect(next.port).toBe(8080);
    expect(config.args[3]).toBe('0.55');
    expect(applyCalibrationSettings(config, { '--pcie-frac': null }, 'cuda').args).toEqual(['--native', 'model.gguf', '--api-key-env', 'KEY', '--unknown', 'x']);
    expect((applyCalibrationSettings(config, { '--prefill-pipe': '1536' }, 'cuda').args as string[]).slice(-2)).toEqual(['--prefill-pipe', '1536']);
  });
  it('never writes pcie_frac 0 off a confirmed NVIDIA GPU', () => {
    for (const backend of ['hip', 'sycl', 'unknown'] as const) expect(() => applyCalibrationSettings(config, { '--pcie-frac': '0' }, backend)).toThrow(/NVIDIA/);
    expect(applyCalibrationSettings(config, { '--pcie-frac': '0' }, 'cuda').args).toContain('0');
  });
  it('rejects unknown flags, out-of-range values and duplicated flags', () => {
    expect(() => applyCalibrationSettings(config, { '--pool-workers': '4' }, 'cuda')).toThrow();
    expect(() => applyCalibrationSettings(config, { '--spec-min-p': '1.5' }, 'cuda')).toThrow();
    expect(() => applyCalibrationSettings(config, { '--prefill-pipe': '1.5' }, 'cuda')).toThrow();
    expect(() => applyCalibrationSettings({ ...config, args: ['--pcie-frac', '0.2', '--pcie-frac', '0.3'] }, { '--pcie-frac': '0.35' }, 'cuda')).toThrow(/more than once/);
  });
  it('names new config versions next to the current file without stacking suffixes', () => {
    const at = new Date(2026, 9, 17, 9, 5);
    expect(calibratedConfigName('D:\\AI\\Strata\\strata-qwen.json', at)).toBe('strata-qwen-calibrated-20261017-0905.json');
    expect(calibratedConfigName('/x/strata-qwen-calibrated-20261001-1200.json', at)).toBe('strata-qwen-calibrated-20261017-0905.json');
  });
  it('turns sweep samples into one point per value with whiskers, current and chosen marks', () => {
    const step: CalibrationStep = { kind: 'pcieFrac', status: 'done', metric: 'decode', values: [0.2, 0.35, 0.55], currentValue: 0.55, rounds: 2, requests: 18, chosen: 0.35, best: 0.35,
      samples: [{ value: 0.35, round: 0, rate: 120 }, { value: 0.35, round: 1, rate: 118 }, { value: 0.55, round: 0, rate: 100 }], excluded: [{ value: 0, reason: 'amdPcieZero' }] };
    const points = sweepPoints(step);
    expect(points.map(p => p.value)).toEqual([0, 0.2, 0.35, 0.55]);
    expect(points[0]).toMatchObject({ excluded: true, samples: 0, median: null });
    expect(points[2]).toMatchObject({ median: 119, min: 118, max: 120, chosen: true, current: false });
    expect(points[3]).toMatchObject({ current: true, median: 100 });
  });
  it('reports real progress and never exceeds the total', () => {
    expect(calibrationProgress({ completedRequests: 10, totalRequests: 40 })).toEqual({ done: 10, total: 40, fraction: 0.25 });
    expect(calibrationProgress({ completedRequests: 10, totalRequests: 40 }, { completedUnits: 12, totalUnits: 40 }).done).toBe(12);
    expect(calibrationProgress({ completedRequests: 0, totalRequests: 0 }).fraction).toBe(0);
  });
  it('limits restart suggestions to four and recommends only a completed change', () => {
    expect(restartCandidatesFromCalibration({ restartSuggestions: [{ poolWorkers: 4 }, { poolWorkers: 6 }, { adaptEvery: 1 }, { adaptSwaps: 160 }, { poolWorkers: 2 }] })).toHaveLength(4);
    expect(calibrationHasChange({ state: 'completed', settings: {} })).toBe(false);
    expect(calibrationHasChange({ state: 'completed', settings: { '--pcie-frac': '0.35' } })).toBe(true);
    expect(calibrationHasChange({ state: 'running', settings: { '--pcie-frac': '0.35' } })).toBe(false);
  });
  it('flags a config edited since calibration started without blocking a missing fingerprint', () => {
    const fp = 'a'.repeat(64);
    expect(calibrationConfigChanged({ configFingerprint: fp }, fp)).toBe(false);
    expect(calibrationConfigChanged({ configFingerprint: fp }, fp.toUpperCase())).toBe(false);
    expect(calibrationConfigChanged({ configFingerprint: fp }, 'b'.repeat(64))).toBe(true);
    expect(calibrationConfigChanged({ configFingerprint: '' }, 'b'.repeat(64))).toBe(false);
    expect(calibrationConfigChanged(null, 'b'.repeat(64))).toBe(false);
  });
  it('writes --prefill-pipe as an integer within the upstream range', () => {
    expect(applyCalibrationSettings({ args: [] }, { '--prefill-pipe': '1536' }, 'hip').args).toEqual(['--prefill-pipe', '1536']);
    expect(() => applyCalibrationSettings({ args: [] }, { '--prefill-pipe': '262145' }, 'hip')).toThrow();
  });
});
