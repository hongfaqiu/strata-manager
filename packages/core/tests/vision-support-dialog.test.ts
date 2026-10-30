import { describe, expect, it } from 'vitest';
import { assertVisionBaseline, configureDeepseek41VisionSupport, configureVisionSupport, visionDraftOf } from '../../../apps/desktop/src/pages/visionSupportConfiguration';
import { applyDeepseek41Vision, deepseek41Vision } from '../src';

describe('quick vision configuration', () => {
  const draft = { exe: 'D:\\Strata\\engine\\strata-vision.exe', model: 'D:\\Models\\weights.gguf', mmproj: 'D:\\Models\\mmproj.gguf', gpu: false, threads: '8', maxTokens: '1024' };
  it('defaults to CPU without guessing a projector and reads model argv safely', () => {
    expect(visionDraftOf({ args: ['--model', 'D:\\Models\\main.gguf'] }, 'D:\\Strata\\')).toEqual({ ...draft, model: 'D:\\Models\\main.gguf', mmproj: '' });
    expect(visionDraftOf({ args: ['--native', '/models/main.gguf'] }, '/strata')).toMatchObject({ exe: '/strata/engine/strata-vision.exe', model: '/models/main.gguf', mmproj: '' });
    expect(visionDraftOf({ exe: '/strata/engine_cuda12/strata.exe', args: ['--native', '/models/main.gguf'] }, '/strata')).toMatchObject({ exe: '/strata/engine_cuda12/strata-vision.exe', model: '/models/main.gguf', mmproj: '' });
    expect(visionDraftOf({ exe: 'D:\\Strata\\engine-cuda12\\strata.exe', args: ['--model', 'D:\\Models\\main.gguf'] }, 'D:\\Strata\\')).toMatchObject({ exe: 'D:\\Strata\\engine-cuda12\\strata-vision.exe', model: 'D:\\Models\\main.gguf' });

  });
  it('defaults to the Mac/Linux vision binary name beside a main engine without .exe', () => {
    expect(visionDraftOf({ exe: 'engine/strata', args: ['--model', '/Users/ai/models/main.gguf'] }, '/Users/ai/Strata').exe).toBe('engine/strata-vision');
    expect(visionDraftOf({ exe: '/opt/strata/engine-cuda12/strata', args: [] }, '/opt/strata').exe).toBe('/opt/strata/engine-cuda12/strata-vision');
    expect(visionDraftOf({ exe: 'strata', args: [] }, '/Users/ai/Strata').exe).toBe('/Users/ai/Strata/engine/strata-vision');
    expect(visionDraftOf({ exe: 'D:\\Strata\\engine\\STRATA.EXE', args: [] }, 'D:\\Strata').exe).toBe('D:\\Strata\\engine\\strata-vision.exe');

    expect(visionDraftOf({ args: ['--model', '--vision'] }, 'D:\\Strata').model).toBe('');
    expect(visionDraftOf({ args: ['--model', 'a.gguf', '--model', 'b.gguf'] }, 'D:\\Strata').model).toBe('');
  });
  it('prefills the existing paths and encoder settings', () => {
    expect(visionDraftOf({ args: ['--model', 'other.gguf'], vision: { exe: 'vision.exe', model: 'current.gguf', mmproj: 'projector.gguf', gpu: true, threads: 3, max_tokens: 2048 } }, 'D:\\Strata')).toEqual({ exe: 'vision.exe', model: 'current.gguf', mmproj: 'projector.gguf', gpu: true, threads: '3', maxTokens: '2048' });
  });
  it('preserves complete configuration and unknown vision fields without mutating its baseline', () => {
    const config = { exe: 'engine.exe', args: ['--native', 'weights.gguf', '--max-context', '65536', '--custom', 'keep'], api_key: 'secret', sampling: { temperature: .6 }, env: { CUSTOM: 'keep' }, mcp: [{ name: 'tool' }], vision: { min_tokens: 256, cuda_device: 2, custom: [false, null, 3] } };
    const original = structuredClone(config);
    const next = configureVisionSupport(config, draft);
    expect(next).toEqual({ ...config, args: [...config.args, '--vision'], vision: { ...config.vision, exe: draft.exe, model: draft.model, mmproj: draft.mmproj, gpu: false, threads: 8, max_tokens: 1024 } });
    expect(config).toEqual(original);
  });
  it('keeps exactly one main-engine vision flag and preserves every other token', () => {
    const config = { args: ['--vision', '--native', 'weights.gguf', '--custom', 'value', '--vision', '--max-context', '4096', '--vision'] };
    expect(configureVisionSupport(config, draft).args).toEqual(['--vision', '--native', 'weights.gguf', '--custom', 'value', '--max-context', '4096']);
  });
  it('rejects missing files, malformed encoder limits and invalid startup configuration', () => {
    for (const key of ['exe', 'model', 'mmproj']) expect(() => configureVisionSupport({ args: [] }, { ...draft, [key]: ' ' })).toThrow('file path');
    for (const value of ['0', '-1', '1.5', 'not-a-number']) expect(() => configureVisionSupport({ args: [] }, { ...draft, threads: value })).toThrow();
    expect(() => configureVisionSupport({ args: ['--max-context'] }, draft)).toThrow();
    expect(() => configureVisionSupport({ args: [], vision: 'invalid' }, draft)).toThrow('vision');
  });
  it('rejects stale read baselines rather than overwriting external configuration changes', () => {
    const baseline = { args: ['--max-context', '4096'], api_key: 'keep' };
    expect(() => assertVisionBaseline(baseline, structuredClone(baseline))).not.toThrow();
    expect(() => assertVisionBaseline(baseline, { ...baseline, api_key: 'changed' })).toThrow('Configuration changed');
    expect(() => assertVisionBaseline(baseline, { ...baseline, args: ['--max-context', '8192'] })).toThrow();
  });
});

