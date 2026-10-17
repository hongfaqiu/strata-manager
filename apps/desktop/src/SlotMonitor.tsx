import type { AppLanguage } from "@strata-manager/core";
import { useEffect, useRef, useState } from 'react';
import { asObject, runtimeSlots, type JsonObject } from '@strata-manager/core';
import './runtime-operations.css';
import './pages/setup-tuning-interactions.css';
import './slot-monitor.css';

const HISTORY = 30;
const numeric = (value: unknown): number | null => typeof value === 'number' && Number.isFinite(value) && value >= 0 ? value : null;

/** Rolling tok/s per slot across metric polls; idle samples are kept as gaps, never as zero speed. */
export function nextSlotHistory(previous: Record<number, (number | null)[]>, slots: { id: number; state: string; tokS: number | null }[]): Record<number, (number | null)[]> {
  const next: Record<number, (number | null)[]> = {};
  for (const slot of slots) next[slot.id] = [...(previous[slot.id] ?? []), slot.state === 'idle' ? null : slot.tokS].slice(-HISTORY);
  return next;
}

function Spark({ values }: { values: (number | null)[] }) {
  const finite = values.filter((v): v is number => v !== null);
  if (finite.length < 2) return <span className="slot-spark slot-spark--empty" aria-hidden="true"/>;
  const top = Math.max(...finite, 1e-9), step = 60 / Math.max(1, HISTORY - 1), offset = (HISTORY - values.length) * step;
  let d = '';
  values.forEach((v, i) => { if (v === null) return; const cmd = i > 0 && values[i - 1] !== null && d ? 'L' : 'M'; d += `${cmd}${(offset + i * step).toFixed(1)},${(16 - v / top * 14).toFixed(1)}`; });
  return <svg className="slot-spark" viewBox="0 0 60 18" aria-hidden="true"><path d={d}/></svg>;
}

export function SlotMonitor({ raw, language }: { raw: JsonObject; language: AppLanguage }) {
  const zh = language === 'zh-CN', t = (cn: string, en: string) => zh ? cn : en;
  const live = asObject(raw.live), slots = runtimeSlots(raw);
  const [history, setHistory] = useState<Record<number, (number | null)[]>>({});
  const lastRaw = useRef<JsonObject | null>(null);
  useEffect(() => { if (!slots || lastRaw.current === raw) return; lastRaw.current = raw; setHistory(previous => nextSlotHistory(previous, slots)); }, [raw, slots]);
  const fmt = (value: unknown, digits = 0) => { const number = numeric(value); return number === null ? '–' : number.toLocaleString(language, { maximumFractionDigits: digits }); };
  if (slots === null && !(numeric(live.parallel) !== null && Number(live.parallel) > 1)) return null;
  const states: Record<string, string> = { idle: t('空闲', 'Idle'), reading: t('读取', 'Reading'), decoding: t('生成', 'Decoding'), generating: t('生成', 'Generating'), busy: t('忙碌', 'Busy'), unknown: t('未知', 'Unknown') };
  const effective = numeric(live.parallel) ?? slots?.length ?? null;
  const busy = slots?.filter(slot => slot.state !== 'idle').length ?? 0;
  const total = (slots ?? []).reduce((sum, slot) => sum + (slot.state !== 'idle' && slot.tokS !== null ? slot.tokS : 0), 0);
  const waiting = numeric(live.waiting ?? live.queued);
  return <section className="st-card runtime-slot-monitor" aria-label={t('逐槽监控', 'Per-slot monitoring')} data-testid="slot-monitor">
    <div className="runtime-operations-heading"><h2>{t('并行任务', 'Parallel requests')}</h2><span className="muted">{t('处理中', 'Running')} {fmt(live.running)} · {t('等待中', 'Waiting')} {fmt(live.waiting ?? live.queued)}{numeric(live.outside_slots) !== null && <> · {t('槽外请求', 'Outside slots')} {fmt(live.outside_slots)}</>}</span></div>
    <dl className="slot-monitor-summary">
      <div><dt>{t('生效槽数', 'Slots in effect')}</dt><dd>{fmt(effective)}<small>{t(`${busy} 个在用`, `${busy} busy`)}</small></dd></div>
      <div><dt>{t('合计速度', 'Total speed')}</dt><dd>{busy ? fmt(total, 1) : '–'}<small>tok/s</small></dd></div>
      <div><dt>{t('排队', 'Waiting')}</dt><dd data-busy={(waiting ?? 0) > 0 || undefined}>{fmt(waiting)}<small>{(waiting ?? 0) > 0 ? t('槽已满', 'slots full') : t('无', 'none')}</small></dd></div>
    </dl>
    {slots === null || slots.length === 0 ? <p className="muted">{t('引擎尚未提供逐槽指标。', 'The engine has not supplied per-slot metrics.')}</p> : <div className="table-wrap"><table className="st-table slot-monitor-table"><thead><tr>
      <th>{t('任务位', 'Slot')}</th><th>{t('状态', 'State')}</th><th className="num">{t('输入词元', 'Input tokens')}</th><th className="num">{t('输出词元', 'Output tokens')}</th><th className="num">{t('保留历史词元', 'Held history tokens')}</th><th className="num">{t('生成速度（词元/秒）', 'Speed (tokens/s)')}</th><th>{t('速度走势', 'Speed trend')}</th><th className="num">{t('耗时', 'Elapsed')}</th><th>{t('对话容量占用', 'Context usage')}</th>
    </tr></thead><tbody>{slots.map(slot => {
      const percent = slot.usedContext !== null && slot.context !== null && slot.context > 0 ? Math.min(100, Math.max(0, slot.usedContext / slot.context * 100)) : null;
      return <tr key={slot.id} data-state={slot.state}><td>{slot.id}</td><td><span className={`st-badge ${slot.state === 'reading' ? 'st-badge--reading' : slot.state === 'decoding' || slot.state === 'generating' ? 'st-badge--generating' : ''}`}>{states[slot.state] ?? slot.state}</span></td><td className="num">{fmt(slot.promptTokens)}</td><td className="num">{fmt(slot.generatedTokens)}</td><td className="num">{fmt(slot.heldTokens)}</td><td className="num slot-monitor-speed">{fmt(slot.tokS, 1)}</td><td><Spark values={history[slot.id] ?? []}/></td><td className="num">{slot.elapsedS === null ? '–' : `${fmt(slot.elapsedS, 1)} s`}</td><td className="runtime-slot-context"><span>{fmt(slot.usedContext)} / {fmt(slot.context)}</span>{percent !== null && <div className="st-progress" role="progressbar" aria-label={`${t('槽位', 'Slot')} ${slot.id} ${t('上下文', 'context')}`} aria-valuemin={0} aria-valuemax={100} aria-valuenow={percent}><div className="st-progress__bar" style={{ width: `${percent}%` }}/></div>}</td></tr>;
    })}</tbody></table></div>}
  </section>;
}
