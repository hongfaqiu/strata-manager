// Synthetic native boundary for language acceptance; no user storage or services.
const params = new URLSearchParams(location.search);
const storageKey = 'strata-language-fixture-' + (params.get('case') ?? 'default');
window.__fixture.profiles.length = 0;
Object.assign(window.__fixture.store,{activeProfile:'',conversations:[],activeConversationIds:{}});
const persisted = sessionStorage.getItem(storageKey);
if (persisted) window.__fixture.store.settings = JSON.parse(persisted);
else if (params.has('legacy')) window.__fixture.store.settings.language = params.get('legacy');
else delete window.__fixture.store.settings;
const originalInvoke = window.__TAURI_INTERNALS__.invoke;
window.__TAURI_INTERNALS__.invoke = async (command,args) => {
  if (command === 'analytics_query') {
    window.__fixture.calls.push({command,args});
    const coverage = {gaps:[],sessions:[],observerStatuses:[],collectionScope:[]};
    const distribution = {samples:0,mean:null,p20:null,p50:null,p95:null};
    const summary = {startMs:0,endMs:Date.now(),retentionDays:30,successRateDefinition:'Fixture',tokenDefinition:'Fixture',groups:[],
      http:{requests:0,succeeded:0,failed:0,cancelled:0,interrupted:0,pending:0,inputTokens:null,outputTokens:null,cacheReadTokens:null,cacheCreationTokens:null,inputTokenSamples:0,outputTokenSamples:0,mcpToolCalls:0,mcpToolFailures:0,firstRequestAtMs:null,lastFinishedAtMs:null,successRate:null},
      inference:{runs:0,inputTokens:null,outputTokens:null,cacheReadTokens:null,toolCalls:0,inputTokenSamples:0,decodeSpeedSamples:0,prefillTokens:null,prefillS:null,decodeS:null,prefillSpeedSamples:0,cacheHitRate:null,cacheRateSamples:0,expertCacheHitRate:null,expertCacheSamples:0},
      ttftS:distribution,durationS:distribution,decodeTokS:distribution,prefillTokS:distribution};
    const action=args.query?.action;
    return {coverage,data:action==='summary'?summary:action==='trends'?{bucketMs:60000,buckets:[]}:action==='request_options'?{clients:[],models:[],unknownClient:false,unknownModel:false,truncated:false}:{items:[],nextCursor:null,snapshotRowId:0,limit:20}};
  }
  if (command === 'get_system_language') {
    window.__fixture.calls.push({command,args});
    return {locales:[params.get('locale') ?? 'en-US'],installerLanguage:params.get('installer')};
  }
  const result = await originalInvoke(command,args);
  if (command === 'store_set' && args.key === 'settings') sessionStorage.setItem(storageKey,JSON.stringify(args.value));
  return result;
};
