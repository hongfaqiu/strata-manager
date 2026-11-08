import { describe, expect, it } from 'vitest';
import { applyCalibrationSettings, calibrationEngineOutdated, calibratedConfigName, calibrationConfigChanged, calibrationHasChange, calibrationProgress, mergeUserArgs, restartCandidatesFromCalibration, sweepPoints, type CalibrationStep } from '../src';

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
  it('clears conflicting user_args overrides and refreshes args_written so calibrated values survive server.py merge (U4A)', () => {
    const repro = {
      args: ['--pcie-frac', '0.4'],
      user_args: ['--pcie-frac', '0.4'],
      args_written: ['--pcie-frac', '0.4'],
    };
    const applied = applyCalibrationSettings(repro, { '--pcie-frac': '0.8' }, 'cuda');
    expect(applied.args).toEqual(['--pcie-frac', '0.8']);
    expect(applied.user_args).toBeUndefined();
    expect(applied.args_written).toEqual(['--pcie-frac', '0.8']);
    expect(mergeUserArgs(applied.args as string[], applied.user_args)).toEqual(['--pcie-frac', '0.8']);

    // Keeps unrelated user_args, multi-value flags, repeated flags, and hand edits since args_written.
    const withExtras = {
      args: ['--native', 'm.gguf', '--pcie-frac', '0.4', '--pool-workers', '12'],
      user_args: ['--pcie-frac', '0.4', '--control-vector-layer-range', '4', '44', '--control-vector', 'a.gguf', '--control-vector', 'b.gguf', '--unknown-opt', 'v'],
      args_written: ['--native', 'm.gguf', '--pcie-frac', '0.4', '--pool-workers', '8'],
      args_derived: ['--native', 'm.gguf', '--pcie-frac', '0.4', '--pool-workers', '8'],
      launch_set: ['--pcie-frac', '--pool-workers'],
      calibrated: { settings: { '--pcie-frac': '0.4', '--spec-min-p': '0.50' }, model_name: 'qwen' },
    };
    const next = applyCalibrationSettings(withExtras, { '--pcie-frac': '0.8', '--spec-min-p': null }, 'cuda');
    expect(next.args).toEqual(['--native', 'm.gguf', '--pcie-frac', '0.8', '--pool-workers', '12']);
    expect(next.user_args).toEqual([
      '--control-vector-layer-range', '4', '44',
      '--control-vector', 'a.gguf', '--control-vector', 'b.gguf',
      '--unknown-opt', 'v',
      '--pool-workers', '12',
    ]);
    expect(next.args_written).toEqual(next.args);
    expect(next.args_derived).toEqual(next.args);
    expect(next.launch_set).toEqual(['--pool-workers']);
    expect(next.calibrated).toEqual({ settings: { '--pcie-frac': '0.8' }, model_name: 'qwen' });
    expect(mergeUserArgs(next.args as string[], next.user_args)).toContain('0.8');
    expect(mergeUserArgs(next.args as string[], next.user_args)).not.toContain('0.4');
  });
});

describe('calibrationEngineOutdated (upstream #4841)', () => {
  const job = (engineVersion: unknown, state = 'completed') => ({ state, identity: { engineVersion } }) as never;
  it('reports a finished calibration measured on an older engine', () => {
    expect(calibrationEngineOutdated(job('0.1.54'), '0.1.55')).toEqual({ from: '0.1.54', to: '0.1.55' });
    expect(calibrationEngineOutdated(job('v0.1.9', 'applied'), '0.1.10')).toEqual({ from: '0.1.9', to: '0.1.10' });
  });
  it('stays quiet when the engine is the same or older, unknown, or the job did not finish', () => {
    expect(calibrationEngineOutdated(job('0.1.55'), '0.1.55')).toBeNull();
    expect(calibrationEngineOutdated(job('0.1.56'), '0.1.55')).toBeNull();
    expect(calibrationEngineOutdated(job(null), '0.1.55')).toBeNull();
    expect(calibrationEngineOutdated(job('0.1.54'), null)).toBeNull();
    expect(calibrationEngineOutdated(job('dev'), '0.1.55')).toBeNull();
    expect(calibrationEngineOutdated(job('0.1.54', 'failed'), '0.1.55')).toBeNull();
    expect(calibrationEngineOutdated(job('0.1.54', 'running'), '0.1.55')).toBeNull();
    expect(calibrationEngineOutdated(null, '0.1.55')).toBeNull();
  });
});
