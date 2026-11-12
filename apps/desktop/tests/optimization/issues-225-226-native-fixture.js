// #225 / #226 preview data layered over native-fixture.js. Synthetic paths and tasks only; nothing is started.
(() => {
  const previous = window.__TAURI_INTERNALS__.invoke;
  const fixture = window.__fixture;
  // A config written by an upstream setup (args + args_written) that Manager later edited (user_args): #226.
  fixture.configs.a = {
    exe: 'engine/strata.exe', cwd: 'C:\\fixture\\Strata', model_name: 'qwen3.8-flash-next-iq3_s', port: 19001,
    args: ['--native', 'models\\Qwen3.8-Flash-Next-IQ3_S-00001-of-00002.gguf', '--max-context', '163840', '--kv', 'int8', '--pcie-frac', '0.4'],
    args_written: ['--native', 'models\\Qwen3.8-Flash-Next-IQ3_S-00001-of-00002.gguf', '--max-context', '163840', '--kv', 'int8', '--pcie-frac', '0.4'],
    user_args: ['--pool-workers', '6'],
  };
  const now = Date.now();
  const tasks = [
    { id: 'ec8561cd-3cb9-446f-8b05-b18ab28db959', kind: 'setup', state: 'completed', message: '模型文件准备完成；“我的模型”里已有这个模型，但设置和这次准备的不同（上下文：现在 160K，这次 128K）。为了不覆盖你的设置，没有替换它。可以继续用现在的设置，或去改设置后重新检测', startedAt: now - 4 * 60000, finishedAt: now - 3 * 60000 },
    { id: '7d623540-99ad-4ce2-9e78-3d80c8af7e40', kind: 'setup', state: 'completed', message: '模型准备完成并已加入本机模型；可选择使用', startedAt: now - 9 * 60000, finishedAt: now - 8 * 60000 },
  ];
  const handoffs = [
    { taskId: tasks[0].id, status: 'needs-choice', profileId: 'a', error: tasks[0].message.replace('模型文件准备完成；', ''), differences: [{ field: 'context', current: '160K', prepared: '128K' }] },
    { taskId: tasks[1].id, status: 'registered', profileId: 'a' },
  ];
  if (new URLSearchParams(location.search).has('all')) handoffs[0].differences.push(
    { field: 'weights', current: 'Qwen3.8-Flash-Next-IQ3_S-00001-of-00002.gguf', prepared: 'Qwen3.8-Flash-Next-IQ3_XXS-00001-of-00002.gguf' },
    { field: 'images', current: 'false', prepared: 'true' });
  window.__TAURI_INTERNALS__.invoke = async (command, args = {}) => {
    if (command === 'list_tasks') return structuredClone(tasks);
    if (command === 'list_setup_handoffs') return structuredClone(handoffs);
    if (command === 'engine_help_flags') throw Error('fixture: engine --help is not run');
    if (command === 'environment_info') return { os: 'Windows 11 Pro', arch: 'x86_64', cpuName: 'fixture CPU', totalMemory: 128 * 2 ** 30, availableMemory: 96 * 2 ** 30, gpus: ['NVIDIA GeForce RTX 4090, 560.94, 24564 MiB'], python: null, git: null, appVersion: '0.2.46' };
    return previous(command, args);
  };
})();
