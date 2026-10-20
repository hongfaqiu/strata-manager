// Extends the existing native fixture. All tuning jobs and mutations are held
// in this page's memory; no model, filesystem configuration or service is used.
(() => {
  const fixture = window.__fixture, internal = window.__TAURI_INTERNALS__, originalInvoke = internal.invoke;
  const query = new URLSearchParams(location.search);
  fixture.capability = 1;
  const languages = ['zh-CN', 'en', 'zh-TW', 'ja', 'ko', 'de', 'fr', 'es', 'pt', 'ru'];
  fixture.store.settings.language = languages.includes(query.get('language')) ? query.get('language') : 'zh-CN';
  const detail = '模型返回的补丁未通过测试样例的语法校验（隔离模拟）。';
  const recoveryError = '恢复原配置失败：隔离模拟的文件核验错误。';
  const resourceAssessment = { status: 'checked', dataScope: 'systemAndPrimaryGpu', sampleCount: 12, ramPeakBytes: 8 * 1024 ** 3, gpuPeakBytes: 4 * 1024 ** 3, ramTotalBytes: 64 * 1024 ** 3, gpuTotalBytes: 32 * 1024 ** 3, minimumRamHeadroomBytes: 1024 ** 3, minimumGpuHeadroomBytes: 256 * 1024 ** 2, note: 'Synthetic resource samples' };
  const tuning = { job: null, starts: [], cancels: [], applies: [], restores: [], detail, recoveryError };
  fixture.tuning = tuning;
  tuning.makeJob = (mode = 'running', request = {}) => {
    const failed = mode === 'failed', legacy = mode === 'legacy';
    const state = failed ? 'failed' : ['recommended', 'legacy'].includes(mode) ? 'completed' : mode;
    const full = !legacy && !request.scenes;
    const complete = !['running', 'checking', 'canceling'].includes(state);
    return {
      id: 'isolated-tuning-job', profileId: 'a', state, reportVersion: legacy ? 1 : 2,
      scope: full ? 'fullScenario' : 'requestDiagnostic', useCase: full ? request.useCase ?? 'agent' : undefined,
      contextLimit: request.contextLimit ?? 8192, includeVision: request.includeVision ?? false,
      restartBaseline: { poolWorkers: 4 }, scenes: request.scenes ?? ['chat', 'code', 'chinese'],
      rounds: request.rounds ?? 2, maxTokens: request.maxTokens ?? 1024,
      startedAt: Date.now() - 42000, updatedAt: Date.now(), ...(complete ? { finishedAt: Date.now() } : {}),
      completedRequests: complete ? 24 : 7, totalRequests: 24, currentStep: 'Synthetic fixture stage',
      baseline: { pcieFrac: 0.55, specMinP: 0.5 },
      candidates: [{ id: 'candidate-1', kind: 'request', pcieFrac: 0.7, specMinP: 0.5, resourceAssessment,
        evaluation: { gain: 0.12, drift: 0.01, pairs: 4, accepted: !failed, reason: failed ? 'semanticQualityFailed' : 'fullScenarioGain' } }],
      measurements: [], recommendedCandidateId: !failed && complete ? 'candidate-1' : null,
      identity: { model: 'Isolated synthetic model', engineVersion: 'fixture' }, configFingerprint: 'fixture-only', notes: [],
      ...(failed ? { error: `完整 Agent 质量检查失败：${detail}` } : {}),
      progress: { phase: complete ? 'finished' : 'candidate', candidateId: 'candidate-1', workloadKind: 'fullAgent', round: 0, completedWorkloads: complete ? 12 : 3, totalWorkloads: 12 },
      recovery: failed ? { state: 'failed', configurationRestored: false, serviceVerified: false, error: recoveryError }
        : complete ? { state: 'restored', configurationRestored: true, serviceVerified: true }
          : { state: 'pending', configurationRestored: false, serviceVerified: false },
      limits: { maxDurationSeconds: 7200, generationRequestLimit: 24, outputTokenUpperBound: 24576, recoveryDeadlineSeconds: 420 },
      workloadMeasurements: full ? [{ id: 'synthetic-full-agent', candidateId: 'candidate-1', round: 0, position: 'candidate', workloadId: 'fixture-agent', kind: 'fullAgent', freshlyLoaded: true,
        result: { benchmarkVersion: 'complete-workloads-v2', workloadId: 'fixture-agent', useCase: 'agent', kind: 'fullAgent',
          qualityPassed: !failed, complete: !failed, wallMs: 1200, firstTokenMs: 100, firstVisibleMs: 200,
          inputTokens: 512, outputTokens: 64, cachedTokens: 128, actualContextTokens: 512, requestCount: 2, tokenCountRequests: 1,
          finish: failed ? null : 'stop', qualityReason: failed ? 'qualityAgentPatchFailed' : null,
          qualityDetail: failed ? detail : null, qualityDiagnostic: failed ? { stage: 'patch_fixture', code: 'syntax', detail } : null,
          fullAgentWallMs: 1400, coldModelVerified: true, targetInputTokens: 512,
          resourcePeak: { scope: 'workload', dataScope: 'systemAndPrimaryGpu', sampleCount: 12, ramUsedBytes: 8 * 1024 ** 3, gpuMemoryUsedBytes: 4 * 1024 ** 3, telemetryAvailable: true },
          turns: [], limits: { maxGenerationRequests: 4, deadlineSeconds: 600, resourcesAreSampled: true, modelColdDoesNotProveOsCacheCold: true }
        } }] : [],
    };
  };
  tuning.setJob = mode => { tuning.job = tuning.makeJob(mode); };
  if (query.get('job')) tuning.setJob(query.get('job'));

  // Quick calibration mock data: an AMD (hip) card, so pcie_frac 0 is excluded.
  // finished: a fixed share (0.35) beat the configured 0.55 for short and long answers.
  // autoback: the config fixes 0.55, the engine's own share (-1) was as fast: the flag is removed.
  // nochange: nothing beat the current values. Every measurement mixes short chats with a 512-token answer.
  const calibration = { job: null, starts: [], cancels: [], live: null, switches: [] };
  fixture.calibration = calibration;
  const pcieValues = [0.2, 0.35, 0.55, 0.75, 0.9, 1.0];
  const pcieRate = { 0.2: 31.4, 0.35: 39.3, 0.55: 36.2, 0.75: 35.1, 0.9: 33.8, 1.0: 32.6 };
  const jitter = [-0.6, 0.4, 0.1];
  const samples = (values, rates, rounds) => values.flatMap(value => Array.from({ length: rounds }, (_, round) => { const rate = Math.round((rates[value] + jitter[(round + values.indexOf(value)) % 3]) * 10) / 10; return { value, round, rate, short: Math.round(rate * 1.06 * 10) / 10, long: Math.round(rate * 0.94 * 10) / 10 }; }));
  calibration.makeJob = (mode = 'running') => {
    const running = mode === 'running', nochange = mode === 'nochange', autoback = mode === 'autoback';
    const done = !running;
    const values = autoback ? [-1, ...pcieValues] : pcieValues;
    const rates = autoback ? { ...pcieRate, [-1]: 36.4, 0.35: 36.6 } : nochange ? { ...pcieRate, 0.35: 36.6 } : pcieRate;
    const pcieSamples = running ? samples(values, rates, 3).filter(sample => sample.round < 2 || values.indexOf(sample.value) < 3) : samples(values, rates, 3);
    const chosenPcie = autoback ? -1 : nochange ? 0.55 : 0.35;
    const specRates = nochange ? { 0.3: 35.4, 0.5: 36.2, 0.7: 35.9 } : { 0.3: 38.1, 0.5: 39.3, 0.7: 39.6 };
    const steps = [
      { kind: 'warmup', status: 'done', metric: 'decode', values: [], rounds: 2, requests: 6, samples: [] },
      { kind: 'prefillPipe', status: 'skipped', metric: 'prompt', values: [0, 1, 768, 1536, 3072, 6144], currentValue: 0, rounds: 3, requests: 0, samples: [], skippedReason: 'noLayerSplit' },
      { kind: 'pcieFrac', status: running ? 'running' : 'done', metric: 'decode', values, currentValue: 0.55, rounds: 3, requests: 54, samples: pcieSamples, excluded: [{ value: 0, reason: 'amdPcieZero' }], ...(done ? { best: nochange || autoback ? 0.35 : 0.35, chosen: chosenPcie } : {}) },
      { kind: 'specMinP', status: running ? 'pending' : 'done', metric: 'decode', values: [0.3, 0.5, 0.7], currentValue: 0.5, rounds: 3, requests: 27, samples: running ? [] : samples([0.3, 0.5, 0.7], specRates, 3), ...(done ? { best: 0.7, chosen: 0.5 } : {}) },
      { kind: 'confirm', status: running ? 'pending' : nochange ? 'skipped' : 'done', metric: 'decode', values: [], rounds: 3, requests: 18, samples: running || nochange ? [] : [{ value: 0, round: 0, rate: 36.1 }, { value: 1, round: 0, rate: 39.2 }, { value: 0, round: 1, rate: 36.3 }, { value: 1, round: 1, rate: 39.4 }, { value: 0, round: 2, rate: 36.2 }, { value: 1, round: 2, rate: 39.3 }], ...(nochange ? { skippedReason: 'sameAsCurrent' } : {}) },
    ];
    const completed = running ? 6 + pcieSamples.length * 3 : 105;
    return {
      id: 'isolated-calibration-job', profileId: 'a', kind: 'quickCalibrate', state: running ? 'running' : 'completed',
      startedAt: Date.now() - (running ? 214000 : 486000), updatedAt: Date.now(), ...(done ? { finishedAt: Date.now() } : {}),
      backend: 'hip', layerSplit: false, rounds: 3, minGain: 0.03, workload: 'general', goal: 'balanced', pcieFlag: true, pcieAuto: autoback, enginePcieFrac: 0.55,
      baseline: { pcieFrac: 0.55, specMinP: 0.5 },
      ...(done ? { candidate: { pcieFrac: chosenPcie, specMinP: 0.5 }, recommended: { pcieFrac: chosenPcie, specMinP: 0.5 } } : {}),
      settings: done && !nochange ? { '--pcie-frac': autoback ? null : '0.35' } : {},
      ...(done && !nochange && !autoback ? { gain: 0.0856, baseRate: 36.2, tunedRate: 39.3, baseRates: { short: 38.4, long: 34.1 }, tunedRates: { short: 41.6, long: 37.1 }, verdict: 'faster' } : {}),
      ...(autoback ? { gain: 0.0055, baseRate: 36.2, tunedRate: 36.4, baseRates: { short: 38.4, long: 34.1 }, tunedRates: { short: 38.5, long: 34.3 }, verdict: 'autoPreferred' } : {}),
      ...(nochange ? { baseRate: 36.2, baseRates: { short: 38.4, long: 34.1 }, verdict: 'belowMinGain' } : {}),
      steps, completedRequests: completed, totalRequests: 105,
      restartSuggestions: [{ poolWorkers: 13 }, { poolWorkers: 10 }, { adaptEvery: 1, adaptSwaps: 80, adaptDecay: 0.97 }, { adaptEvery: 1, adaptSwaps: 160, adaptDecay: 0.97 }],
      identity: { model: 'Isolated synthetic model' }, configFingerprint: JSON.stringify(fixture.configs.a), notes: [],
      ...(done ? { liveLog: [
        { at: Date.now() - 400000, key: 'warmup', detail: {} },
        { at: Date.now() - 300000, key: 'stepWinner', detail: { step: 'pcieFrac', chosen: chosenPcie } },
        { at: Date.now() - 200000, key: 'stepWinner', detail: { step: 'specMinP', chosen: 0.5 } },
        { at: Date.now() - 60000, key: 'finished', detail: nochange ? {} : { gain: 0.0856 } },
      ] } : {}),
    };
  };
  calibration.makeLive = job => {
    const at = Date.now();
    const pcie = job.steps.find(step => step.kind === 'pcieFrac');
    const log = [
      { at: at - 212000, key: 'waitingForIdle', detail: {} },
      { at: at - 200000, key: 'warmup', detail: {} },
      ...pcie.samples.map((sample, index) => ({ at: at - 190000 + index * 5200, key: 'sample', detail: { step: 'pcieFrac', value: sample.value, round: sample.round + 1, rate: sample.rate } })),
    ];
    return { jobId: job.id, stepKey: 'pcieFrac', stepIndex: 2, stepTotal: 4, parameters: { pcieFrac: 0.75, specMinP: 0.5, value: 0.75 }, round: 3, rounds: 3,
      completedUnits: job.completedRequests, totalUnits: job.totalRequests, runningSince: job.startedAt, etaMs: 271000,
      request: { startedAt: at - 1900, deltas: 72, firstTokenMs: 210, tokS: 35.4 }, lastTokS: 35.0, log, updatedAt: at };
  };
  // Config facts that predate the calibration (they are part of its fingerprint).
  const lowHealth = query.get('health') === 'low';
  if (query.get('calibration') === 'autoback') fixture.configs.a.args.push('--pcie-frac', '0.55');
  if (lowHealth) fixture.configs.a.args.push('--max-context', '131072', '--expert-cache', '900');
  // failedEarlier: a run from an older Manager that the observer gate refused (Strata 0.2.0 before the
  // observer supported it). It ended two hours before the page opened, so it is history, not a current error.
  calibration.makeFailed = (error, endedAt) => ({ ...calibration.makeJob('running'), state: 'failed', startedAt: endedAt - 1500, updatedAt: endedAt, finishedAt: endedAt,
    completedRequests: 0, error, steps: calibration.makeJob('running').steps.map(step => ({ ...step, status: step.status === 'skipped' ? 'skipped' : 'pending', samples: [] })) });
  const legacyObserverError = '服务观察器版本、心跳或持久化状态不完整，保留当前服务';
  const unsupportedObserverError = '这个 Strata 版本的服务端还不在统计观察器的兼容列表里，无法安全暂停请求。请把 Strata Manager 更新到最新版本，然后重启这个模型服务';
  if (query.get('calibration') === 'failedEarlier') calibration.job = calibration.makeFailed(legacyObserverError, Date.now() - 2 * 3600_000);
  else if (query.get('calibration')) { calibration.job = calibration.makeJob(query.get('calibration')); if (calibration.job.state === 'running') calibration.live = calibration.makeLive(calibration.job); }
  // observer=unsupported: the gate refuses a new run (an unsupported Strata server), so the failure is current.
  calibration.startFailure = query.get('observer') === 'unsupported' ? unsupportedObserverError : null;
  // The config was edited elsewhere after calibration started: its revision no longer matches the job fingerprint.
  if (query.get('configEdited')) fixture.configs.a.args.push('--stats');
  // Health check inputs: the running engine's INFO facts and free RAM (synthetic).
  const engineInfo = lowHealth ? { model: 'Fixture A', max_context: 131072, context: 131072, kv_resident: 0, vram_free_mib: 410, pcie_frac: 0.55, spec_min_p: 0.5 }
    : { model: 'Fixture A', max_context: 32768, context: 32768, kv_resident: 0, vram_free_mib: 3180, pcie_frac: 0.55, spec_min_p: 0.5 };
  const hardware = { sampledAt: Date.now(), totalMemoryBytes: 64 * 1024 ** 3, availableMemoryBytes: 41 * 1024 ** 3, gpus: [{ id: 0, name: 'AMD Radeon AI PRO R9700', vendor: 'amd', totalBytes: 32 * 1024 ** 3, availableBytes: 3 * 1024 ** 3, source: 'fixture' }], cpuName: 'Fixture CPU', cpuIsa: 'avx2', wsl: false, managedServiceRunning: true };
  // Switching versions is allowed only when a case asks for it (&switch=1); it is recorded, never started.
  fixture.allowSwitch = query.get('switch') === '1';
  internal.invoke = async (command, args = {}) => {
    const record = () => fixture.calls.push({ command, args: structuredClone(args) });
    if (command === 'supervisor_status') {
      const status = await originalInvoke(command, args);
      return fixture.capability ? { ...status, capabilities: { ...(status.capabilities ?? {}), quickCalibration: 1, tuningLive: 1 } } : status;
    }
    if (command === 'strata_request' && args.path?.startsWith('/metrics')) { record(); return { live: { state: 'idle' }, engine: { ...engineInfo }, hardware: { gpu_util: 3 }, requests: [] }; }
    if (command === 'assess_setup_resources') { record(); return { status: 'suggested', estimate: true, sampledAt: Date.now(), hardware, ram: { baselineBytes: null, expertBytes: null, longContextBytes: null, mode: 'unknown' }, kv: { streaming: null, streamingRamBytes: null }, slots: { count: 1, perSlotVramBytes: null, totalVramBytes: null }, recommendations: { context: null, parallel: null }, reasons: [], unknowns: [], sourceRevision: 'fixture' }; }
    if (command === 'switch_local_service' && fixture.allowSwitch) {
      record(); calibration.switches.push(args.profileId);
      for (const id of Object.keys(fixture.configs)) fixture.serviceStatuses[id] = { profileId: id, running: id === args.profileId, owned: id === args.profileId, pid: id === args.profileId ? 99999 : null, phase: id === args.profileId ? 'ready' : 'stopped' };
      return;
    }
    if (command === 'calibrate_status') { record(); return args.profileId === 'a' ? structuredClone(calibration.job) : null; }
    if (command === 'calibrate_start') { record(); calibration.starts.push(structuredClone(args)); if (calibration.startFailure) { calibration.job = calibration.makeFailed(calibration.startFailure, Date.now()); calibration.live = null; return structuredClone(calibration.job); } calibration.job = calibration.makeJob('running'); calibration.live = calibration.makeLive(calibration.job); return structuredClone(calibration.job); }
    if (command === 'calibrate_cancel') { record(); calibration.cancels.push(structuredClone(args)); calibration.job.state = 'canceled'; calibration.job.finishedAt = Date.now(); calibration.job.error = undefined; calibration.live = null; return; }
    if (command === 'tuning_live') {
      record();
      if (calibration.live && args.jobId === calibration.live.jobId) return structuredClone(calibration.live);
      if (tuning.job && args.jobId === tuning.job.id && ['running', 'checking', 'canceling'].includes(tuning.job.state)) return { jobId: tuning.job.id, stepKey: 'candidate', stepIndex: 1, stepTotal: 1, parameters: { candidateId: 'candidate-1', workloadKind: 'fullAgent', pcieFrac: 0.7, specMinP: 0.5 }, round: 1, rounds: 2, completedUnits: 3, totalUnits: 12, runningSince: tuning.job.startedAt, etaMs: 640000, request: { startedAt: Date.now() - 1200, deltas: 40, firstTokenMs: 320, tokS: 33.2 }, lastTokS: 32.8, log: [{ at: Date.now() - 30000, key: 'workloadDone', detail: { candidateId: 'candidate-1', position: 'baselineBefore', workloadKind: 'coldInput', round: 1, wallMs: 21400 } }], updatedAt: Date.now() };
      return null;
    }
    if (command === 'tuning_status') { record(); return args.profileId === 'a' ? structuredClone(tuning.job) : null; }
    if (command === 'tuning_start') {
      record(); tuning.starts.push(structuredClone(args)); tuning.job = tuning.makeJob('running', args.request); return structuredClone(tuning.job);
    }
    if (command === 'tuning_cancel') {
      record(); tuning.cancels.push(structuredClone(args)); tuning.job.state = 'canceled'; tuning.job.finishedAt = Date.now();
      tuning.job.recovery = { state: 'restored', configurationRestored: true, serviceVerified: true }; return;
    }
    if (command === 'tuning_apply') {
      record(); tuning.applies.push(structuredClone(args)); tuning.job.state = 'applied'; return structuredClone(tuning.job);
    }
    if (command === 'tuning_restore') {
      record(); tuning.restores.push(structuredClone(args)); tuning.job.state = 'restored'; return structuredClone(tuning.job);
    }
    return originalInvoke(command, args);
  };
})();
