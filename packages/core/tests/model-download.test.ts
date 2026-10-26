import { describe, expect, it } from 'vitest';
import * as core from '../src/index';
import { MODEL_CATALOG } from '../src/catalog';
import type { OfficialSetupOptions } from '../src/official-setup';
import type { ServiceProfile } from '../src/types';

const runtime = (): ServiceProfile => ({
  id: 'registered-runtime-id', name: 'Local runtime', baseUrl: 'http://127.0.0.1:18081',
  installDir: 'fixture/a', pythonPath: '', configPath: '', managed: true,
});
const stored = () => ({ schemaVersion: 1, options: { source: 'official', backend: 'auto', gpus: '' }, runtime: runtime() });
const selection = () => ({ model: 'qwen', quant: 'IQ3_S', context: 32768, images: true });

describe('model download defaults', () => {
  it('creates fresh official defaults only for absent stored values', () => {
    expect(core.MODEL_DOWNLOAD_DEFAULTS_KEY).toBe('modelDownloadDefaultsV1');
    const expected = { schemaVersion: 1, options: { source: 'official', backend: 'auto', gpus: '' }, runtime: null };
    const first = core.defaultModelDownloadDefaults();
    expect(first).toEqual(expected);
    expect(core.normalizeModelDownloadDefaults(null)).toEqual(expected);
    expect(core.normalizeModelDownloadDefaults(undefined)).toEqual(expected);
    first.options.source = 'modelscope';
    expect(core.defaultModelDownloadDefaults()).toEqual(expected);
    expect(core.normalizeModelDownloadDefaults(null)).toEqual(expected);
  });

  it('rejects malformed stored envelopes instead of resetting the download source', () => {
    for (const value of [false, 0, '', [], {}, new Date(), { ...stored(), schemaVersion: 2 },
      { ...stored(), schemaVersion: '1' }, { options: {}, runtime: null },
      { schemaVersion: 1, runtime: null }, { schemaVersion: 1, options: {} }]) {
      expect(() => core.normalizeModelDownloadDefaults(value)).toThrow();
    }
  });

  it('validates option objects and field types before applying optional defaults', () => {
    for (const options of [null, undefined, [], 'mirror', new Date(), { source: null },
      { source: 'unknown' }, { backend: 'cpu' }, { backend: null }, { gpus: [] },
      { gpus: 0 }, { hfEndpoint: {} }, { source: 'mirror' }]) {
      expect(() => core.normalizeModelDownloadDefaults({ ...stored(), options })).toThrow();
    }
    expect(core.normalizeModelDownloadDefaults({ ...stored(), options: {} }).options)
      .toEqual({ source: 'official', backend: 'auto', gpus: '' });
  });

  it('rejects invalid mirror addresses and GPU choices without changing source', () => {
    for (const hfEndpoint of ['', 'http://mirror.example', 'https://user:password@mirror.example',
      'https://mirror.example/?token=secret', 'https://mirror.example/#secret', 'https://mirror.example\\path',
      'https://mirror.example\n']) {
      expect(() => core.normalizeModelDownloadDefaults({ ...stored(), options: { source: 'mirror', hfEndpoint } })).toThrow();
    }
    for (const gpus of ['1,1', '256', '-1', '0 --build', 'all\n']) {
      expect(() => core.normalizeModelDownloadDefaults({ ...stored(), options: { gpus } })).toThrow();
    }
  });

  it('normalizes valid mirror and GPU settings and removes stale mirrors when the source changes', () => {
    const options = { source: 'mirror', hfEndpoint: 'https://mirror.example/', backend: 'cuda', gpus: '2, 0' };
    const result = core.normalizeModelDownloadDefaults({ ...stored(), options });
    expect(result.options).toEqual({ source: 'mirror', hfEndpoint: 'https://mirror.example', backend: 'cuda', gpus: '2,0' });
    for (const source of ['official', 'modelscope']) {
      expect(core.normalizeModelDownloadDefaults({ ...stored(), options: { ...options, source } }).options)
        .toEqual({ source, backend: 'cuda', gpus: '2,0' });
    }
    expect(options.hfEndpoint).toBe('https://mirror.example/');
  });

  it('accepts an unselected runtime and preserves the registered runtime identity', () => {
    expect(core.normalizeModelDownloadDefaults({ ...stored(), runtime: null }).runtime).toBeNull();
    const profile = { ...runtime(), id: ' registered-runtime-id ' };
    expect(core.normalizeModelDownloadDefaults({ ...stored(), runtime: profile }).runtime).toEqual(profile);
  });

  it('requires every runtime field, a managed runtime and a nonempty install directory', () => {
    for (const value of [undefined, [], false, {}, { ...runtime(), managed: false },
      { ...runtime(), managed: 'true' }, { ...runtime(), installDir: ' ' },
      { ...runtime(), id: '' }, { ...runtime(), pythonPath: null }, { ...runtime(), configPath: 4 }]) {
      expect(() => core.normalizeModelDownloadDefaults({ ...stored(), runtime: value })).toThrow();
    }
    for (const field of Object.keys(runtime())) {
      const incomplete: Record<string, unknown> = runtime() as unknown as Record<string, unknown>;
      delete incomplete[field];
      expect(() => core.normalizeModelDownloadDefaults({ ...stored(), runtime: incomplete })).toThrow();
    }
  });

  it('rejects runtime URLs that can persist credentials or are not HTTP service URLs', () => {
    for (const baseUrl of ['https://user:password@host', 'http://host?token=secret', 'https://host/#secret',
      'ftp://host', 'not a URL', 'http://host\n', 'http://host\\path']) {
      expect(() => core.normalizeModelDownloadDefaults({ ...stored(), runtime: { ...runtime(), baseUrl } })).toThrow();
    }
  });

  it('keeps only contract fields and never retains mutable input objects', () => {
    const input = { ...stored(), extra: { secret: true },
      options: { source: 'mirror', hfEndpoint: 'https://mirror.example', gpus: '2,0', extra: ['ignored'] },
      runtime: { ...runtime(), credentials: { token: 'ignored' } } };
    const normalized = core.normalizeModelDownloadDefaults(input);
    expect(normalized).toEqual({ schemaVersion: 1,
      options: { source: 'mirror', hfEndpoint: 'https://mirror.example', backend: 'auto', gpus: '2,0' }, runtime: runtime() });
    expect(normalized.options).not.toBe(input.options);
    expect(normalized.runtime).not.toBe(input.runtime);
    input.options.hfEndpoint = 'https://changed.example';
    input.runtime.installDir = 'changed/runtime';
    expect(normalized.options.hfEndpoint).toBe('https://mirror.example');
    expect(normalized.runtime?.installDir).toBe('fixture/a');
  });
});

