// Mock-data previews of the concurrency UI. Synthetic numbers only; no native bridge, no network.
import React, { useEffect, useState } from 'react';
import { createRoot } from 'react-dom/client';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import * as core from '@strata-manager/core';
import type { JsonObject } from '@strata-manager/core';
import { StartupQuickParams } from '../../src/pages/StartupQuickParams';
import { ConcurrencyEnvironmentContext } from '../../src/pages/concurrencyContext';
import { ConcurrencyLadderView } from '../../src/pages/ConcurrencyLadder';
import { SlotMonitor } from '../../src/SlotMonitor';
import { ConcurrencyComparisonView } from '../../src/pages/tuning/ConcurrencyComparison';
import '../../src/official/tokens.css';
import '../../src/official/components.css';
import '../../src/styles.css';
import '../../src/official-alignment.css';
import '../../src/official-controls.css';
import '../../src/official/scoped-components.css';
import '../../src/official/scoped-app.css';
import '../../src/official-pages.css';
import '../../src/pages/benchmark.css';
import '../../src/pages/tuning.css';

const params = new URLSearchParams(location.search);
const scene = params.get('scene') ?? 'card-16gb';
const language = params.get('lang') === 'en' ? 'en' : 'zh-CN';
const zh = language === 'zh-CN';
const GIB = 2 ** 30;
const gpu = (id: number, gib: number, name: string) => ({ id, name, vendor: 'nvidia', totalBytes: gib * GIB });

const cards: Record<string, { config: JsonObject; hardware: core.ConcurrencyHardware }> = {
  'card-16gb': { config: { model_name: 'qwen3.8-iq3_s', args: ['--native', 'D:\\models\\Qwen3.8-IQ3_S-00001-of-00002.gguf', '--max-context', '131072', '--kv', 'int8'] }, hardware: { gpus: [gpu(0, 16, 'RTX 4080')], totalMemoryBytes: 64 * GIB } },
  'card-32gb': { config: { model_name: 'qwen3.8-q2_0', args: ['--native', 'D:\\models\\Qwen3.8-Q2_0.gguf', '--max-context', '32768', '--mtp', 'D:\\models\\mtp.gguf'] }, hardware: { gpus: [gpu(0, 32, 'RTX 5090')], totalMemoryBytes: 96 * GIB } },
  'card-multi-gpu': { config: { model_name: 'qwen3.8-iq3_s', gpu: [0, 1], parallel: 4, args: ['--native', 'D:\\models\\Qwen3.8-IQ3_S-00001-of-00002.gguf', '--max-context', '65536', '--layer-split', '24', '--mtp', 'D:\\models\\mtp.gguf', '--batch-mtp'] }, hardware: { gpus: [gpu(0, 24, 'RTX 4090'), gpu(1, 24, 'RTX 4090')], totalMemoryBytes: 128 * GIB } },
};

function CardScene({ name }: { name: string }) {
  const { config, hardware } = cards[name]!;
  const [draft, setDraft] = useState<JsonObject>(config);
  const fieldValue = (field: core.StartupFieldSpec) => core.startupFieldValue(draft, field);
  const onFieldChange = (field: core.StartupFieldSpec, value: string) => setDraft(old => { try { return core.applyStartupField(old, field, value); } catch { return old; } });
  return <ConcurrencyEnvironmentContext.Provider value={{ desktop: false, hardware, platform: 'other' }}>
    <div className="st-card" style={{ padding: 20 }}><StartupQuickParams language={language} draft={draft} showParameterNames={false} fieldValue={fieldValue} onFieldChange={onFieldChange}/></div>
    <pre data-testid="draft" hidden>{JSON.stringify(draft)}</pre>
  </ConcurrencyEnvironmentContext.Provider>;
}

const rows = [
  { concurrency: 1, completed: 6, failed: 0, totalTokS: 38.6, perRequestTokS: 38.6, ttftP50Ms: 310, ttftP95Ms: 360 },
  { concurrency: 2, completed: 10, failed: 0, totalTokS: 68.2, perRequestTokS: 34.5, ttftP50Ms: 340, ttftP95Ms: 420 },
  { concurrency: 4, completed: 17, failed: 0, totalTokS: 104.7, perRequestTokS: 27.1, ttftP50Ms: 420, ttftP95Ms: 690 },
];

