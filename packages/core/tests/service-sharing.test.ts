import { describe, expect, it } from 'vitest';
import { buildSharingPreview, sharingClientExample, type ServiceSharingStatus } from '../src/service-sharing';
import { validateStartupConfiguration } from '../src/config-tuning';

const status: ServiceSharingStatus = { profileId: 'fixture', configRevision: 'a'.repeat(64), host: '127.0.0.1', port: 18081, hasServerKey: true, keyCount: 2, running: false, owned: false, restartRequired: false, liveHost: null, livePort: null, lanAddresses: ['192.168.1.3', 'fd00::3'], managementUrl: 'http://127.0.0.1:18081' };
describe('sharing review and safe client handoff', () => {
  it('previews real assigned IPv4 addresses, preserves arrays and never suggests restarting a stopped model', () => {
    const preview = buildSharingPreview(status, { expectedRevision: status.configRevision, host: '0.0.0.0', port: 19081, keyAction: 'keep' });
    expect(preview.urls).toEqual(['http://192.168.1.3:19081/v1']); expect(preview.keyCountAfterSave).toBe(2); expect(preview.restartRequired).toBe(false);
    const live = buildSharingPreview({ ...status, running: true }, { expectedRevision: status.configRevision, host: '0.0.0.0', port: 18081, keyAction: 'set', serverKey: 'server-secret' });
    expect(live.restartRequired).toBe(true); expect(live.keyCountAfterSave).toBe(1); expect(JSON.stringify(live)).not.toContain('server-secret');
  });
  it('requires auth for LAN and rejects ambiguous key operations', () => {
    expect(() => buildSharingPreview({ ...status, keyCount: 0 }, { expectedRevision: status.configRevision, host: '0.0.0.0', port: 18081, keyAction: 'keep' })).toThrow('SHARING_KEY_REQUIRED');
    expect(() => buildSharingPreview(status, { expectedRevision: status.configRevision, host: '0.0.0.0', port: 18081, keyAction: 'clear' })).toThrow('SHARING_KEY_REQUIRED');
    expect(() => buildSharingPreview(status, { expectedRevision: status.configRevision, host: '127.0.0.1', port: 18081, keyAction: 'keep', serverKey: 'hidden' })).toThrow('SHARING_OPTIONS_INVALID');
    expect(() => buildSharingPreview(status, { expectedRevision: status.configRevision, host: '127.0.0.1', port: 0, keyAction: 'keep' })).toThrow('SHARING_PORT_INVALID');
  });
  it('emits only ENV placeholders with quoted data for client examples', () => {
    const example = sharingClientExample('http://192.168.1.3:18081/v1', "model'quoted");
    expect(example).toContain('YOUR_STRATA_API_KEY'); expect(example).toContain('Bearer $STRATA_API_KEY'); expect(example).toContain("'\"'\"'");
    expect(() => sharingClientExample('http://key:secret@192.168.1.3:18081/v1')).toThrow(); expect(() => sharingClientExample('http://0.0.0.0:18081/v1')).toThrow();
  });
  it('accepts original string and string-array keys without modifying their structure', () => {
    for (const api_key of ['single', ['one', 'two']]) { const config = { api_key, args: ['--native', 'model'] }; const before = JSON.stringify(config); validateStartupConfiguration(config); expect(JSON.stringify(config)).toBe(before); }
    expect(() => validateStartupConfiguration({ api_key: ['one', 2] })).toThrow();
  });
});