describe('model download request snapshots', () => {
  it('accepts catalog families and quants at both context limits', () => {
    for (const model of MODEL_CATALOG) {
      for (const quant of model.quants) {
        // A fixed-context family (DeepSeek-V4.1-Flash: 8K) accepts only that size; catalog-deepseek41.test.ts covers the refusal.
        for (const context of model.fixedContext ? [model.fixedContext] : [512, 1048576]) {
          const choice = { model: model.family, quant, context, images: false };
          expect(core.snapshotModelDownloadRequest(runtime(), choice, {})).toEqual({
            profile: runtime(), ...choice, options: { source: 'official', backend: 'auto', gpus: '' },
          });
        }
      }
    }
  });

  it('rejects unsupported model choices and noninteger or out-of-range context sizes', () => {
    for (const changes of [{ model: 'unknown' }, { model: 'Qwen3.8-Flash-Next' }, { quant: 'IQ1_M' },
      { context: 511 }, { context: 1048577 }, { context: 512.5 }, { context: NaN },
      { context: Infinity }, { context: '32768' }, { images: 'true' }]) {
      expect(() => core.snapshotModelDownloadRequest(runtime(), { ...selection(), ...changes } as core.ModelDownloadSelection, {})).toThrow();
    }
    expect(() => core.snapshotModelDownloadRequest(runtime(), null as unknown as core.ModelDownloadSelection, {})).toThrow();
    expect(() => core.snapshotModelDownloadRequest(runtime(), [] as unknown as core.ModelDownloadSelection, {})).toThrow();
  });

  it('checks the catalog image capability before accepting image support', () => {
    const model = MODEL_CATALOG.find(entry => entry.family === 'qwen')!;
    const supportsImages = model.images;
    try {
      model.images = false;
      expect(() => core.snapshotModelDownloadRequest(runtime(), selection(), {})).toThrow();
      expect(core.snapshotModelDownloadRequest(runtime(), { ...selection(), images: false }, {}).images).toBe(false);
    } finally {
      model.images = supportsImages;
    }
  });

  it('applies the same runtime and option validation when creating requests', () => {
    expect(() => core.snapshotModelDownloadRequest({ ...runtime(), managed: false }, selection(), {})).toThrow();
    expect(() => core.snapshotModelDownloadRequest({ ...runtime(), baseUrl: 'http://user:password@host' }, selection(), {})).toThrow();
    for (const options of [{ source: 'mirror' }, { source: 'mirror', hfEndpoint: 'http://mirror.example' },
      { gpus: '1,1' }, [], null, { source: null }]) {
      expect(() => core.snapshotModelDownloadRequest(runtime(), selection(), options as OfficialSetupOptions)).toThrow();
    }
    expect(core.snapshotModelDownloadRequest(runtime(), selection(), { source: 'official', hfEndpoint: 'https://stale.example' }).options)
      .not.toHaveProperty('hfEndpoint');
  });

  it('isolates queued requests from later edits to defaults, runtime and model selection', () => {
    const profile = runtime();
    const defaults = core.normalizeModelDownloadDefaults({ ...stored(), runtime: profile,
      options: { source: 'mirror', hfEndpoint: 'https://mirror.example', backend: 'cuda', gpus: '2, 0' } });
    const choice = selection();
    const request = core.snapshotModelDownloadRequest(profile, choice, defaults.options);
    expect(request.profile).not.toBe(profile);
    expect(request.options).not.toBe(defaults.options);
    profile.id = 'another-runtime';
    profile.installDir = 'fixture/b';
    defaults.options.source = 'modelscope';
    defaults.options.gpus = 'all';
    defaults.runtime!.installDir = 'fixture/c';
    choice.model = 'coder';
    choice.quant = 'IQ1_M';
    choice.context = 8192;
    expect(request).toEqual({ profile: runtime(), ...selection(),
      options: { source: 'mirror', hfEndpoint: 'https://mirror.example', backend: 'cuda', gpus: '2,0' } });
  });
});

