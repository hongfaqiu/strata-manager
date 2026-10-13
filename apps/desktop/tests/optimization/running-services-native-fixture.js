// Synthetic native IO only. This fixture cannot discover or mutate a real service.
window.__runningFixture = { calls: [], actions: [], health: { service: 'strata', status: 'ok', loaded: false, model: 'qwen-fixture-IQ3_S' } };
window.__TAURI_INTERNALS__ = {
  async invoke(command, args = {}) {
    window.__runningFixture.calls.push({ command, args: structuredClone(args) });
    if (command === 'strata_request' && args.method === 'GET' && args.path === '/health') return structuredClone(window.__runningFixture.health);
    throw Error(`Forbidden running-service fixture operation: ${command}`);
  },
};
