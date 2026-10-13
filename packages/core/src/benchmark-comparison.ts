import type { BenchmarkReport } from './benchmark';
import type { BenchmarkSuiteReport } from './benchmark-suite-types';
import type { JsonObject } from './types';
export type ComparableBenchmarkReport = BenchmarkReport | BenchmarkSuiteReport;
export interface BenchmarkIdentity {
  resourceRequest?: import('./resource-assessment').ResourceAssessmentRequest;
  hardwareSignature?: import('./resource-assessment').ResourceHardwareSignature | null;
  schemaVersion: 1; capturedAt: number; process: { pid: number | null; startedAt: number | null; running: boolean };
  runtime: { strength: 'sha256' | 'metadata' | 'unknown'; fingerprint: string | null };
  model: { strength: 'sha256' | 'metadata' | 'unknown'; fingerprint: string | null; files?: JsonObject[] };
  savedConfigurationHash: string; effectiveStartupHash: string | null; effectiveVerified: boolean;
  engineProcess?: { pid: number; startedAt: number } | null;
}
export interface BenchmarkComparison { comparable: boolean; differences: string[]; unknowns: string[]; }
const object = (value: unknown): value is Record<string, unknown> => !!value && typeof value === 'object' && !Array.isArray(value);
const positive = (value: unknown): value is number => typeof value === 'number' && Number.isFinite(value) && value > 0;
const counter = (value: unknown): value is number => typeof value === 'number' && Number.isSafeInteger(value) && value >= 0;
function canonical(value: unknown): string {
  if (Array.isArray(value)) return JSON.stringify(value.map(v => JSON.parse(canonical(v))));
  if (value && typeof value === 'object') return JSON.stringify(Object.fromEntries(Object.entries(value).sort(([a],[b])=>a.localeCompare(b)).map(([k,v])=>[k,JSON.parse(canonical(v))])));
  return JSON.stringify(value ?? null);
}
/** Comparison readiness is stricter than displaying the two reports. */
export function validBenchmarkIdentity(value: unknown): value is BenchmarkIdentity {
  if (!object(value)) return false;
  const v=value as unknown as BenchmarkIdentity;
  const part=(p:BenchmarkIdentity['model']|undefined)=>object(p)&&['sha256','metadata','unknown'].includes(p.strength)&&(p.fingerprint===null||typeof p.fingerprint==='string');
  const process = v.process;
  const engine = v.engineProcess;
  return v.schemaVersion===1&&positive(v.capturedAt)&&part(v.model)&&part(v.runtime)
    && object(process)&&typeof process.running==='boolean'&&(process.pid===null||counter(process.pid)&&process.pid>0)&&(process.startedAt===null||positive(process.startedAt))
    && (engine===undefined||engine===null||object(engine)&&counter(engine.pid)&&engine.pid>0&&positive(engine.startedAt))
    && typeof v.effectiveVerified==='boolean'&&typeof v.savedConfigurationHash==='string'&&(v.effectiveStartupHash===null||typeof v.effectiveStartupHash==='string');
}
function hardwareKnown(value: BenchmarkIdentity['hardwareSignature']): boolean {
  return object(value)&&typeof value.cpuName==='string'&&!!value.cpuName.trim()&&positive(value.totalMemoryBytes)
    &&Array.isArray(value.gpus)&&value.gpus.every(gpu=>object(gpu)&&counter(gpu.id)&&typeof gpu.name==='string'&&!!gpu.name.trim()&&positive(gpu.totalBytes));
}
function measured(report: ComparableBenchmarkReport) { return report.samples.filter(sample=>!sample.warmup); }
function complete(report: ComparableBenchmarkReport): boolean {
  const samples=measured(report);
  if (report.state!=='completed'||!samples.length||report.samples.some(sample=>sample.state!=='completed')) return false;
  const options=report.options;
  const expected='kind' in options ? options.kind==='suite' ? options.rounds*options.scenarios.reduce((n,id)=>n+(id==='conversation'?options.conversationTurns:1),0) : null : options.rounds;
  return expected===null||samples.length===expected;
}
function cacheKnown(sample: ComparableBenchmarkReport['samples'][number]): boolean {
  return counter(sample.promptTokens)&&sample.promptTokens>0&&counter(sample.cachedTokens)&&sample.cachedTokens<=sample.promptTokens;
}
function inputConditions(report: ComparableBenchmarkReport): string {
  return canonical(measured(report).map(sample=>({promptTokens:sample.promptTokens,cachedTokens:sample.cachedTokens,
    ...('scenario' in sample&&'concurrency' in sample&&'turn' in sample&&'maxTokens' in sample?{scenario:sample.scenario,concurrency:sample.concurrency,turn:sample.turn,maxTokens:sample.maxTokens}:{}),
  })));
}
export function compareBenchmarkReports(a: ComparableBenchmarkReport, b: ComparableBenchmarkReport): BenchmarkComparison {
  const differences: string[] = [], unknowns: string[] = [];
  for (const key of ['model','options'] as const) if (canonical(a[key]) !== canonical(b[key])) differences.push(key);
  if (typeof a.options.prompt!=='string'||!a.options.prompt.trim()||typeof b.options.prompt!=='string'||!b.options.prompt.trim()) unknowns.push('testInput');
  if (!measured(a).every(cacheKnown)||!measured(b).every(cacheKnown)) unknowns.push('cacheConditions');
  else if (inputConditions(a)!==inputConditions(b)) differences.push('inputConditions');
  const left = validBenchmarkIdentity(a.identity) ? a.identity : undefined, right = validBenchmarkIdentity(b.identity) ? b.identity : undefined;
  if (!hardwareKnown(left?.hardwareSignature) || !hardwareKnown(right?.hardwareSignature)) unknowns.push('hardware');
  else if (canonical(left?.hardwareSignature)!==canonical(right?.hardwareSignature)) differences.push('hardware');
  if (!left || !right) unknowns.push('identity');
  else {
    if (!left.process.running||!right.process.running||!positive(left.process.pid)||!positive(right.process.pid)||!positive(left.process.startedAt)||!positive(right.process.startedAt)||!left.engineProcess||!right.engineProcess) unknowns.push('process');
    if (!left.effectiveVerified || !right.effectiveVerified || !left.effectiveStartupHash || !right.effectiveStartupHash) unknowns.push('effectiveConfiguration');
    else if (left.effectiveStartupHash !== right.effectiveStartupHash) differences.push('effectiveConfiguration');
    if (left.model.strength !== 'sha256' || right.model.strength !== 'sha256' || !left.model.fingerprint || !right.model.fingerprint) unknowns.push('modelContent');
    if (left.model.fingerprint !== right.model.fingerprint) differences.push('modelIdentity');
    if (left.runtime.fingerprint !== right.runtime.fingerprint) differences.push('runtime');
    if (left.runtime.strength !== 'sha256' || right.runtime.strength !== 'sha256' || !left.runtime.fingerprint || !right.runtime.fingerprint) unknowns.push('runtimeContent');
  }
  if (!complete(a)||!complete(b)) unknowns.push('incomplete');
  // A runtime change is the intended independent variable for an upgrade comparison.
  return { comparable: differences.every(key=>key==='runtime') && unknowns.length===0, differences, unknowns };
}
export function benchmarkComparisonMetrics(report: ComparableBenchmarkReport) {
  const samples = report.samples.filter(sample=>!sample.warmup && sample.state==='completed');
  const mean = (key: 'ttftMs'|'firstVisibleMs'|'wallMs'|'prefillTokS'|'decodeTokS') => { const values = samples.map(s=>s[key]).filter((n):n is number=>typeof n==='number'&&Number.isFinite(n)&&n>=0); return values.length ? values.reduce((a,b)=>a+b,0)/values.length : null; };
  const points = 'telemetry' in report ? report.telemetry : [];
  const peak = (key:'ramUsed'|'gpuMemoryUsed') => { const values=points.map(p=>p[key]).filter((n):n is number=>typeof n==='number'&&Number.isFinite(n)); return values.length?Math.max(...values):null; };
  const cache = samples.reduce((sum,s)=>sum+(s.cachedTokens??0),0), input = samples.reduce((sum,s)=>sum+(s.promptTokens??0),0);
  return { ttftMs:mean('ttftMs'), firstVisibleMs:mean('firstVisibleMs'), wallMs:mean('wallMs'), prefillTokS:mean('prefillTokS'), decodeTokS:mean('decodeTokS'), cacheHitRate:input&&samples.every(cacheKnown)?cache/input:null, ramPeak:peak('ramUsed'), vramPeak:peak('gpuMemoryUsed') };
}
/** Metadata-only export by default; user-visible opt-in is required for test text and output. */
export function exportBenchmarkReport(report: ComparableBenchmarkReport, includeContent = false): ComparableBenchmarkReport {
  if (includeContent) return report;
  const safeIdentity=validBenchmarkIdentity(report.identity)?{...report.identity,model:{...report.identity.model,files:undefined}}:undefined;
  return { ...report, options:{ ...report.options,prompt:'' }, samples:report.samples.map(s=>({...s,output:'',error:s.state==='failed'?'Request failed; inspect locally for details':undefined})), identity:safeIdentity };
}