function SlotScene() {
  const [tick, setTick] = useState(0);
  useEffect(() => { if (tick >= 24) return; const id = setTimeout(() => setTick(t => t + 1), 25); return () => clearTimeout(id); }, [tick]);
  const wave = (base: number, phase: number) => Math.round((base + Math.sin((tick + phase) / 3) * 3.2) * 10) / 10;
  const raw: JsonObject = { engine: { max_context: 65536 }, live: { state: 'generating', parallel: 4, running: 6, waiting: 2, outside_slots: 2, tok_s: 0, slots: [
    { slot: 0, state: 'generating', prompt_tokens: 1840, generated: 120 + tick * 6, tok_s: wave(29, 0), elapsed_s: 12.4 + tick * 0.2 },
    { slot: 1, state: 'generating', prompt_tokens: 9210, generated: 64 + tick * 5, tok_s: wave(26.5, 4), elapsed_s: 18.1 + tick * 0.2 },
    { slot: 2, state: 'reading', prompt_tokens: 24576, generated: 0, tok_s: null, elapsed_s: 3.2 },
    { slot: 3, state: tick < 12 ? 'generating' : 'idle', held_tokens: 4096, prompt_tokens: 512, generated: 300, tok_s: tick < 12 ? wave(31, 8) : null, elapsed_s: tick < 12 ? 9.6 : null },
  ] } };
  return <SlotMonitor raw={raw} language={language}/>;
}

const candidates: core.ConcurrencyCandidate[] = [
  { id: 'p1', parallel: 1, experimental: false, edits: [{ key: 'parallel', value: '' }] },
  { id: 'p4', parallel: 4, experimental: false, edits: [{ key: 'parallel', value: '4' }, { key: '--batch-mtp', value: 'true' }, { key: '--adapt-async', value: '1' }] },
  { id: 'p5', parallel: 5, experimental: false, edits: [{ key: 'parallel', value: '5' }, { key: '--batch-mtp', value: 'true' }, { key: '--adapt-async', value: '1' }] },
  { id: 'p4-exp', parallel: 4, experimental: true, edits: [{ key: 'parallel', value: '4' }, { key: '--batch-mtp', value: 'true' }, { key: '--adapt-async', value: '1' }, { key: 'env.STRATA_BATCH_ATTN_ROWS', value: '1' }, { key: 'env.STRATA_BATCH_GDN_GROUPS', value: '1' }] },
];
const versions = Object.fromEntries(candidates.map(c => [c.id, { id: c.id, name: c.id, baseUrl: '', installDir: '', pythonPath: '', configPath: `D:\\Strata\\strata-qwen3.8-q2_0-parallel-${c.parallel}${c.experimental ? '-exp' : ''}-20261017-1104.json`, managed: true }]));
const results = [core.concurrencyCandidateResult('p1', [rows[0]!, { ...rows[1]!, totalTokS: 39.1, perRequestTokS: 19.4 }]), core.concurrencyCandidateResult('p4', [{ ...rows[0]!, perRequestTokS: 36.2, totalTokS: 36.2 }, rows[1]!, { ...rows[2]!, totalTokS: 118.4 }]), core.concurrencyCandidateResult('p5', [{ ...rows[0]!, perRequestTokS: 35.4, totalTokS: 35.4 }, rows[1]!, { ...rows[2]!, totalTokS: 112.9 }, { ...rows[2]!, concurrency: 5, totalTokS: 115.3, ttftP95Ms: 980 }]), core.concurrencyCandidateResult('p4-exp', [{ ...rows[0]!, perRequestTokS: 36.0, totalTokS: 36.0 }, rows[1]!, { ...rows[2]!, totalTokS: 124.6 }])];

function Scene() {
  if (scene.startsWith('card-')) return <CardScene name={scene}/>;
  if (scene === 'ladder-running') return <ConcurrencyLadderView zh={zh} slots={4} running levels={[1, 2, 4]} progress={{ stageIndex: 3, concurrency: 4, completed: 19, failed: 0, elapsedMs: 94_000 }} rows={[rows[0]!, rows[1]!, { ...rows[2]!, totalTokS: null, completed: 3 }]}/>;
  if (scene === 'ladder-result') return <ConcurrencyLadderView zh={zh} slots={4} running={false} levels={[1, 2, 4]} rows={rows} finishedAt={Date.UTC(2026, 9, 17, 15, 12)}/>;
  if (scene === 'slots') return <SlotScene/>;
  if (scene === 'comparison-running') return <ConcurrencyComparisonView zh={zh} candidates={candidates} recommended={4} experimental state={{ phase: 'measuring', baseProfileId: 'a', candidates, versions, results: results.slice(0, 2), current: 'p5', stage: { index: 3, total: 4, concurrency: 4 } }} canSave canRun/>;
  return <ConcurrencyComparisonView zh={zh} candidates={candidates} recommended={4} experimental state={{ phase: 'done', baseProfileId: 'a', candidates, versions, results, finishedAt: Date.now() }} canSave canRun/>;
}
document.documentElement.lang = language;
createRoot(document.getElementById('root')!).render(<QueryClientProvider client={new QueryClient()}><main className="official-app" style={{ padding: 24, maxWidth: 1080 }} data-scene={scene}><Scene/></main></QueryClientProvider>);