describe('retrying an unreachable Hugging Face download on ModelScope', () => {
  const message = '网络或下载失败：cannot reach huggingface.co (<urlopen error [WinError 10060] x>)（check your internet connection）';
  it('names the unreachable host from the failure text', () => {
    expect(core.unreachableDownloadHost(message)).toBe('huggingface.co');
    expect(core.unreachableDownloadHost('cannot reach hf-mirror.com (timed out)')).toBe('hf-mirror.com');
    expect(core.unreachableDownloadHost('磁盘空间不足')).toBeNull();
    expect(core.unreachableDownloadHost(undefined)).toBeNull();
  });
  it('switches only the source, drops a mirror address and keeps the rest', () => {
    expect(core.modelScopeRetryOptions({ source: 'official', backend: 'cuda', gpus: '1' }, message)).toEqual({ source: 'modelscope', backend: 'cuda', gpus: '1' });
    expect(core.modelScopeRetryOptions({ source: 'mirror', hfEndpoint: 'https://hf-mirror.com', backend: 'auto', gpus: '' }, 'cannot reach hf-mirror.com (x)')).toEqual({ source: 'modelscope', backend: 'auto', gpus: '' });
    expect(core.modelScopeRetryOptions(undefined, message)).toEqual({ source: 'modelscope', backend: 'auto', gpus: '' });
  });
  it('is not offered when it cannot help', () => {
    expect(core.modelScopeRetryOptions({ source: 'modelscope' }, message)).toBeNull();
    expect(core.modelScopeRetryOptions({ source: 'official' }, 'cannot reach www.modelscope.cn (timed out)')).toBeNull();
    expect(core.modelScopeRetryOptions({ source: 'official' }, 'SHA-256 mismatch')).toBeNull();
  });
});
