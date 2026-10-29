import { describe, expect, it } from 'vitest';
import { applyCalibrationSettings, applySpeedFixes, assertDeepseek41Flags, DEEPSEEK41_ENGINE_FLAGS, deepseek41ForeignFlags, restartCandidatesFromCalibration, speedHealthCheck } from '../src';

const deepseek = { arch: 'deepseek41', exe: 'engine/strata-dsv41', args: ['--pack', 'model/maya-ds4', '--max-context', '131072', '--reserve-mib', '600'] };
const qwen = { exe: 'engine/strata', args: ['--native', 'model.gguf', '--max-context', '131072'] };
const QWEN_ONLY = ['--vram-reserve-mib', '--pool-workers', '--resident-gib', '--expert-cache', '--kv-resident', '--pcie-frac', '--spec-min-p', '--prefill-pipe'];

describe('DeepSeek-V4.1 configs never get Qwen tuning flags', () => {
  it('names only the flags strata-dsv41 does not take, and nothing for Qwen configs', () => {
    expect(deepseek41ForeignFlags(deepseek, [...QWEN_ONLY, '--reserve-mib', '--experts'])).toEqual(QWEN_ONLY);
    expect(deepseek41ForeignFlags(qwen, QWEN_ONLY)).toEqual([]);
    for (const flag of QWEN_ONLY) expect(DEEPSEEK41_ENGINE_FLAGS).not.toHaveProperty(flag);
    expect(() => assertDeepseek41Flags(deepseek, ['--pool-workers'])).toThrow(/DeepSeek.*--pool-workers/);
    expect(() => assertDeepseek41Flags(deepseek, ['--reserve-mib'])).not.toThrow();
  });

  it('the health check offers no fix for a DeepSeek config, even when VRAM is low and long context is on', () => {
    const checks = speedHealthCheck({ config: deepseek, engine: { vram_free_mib: 100, context: 262144 }, hardware: { availableMemoryBytes: 512 * 1024 ** 3 }, platform: 'windows', logs: ['WARNING LOW VRAM: pass --vram-reserve-mib 2048'] });
    expect(checks).toEqual([{ id: 'engine', status: 'info', reason: 'deepseek41', values: {} }]);
    expect(checks.some(check => check.fix)).toBe(false);
    // The same signals still produce the Qwen fixes for a Qwen config.
    const qwenChecks = speedHealthCheck({ config: qwen, engine: { vram_free_mib: 100, context: 262144 }, hardware: { availableMemoryBytes: 512 * 1024 ** 3 }, platform: 'windows' });
    expect(qwenChecks.find(check => check.id === 'vramHeadroom')?.fix).toHaveProperty('--vram-reserve-mib');
  });

  it('speed fixes refuse Qwen-only flags and leave the DeepSeek config unchanged', () => {
    for (const flag of ['--vram-reserve-mib', '--expert-cache', '--kv-resident', '--pool-workers', '--resident-gib']) {
      expect(() => applySpeedFixes(deepseek, [{ [flag]: '2048' }])).toThrow(/DeepSeek/);
    }
    expect(deepseek.args).toEqual(['--pack', 'model/maya-ds4', '--max-context', '131072', '--reserve-mib', '600']);
    expect(applySpeedFixes(deepseek, [{ '--reserve-mib': '800' }]).args).toEqual(['--pack', 'model/maya-ds4', '--max-context', '131072', '--reserve-mib', '800']);
    expect(applySpeedFixes(qwen, [{ '--vram-reserve-mib': '2048' }]).args).toContain('--vram-reserve-mib');
  });

  it('a calibration result is not written into a DeepSeek config', () => {
    expect(() => applyCalibrationSettings(deepseek, { '--pcie-frac': '0.35' }, 'cuda')).toThrow(/DeepSeek/);
    expect(() => applyCalibrationSettings(deepseek, { '--spec-min-p': '0.70', '--prefill-pipe': '4096' }, 'cuda')).toThrow(/DeepSeek/);
    expect(applyCalibrationSettings(qwen, { '--pcie-frac': '0.35' }, 'cuda').args).toContain('--pcie-frac');
  });

  it('restart candidates from calibration are empty for a DeepSeek config', () => {
    const job = { restartSuggestions: [{ poolWorkers: 4 }, { vramReserveMib: 2048 }] };
    expect(restartCandidatesFromCalibration(job, deepseek)).toEqual([]);
    expect(restartCandidatesFromCalibration(job, qwen)).toEqual([{ poolWorkers: 4 }, { vramReserveMib: 2048 }]);
    expect(restartCandidatesFromCalibration(job)).toHaveLength(2);
  });
});
