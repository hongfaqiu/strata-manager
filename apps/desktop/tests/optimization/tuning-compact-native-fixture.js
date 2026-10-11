// Extends the existing native fixture. All tuning jobs and mutations are held
// in this page's memory; no model, filesystem configuration or service is used.
(() => {
  const fixture = window.__fixture, internal = window.__TAURI_INTERNALS__, originalInvoke = internal.invoke;
  const query = new URLSearchParams(location.search);
  fixture.capability = 1;
  fixture.store.settings.language = query.get('language') === 'en' ? 'en' : 'zh-CN';
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
  internal.invoke = async (command, args = {}) => {
    const record = () => fixture.calls.push({ command, args: structuredClone(args) });
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
