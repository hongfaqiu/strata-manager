import { useMemo, useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import * as core from '@strata-manager/core';
import type { JsonObject, StartupFieldSpec } from '@strata-manager/core';
import { Segmented, Toggle } from '../OfficialControls';
import { useConcurrencyEnvironment } from './concurrencyContext';
import './concurrency-card.css';

/** Keys the card reads from the draft (with pending field edits) and may write. */
const CARD_KEYS = ['parallel', '--batch', '--batch-mtp', '--batch-groups', '--adapt-async', '--trim-stage-weights', '--conversation-cache-mib', '--conversation-cache-slots', '--max-context', '--kv', '--kv-resident', '--prompt-cache', '--layer-split', '--mtp', '--gpu',
  'env.STRATA_BATCH_ATTN_ROWS', 'env.STRATA_BATCH_GDN_GROUPS', 'env.STRATA_PIPED_CONCURRENT'];
const EXPERIMENTAL: { env: core.ConcurrencyExperimentalEnv; cn: string; en: string; noteCn: string; noteEn: string; splitOnly?: boolean }[] = [
  { env: 'STRATA_BATCH_ATTN_ROWS', cn: '注意力合并启动', en: 'One attention launch', noteCn: '所有槽的注意力一次启动；官方默认关闭。', noteEn: 'Attention for all slots in one launch; off by default upstream.' },
  { env: 'STRATA_BATCH_GDN_GROUPS', cn: 'GDN 合并启动', en: 'One GDN launch', noteCn: '官方在 RTX PRO 6000 上 308 → 375 tok/s；默认关闭。', noteEn: 'Upstream RTX PRO 6000: 308 → 375 tok/s; off by default.' },
  { env: 'STRATA_PIPED_CONCURRENT', cn: '流水线旁读提示词', en: 'Read prompts beside pipeline', noteCn: '仅多卡流水线分组时生效。', noteEn: 'Only with pipelined groups on a layer split.', splitOnly: true },
];

export interface ConcurrencyCardProps {
  draft: JsonObject;
  fieldValue: (field: StartupFieldSpec) => string;
  onFieldChange: (field: StartupFieldSpec, value: string) => void;
  zh: boolean;
  /** Test/preview seam: skips the native hardware read. */
  hardware?: core.ConcurrencyHardware | null;
  platform?: 'mac' | 'other';
}

const gb = (value: number) => value >= 10 ? value.toFixed(0) : value.toFixed(1);
const pct = (value: number) => `${Math.round(value * 100)}%`;
const fieldByKey = (key: string) => core.STARTUP_TUNING_FIELDS.find(field => field.key === key);

/** The draft as the engine will see it once the pending field edits are saved. */
export function concurrencyDraft(draft: JsonObject, fieldValue: (field: StartupFieldSpec) => string): JsonObject {
  let next = draft;
  for (const key of CARD_KEYS) {
    const field = fieldByKey(key);
    if (!field) continue;
    try { next = core.applyStartupField(next, field, fieldValue(field)); } catch { /* invalid in-progress edit: keep the saved value */ }
  }
  return next;
}

function defaultUseCase(settings: core.ConcurrencySettings): core.ConcurrencyUseCase {
  if (settings.parallel > 1) return 'multiUser';
  return (settings.conversationCacheMib ?? 0) > 0 ? 'agent' : 'single';
}

export function ConcurrencyCard({ draft, fieldValue, onFieldChange, zh, hardware: hardwareOverride, platform }: ConcurrencyCardProps) {
  const { installationId, desktop } = useConcurrencyEnvironment();
  const config = useMemo(() => concurrencyDraft(draft, fieldValue), [draft, fieldValue]);
  const settings = useMemo(() => core.readConcurrencySettings(config), [config]);
  const identity = useMemo(() => core.concurrencyModelIdentity(config), [config]);
  const [useCase, setUseCase] = useState<core.ConcurrencyUseCase>(() => defaultUseCase(settings));
  const hardwareQuery = useQuery({
    queryKey: ['concurrency-hardware', installationId, identity?.family, identity?.quant],
    enabled: hardwareOverride === undefined && desktop && !!installationId,
    staleTime: 60_000,
    queryFn: async (): Promise<core.ConcurrencyHardware> => {
      const result = await core.assessSetupResources({ installationId: installationId!, family: identity?.family ?? 'unknown', quant: identity?.quant ?? 'unknown', context: Math.min(1_048_576, Math.max(512, settings.context ?? 32768)), images: false, kv: settings.kv.slice(0, 32), gpuIds: settings.gpuIds.filter(id => id <= 255).slice(0, 8), parallel: 1 });
      return { gpus: result.hardware.gpus.map(gpu => ({ id: gpu.id, name: gpu.name, vendor: gpu.vendor, totalBytes: gpu.totalBytes })), totalMemoryBytes: result.hardware.totalMemoryBytes };
    },
  });
  const hardware = hardwareOverride !== undefined ? hardwareOverride : hardwareQuery.data ?? null;
  const arenaGb = identity ? core.modelExpertArenaGb(identity.family, identity.quant) : null;
  const plan = useMemo(() => core.recommendConcurrency({ settings, hardware, arenaGb, useCase }), [settings, hardware, arenaGb, useCase]);
  const os = platform ?? (typeof navigator !== 'undefined' && /Mac/i.test(navigator.userAgent) && !/Windows/i.test(navigator.userAgent) ? 'mac' : 'other');
  const ramGib = hardware?.totalMemoryBytes ? hardware.totalMemoryBytes / 2 ** 30 : null;
  const issues = useMemo(() => core.concurrencyIssues(settings, { platform: os, officialParallel: hardware ? plan.officialParallel : undefined, ramGib }), [settings, os, hardware, plan.officialParallel, ramGib]);
  const edits = useMemo(() => core.concurrencyPlanEdits(settings, plan), [settings, plan]);
  const pending = edits.filter(edit => { const field = fieldByKey(edit.key); return field && fieldValue(field) !== edit.value; });
  const apply = (changes: core.ConcurrencyChange[]) => { for (const change of changes) { const field = fieldByKey(change.key); if (field) onFieldChange(field, change.value); } };
  const t = (cn: string, en: string) => zh ? cn : en;
  const msg = (code: string, values?: Record<string, string | number>) => core.concurrencyMessage(code, zh, values);
  const useCaseLabels: Record<core.ConcurrencyUseCase, [string, string]> = { single: ['单人最快', 'Fastest solo'], agent: ['Agent / 子 Agent', 'Agents'], multiUser: ['多人 / 多客户端', 'Several users'], batch: ['批量生成', 'Batch jobs'] };
  const current = settings.parallel;
  const recommendation = plan.parallel > 1 ? t(`${plan.parallel} 个同时`, `${plan.parallel} at once`) : t('一次一个', 'One at a time');
  const cacheNote = plan.conversationCache ? t(`+ 会话暂存 ${plan.conversationCache.mib / 1024} GiB × ${plan.conversationCache.slots}`, `+ parking ${plan.conversationCache.mib / 1024} GiB × ${plan.conversationCache.slots}`) : null;
  const gpuLine = plan.vramGbs.length ? plan.vramGbs.map(v => `${gb(v)} GB`).join(' + ') + (plan.layerSplit ? t(' · 多卡层分配', ' · layer split') : '') : t('显卡未知', 'GPU unknown');
  const showExperimental = current > 1;
  // The 1M-context warning lives with the context field; this note covers context × slots only.
  const longContext = (settings.context ?? 0) > core.TRAINED_CONTEXT && (current > 1 || plan.parallel > 1);
  const listed = issues.filter(issue => issue.code !== 'long_context_conflict');
  return <section className="concurrency-card" data-testid="concurrency-card" aria-label={t('多并发', 'Concurrency')}>
    <header className="concurrency-card-head">
      <div><strong>{t('多并发', 'Concurrency')}</strong><span className="concurrency-card-hw">{gpuLine}{identity ? ` · ${identity.family} ${identity.quant}` : ''}</span></div>
      <span className="concurrency-card-now" data-active={current > 1}>{current > 1 ? t(`当前 ${current} 个同时`, `Now ${current} at once`) : t('当前一次一个', 'Now one at a time')}</span>
    </header>
    <Segmented ariaLabel={t('使用方式', 'How you use it')} value={useCase} onValueChange={value => setUseCase(value as core.ConcurrencyUseCase)} options={core.CONCURRENCY_USE_CASES.map(value => ({ value, label: t(...useCaseLabels[value]) }))}/>
    <dl className="concurrency-card-facts">
      <div className="concurrency-card-primary"><dt>{t('推荐', 'Recommended')}</dt><dd data-testid="concurrency-recommendation">{recommendation}{cacheNote && <small>{cacheNote}</small>}</dd></div>
      <div><dt>{t('每个槽占显存', 'VRAM per slot')}</dt><dd>{gb(plan.perSlotVramGb)} GB{plan.parallel > 1 && <small>{t(`共 ${gb(plan.totalSlotVramGb)} GB`, `${gb(plan.totalSlotVramGb)} GB total`)}</small>}</dd></div>
      <div><dt>{t('专家仍在显存', 'Experts still in VRAM')}</dt><dd>{plan.expertShare === null ? '—' : pct(plan.expertShare)}{plan.arenaGb !== null && plan.cacheGb !== null && <small>{t(`缓存 ${gb(plan.cacheGb)} / 专家 ${gb(plan.arenaGb)} GB`, `cache ${gb(plan.cacheGb)} / experts ${gb(plan.arenaGb)} GB`)}</small>}</dd></div>
      <div><dt>{t('单个请求速度', 'One request alone')}</dt><dd data-tone={plan.slowdown && plan.slowdown[1] > 0.06 ? 'warn' : undefined}>{plan.slowdown ? (plan.slowdown[0] === 0 ? t(`约 −${Math.round(plan.slowdown[1] * 100)}% 以内`, `within −${Math.round(plan.slowdown[1] * 100)}%`) : `−${Math.round(plan.slowdown[0] * 100)}–${Math.round(plan.slowdown[1] * 100)}%`) : t('不变', 'unchanged')}</dd></div>
    </dl>
    <p className="concurrency-card-reason">{plan.reasons.filter(code => code !== 'long_context_conflict' && code !== 'trim_needs_explicit_split').map(code => msg(code)).join(' ')}</p>
    {longContext && <p className="concurrency-card-long" data-testid="concurrency-long-context">{msg('long_context_conflict')}</p>}
    {plan.companions.length > 0 && <ul className="concurrency-card-companions">{plan.companions.map(item => <li key={item.key}><code>{item.value === '' ? t(`移除 ${item.key}`, `remove ${item.key}`) : item.value === 'true' ? item.key : `${item.key} ${item.value}`}</code><span>{msg(item.reason)}</span></li>)}</ul>}
    <div className="concurrency-card-apply">
      <button type="button" className="primary" disabled={!pending.length} onClick={() => apply(edits)} data-testid="concurrency-apply">{pending.length ? t('应用推荐', 'Apply recommendation') : t('已是推荐设置', 'Already recommended')}</button>
      {pending.length > 0 && <span className="concurrency-card-diff">{pending.map(edit => edit.value === '' ? t(`移除 ${edit.key}`, `remove ${edit.key}`) : `${edit.key} ${edit.value === 'true' ? t('开', 'on') : edit.value}`).join(' · ')}</span>}
    </div>
    {listed.length > 0 && <ul className="concurrency-card-issues" data-testid="concurrency-issues">{listed.map(issue => <li key={issue.code} data-severity={issue.severity} data-code={issue.code}>
      <span>{msg(issue.code, issue.values)}</span>
      {issue.fix && <button type="button" className="concurrency-card-fix" onClick={() => apply(issue.fix!)}>{t('修复', 'Fix')}</button>}
    </li>)}</ul>}
    {showExperimental && <div className="concurrency-card-advanced" data-testid="concurrency-experimental">
      <h4>{t('高级 · 实验开关', 'Advanced · experimental switches')}</h4>
      <p>{t('引擎环境变量，官方默认关闭。可能更快，也可能不稳定；建议先在调优页对比。', 'Engine environment switches, off by default upstream. They may be faster or unstable; compare them on the Tuning page first.')}</p>
      {EXPERIMENTAL.map(item => { const field = fieldByKey(`env.${item.env}`)!; const disabled = !!item.splitOnly && !plan.layerSplit; return <label key={item.env} className="concurrency-card-switch" data-disabled={disabled}>
        <span><b>{t(item.cn, item.en)}</b><em className="concurrency-card-tag">{t('实验', 'Experimental')}</em><code>{item.env}</code><small>{t(item.noteCn, item.noteEn)}</small></span>
        <Toggle ariaLabel={`${t(item.cn, item.en)} ${item.env}`} disabled={disabled && !settings.experimental[item.env]} checked={!!settings.experimental[item.env]} onCheckedChange={checked => onFieldChange(field, checked ? '1' : '')}/>
      </label>; })}
    </div>}
  </section>;
}
