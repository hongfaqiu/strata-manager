// Only isolated browser memory is changed. Production components/styles stay intact.
(() => {
  const fixture = window.__fixture, query = new URLSearchParams(location.search);
  const original = window.__TAURI_INTERNALS__.invoke;
  const language = query.get('language') === 'en' ? 'en' : 'zh-CN';
  Object.assign(fixture.store.settings, { language, languagePreference: query.get('view') === 'language-settings' ? 'system' : language, languageSetupCompleted: true });
  const deny = /^(?:connect_running_service|import_local|switch_local_service|ensure_local_service|start_service|stop_service|restart_service|take_over_service|write_config|copy_configuration|delete_configuration|delete_model|strata_stream|run_setup|install_runtime|prepare_app_update|tuning_start|tuning_apply)$/;
  window.__TAURI_INTERNALS__.invoke = async (command, args = {}) => {
    if (deny.test(command)) { fixture.documentation.forbiddenCalls.push({ command }); throw Error(`Forbidden screenshot operation: ${command}`); }
    if (command === 'get_system_language') { fixture.calls.push({command,args}); return {locales:[language === 'en' ? 'en-US' : 'zh-CN']}; }
    if (command === 'read_config_snapshot') { fixture.calls.push({command,args}); const id = args.profile?.id ?? args.profileId ?? 'a'; return {config:structuredClone(fixture.configs[id]),revision:`preview-${id}`}; }
    if (command === 'discover_local') {
      const rows = await original(command,args);
      return rows.map((row,index) => ({...row,
        ...(query.get('view')==='running-services'&&index===0?{id:'observed-existing-service',name:'Strata · '+(language==='en'?'Existing service':'已有服务'),configPath:'D:/AI/Strata/config/other-manager.json',detectedPort:19003}:{}),
        pid:row.running?99999:undefined,configModifiedAt:Date.UTC(2026,9,14),runtimeVersion:'0.1.43.1',config:{...fixture.configs[index?'b':'a'],port:index?19002:19001}}));
    }
    if(command==='analytics_query'){
      const response=await original(command,args),data=response.data,action=args.query?.action;
      if(action==='summary'){
        Object.assign(data,{startMs:args.query.startMs,endMs:args.query.endMs});
        Object.assign(data.inference,{prefillTokens:200704,prefillS:98,decodeS:540,cacheHitRate:.88,cacheRateSamples:128,expertCacheHitRate:.82,expertCacheSamples:128,prefillSpeedSamples:128});
        for(const [key,mean,p20] of [['ttftS',3.5,2.1],['durationS',32,20],['decodeTokS',34.6,29],['prefillTokS',2120,1800]])Object.assign(data[key],{mean,p20});
      }
      if(action==='trends'){
        const {startMs,endMs,bucketMs}=args.query;
        data.bucketMs=bucketMs;
        data.buckets=Array.from({length:Math.ceil((endMs-startMs)/bucketMs)},(_,index)=>{
          const count=3+Math.round((Math.sin(index*.65)+1)*5);
          return {startMs:startMs+index*bucketMs,requests:count,succeeded:count,failed:0,cancelled:0,interrupted:0,pending:0,inputTokens:count*4096,outputTokens:count*384,inputTokenSamples:count,outputTokenSamples:count,firstTokenS:3+Math.sin(index)*.7,firstTokenSamples:count,durationS:25+Math.cos(index)*8,durationSamples:count,decodeTokS:34+Math.sin(index)*5,decodeSamples:count,prefillTokS:2100+Math.sin(index)*300,prefillSamples:count,cacheHitRate:.88+Math.sin(index)*.06,cacheRateSamples:count,expertCacheHitRate:.82+Math.cos(index)*.03,expertCacheSamples:count};
        });
      }
      return response;
    }
    return original(command,args);
  };
})();
