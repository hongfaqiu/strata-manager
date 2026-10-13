import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { savePng } from '../src';

const native = vi.hoisted(() => ({ invoke: vi.fn() }));
vi.mock('@tauri-apps/api/core', () => ({ invoke: native.invoke }));
beforeEach(() => { native.invoke.mockReset(); vi.stubGlobal('window', { __TAURI_INTERNALS__: {} }); });
afterEach(() => { vi.unstubAllGlobals(); });

describe('PNG export bridge', () => {
  it('preserves the chosen destination and PNG bytes without contacting the Supervisor', async () => {
    const path = 'D:\\其它位置\\测试结果.png';
    const bytes = [137, 80, 78, 71, 13, 10, 26, 10];
    native.invoke.mockResolvedValue(path);
    expect(await savePng(path, bytes)).toBe(path);
    expect(native.invoke.mock.calls).toEqual([['write_png_export', { path, bytes }]]);
  });

  it('returns a write failure without retrying or reporting success', async () => {
    native.invoke.mockRejectedValue('PNG save failed: access denied');
    await expect(savePng('D:\\result.png', [137])).rejects.toMatchObject({ message: 'PNG save failed: access denied' });
    expect(native.invoke).toHaveBeenCalledTimes(1);
  });

  it('requires the desktop application', async () => {
    vi.stubGlobal('window', {});
    await expect(savePng('D:\\result.png', [])).rejects.toMatchObject({ code: 'DESKTOP_REQUIRED' });
    expect(native.invoke).not.toHaveBeenCalled();
  });
});
