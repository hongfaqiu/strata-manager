import { describe,it,expect } from 'vitest';
import { newChatExecution,advanceChatExecution,finishChatExecution } from '../src/chat-execution';
import { decodeChatChunk } from '../src/chat';
import { parseServiceCapabilities } from '../src/service-capabilities';
import { compareBenchmarkReports,exportBenchmarkReport,benchmarkComparisonMetrics } from '../src/benchmark-comparison';
import type { BenchmarkReport } from '../src/benchmark';

describe('request evidence',()=>{
  it('keeps response, server and local IDs separate and distinguishes first token from answer',()=>{
    let e: ReturnType<typeof newChatExecution>={...newChatExecution('local',1000),requestStartedAt:1000};
    for(const d of decodeChatChunk(JSON.stringify({id:'response',request_id:'server',choices:[{delta:{reasoning_content:'think'}}]}))) e=advanceChatExecution(e,d,1200);
    expect(e).toMatchObject({operationId:'local',responseId:'response',serviceRequestId:'server',phase:'reasoning',firstTokenMs:200});
    expect(e.firstVisibleMs).toBeUndefined();
    e=advanceChatExecution(e,{content:'OK'},1400);expect(e.firstVisibleMs).toBe(400);
    e=finishChatExecution(e,true,false,1500);expect(advanceChatExecution(e,{content:'late'},1600)).toEqual(e);
  });
  it('does not claim global queue or prefill for an unidentified request',()=>{expect(newChatExecution('x').phase).toBe('waiting');});
  it('metadata preflight time is not counted as request TTFT',()=>{const e={...newChatExecution('x',1000),requestStartedAt:6000};expect(advanceChatExecution(e,{content:'OK'},6100).firstTokenMs).toBe(100);});
  it('unknown metadata does not become capability support; resident settings beat saved values',()=>{
    expect(parseServiceCapabilities({profileId:'a'}).items.every(i=>i.state==='unknown')).toBe(true);
    expect(parseServiceCapabilities({profileId:'a',status:{service:'strata'}}).items.every(i=>i.state==='unknown')).toBe(true);
    const result=parseServiceCapabilities({profileId:'a',status:{service:'strata',dialects:['/v1/chat/completions']},metrics:{engine:{version:'0.1.43.1'}},runtime:{verified:true,pid:1,startedAt:1,promptCache:1},configuredPromptCache:3});
    expect(result.items.find(i=>i.id==='prefix')?.state).toBe('restartRequired');
  });
});
function report(id:string):BenchmarkReport {return{id,profileId:'p',profileName:'fixture',baseUrl:'http://127.0.0.1:19001',model:'model',startedAt:1,finishedAt:2,state:'completed',options:{prompt:'private',rounds:1,maxTokens:256,warmup:false,mode:'unique',timeoutMs:60000},samples:[{index:1,warmup:false,state:'completed',model:'model',startedAt:1,ttftMs:200,firstVisibleMs:500,wallMs:1000,promptTokens:10,completionTokens:10,cachedTokens:5,prefillTokS:100,decodeTokS:20,output:'private output'}],hardware:{cpu:'fixture'},identity:{schemaVersion:1,capturedAt:1,process:{running:true,pid:1,startedAt:1},engineProcess:{pid:2,startedAt:1},model:{strength:'sha256',fingerprint:'verified'},runtime:{strength:'sha256',fingerprint:'v1'},savedConfigurationHash:'saved',effectiveStartupHash:'live',effectiveVerified:true,hardwareSignature:{cpuName:"fixture",totalMemoryBytes:64*2**30,gpus:[{id:0,name:"fixture",totalBytes:32*2**30}]}}};}
describe('benchmark comparison',()=>{
  it('accepts a runtime change but rejects unknown model content and changed cache conditions',()=>{
    const a=report('a'),b=report('b');b.identity!.runtime.fingerprint='v2';expect(compareBenchmarkReports(a,b).comparable).toBe(true);
    b.identity!.model.strength='metadata';expect(compareBenchmarkReports(a,b).unknowns).toContain('modelContent');
    b.options.warmup=true;expect(compareBenchmarkReports(a,b).differences).toContain('options');
  });
  it('does not promote old or failed reports to verified comparisons',()=>{const a=report('a'),b=report('b');delete a.identity;b.state='cancelled';expect(compareBenchmarkReports(a,b)).toMatchObject({comparable:false});});
  it('corrupt optional identity safely degrades to unknown',()=>{const a=report('a'),b=report('b');a.identity={} as typeof a.identity;expect(compareBenchmarkReports(a,b)).toMatchObject({comparable:false});});
  it('keeps first-answer latency separate and requires opt-in to export text',()=>{
    const a=report('a');expect(benchmarkComparisonMetrics(a)).toMatchObject({ttftMs:200,firstVisibleMs:500,cacheHitRate:0.5});
    expect(exportBenchmarkReport(a).options.prompt).toBe('');expect(exportBenchmarkReport(a).samples[0]?.output).toBe('');expect(a.samples[0]?.output).toBe('private output');expect(exportBenchmarkReport(a,true)).toBe(a);
  });
});
