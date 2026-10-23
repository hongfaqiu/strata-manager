// Strata version-choice fixture layered over the daily-experience fixture. Releases, packages and
// paths are synthetic; nothing is downloaded or installed. ?pin=0.2.1 pins the engine; ?latest=0.2.2
// makes a newer release available (so the pin has something to hold back).
(() => {
  const params = new URLSearchParams(location.search), previous = window.__TAURI_INTERNALS__.invoke;
  const current = '0.2.1', latest = params.get('latest') || current;
  const installDir = 'C:\\Users\\fixture\\AppData\\Roaming\\io.strata.manager\\runtimes\\release-3f2a\\Strata';
  if (params.get('pin')) window.__fixture.store.runtimePinnedVersion = params.get('pin');
  window.__fixture.store.settings.autoCheckUpdates = true;
  const releases = [
    ...(latest !== current ? [{ version: latest, engineVersion: '0.1.48', packaging: 'feed', publishedAt: '2026-10-18T09:00:00Z' }] : []),
    { version: '0.2.1', engineVersion: '0.1.47', packaging: 'feed', publishedAt: '2026-10-09T09:00:00Z' },
    { version: '0.2.0', engineVersion: '0.1.46', packaging: 'feed', publishedAt: '2026-09-27T09:00:00Z' },
    { version: '0.2.0-beta', packaging: 'feed', prerelease: true, publishedAt: '2026-09-15T09:00:00Z' },
    { version: '0.1.45', packaging: 'zip', publishedAt: '2026-09-02T09:00:00Z' },
    { version: '0.1.44', engineVersion: '0.1.44', packaging: 'zip', publishedAt: '2026-08-21T09:00:00Z' },
    { version: '0.1.43', packaging: 'zip', publishedAt: '2026-08-10T09:00:00Z' },
    { version: '0.1.12', packaging: 'zip', installable: false, publishedAt: '2026-05-02T09:00:00Z' },
  ].map(item => ({ tag: `v${item.version}`, name: `Strata ${item.version}`, prerelease: false, installable: true, releaseUrl: `https://github.com/example/strata/releases/tag/v${item.version}`, ...item }));
  const engines = { '0.2.2': '0.1.48', '0.2.1': '0.1.47', '0.2.0': '0.1.46' };
  const asset = version => ({ engineVersion: engines[version] ?? version, name: `strata-engine-${version}-windows-x64-cuda12.zip`, url: `https://github.com/example/strata/releases/download/v${version}/strata-engine-${version}-windows-x64-cuda12.zip`, size: 1_284_000_000, sha256: 'b3f1c0de'.repeat(8), variant: 'cuda12' });
  const info = (version, checkedAt) => ({ checkedAt, supportedVersion: current, supportedRevision: `v${current}`, latestVersion: version, releaseName: `Strata ${version}`, releaseUrl: `https://github.com/example/strata/releases/tag/v${version}`, publishedAt: releases.find(item => item.version === version)?.publishedAt, notes: `## Strata ${version}\n\n- 合成的发布说明，仅用于截图。`, assets: [asset(version)], installable: true, updateAvailable: version !== current });
  // 「已安装版本」: Manager's own versions, one the user installed, a leftover download and a failed install.
  const root = 'C:\\Users\\fixture\\AppData\\Roaming\\io.strata.manager';
  const GB = 2 ** 30, day = iso => Date.parse(`${iso}T09:00:00Z`);
  const entry = (dir, extra) => ({ installDir: dir, pythonPath: `${dir}\\.venv\\Scripts\\python.exe`, readiness: 'ready', owned: true, current: false, running: false, rollback: false, switching: false, profiles: [], cleanup: false, ...extra });
  const installed = [
    entry(installDir, { releaseVersion: current, engineVersion: '0.1.47', current: true, installedAt: day('2026-10-09'), lastUsedAt: day('2026-10-23'), protectedReason: '当前正在使用' }),
    entry(`${root}\\runtimes\\release-9c41\\Strata`, { releaseVersion: '0.2.0', engineVersion: '0.1.46', rollback: true, installedAt: day('2026-09-27'), lastUsedAt: day('2026-10-09') }),
    entry(`${root}\\runtimes\\release-1b7e\\Strata`, { releaseVersion: '0.1.45', engineVersion: '0.1.45', cleanup: true, installedAt: day('2026-09-02'), lastUsedAt: day('2026-09-27') }),
    entry(`${root}\\runtimes\\release-77d0\\Strata`, { releaseVersion: '0.1.43', engineVersion: '0.1.43', installedAt: day('2026-08-10'), lastUsedAt: day('2026-09-02'), profiles: [{ id: 'old-qwen', name: 'Qwen3-8B · 32K（旧配置）' }] }),
    entry('D:\\AI\\Strata', { engineVersion: '0.1.44', owned: false, installedAt: day('2026-08-21'), lastUsedAt: day('2026-08-30'), protectedReason: '不是 Manager 安装的目录，不会删除' }),
  ];
  const leftovers = [{ path: `${root}\\downloads\\strata-engine-0.2.1-windows-x64-cuda12.zip.part`, kind: 'partialDownload' }, { path: `${root}\\runtimes\\release-e012`, kind: 'failedInstall' }];
  const sizes = { [installed[0].installDir]: 2.14 * GB, [installed[1].installDir]: 2.08 * GB, [installed[2].installDir]: 1.93 * GB, [installed[3].installDir]: 1.86 * GB, [installed[4].installDir]: 1.79 * GB, [leftovers[0].path]: 0.62 * GB, [leftovers[1].path]: 1.12 * GB };
  window.__TAURI_INTERNALS__.invoke = async (command, args = {}) => {
    if (command === 'runtime_installed_versions') return { runtimes: structuredClone(installed), leftovers: structuredClone(leftovers), autoCleanup: window.__fixture.store.runtimeAutoCleanup ?? true, busy: false };
    if (command === 'runtime_installed_size') return Math.round(sizes[args.path] ?? 0);
    if (command === 'runtime_delete_version' || command === 'runtime_cleanup' || command === 'runtime_switch_version') throw new Error('预览夹具不会修改本机 Strata 版本');
    if (command === 'local_runtime_installation') return { detectedRuntimes: [{ installDir, pythonPath: `${installDir}\\.venv\\Scripts\\python.exe`, releaseVersion: current, runtimeVersion: '0.1.47', sourceRevision: `v${current}`, readiness: 'ready', profile: { id: 'runtime-1', name: 'Strata', baseUrl: 'http://127.0.0.1:8080', installDir, pythonPath: `${installDir}\\.venv\\Scripts\\python.exe`, configPath: '', managed: true } }] };
    if (command === 'environment_info') return { os: 'Windows 11 Pro 24H2', arch: 'x86_64', cpuName: 'AMD Ryzen 9 7950X', totalMemory: 96 * 2 ** 30, availableMemory: 71 * 2 ** 30, gpus: ['NVIDIA GeForce RTX 4090, 560.94, 24564 MiB'], python: null, git: null, appVersion: '0.2.10' };
    if (command === 'runtime_update_info') return info(latest, 1760900000000);
    if (command === 'runtime_release_versions') return { checkedAt: 1760900000000, versions: structuredClone(releases) };
    if (command === 'runtime_release_info') return info(String(args.version), 1760900100000);
    if (command === 'resolve_runtime_zip_asset') return asset(args.targetVersion || latest);
    return previous(command, args);
  };
})();
