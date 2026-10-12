import { describe, expect, it } from 'vitest';
import { profileFromConfig, startupServiceEndpoint, type ServiceProfile } from '../src';

const config = { exe: 'D:\\Strata\\engine\\strata.exe', args: ['--native', 'weights.gguf'], cwd: 'D:\\Strata', model_name: '中文模型', port: 18081 };
const previous: ServiceProfile = { id: 'old', name: 'old', baseUrl: 'http://127.0.0.1:8080', installDir: 'D:\\Strata', configPath: 'D:\\Strata\\strata-old.json', managed: true, pythonPath: 'C:\\Python\\python.exe' };

describe('official model config imports', () => {
  it('uses the selected model, runtime directory and non-default port instead of the previous address', () => {
    expect(profileFromConfig('D:\\Strata\\strata-new.json', config, 'new', previous)).toEqual({ ...previous, id: 'new', name: '中文模型', baseUrl: 'http://127.0.0.1:18081', configPath: 'D:\\Strata\\strata-new.json' });
  });
  it('connects wildcard bind addresses through loopback, including IPv6', () => {
    expect(profileFromConfig('/opt/strata/model.json', { ...config, cwd: '/opt/strata', host: '0.0.0.0' }, 'a').baseUrl).toBe('http://127.0.0.1:18081');
    expect(profileFromConfig('/opt/strata/model.json', { ...config, cwd: '/opt/strata', host: '::' }, 'a')).toMatchObject({ baseUrl: 'http://[::1]:18081', managed: true });
    expect(profileFromConfig('/opt/strata/model.json', { ...config, cwd: '/opt/strata', host: '192.168.1.20' }, 'a')).toMatchObject({ baseUrl: 'http://192.168.1.20:18081', managed: true });
  });
  it('resolves relative cwd and leaves Python to native detection for another installation', () => {
    expect(profileFromConfig('E:\\Strata\\configs\\model.json', { ...config, cwd: '..' }, 'new', previous)).toMatchObject({ installDir: 'E:\\Strata', pythonPath: '' });
    expect(profileFromConfig('/opt/strata/configs/model.json', { ...config, cwd: '..' }, 'new')).toMatchObject({ installDir: '/opt/strata', pythonPath: '' });
  });
  it('uses official launcher defaults and file name when optional fields are absent', () => {
    expect(profileFromConfig('D:\\Strata\\strata-new.json', { exe: 'engine.exe', args: [] }, 'new')).toMatchObject({ name: 'strata-new', baseUrl: 'http://127.0.0.1:8080', installDir: 'D:\\Strata', pythonPath: '' });
  });
  it('rejects non-model JSON, invalid ports and malformed hosts before saving a profile', () => {
    expect(() => profileFromConfig('D:\\Strata\\shared-settings.json', { defaults: {} }, 'new')).toThrow('exe');
    for (const port of [0, 65536, 1.5, '8080', null]) expect(() => profileFromConfig('D:\\Strata\\model.json', { ...config, port }, 'new')).toThrow('port');
    for (const host of ['localhost/path', 'user@localhost', 'localhost?key=value']) expect(() => profileFromConfig('D:\\Strata\\model.json', { ...config, host }, 'new')).toThrow('host');
  });
});

describe('startup listener endpoints', () => {
  it('distinguishes loopback-only listeners from wildcard and explicit network interfaces', () => {
    expect(startupServiceEndpoint({})).toEqual({ host: '127.0.0.1', port: 8080, baseUrl: 'http://127.0.0.1:8080', localOnly: true, wildcard: false });
    expect(startupServiceEndpoint({ host: ' localhost ', port: 18082 })).toMatchObject({ baseUrl: 'http://localhost:18082', localOnly: true });
    expect(startupServiceEndpoint({ host: '0.0.0.0', port: 18082 })).toMatchObject({ baseUrl: 'http://127.0.0.1:18082', localOnly: false, wildcard: true });
    expect(startupServiceEndpoint({ host: '[::]', port: 18082 })).toMatchObject({ baseUrl: 'http://[::1]:18082', localOnly: false, wildcard: true });
    expect(startupServiceEndpoint({ host: '192.168.1.20', port: 18082 })).toMatchObject({ baseUrl: 'http://192.168.1.20:18082', localOnly: false, wildcard: false });
    expect(startupServiceEndpoint({ host: '2001:db8::20', port: 18082 })).toMatchObject({ baseUrl: 'http://[2001:db8::20]:18082', localOnly: false, wildcard: false });
  });
  it('accepts inclusive port bounds and rejects URL components in listener hosts', () => {
    expect(startupServiceEndpoint({ host: '127.0.0.1', port: 1 }).baseUrl).toBe('http://127.0.0.1:1');
    expect(startupServiceEndpoint({ host: '127.0.0.1', port: 65535 }).baseUrl).toBe('http://127.0.0.1:65535');
    expect(startupServiceEndpoint({ host: 'localhost', port: 80 }).baseUrl).toBe('http://localhost');
    for (const host of ['http://localhost', 'localhost/', 'localhost\\path', 'user@localhost', 'localhost?key=value', 'localhost#fragment', 'localhost:8080', 'local\nhost', null, 0]) expect(() => startupServiceEndpoint({ host })).toThrow('host');
  });
});
