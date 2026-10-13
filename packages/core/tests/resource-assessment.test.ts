import { describe, expect, it } from 'vitest';
import { RESOURCE_ASSESSMENT_REVISION, matchingResourceMeasurements, resourceAssessmentMessage, resourceRequestFromConfiguration, validateResourceAssessmentRequest, type ResourceAssessmentRequest, type ResourceHardwareSnapshot } from '../src/resource-assessment';

const request: ResourceAssessmentRequest = { installationId: 'runtime', family: 'qwen', quant: 'Q2_0', context: 32768, images: false, kv: 'int8', gpuIds: [0], parallel: 1 };
const config = () => ({ model_name: 'qwen3.8-flash-next-gsq-rco-iq3_s', args: ['--native', 'D:\\models\\Qwen3.8-Flash-Next-GSQ-RCO-IQ3_S-00001-of-00002.gguf', '--pack', 'D:\\packs\\IQ3_S', '--expert-cache', 'auto', '--max-context', '131072', '--kv', 'int8'], gpu: 0 });

describe('finite resource request contract', () => {
  it('validates a request without sharing mutable GPU selection or changing source input', () => {
    const result = validateResourceAssessmentRequest(request);
    expect(result).toEqual(request); expect(result.gpuIds).not.toBe(request.gpuIds);
    expect(RESOURCE_ASSESSMENT_REVISION).toBe('a0116b2782a5b82622358c04a06496485d12b2d6');
  });
  it('rejects invalid capacities, IDs and argument shapes before invoking a backend', () => {
    for (const extra of [{ installationId: '' }, { context: 0 }, { context: 1048577 }, { context: NaN }, { parallel: 0 }, { parallel: 65 }, { gpuIds: [0, 0] }, { gpuIds: [-1] }, { gpuIds: [256] }, { images: 'false' }, { kv: undefined }]) {
      expect(() => validateResourceAssessmentRequest({ ...request, ...extra } as ResourceAssessmentRequest)).toThrow();
    }
  });
  it('derives a recipe from the complete current draft without mutating it', () => {
    const draft = config(), before = structuredClone(draft);
    expect(resourceRequestFromConfiguration(draft, 'runtime')).toEqual({ ...request, quant: 'IQ3_S', context: 131072 });
    expect(draft).toEqual(before);
    draft.args[draft.args.indexOf('131072')] = '65536';
    expect(resourceRequestFromConfiguration(draft, 'runtime')?.context).toBe(65536);
  });
  it('keeps custom cache, replicas, memory modes and ambiguous flags unknown', () => {
    for (const args of [['--expert-cache', '8000'], ['--kv-resident', '32768'], ['--resident-experts'], ['--batch', '2'], ['--layer-split', '24'], ['--max-context', '65536']]) {
      const draft = config(); draft.args.push(...args);
      expect(resourceRequestFromConfiguration(draft, 'runtime')).toBeNull();
    }
    expect(resourceRequestFromConfiguration({ ...config(), replicas: 2 }, 'runtime')).toBeNull();
    expect(resourceRequestFromConfiguration({ ...config(), env: { STRATA_ADAPT_OVERLAP: '1' } }, 'runtime')).toBeNull();
    expect(resourceRequestFromConfiguration({ args: ['--max-context', '32768'], model_name: 'unknown' }, 'runtime')).toBeNull();
  });
  it('recognizes supported family hints while retaining unsupported KV for explicit unknown guidance', () => {
    expect(resourceRequestFromConfiguration({ ...config(), model_name: 'Swift-1.5-IQ3_S' }, 'runtime')?.family).toBe('swift');
    expect(resourceRequestFromConfiguration({ ...config(), model_name: 'qwen3.8-coder-IQ1_M', args: ['--max-context', '8192'] }, 'runtime')).toMatchObject({ family: 'coder', quant: 'IQ1_M', kv: 'fp16' });
    expect(resourceRequestFromConfiguration({ ...config(), model_name: 'qwen3.8-IQ2_XS' }, 'runtime')).toBeNull();
    expect(resourceAssessmentMessage('gpu_unknown', true)).toContain('未知');
    expect(resourceAssessmentMessage('gpu_unknown', false)).toContain('unknown');
  });
});

describe('resource report matching requires actual configuration and static hardware', () => {
  const hardware: ResourceHardwareSnapshot = { sampledAt:1000,totalMemoryBytes:64*1024**3,availableMemoryBytes:40*1024**3,cpuName:'Fixture CPU',cpuIsa:'avx2',wsl:false,managedServiceRunning:false,
    gpus:[{id:0,vendor:'nvidia',name:'Fixture GPU',totalBytes:24*1024**3,availableBytes:null,source:'fixture'}] };
  const report=()=>({id:'report',startedAt:1000,state:'completed',samples:[{state:'completed'}],telemetry:[{ramUsed:1024,gpuMemoryUsed:512},{ramUsed:2048,gpuMemoryUsed:null}],
    identity:{effectiveVerified:true,effectiveStartupHash:'actual-argv-hash',resourceRequest:{...request},hardwareSignature:{cpuName:hardware.cpuName,totalMemoryBytes:hardware.totalMemoryBytes,gpus:[{id:0,name:'Fixture GPU',totalBytes:24*1024**3}]} }});
  it('shows at most three recent matched measurements with unknown values kept null',()=>{
    const reports=[1,2,3,4].map(time=>({...report(),id:`r${time}`,startedAt:time}));
    expect(matchingResourceMeasurements(reports,request,hardware).map(row=>row.id)).toEqual(['r4','r3','r2']);
    expect(matchingResourceMeasurements([report()],request,hardware)[0]).toMatchObject({ramPeakBytes:2048,vramPeakBytes:512});
    expect(matchingResourceMeasurements([report()],request,{...hardware,availableMemoryBytes:0})).toHaveLength(1);
  });
  it('excludes other configurations, unverifiable or incomplete identity and changed hardware',()=>{
    for (const change of [{context:65536},{kv:'q4_0'},{parallel:2},{images:true},{installationId:'other'},{gpuIds:[1]}]) {
      const value=report();value.identity.resourceRequest={...request,...change};expect(matchingResourceMeasurements([value],request,hardware)).toEqual([]);
    }
    for(const extra of [{effectiveVerified:false},{effectiveStartupHash:''},{resourceRequest:undefined},{hardwareSignature:undefined}]) {
      const value=report();Object.assign(value.identity,extra);expect(matchingResourceMeasurements([value],request,hardware)).toEqual([]);
    }
    expect(matchingResourceMeasurements([report()],request,{...hardware,cpuName:'Different CPU'})).toEqual([]);
    expect(matchingResourceMeasurements([report()],request,{...hardware,gpus:[{...hardware.gpus[0]!,totalBytes:null}]})).toEqual([]);
    expect(matchingResourceMeasurements([{...report(),state:'failed'}],request,hardware)).toEqual([]);
    expect(matchingResourceMeasurements([{...report(),samples:[{state:'failed'}]}],request,hardware)).toEqual([]);
  });
});
