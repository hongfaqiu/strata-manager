import type { AppLanguage } from "@strata-manager/core";
import { useState } from 'react';
import { asObject, runtimeSlots, type JsonObject } from '@strata-manager/core';
import './runtime-operations.css';
import './pages/setup-tuning-interactions.css';

export function SlotMonitor({ raw, language }: { raw: JsonObject; language: AppLanguage }) {
  const zh = language === 'zh-CN', t = (cn: string, en: string) => zh ? cn : en;
  const [showDetails, setShowDetails] = useState(false);
  const live = asObject(raw.live), slots = runtimeSlots(raw);
  const numeric = (value: unknown): number | null => typeof value === 'number' && Number.isFinite(value) && value >= 0 ? value : null;
  const fmt = (value: unknown, digits = 0) => { const number = numeric(value); return number === null ? '–' : number.toLocaleString(language, { maximumFractionDigits: digits }); };
  if (slots === null && !(numeric(live.parallel) !== null && Number(live.parallel) > 1)) return null;
  const states: Record<string, string> = { idle: t('空闲', 'Idle'), reading: t('读取', 'Reading'), decoding: t('生成', 'Decoding'), generating: t('生成', 'Generating'), unknown: t('未知', 'Unknown') };
  return <section className="st-card runtime-slot-monitor" aria-label={t('逐槽监控', 'Per-slot monitoring')}>
    <div className="runtime-operations-heading"><h2>{t('并行任务', 'Parallel requests')}</h2><span className="muted">{t('处理中', 'Running')} {fmt(live.running)} · {t('等待中', 'Waiting')} {fmt(live.waiting ?? live.queued)}{showDetails && numeric(live.outside_slots) !== null && <> · {t('槽外请求', 'Outside slots')} {fmt(live.outside_slots)}</>}</span><button type="button" className="runtime-slot-detail-toggle" aria-pressed={showDetails} onClick={() => setShowDetails(previous => !previous)}>{showDetails ? t('收起指标', 'Fewer metrics') : t('更多指标', 'More metrics')}</button></div>
    {slots === null || slots.length === 0 ? <p className="muted">{t('引擎尚未提供逐槽指标。', 'The engine has not supplied per-slot metrics.')}</p> : <div className="table-wrap"><table className="st-table"><thead><tr>
      <th>{t('任务位', 'Slot')}</th><th>{t('状态', 'State')}</th>{showDetails && <th className="num">{t('输入词元', 'Input tokens')}</th>}<th className="num">{t('输出词元', 'Output tokens')}</th>{showDetails && <th className="num">{t('保留历史词元', 'Held history tokens')}</th>}<th className="num">{t('生成速度（词元/秒）', 'Speed (tokens/s)')}</th><th className="num">{t('耗时', 'Elapsed')}</th><th>{t('对话容量占用', 'Context usage')}</th>
    </tr></thead><tbody>{slots.map(slot => {
      const percent = slot.usedContext !== null && slot.context !== null && slot.context > 0 ? Math.min(100, Math.max(0, slot.usedContext / slot.context * 100)) : null;
      return <tr key={slot.id}><td>{slot.id}</td><td><span className={`st-badge ${slot.state === 'reading' ? 'st-badge--reading' : slot.state === 'decoding' || slot.state === 'generating' ? 'st-badge--generating' : ''}`}>{states[slot.state] ?? slot.state}</span></td>{showDetails && <td className="num">{fmt(slot.promptTokens)}</td>}<td className="num">{fmt(slot.generatedTokens)}</td>{showDetails && <td className="num">{fmt(slot.heldTokens)}</td>}<td className="num">{fmt(slot.tokS, 1)}</td><td className="num">{slot.elapsedS === null ? '–' : `${fmt(slot.elapsedS, 1)} s`}</td><td className="runtime-slot-context"><span>{fmt(slot.usedContext)} / {fmt(slot.context)}</span>{percent !== null && <div className="st-progress" role="progressbar" aria-label={`${t('槽位', 'Slot')} ${slot.id} ${t('上下文', 'context')}`} aria-valuemin={0} aria-valuemax={100} aria-valuenow={percent}><div className="st-progress__bar" style={{ width: `${percent}%` }}/></div>}</td></tr>;
    })}</tbody></table></div>}
  </section>;
}
