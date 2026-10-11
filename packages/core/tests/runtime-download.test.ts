import { afterEach, describe, expect, it, vi } from 'vitest';
import { getRuntimeDownloadPreferences, resolveRuntimeDownloadPreferences, runtimeDownloadSources, saveRuntimeDownloadPreferences } from '../src/runtime-download';
import { resolveRuntimeZipAsset, testRuntimeZipDownload } from '../src/bridge';
import type { RuntimeUpdateInfo } from '../src/runtime-types';

const release = (version = '0.1.43'): RuntimeUpdateInfo => ({
  checkedAt: 100, supportedVersion: version, supportedRevision: 'a'.repeat(40), latestVersion: version,
  updateAvailable: true, installable: true,
  assets: [{ name: 'strata-cuda12.zip', variant: 'cuda12', size: 123456, sha256: 'a'.repeat(64), url: `https://github.com/Niko1221/Strata/releases/download/v${version}/strata-cuda12.zip` }],
});
const assetName = 'strata-cuda12.zip';
afterEach(() => vi.unstubAllGlobals());

describe('saved runtime download choices', () => {
  it('follows automatic engine selection and the current official URL for each built-in source', () => {
    for (const source of runtimeDownloadSources) {
      const preferences = { mode: 'mirror' as const, sourceId: source.id };
      expect(resolveRuntimeDownloadPreferences(preferences, release())).toMatchObject({ requiresSelection: true, download: { downloadUrl: '' } });
      for (const version of ['0.1.43', '0.1.44']) {
        expect(resolveRuntimeDownloadPreferences(preferences, release(version), assetName)).toEqual({
          assetName, requiresSelection: false,
          download: { downloadUrl: source.urlTemplate.replace('{url}', release(version).assets[0]!.url) },
        });
      }
      expect(resolveRuntimeDownloadPreferences({ ...preferences, assetName: 'removed.zip' }, release(), assetName).requiresSelection).toBe(true);
    }
  });
  it('resolves engine compatibility through a read-only command without lifecycle authorization', async () => {
    const invoke = vi.fn(async () => release().assets[0]);
    vi.stubGlobal('window', { __TAURI_INTERNALS__: { invoke } });
    expect(await resolveRuntimeZipAsset('D:\\AI\\Strata')).toEqual(release().assets[0]);
    expect(invoke).toHaveBeenCalledExactlyOnceWith('resolve_runtime_zip_asset', { installDir: 'D:\\AI\\Strata' }, undefined);
  });
  it('binds local ZIP and literal mirror URL to the chosen official release', () => {
    const local = { mode: 'local' as const, assetName, releaseVersion: '0.1.43', localArchivePath: 'D:\\Downloads\\engine.zip' };
    expect(resolveRuntimeDownloadPreferences(local, release()).download.localArchivePath).toBe(local.localArchivePath);
    expect(resolveRuntimeDownloadPreferences(local, release('0.1.44'))).toEqual({ assetName, download: { localArchivePath: '' }, requiresSelection: true });
    const mirror = { mode: 'mirror' as const, assetName, releaseVersion: '0.1.43', mirrorUrl: 'https://mirror.example/0.1.43/engine.zip' };
    expect(resolveRuntimeDownloadPreferences(mirror, release()).requiresSelection).toBe(false);
    expect(resolveRuntimeDownloadPreferences(mirror, release('0.1.44'))).toEqual({ assetName, download: { downloadUrl: '' }, requiresSelection: true });
  });
  it('resolves mirror templates against the next official asset without carrying old URLs', () => {
    const preferences = { mode: 'mirror' as const, assetName, releaseVersion: '0.1.43', mirrorUrl: 'https://mirror.example/{version}/{asset}' };
    expect(resolveRuntimeDownloadPreferences(preferences, release('0.1.44')).download.downloadUrl).toBe('https://mirror.example/0.1.44/strata-cuda12.zip');
    expect(resolveRuntimeDownloadPreferences({ ...preferences, mirrorUrl: 'https://mirror.example/{url}' }, release('0.1.44')).download.downloadUrl).toBe(`https://mirror.example/${release('0.1.44').assets[0]!.url}`);
  });
  it('requires a matching asset and rejects unsafe or unknown mirror placeholders', () => {
    for (const mirrorUrl of ['http://mirror.example/{asset}', 'https://user:secret@mirror.example/{asset}', 'https://mirror.example/{asset}#part', 'https://mirror.example/{unknown}/{asset}', 'https://mirror.example/']) {
      expect(resolveRuntimeDownloadPreferences({ mode: 'mirror', assetName, releaseVersion: '0.1.43', mirrorUrl }, release())).toMatchObject({ download: { downloadUrl: '' }, requiresSelection: true });
    }
    expect(resolveRuntimeDownloadPreferences({ mode: 'mirror', assetName: 'removed.zip', mirrorUrl: 'https://mirror.example/{url}' }, release())).toMatchObject({ requiresSelection: true });
  });
  it('persists choices through the existing store without applying app settings or starting tasks', async () => {
    let saved: unknown = null;
    const calls: string[] = [];
    vi.stubGlobal('window', { __TAURI_INTERNALS__: { invoke: async (command: string, args: Record<string, unknown>) => {
      calls.push(command);
      expect(args.key).toBe('runtimeDownloadPreferences');
      if (command === 'store_set') { saved = args.value; return null; }
      if (command === 'store_get') return saved;
      throw new Error(command);
    } } });
    expect(await getRuntimeDownloadPreferences()).toEqual({ mode: 'official' });
    await saveRuntimeDownloadPreferences({ mode: 'mirror', assetName, releaseVersion: '0.1.43', mirrorUrl: ' https://mirror.example/{url} ', localArchivePath: 'discard.zip' });
    expect(await getRuntimeDownloadPreferences()).toEqual({ mode: 'mirror', assetName, releaseVersion: '0.1.43', mirrorUrl: 'https://mirror.example/{url}' });
    expect(calls).toEqual(['store_get', 'store_set', 'store_get']);
  });
  it('routes source checks only to the read-only native command without stop authorization', async () => {
    const invoke = vi.fn(async () => ({ source: 'local', sha256Verified: true }));
    vi.stubGlobal('window', { __TAURI_INTERNALS__: { invoke } });
    await testRuntimeZipDownload(assetName, { localArchivePath: ' D:\\Downloads\\engine.zip ' });
    expect(invoke).toHaveBeenCalledExactlyOnceWith('test_runtime_zip_download', { assetName, localArchivePath: 'D:\\Downloads\\engine.zip' }, undefined);
  });
});
