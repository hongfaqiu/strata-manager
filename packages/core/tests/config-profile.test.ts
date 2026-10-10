import { describe, expect, it } from 'vitest';
import { profileFromConfig, type ServiceProfile } from '../src';

const config = { exe: 'D:\\Strata\\engine\\strata.exe', args: ['--native', 'weights.gguf'], cwd: 'D:\\Strata', model_name: '中文模型', port: 18081 };
const previous: ServiceProfile = { id: 'old', name: 'old', baseUrl: 'http://127.0.0.1:8080', installDir: 'D:\\Strata', configPath: 'D:\\Strata\\strata-old.json', managed: true, pythonPath: 'C:\\Python\\python.exe' };

describe('official model config imports', () => {
  it('uses the selected model, runtime directory and non-default port instead of the previous address', () => {
    expect(profileFromConfig('D:\\Strata\\strata-new.json', config, 'new', previous)).toEqual({ ...previous, id: 'new', name: '中文模型', baseUrl: 'http://127.0.0.1:18081', configPath: 'D:\\Strata\\strata-new.json' });
  });
  it('connects wildcard bind addresses through loopback, including IPv6', () => {
    expect(profileFromConfig('/opt/strata/model.json', { ...config, cwd: '/opt/strata', host: '0.0.0.0' }, 'a').baseUrl).toBe('http://127.0.0.1:18081');
    expect(profileFromConfig('/opt/strata/model.json', { ...config, cwd: '/opt/strata', host: '::' }, 'a')).toMatchObject({ baseUrl: 'http://[::1]:18081', managed: true });
    expect(profileFromConfig('/opt/strata/model.json', { ...config, cwd: '/opt/strata', host: '192.168.1.20' }, 'a')).toMatchObject({ baseUrl: 'http://192.168.1.20:18081', managed: false });
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
