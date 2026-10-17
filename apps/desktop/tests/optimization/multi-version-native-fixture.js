// Multi-version layout from user feedback: Strata 0.1.38 → 0.1.44 installed side
// by side, every version folder holds strata-<model>.json for two models, and all
// of them share the shards and MTP layer in D:\AI\Strata-data. Synthetic only.
(() => {
  const fixture = window.__fixture;
  const data = 'D:\\AI\\Strata-data';
  const versions = ['0.1.38', '0.1.40', '0.1.42', '0.1.44'];
  const root = version => `D:\\AI\\Strata-${version}`;
  const models = [
    { tag: 'qwen3.6-35b-ud-q4_k_xl', name: 'Qwen3.6-35B-A3B UD-Q4_K_XL', weights: `${data}\\models\\Qwen3.6-35B-A3B-UD-Q4_K_XL-00001-of-00003.gguf`, context: '65536', bytes: 22.4 * 1024 ** 3 },
    { tag: 'qwen3.6-35b-iq2_xs', name: 'Qwen3.6-35B-A3B IQ2_XS', weights: `${data}\\models\\Qwen3.6-35B-A3B-IQ2_XS-00001-of-00002.gguf`, context: '131072', bytes: 11.1 * 1024 ** 3 },
  ];
  // 0.1.38 used a smaller context; 0.1.40 has a hand-edited KV setting.
  const context = (version, model) => version === '0.1.38' ? '32768' : model.context;
  const config = (version, model) => ({
    exe: `${root(version)}\\engine\\strata.exe`, cwd: root(version), tokenizer: 'pack\\tokenizer', log: `strata-${model.tag}.log`, model_name: model.name, port: 8080,
    args: ['--native', model.weights, '--mtp', `${data}\\mtp\\qwen3.6-mtp.gguf`, '--max-context', context(version, model), ...(version === '0.1.40' && model.tag.includes('iq2') ? ['--kv', 'q8'] : [])],
  });
  const day = 86400000, now = Date.UTC(2026, 9, 17, 9);
  const candidates = versions.flatMap((version, v) => models.map((model, m) => ({
    id: `mv-${version}-${m}`, name: `strata-${model.tag}`, installDir: root(version), pythonPath: `${root(version)}\\.venv\\Scripts\\python.exe`,
    configPath: `${root(version)}\\strata-${model.tag}.json`, modelPath: model.weights, modelBytes: model.bytes, modelGroupKey: `weights-${m}`,
    runtimeVersion: version, configModifiedAt: now - (versions.length - v) * 9 * day - m * 3600000, config: config(version, model), detectedPort: 8080, running: false, availability: 'ready', source: 'common',
  })));
  // The running model is a registered private copy of 0.1.44's UD-Q4_K_XL config.
  const current = models[0], currentRoot = root('0.1.44');
  fixture.profiles.splice(0, fixture.profiles.length, { id: 'a', name: current.name, baseUrl: 'http://127.0.0.1:8080', installDir: currentRoot, pythonPath: `${currentRoot}\\.venv\\Scripts\\python.exe`, configPath: 'C:\\Users\\fixture\\AppData\\Roaming\\io.strata.manager\\imports\\a\\config.json', managed: true });
  fixture.configs.a = config('0.1.44', current);
  const runtimes = versions.map(version => ({ installDir: root(version), pythonPath: `${root(version)}\\.venv\\Scripts\\python.exe`, runtimeVersion: version, readiness: 'ready', profile: { id: `runtime-${version}`, name: 'Strata', baseUrl: 'http://127.0.0.1:18081', installDir: root(version), pythonPath: '', configPath: '', managed: true } }));
  const fingerprint = (value, dir) => JSON.stringify(value).split(JSON.stringify(dir).slice(1, -1)).join('<install>');
  const currentPrints = models.map(model => fingerprint(config('0.1.44', model), currentRoot));
  const archivedPaths = new Set();
  fixture.multiVersion = { candidates, runtimes, archivedPaths };
  const base = window.__TAURI_INTERNALS__.invoke.bind(window.__TAURI_INTERNALS__);
  window.__TAURI_INTERNALS__.invoke = async (command, args = {}) => {
    if (command === 'discover_local') { fixture.calls.push({ command, args }); return structuredClone(candidates.filter(item => !archivedPaths.has(item.configPath))); }
    if (command === 'local_runtime_installation') { fixture.calls.push({ command, args }); return { detectedRuntimes: structuredClone(runtimes) }; }
    if (command === 'local_installation_details') return [{ profileId: 'a', originalConfigPath: `${currentRoot}\\strata-${current.tag}.json`, configModifiedAt: now - day, lastActivatedAt: now - 3600000, config: structuredClone(fixture.configs.a) }];
    if (command === 'plan_config_cleanup') {
      fixture.calls.push({ command, args });
      const items = candidates.filter(item => item.installDir !== args.currentInstallDir && !archivedPaths.has(item.configPath)).map(item => {
        const same = currentPrints.includes(fingerprint(item.config, item.installDir));
        return { profile: { id: `configuration-${item.id}`, name: item.name, baseUrl: 'http://127.0.0.1:8080', installDir: item.installDir, pythonPath: item.pythonPath, configPath: item.configPath, managed: false }, configPath: item.configPath, installDir: item.installDir, runtimeVersion: item.runtimeVersion, modelName: item.config.model_name, identical: same, identicalTo: same ? `${currentRoot}\\${item.configPath.split('\\').at(-1)}` : undefined };
      }).sort((a, b) => Number(b.identical) - Number(a.identical) || a.installDir.localeCompare(b.installDir));
      return { currentInstallDir: args.currentInstallDir, currentVersion: runtimes.find(item => item.installDir === args.currentInstallDir)?.runtimeVersion, items };
    }
    if (command === 'delete_configuration') { fixture.calls.push({ command, args }); archivedPaths.add(args.profile.configPath); return { archivedPath: `C:\\Users\\fixture\\AppData\\Roaming\\io.strata.manager\\config-trash\\${archivedPaths.size}.json` }; }
    if (command === 'plugin:dialog|open') return null;
    return base(command, args);
  };
})();