describe('DeepSeek-V4.1-Flash image input', () => {
  const deepseek = (args: string[]) => ({ arch: 'deepseek41', exe: '/s/engine-dsv41/strata-dsv41', args: ['--pack', '/m/packs/ds4', '--max-context', '8192', ...args] });
  const draft = { exe: '/s/engine/strata-vision', model: '/m/w.gguf', mmproj: '/m/p.gguf', gpu: false, threads: '8', maxTokens: '1024' };
  it('only counts an explicit --vision on', () => {
    expect(deepseek41Vision(deepseek([]))).toBe(false);
    expect(deepseek41Vision(deepseek(['--vision', 'off']))).toBe(false);
    expect(deepseek41Vision(deepseek(['--vision']))).toBe(false);
    expect(deepseek41Vision(deepseek(['--vision', '--eos', '1']))).toBe(false);
    expect(deepseek41Vision(deepseek(['--vision', 'on']))).toBe(true);
    expect(deepseek41Vision(deepseek(['--vision=on']))).toBe(true);
  });
  it('turns the engine tower on with --vision on, never a vision section or a bare switch', () => {
    const config = deepseek(['--vision', 'off', '--eos', '1']);
    const original = structuredClone(config);
    const next = configureVisionSupport(config, draft);
    expect(next.args).toEqual(['--pack', '/m/packs/ds4', '--max-context', '8192', '--eos', '1', '--vision', 'on']);
    expect(next).not.toHaveProperty('vision');
    expect(config).toEqual(original);
    expect(configureDeepseek41VisionSupport(deepseek(['--vision']), true).args).toEqual(['--pack', '/m/packs/ds4', '--max-context', '8192', '--vision', 'on']);
    expect(configureDeepseek41VisionSupport(deepseek(['--vision=on', '--vision', 'on']), false).args).toEqual(['--pack', '/m/packs/ds4', '--max-context', '8192', '--vision', 'off']);
  });
  it('leaves Qwen configs on the picture reader path', () => {
    expect(() => applyDeepseek41Vision({ args: [] }, true)).toThrow('DeepSeek');
    expect(configureVisionSupport({ args: ['--native', 'w.gguf'] }, draft).args).toEqual(['--native', 'w.gguf', '--vision']);
  });
});
