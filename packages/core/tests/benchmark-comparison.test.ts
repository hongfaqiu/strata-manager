import { describe, expect, it } from 'vitest';
import { benchmarkComparisonMetrics, compareBenchmarkReports, exportBenchmarkReport, validBenchmarkIdentity } from '../src/benchmark-comparison';
import { advanceChatExecution, finishChatExecution, newChatExecution } from '../src/chat-execution';
import type { BenchmarkReport } from '../src/benchmark';

function report(id: string): BenchmarkReport {
  return {
    id, profileId: 'fixture', profileName: 'Fixture', baseUrl: 'http://127.0.0.1:19001', model: 'fixture',
    startedAt: 10, finishedAt: 20, state: 'completed',
    options: { prompt: 'same test input', rounds: 1, maxTokens: 256, warmup: false, mode: 'unique', timeoutMs: 60000 },
    samples: [{ index: 1, warmup: false, state: 'completed', model: 'fixture', startedAt: 10, ttftMs: 100, firstVisibleMs: 150,
      wallMs: 200, promptTokens: 100, completionTokens: 20, cachedTokens: 0, prefillTokS: 1000, decodeTokS: 100, output: 'answer' }],
    identity: { schemaVersion: 1, capturedAt: 9, process: { running: true, pid: 42, startedAt: 1 },
      engineProcess: { pid: 43, startedAt: 2 }, runtime: { strength: 'sha256', fingerprint: 'runtime-a' },
      model: { strength: 'sha256', fingerprint: 'model' }, savedConfigurationHash: 'saved',
      effectiveStartupHash: 'effective', effectiveVerified: true,
      hardwareSignature: { cpuName: 'fixture', totalMemoryBytes: 64 * 2 ** 30, gpus: [{ id: 0, name: 'fixture', totalBytes: 32 * 2 ** 30 }] } },
  };
}

describe('benchmark evidence eligibility', () => {
  it('accepts verified runtime content as the only changed condition', () => {
    const a = report('a'), b = report('b'); b.identity!.runtime.fingerprint = 'runtime-b';
    expect(compareBenchmarkReports(a, b)).toEqual({ comparable: true, differences: ['runtime'], unknowns: [] });
  });
  it('does not treat runtime metadata hashes as verified executable contents', () => {
    const a = report('a'), b = report('b'); b.identity!.runtime.strength = 'metadata';
    expect(compareBenchmarkReports(a, b)).toMatchObject({ comparable: false, unknowns: expect.arrayContaining(['runtimeContent']) });
  });
  it('requires a valid process record and resident engine proof', () => {
    const a = report('a'), b = report('b');
    a.identity!.process = undefined as never;
    expect(validBenchmarkIdentity(a.identity)).toBe(false);
    expect(compareBenchmarkReports(a, b).unknowns).toContain('identity');
    a.identity = report('a').identity; delete a.identity!.engineProcess;
    expect(compareBenchmarkReports(a, b)).toMatchObject({ comparable: false, unknowns: expect.arrayContaining(['process']) });
  });
  it('requires completed measured rounds even when both reports claim completion', () => {
    const a = report('a'), b = report('b'); a.samples = []; b.samples = [];
    expect(compareBenchmarkReports(a, b)).toMatchObject({ comparable: false, unknowns: expect.arrayContaining(['incomplete']) });
    a.samples = report('a').samples; b.samples = report('b').samples; a.options.rounds = 2; b.options.rounds = 2;
    expect(compareBenchmarkReports(a, b).unknowns).toContain('incomplete');
  });
  it('checks actual input and cache reuse instead of relying on saved test options', () => {
    const a = report('a'), b = report('b'); b.samples[0]!.cachedTokens = 50;
    expect(compareBenchmarkReports(a, b)).toMatchObject({ comparable: false, differences: expect.arrayContaining(['inputConditions']) });
    b.samples[0]!.cachedTokens = null;
    expect(compareBenchmarkReports(a, b).unknowns).toContain('cacheConditions');
  });
  it('does not compare redacted test text as if its input were known', () => {
    const a = exportBenchmarkReport(report('a')), b = exportBenchmarkReport(report('b'));
    expect(compareBenchmarkReports(a, b)).toMatchObject({ comparable: false, unknowns: expect.arrayContaining(['testInput']) });
  });
  it('keeps missing or invalid cache counters unknown in displayed metrics', () => {
    const a = report('a'); a.samples[0]!.cachedTokens = undefined as never;
    expect(benchmarkComparisonMetrics(a).cacheHitRate).toBeNull();
    a.samples[0]!.cachedTokens = 101;
    expect(benchmarkComparisonMetrics(a).cacheHitRate).toBeNull();
  });
});

describe('first visible answer evidence', () => {
  it('counts whitespace as a token but waits for visible answer text', () => {
    const initial = { ...newChatExecution('local', 1000), requestStartedAt: 1000 };
    const whitespace = advanceChatExecution(initial, { content: ' \n' }, 1100);
    expect(whitespace.firstTokenMs).toBe(100); expect(whitespace.firstVisibleMs).toBeUndefined();
    expect(advanceChatExecution(whitespace, { content: 'answer' }, 1200).firstVisibleMs).toBe(200);
  });
  it('preserves the first terminal result when completion is delivered again', () => {
    const stopped = finishChatExecution(newChatExecution('local', 1000), true, false, 1100);
    expect(finishChatExecution(stopped, false, false, 1200)).toEqual(stopped);
  });
});
