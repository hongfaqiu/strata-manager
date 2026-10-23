import { describe, expect, it } from 'vitest';
import { applyControlVector, bundledControlVectorPath, controlVectorArgs, controlVectorAvailability, controlVectorCheckMessage, controlVectorError, CONTROL_VECTOR_PRESET, isBundledControlVector, readControlVector, splitScaledVector, type ControlVectorSettings } from '../src/control-vector';

const root = 'C:\\Users\\me\\Strata';
const bundled = 'C:\\Users\\me\\Strata\\data\\experimental-speed-projection\\Qwen3.8-Flash-Next-experimental-speed-projection.gguf';
const base = { exe: 'engine.exe', cwd: root, args: ['--native', 'm.gguf', '--max-context', '262144', '--serve'], sampling: { experimental_speed_projection: false } };
const preset: ControlVectorSettings = { file: bundled, ...CONTROL_VECTOR_PRESET };

describe('control vector launch args', () => {
  it('resolves the vector shipped with the Strata runtime from the config cwd', () => {
    expect(bundledControlVectorPath(root)).toBe(bundled);
    expect(bundledControlVectorPath('/opt/strata/')).toBe('/opt/strata/data/experimental-speed-projection/Qwen3.8-Flash-Next-experimental-speed-projection.gguf');
    expect(bundledControlVectorPath('')).toBeNull();
    expect(isBundledControlVector(bundled)).toBe(true);
    expect(isBundledControlVector('D:\\vectors\\other.gguf')).toBe(false);
  });

  it('writes exactly the upstream setup.py preset when switched on', () => {
    const on = applyControlVector(base, preset);
    expect(on.args).toEqual(['--native', 'm.gguf', '--max-context', '262144', '--serve',
      '--control-vector-scaled', `${bundled}:1.0`, '--control-vector-layer-range', '4', '44', '--cvec-mode', 'project', '--cvec-dir', 'per-layer']);
    expect(on.sampling).toEqual(base.sampling);
    expect(base.args).toHaveLength(5);
    expect(readControlVector(on)).toEqual({ enabled: true, multiple: false, settings: preset });
  });

  it('removes every control vector flag when off and keeps the other args in order', () => {
    const messy = { ...base, args: ['--control-vector', 'a.gguf', '--native', 'm.gguf', '--cvec-mode', 'add', '--control-vector-layer-range', '2', '9', '--serve', '--cvec-dir', 'single:20'] };
    expect(applyControlVector(messy, null).args).toEqual(['--native', 'm.gguf', '--serve']);
    expect(applyControlVector(base, null).args).toEqual(base.args);
    expect(readControlVector(base).enabled).toBe(false);
  });

  it('replaces an existing vector instead of adding a second one', () => {
    const on = applyControlVector(applyControlVector(base, preset), { ...preset, file: 'D:\\v\\x.gguf', scale: '0.5', first: '', last: '', mode: 'add' });
    expect((on.args as string[]).slice(5)).toEqual(['--control-vector-scaled', 'D:\\v\\x.gguf:0.5', '--cvec-mode', 'add', '--cvec-dir', 'per-layer']);
  });

  it('reads engine defaults, Windows drive letters and several vectors', () => {
    expect(splitScaledVector('C:\\v.gguf:0.8')).toEqual({ file: 'C:\\v.gguf', scale: '0.8' });
    expect(splitScaledVector('C:\\v.gguf')).toEqual({ file: 'C:\\v.gguf', scale: '1.0' });
    const plain = readControlVector({ args: ['--control-vector', 'v.gguf'] });
    expect(plain).toEqual({ enabled: true, multiple: false, settings: { file: 'v.gguf', scale: '1.0', first: '', last: '', mode: 'add', direction: 'per-layer' } });
    expect(readControlVector({ args: ['--control-vector-scaled', 'a.gguf:1,b.gguf:-0.5'] }).multiple).toBe(true);
    expect(controlVectorArgs({ ...preset, scale: '2' })[1]).toBe(`${bundled}:2.0`);
  });

  it('validates strength, layer range, mode and direction', () => {
    expect(controlVectorError(preset)).toBeNull();
    expect(controlVectorError({ ...preset, file: ' ' })).toMatch(/控制向量文件/);
    expect(controlVectorError({ ...preset, file: 'a,b.gguf' })).toMatch(/逗号/);
    expect(controlVectorError({ ...preset, scale: 'x' })).toMatch(/强度/);
    expect(controlVectorError({ ...preset, scale: '' })).toMatch(/强度/);
    expect(controlVectorError({ ...preset, first: '4', last: '' })).toMatch(/同时/);
    expect(controlVectorError({ ...preset, first: '0', last: '4' })).toMatch(/从 1/);
    expect(controlVectorError({ ...preset, first: '1.5', last: '4' })).toMatch(/从 1/);
    expect(controlVectorError({ ...preset, first: '10', last: '4' })).toMatch(/起始层/);
    expect(controlVectorError({ ...preset, first: '50', last: '60' }, 47)).toMatch(/最高 47/);
    expect(controlVectorError({ ...preset, first: '', last: '' })).toBeNull();
    expect(controlVectorError({ ...preset, direction: 'single:20' })).toBeNull();
    expect(controlVectorError({ ...preset, direction: 'single:20', mode: 'add' })).toMatch(/project/);
    expect(controlVectorError({ ...preset, direction: 'single:x' })).toMatch(/per-layer/);
    expect(controlVectorError({ ...preset, direction: 'single:60' }, 47)).toMatch(/超出/);
    expect(controlVectorError({ ...preset, mode: 'sub' as never })).toMatch(/模式/);
    expect(() => applyControlVector(base, { ...preset, scale: 'NaN' })).toThrow(/强度/);
  });

  it('is disabled with a reason on engines without the flag and on Mac', () => {
    const old = ['--native', '--serve', '--max-context', '--kv'];
    expect(controlVectorAvailability(old, false)).toMatchObject({ available: false, reason: { zh: expect.stringMatching(/0\.1\.44/) } });
    expect(controlVectorAvailability([...old, '--control-vector-scaled'], false)).toEqual({ available: true });
    expect(controlVectorAvailability(null, false)).toEqual({ available: true });
    expect(controlVectorAvailability(null, true).available).toBe(false);
  });

  it('explains file check results', () => {
    expect(controlVectorCheckMessage({ path: 'x', status: 'ok', layers: 47 }, true)).toBeNull();
    expect(controlVectorCheckMessage({ path: 'x', status: 'notControlVector', architecture: 'qwen3next', layers: 0 }, true)).toMatch(/qwen3next/);
    expect(controlVectorCheckMessage({ path: 'x', status: 'missing', layers: 0 }, false)).toBe('File not found.');
  });
});
