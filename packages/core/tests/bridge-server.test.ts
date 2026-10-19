import { afterEach, describe, expect, it, vi } from 'vitest';

function makeSessionStore() {
  const store = new Map<string, string>();
  return {
    getItem: (k: string) => store.get(k) ?? null,
    setItem: (k: string, v: string) => { store.set(k, v); },
    removeItem: (k: string) => { store.delete(k); },
  };
}

describe('server transport helpers', () => {
  afterEach(() => {
    vi.resetModules();
    vi.unstubAllGlobals();
  });

  it('detects server mode from bootstrap and routes RPC', async () => {
    const fetchMock = vi.fn(async () =>
      new Response(JSON.stringify({ ok: true, result: { running: true } }), {
        status: 200,
        headers: { 'Content-Type': 'application/json' },
      }),
    );
    vi.stubGlobal('fetch', fetchMock);
    const sessionStorage = makeSessionStore();
    vi.stubGlobal('sessionStorage', sessionStorage);
    vi.stubGlobal('window', {
      __STRATA_MANAGER_SERVER__: { apiBase: '/api/v1', version: '0.2.6' },
      location: { search: '', href: 'http://127.0.0.1:8787/', pathname: '/', hash: '' },
      history: { replaceState() {} },
      sessionStorage,
    });
    const bridge = await import('../src/bridge');
    expect(bridge.isServerMode()).toBe(true);
    expect(bridge.isTauri()).toBe(false);
    expect(bridge.isDesktop()).toBe(true);
    bridge.setServerToken('test-token-1234567890');
    const status = await bridge.serviceStatus('p1');
    expect(status).toEqual({ running: true });
    expect(fetchMock).toHaveBeenCalledOnce();
    const call = fetchMock.mock.calls[0] as unknown as [string, RequestInit];
    expect(call[0]).toBe('/api/v1/rpc');
    expect(call[1].headers).toMatchObject({
      Authorization: 'Bearer test-token-1234567890',
    });
  });

  it('requires a token before RPC', async () => {
    const sessionStorage = makeSessionStore();
    vi.stubGlobal('sessionStorage', sessionStorage);
    vi.stubGlobal('window', {
      __STRATA_MANAGER_SERVER__: { apiBase: '/api/v1', version: '0.2.6' },
      location: { search: '', href: 'http://127.0.0.1:8787/', pathname: '/', hash: '' },
      history: { replaceState() {} },
      sessionStorage,
    });
    const bridge = await import('../src/bridge');
    await expect(bridge.environmentInfo()).rejects.toMatchObject({ code: 'AUTH_REQUIRED' });
  });
});
