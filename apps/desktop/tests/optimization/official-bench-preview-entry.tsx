// Mock-data previews of the 「官方基准」 tab. "Your" numbers are synthetic; official numbers come from the shipped JSON.
import React from 'react';
import { createRoot } from 'react-dom/client';
import * as core from '@strata-manager/core';
import type { OfficialBenchProgress, OfficialBenchReport } from '@strata-manager/core';
import { Panel } from '../../src/components';
import { OfficialBenchmarkResult, OfficialBenchmarkRunCard } from '../../src/pages/OfficialBenchmarkView';
import '../../src/official/tokens.css';
import '../../src/official/components.css';
import '../../src/styles.css';
import '../../src/official-alignment.css';
import '../../src/official-controls.css';
import '../../src/official/scoped-components.css';
import '../../src/official/scoped-app.css';
import '../../src/official-pages.css';
import '../../src/pages/benchmark.css';

const params = new URLSearchParams(location.search);
const scene = params.get('scene') ?? 'match';
const language = params.get('lang') === 'en' ? 'en' : 'zh-CN';
const s = (...v: number[]) => core.officialStat(v);
const prompt = (tokens: number, tps: number[], ttft: number[]) => ({ targetTokens: tokens, requests: [], promptTps: s(...tps), ttftS: s(...ttft), promptTokens: s(tokens + 29), reusedTokens: s(0) });
function report(machine: OfficialBenchReport['machine'], model: string, scale: number, skipped: Record<string, string> = {}): OfficialBenchReport {
  const k = (v: number) => Math.round(v * scale * 10) / 10;
  const prompts: OfficialBenchReport['results']['prompts'] = { '4K': prompt(4096, [k(731), k(742), k(719)], [5.6, 5.5, 5.7]), '16K': prompt(16384, [k(806), k(812), k(799)], [20.3, 20.1, 20.5]) };
  if (!skipped['32K']) prompts['32K'] = prompt(32768, [k(779), k(783), k(770)], [42.0, 41.8, 42.5]);
  return { schemaVersion: 1, kind: 'official-bench', script: core.OFFICIAL_BENCH_SCRIPT, id: scene, profileId: 'p', profileName: 'Strata', baseUrl: 'http://127.0.0.1:8080', model,
    maxContext: 131072, startedAt: Date.UTC(2026, 9, 29, 1, 20), finishedAt: Date.UTC(2026, 9, 29, 1, 31), elapsedMs: 660_000, options: core.DEFAULT_OFFICIAL_BENCH_OPTIONS, state: 'completed',
    calibration: { tokensPerWord: 1.2, overhead: 22 }, machine, engineVersion: '0.1.51',
    results: { chat: { requests: [], decodeTps: s(k(46.2), k(41.9), k(58.7), k(45.0), k(42.3), k(57.9), k(46.8), k(41.1), k(59.0)), ttftS: s(0.62, 0.58, 0.66), generatedTokens: s(100), promptTokens: s(34) },
      prompts, agent: { sessions: [], hitPct: s(68.4, 69.1, 68.8), rereadTokens: s(0), newTokens: s(9420), turnTtftS: s(4.7, 4.6, 4.8), lastTurnPromptTokens: s(10120), turnDecodeTps: s(k(46.1), k(45.7), k(46.4)), firstTurnTtftS: s(0.9) }, skipped, failures: [] } };
}
const strix = { gpuNames: ['AMD Radeon(TM) 8060S Graphics'], vramGB: 64, cpuName: 'AMD RYZEN AI MAX+ 395 w/ Radeon 8060S' };
const reports: Record<string, OfficialBenchReport> = {
  match: report({ ...strix, modelEvidence: ['Qwen3.8-Flash-Next-IQ3_S', 'qwen', 'IQ3_S'] }, 'Qwen3.8-Flash-Next-IQ3_S', 1),
  range: report({ ...strix, modelEvidence: ['DeepSeek-V4.1-Flash', 'deepseek41', 'IST-DAS-2.00bpw'] }, 'DeepSeek-V4.1-Flash-IST-DAS-2.00bpw', 0.29),
  nomatch: report({ gpuNames: ['NVIDIA GeForce RTX 4090'], vramGB: 24, cpuName: 'AMD Ryzen 9 7950X', modelEvidence: ['Qwen3.8-Flash-Next-IQ3_S', 'qwen', 'IQ3_S'] }, 'Qwen3.8-Flash-Next-IQ3_S', 2.6, { '32K': 'the context is 32768 tokens' }),
};
const running: OfficialBenchProgress = { phase: '16K', done: 19, total: 37, phases: ['warmup', 'chat', '4K', '16K', 'agent', '32K'] };
function Scene() {
  const t = (cn: string, en: string) => language === 'zh-CN' ? cn : en;
  const run = <Panel className="benchmark-plan" title={t('测试', 'Run')}><OfficialBenchmarkRunCard language={language} ready running={scene === 'running'} stopping={false}
    progress={scene === 'running' ? running : undefined} long elapsedMs={204_000} onLong={() => {}} onStart={() => {}} onStop={() => {}}/></Panel>;
  const r = reports[scene];
  return <div className="benchmark-page official-benchmark-page">{run}{r && <Panel className="obench-result-panel" title={t('结果对比', 'Official vs yours')} action={<span className="obench-when">10/29 09:20</span>}><OfficialBenchmarkResult report={r} language={language}/></Panel>}</div>;
}
document.documentElement.lang = language;
createRoot(document.getElementById('root')!).render(<main className="official-app" style={{ padding: 24, maxWidth: 1120 }} data-scene={scene}><Scene/></main>);
