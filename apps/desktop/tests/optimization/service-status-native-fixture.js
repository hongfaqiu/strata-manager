// In-memory UI evidence only. Does not connect to services or access credentials.
(() => {
  const fixture = window.__fixture, invoke = window.__TAURI_INTERNALS__.invoke;
  const query = new URLSearchParams(location.search);
  fixture.unloaded = query.has('unloaded');
  fixture.external = query.has('external');
  const job = { id:'fixture-failure',profileId:'a',state:'failed',scenes:['chat'],rounds:2,maxTokens:1024,startedAt:Date.now(),updatedAt:Date.now(),finishedAt:Date.now(),completedRequests:2,totalRequests:36,currentStep:'finished',baseline:{pcieFrac:.55,specMinP:.5},candidates:[],measurements:[],workloadMeasurements:[],recommendedCandidateId:null,identity:{},configFingerprint:'fixture',notes:[],scope:'fullScenario',useCase:'agent',contextLimit:8192,progress:{phase:'finished',completedWorkloads:1,totalWorkloads:36},recovery:{state:'failed',configurationRestored:true,serviceVerified:false,error:'恢复未通过核验'},error:'完整 Agent 补丁未通过语义验收：输入列表被修改；恢复未通过核验' };
  window.__TAURI_INTERNALS__.invoke = async (command,args={}) => {
    if (command === 'tuning_status' && query.has('failed')) { fixture.calls.push({command,args});return args.profileId === 'a' ? job : null; }
    if (command === 'tuning_history') { fixture.calls.push({command,args});return query.has('failed') ? [job] : []; }
    if (command === 'strata_request' && ['load','unload'].some(name=>args.path===`/${name}`) && args.method === 'POST') { fixture.calls.push({command,args});fixture.unloaded=args.path==='/unload';return {loaded:!fixture.unloaded}; }
    const value = await invoke(command,args);
    if (command === 'service_status' && fixture.external && value.running) return {...value,owned:false};
    if (command === 'strata_request' && args.path === '/health') return {...value,loaded:!fixture.benchmark.stopped&&!fixture.unloaded};
    if (command === 'strata_request' && args.path === '/metrics') return {...value,live:{...value.live,state:fixture.unloaded?'unloaded':value.live.state}};
    return value;
  };
})();
