// All native state is synthetic; no supervisor, model, vault or host configuration is touched.
(() => {
  const original=window.__TAURI_INTERNALS__.invoke,f=window.__fixture,params=new URLSearchParams(location.search);
  f.currentVersion=params.get('version')||'0.1.7';f.sharing={profileId:'a',configRevision:'a'.repeat(64),host:'127.0.0.1',port:19001,hasServerKey:true,keyCount:2,running:!f.stopped,owned:!f.stopped,restartRequired:false,liveHost:'127.0.0.1',livePort:19001,lanAddresses:['192.0.2.10'],managementUrl:'http://127.0.0.1:19001'};
  f.dailyAttempts=0;
  // Explicit download-design fixtures stay in-memory; persistence is scoped to this tab's case.
  const downloadCase=params.has('download'),downloadTasks=[];
  const downloadStoreKey=`model-download-fixture-${params.get('case')||'default'}`;
  if(downloadCase){try{const value=sessionStorage.getItem(downloadStoreKey);if(value)f.store.modelDownloadDefaultsV1=JSON.parse(value);}catch{}}
  if(params.has('download-corrupt'))f.store.modelDownloadDefaultsV1={schemaVersion:999,options:{source:'bad'},runtime:null};
  const publishDownloadEvidence=()=>{if(downloadCase)document.documentElement.dataset.downloadFixtureEvidence=JSON.stringify({defaults:f.store.modelDownloadDefaultsV1??null,settingsWrites:f.calls.filter(call=>call.command==='store_set'&&call.args.key==='modelDownloadDefaultsV1').length,requests:f.calls.filter(call=>call.command==='run_setup').map(call=>call.args),lifecycle:f.calls.filter(call=>/^(start_service|switch_local_service|ensure_local_service|restart_service|stop_service)$/.test(call.command)).map(call=>call.command)});};
  publishDownloadEvidence();
  if(params.has('history')) {
    const options={kind:'suite',scenarios:['short'],prompt:'Fixture prompt',rounds:1,maxTokens:256,inputChars:8192,conversationTurns:3,warmup:false,mode:'unique',timeoutMs:60000,concurrency:1,stressPattern:'steady',stressLimit:'requests',requestLimit:1,durationMs:60000,stageDurationMs:10000,requestDelayMs:0,stopOnError:true};
    const report=(id,speed,offset)=>({schemaVersion:3,id,profileId:'a',profileName:'Fixture A',baseUrl:'http://127.0.0.1:19001',model:'Fixture A',startedAt:Date.now()-offset,finishedAt:Date.now()-offset+1000,elapsedMs:1000,measurementElapsedMs:1000,options:{...options},state:'completed',stopReason:'completed',samples:[{index:1,scenario:'short',stage:1,concurrency:1,worker:0,conversationId:null,turn:1,inputChars:50,maxTokens:256,warmup:false,state:'completed',model:'Fixture A',startedAt:Date.now()-offset,ttftMs:200,firstVisibleMs:300,wallMs:1000,promptTokens:10,completionTokens:20,cachedTokens:5,prefillTokS:100,decodeTokS:speed,output:'Fixture output',finishReason:'stop'}],stages:[{index:1,concurrency:1,startedAt:1,finishedAt:1001,elapsedMs:1000}],telemetry:[{at:1,elapsedMs:0,active:1,queued:0,running:1,cpuUtil:20,gpuUtil:30,gpuMemoryUsed:4*2**30,ramUsed:8*2**30,gpuTemperature:50}],hardware:{cpu:'Fixture CPU'},engine:{version:'0.1.43.1'}});
    f.store.benchmarkReportsV1=[report('fixture-current',24,10000),report('fixture-baseline',20,60000)];
  }
  const at=Date.now()-1000;
  const diagnostic={profileId:'a',attemptStartedAt:at,failedAt:at+400,phase:'starting',category:'port',confidence:'confirmed',code:'STARTUP_PORT_IN_USE',message:'隔离夹具：端口被另一个进程占用。',evidence:[{source:'startupError',at:at+400,message:'Fixture AddrInUse'}],actions:['openNetwork','viewLogs','exportDiagnostics'],processRunning:false};
  if(params.has('catalog-showcase'))for(const profile of f.profiles??[]){profile.installDir='D:/AI/Strata';profile.name='Swift-Qwen3.8-Flash-Next-GSQ-RCO-IQ3_S';}
  window.__TAURI_INTERNALS__.invoke=async(command,args={})=>{
    // Catalog showcase: a realistic machine, one local model and one live download, so the catalog's live fit and progress are visible.
    if(params.has('catalog-showcase')){
      if(command==='environment_info')return{os:'Windows',arch:'x86_64',cpuName:'AMD Ryzen 9 7950X',totalMemory:96*2**30,availableMemory:34*2**30,gpus:['NVIDIA GeForce RTX 4080 SUPER'],python:'3.11.9',git:'2.46.0',appVersion:f.currentVersion};
      if(command==='setup_disk_preflight')return{status:'ready',dataDirectory:'D:/AI/Strata',modelDirectory:'D:/AI/Strata/models',modelDownloadBytesEstimate:Math.round(66.4*2**30),reusableModelBytes:0,additionalBytesEstimate:Math.round(66.4*2**30),estimate:true,volumes:[{directory:'D:/AI/Strata',mountPoint:'D:',availableBytes:412*2**30,requiredAdditionalBytesEstimate:Math.round(66.4*2**30)}],reason:'',source:'showcase'};
      if(command==='list_local_models')return[{name:'Swift-Qwen3.8-Flash-Next-GSQ-RCO-IQ3_S',configPath:'D:/AI/Strata/strata-swift-iq3_s.json',modelPath:'D:/AI/Strata/models/swift-iq3_s',sizeBytes:Math.round(83.6*2**30)}];
      if(command==='list_tasks')return[...await original(command,args),{id:'download-showcase-1',kind:'setup',state:'running',message:'Swift 1.5 IQ3_XXS 31.2 / 75.8 GB',startedAt:Date.now()-20*60000}];
    }
    if(command==='service_status'){const value=await original(command,args);return{...value,startedAt:value.startedAt??(value.running?1:undefined)};}
    if(downloadCase)queueMicrotask(publishDownloadEvidence);
    if(downloadCase&&command==='store_set'&&args.key==='modelDownloadDefaultsV1'){
      if(params.has('download-save-error')){f.calls.push({command,args:structuredClone(args)});throw Error('Fixture download settings could not be saved');}
      await original(command,args);sessionStorage.setItem(downloadStoreKey,JSON.stringify(args.value));publishDownloadEvidence();return;
    }
    if(downloadCase&&command==='run_setup'){
      f.calls.push({command,args:structuredClone(args)});
      const task={id:`download-fixture-${downloadTasks.length+1}`,kind:'setup',state:'running',message:'隔离样例：正在下载模型文件',startedAt:Date.now()};downloadTasks.push(task);return structuredClone(task);
    }
    if(downloadCase&&command==='list_tasks')return [...await original(command,args),...structuredClone(downloadTasks)];
    if(downloadCase&&command==='cancel_task'&&downloadTasks.some(task=>task.id===args.taskId)){f.calls.push({command,args:structuredClone(args)});const task=downloadTasks.find(task=>task.id===args.taskId);task.state='cancelled';task.finishedAt=Date.now();return;}
    if(downloadCase&&command==='read_task_logs'&&String(args.taskId).startsWith('download-fixture-'))return[{timestamp:Date.now(),level:'stdout',message:'Fixture: download 12.4 GB / 66.4 GB. No network or model activity.'}];
    if(command==='strata_request'&&args.method&&args.method!=='GET'&&/^\/(?:v1\/)?(?:load|unload|vram)(?:[?\/]|$)/.test(args.path)){f.calls.push({command,args:structuredClone(args)});throw Error('Forbidden fixture lifecycle request');}
    if(command==='benchmark_identity'){
      f.calls.push({command,args:{profile:args.profile}});
      const bytes=new Uint8Array(await crypto.subtle.digest('SHA-256',new TextEncoder().encode(JSON.stringify(f.configs[args.profile.id]??{}))));
      return{schemaVersion:1,capturedAt:Date.now(),process:{pid:99999,startedAt:1,running:!f.stopped},engineProcess:f.stopped?null:{pid:99999,startedAt:1},runtime:{strength:'metadata',fingerprint:'fixture-runtime'},model:{strength:'metadata',fingerprint:'fixture-model'},savedConfigurationHash:'fixture-config',effectiveStartupHash:[...bytes].map(b=>b.toString(16).padStart(2,'0')).join(''),effectiveVerified:!f.stopped,hardwareSignature:{cpuName:'Fixture CPU',totalMemoryBytes:64*2**30,gpus:[{id:0,name:'Fixture GPU',totalBytes:32*2**30}]}};
    }
    if(command==='strata_request'&&args.path==='/metrics'){const value=await original(command,args);return{...value,engine:{...value.engine,version:'0.1.43.1',logit_bias:1},live:{...value.live,parallel:1}};}
    if(command==='strata_stream') {
      f.calls.push({command,args:{body:structuredClone(args.body)}});
      const tool=args.body.tools?.length,vision=Array.isArray(args.body.messages?.[0]?.content);
      const chunk=tool?{id:'fixture-response',request_id:'fixture-request',choices:[{delta:{tool_calls:[{index:0,id:'fixture-tool',type:'function',function:{name:'strata_api_check',arguments:'{"value":"strata-ok"}'}}]},finish_reason:'tool_calls'}]}:{id:'fixture-response',request_id:'fixture-request',choices:[{delta:{content:vision?'red':'STRATA_API_OK'},finish_reason:'stop'}],usage:{prompt_tokens:8,completion_tokens:4}};
      await new Promise(resolve=>setTimeout(resolve,150));
      f.deliverChannel(args.onEvent,{kind:'data',data:`data: ${JSON.stringify(chunk)}\n\ndata: [DONE]\n\n`});f.deliverChannel(args.onEvent,{kind:'done'});return;
    }
    if(command==='cancel_stream'){f.calls.push({command,args});return;}
    if(command==='strata_request'&&args.path.startsWith('/health')){const value=await original(command,args);return{...value,images:true};}
    if(command==='assess_setup_resources') { f.calls.push({command,args:structuredClone(args)});return {status:args.request.context>131072?'risk':'suggested',estimate:true,sampledAt:Date.now(),hardware:{sampledAt:Date.now(),cpuName:'Fixture CPU',totalMemoryBytes:64*2**30,availableMemoryBytes:48*2**30,gpus:[{id:0,vendor:'nvidia',name:'Fixture GPU',totalBytes:32*2**30,availableBytes:24*2**30,source:'fixture'}],cpuIsa:'avx2',wsl:false,managedServiceRunning:!f.stopped},ram:{baselineBytes:48*2**30,expertBytes:40*2**30,longContextBytes:64*2**30,mode:'normal'},kv:{streaming:true,streamingRamBytes:args.request.context*8192},slots:{count:args.request.parallel,perSlotVramBytes:2**30,totalVramBytes:args.request.parallel*2**30},recommendations:{context:131072,parallel:1},reasons:[{code:'estimate_scope',severity:'info'}],unknowns:[],sourceRevision:'a0116b2782a5b82622358c04a06496485d12b2d6'}; }
    if(command==='service_sharing_status'){f.calls.push({command,args:{profile:args.profile}});return structuredClone({...f.sharing,profileId:args.profile.id});}
    if(command==='set_service_auth'){f.calls.push({command,args:{profile:args.profile,request:{...args.request,serverKey:args.request.serverKey?'[redacted]':undefined}}});if(args.request.expectedRevision!==f.sharing.configRevision)throw Error('CONFIG_REVISION_CONFLICT');const q=args.request;Object.assign(f.sharing,{host:q.host,port:q.port,keyCount:q.keyAction==='keep'?f.sharing.keyCount:q.keyAction==='set'?1:0,configRevision:'b'.repeat(64),restartRequired:f.sharing.running});f.sharing.hasServerKey=f.sharing.keyCount>0;return{status:structuredClone(f.sharing),restartRequired:f.sharing.restartRequired,clientCredentialNeedsUpdate:q.keyAction!=='keep'};}
    if(command==='switch_local_service'&&params.has('diagnostic')){f.dailyAttempts++;f.calls.push({command,args});throw JSON.stringify({code:diagnostic.code,message:diagnostic.message,details:{startupDiagnostic:{...diagnostic,attemptStartedAt:Date.now()-5,failedAt:Date.now()}}});}
    if(command==='supervisor_status'){const value=await original(command,args);if(params.has('diagnostic'))value.startupFailures=[diagnostic];return value;}
    if(command==='strata_request'&&args.path==='/v1/status'){f.calls.push({command,args});return{service:'strata',dialects:['/v1/chat/completions','/v1/messages'],tools:true,structured_output:{formats:['json_object']}};}
    if(command==='chat_runtime_evidence')return{verified:true,pid:99999,startedAt:1,promptCache:4};
    if(command==='setup_disk_preflight'){f.calls.push({command,args:structuredClone(args)});if(downloadCase){const status=params.get('download-disk')||'ready';return{status,dataDirectory:`${args.profile.installDir}/models`,modelDirectory:`${args.profile.installDir}/models/${args.model}`,modelDownloadBytesEstimate:66400000000,reusableModelBytes:0,additionalBytesEstimate:120*2**30,estimate:true,volumes:[{directory:args.profile.installDir,mountPoint:null,availableBytes:status==='unknown'?null:(status==='insufficient'?10:200)*2**30,requiredAdditionalBytesEstimate:120*2**30}],reason:'Isolated disk fixture',source:'fixture'};}return{status:'ready',dataDirectory:'fixture',modelDirectory:'fixture',modelDownloadBytesEstimate:1,reusableModelBytes:0,additionalBytesEstimate:1,estimate:true,volumes:[],reason:'fixture',source:'fixture'};}
    return original(command,args);
  };
})();

// Presentation controls are simulated independently of model/service lifecycle.
(() => {
  const f = window.__fixture, previous = window.__TAURI_INTERNALS__.invoke;
  let state = { mode: 'floating', visible: false, active: false, supported: true, message: '浏览器预览：模拟监控显示状态' };
  window.__TAURI_INTERNALS__.invoke = async (command, args = {}) => {
    if (command === 'monitor_mode_status') return { ...state };
    if (['set_monitor_visibility', 'set_monitor_mode', 'open_monitor_window'].includes(command)) {
      const visible = command === 'set_monitor_visibility' ? args.visible : true;
      const mode = command === 'open_monitor_window' ? 'floating' : args.mode;
      state = { ...state, mode, visible, active: visible && mode === 'taskbar' };
      f.calls.push({ command, args: structuredClone(args) });
      f.emitEvent('monitor-mode-status', { ...state });
      return { ...state };
    }
    return previous(command, args);
  };
})();
