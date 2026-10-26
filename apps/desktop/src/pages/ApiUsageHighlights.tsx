import { asObject, normalizeMetrics, type ApiTrendBucket, type ApiUsageSummary, type AppLanguage, type JsonObject } from '@strata-manager/core';
import { Database, Gauge, Layers, Timer, Zap } from 'lucide-react';
import type { ApiUsageLayoutText } from './ApiUsageLayoutStrings';
import { UsageSparkline } from './ApiUsageCharts';
import { cacheSavedSeconds, durationParts, powerReading, ringDash } from './apiUsageHighlights';

export interface ApiUsageHighlightsProps {
  language: AppLanguage; layout: ApiUsageLayoutText; summary: ApiUsageSummary; buckets: ApiTrendBucket[]; measured: boolean;
  live?: { raw?: JsonObject; stale?: boolean; stopped?: boolean };
}

const RING = 2 * Math.PI * 22;
/** A single-value ring; an unknown ratio draws only the track so it never reads as 0%. */
function Ring({ ratio, label, color }: { ratio: number | null; label: string; color: 'accent' | 'blue' }) {
  const dash = ringDash(ratio, RING);
  return <svg className={`api-usage-ring api-chart-color-${color}`} viewBox="0 0 52 52" role="img" aria-label={label}>
    <circle className="api-usage-ring-track" cx="26" cy="26" r="22"/>
    {dash && <circle className="api-usage-ring-value" cx="26" cy="26" r="22" strokeDasharray={dash} transform="rotate(-90 26 26)"/>}
  </svg>;
}

const isMac = () => typeof navigator !== 'undefined' && /Mac/i.test(navigator.userAgent) && !/Windows/i.test(navigator.userAgent);

/** Metrics people check first: cache efficiency, latency and live power. Data that is not collected says so. */
export function ApiUsageHighlights({ language, layout, summary: s, buckets, measured, live }: ApiUsageHighlightsProps) {
  const number = (value: number | null | undefined, digits = 0) => typeof value === 'number' && Number.isFinite(value) ? value.toLocaleString(language, { maximumFractionDigits: digits }) : '—';
  const compact = (value: number | null | undefined) => typeof value === 'number' && Number.isFinite(value) ? value.toLocaleString(language, { notation: 'compact', maximumFractionDigits: 1 }) : '—';
  const percent = (value: number | null | undefined) => measured && value != null ? number(value * 100, 1) : '—';
  const raw = live?.raw ?? {};
  const unavailable = !live || !!live.stale || Object.keys(raw).length === 0;
  const metrics = normalizeMetrics(unavailable ? {} : raw);
  const power = powerReading({ watts: metrics.gpuPower, limit: typeof asObject(raw.hardware).gpu_power_limit === 'number' ? asObject(raw.hardware).gpu_power_limit as number : null, history: metrics.history.gpu_power, unavailable, stopped: !!live?.stopped, mac: isMac() });
  const saved = measured ? cacheSavedSeconds(s.inference) : null;
  const savedParts = saved ? durationParts(saved.seconds) : null;
  const unit = savedParts ? { second: layout.hlUnitSecond, minute: layout.hlUnitMinute, hour: layout.hlUnitHour }[savedParts.unit] : '';
  const cacheRate = measured ? s.inference.cacheHitRate : null, expertRate = measured ? s.inference.expertCacheHitRate : null;
  const powerNote = power.kind === 'stopped' ? layout.hlPowerStopped : power.kind === 'unsupported' ? (power.reason === 'mac' ? layout.hlPowerMac : layout.hlPowerDevice) : [power.average != null ? layout.hlPowerAverage.replace('{{value}}', number(power.average)) : null, power.limit != null ? layout.hlPowerLimit.replace('{{value}}', number(power.limit)) : null].filter(Boolean).join(' · ');

  return <section className="api-usage-highlights" aria-label={layout.highlightsTitle}>
    <div className="api-usage-highlight is-ring" data-highlight="cache">
      <Ring ratio={cacheRate} label={`${layout.hlCache} ${percent(cacheRate)}%`} color="accent"/>
      <div><span><Database size={13} aria-hidden="true"/>{layout.hlCache}</span><strong>{percent(cacheRate)}{cacheRate != null && <em>%</em>}</strong>
        <small data-tooltip={`${number(s.inference.cacheReadTokens)} / ${number(s.inference.inputTokens)} Token`}>{measured ? layout.hlCacheDetail.replace('{{reused}}', compact(s.inference.cacheReadTokens)).replace('{{input}}', compact(s.inference.inputTokens)) : '—'}</small></div>
    </div>
    <div className="api-usage-highlight is-ring" data-highlight="expert">
      <Ring ratio={expertRate} label={`${layout.hlExpert} ${percent(expertRate)}%`} color="blue"/>
      <div><span><Layers size={13} aria-hidden="true"/>{layout.hlExpert}</span><strong>{percent(expertRate)}{expertRate != null && <em>%</em>}</strong>
        <small>{measured ? layout.hlRuns.replace('{{count}}', number(s.inference.expertCacheSamples)) : '—'}</small></div>
    </div>
    <div className="api-usage-highlight" data-highlight="saved" data-tooltip={layout.hlSavedTooltip}>
      <div><span><Timer size={13} aria-hidden="true"/>{layout.hlSaved}</span><strong>{savedParts ? number(savedParts.value, savedParts.digits) : '—'}{savedParts && <em>{unit}</em>}</strong>
        <small>{saved ? layout.hlSavedDetail.replace('{{speed}}', `${number(saved.prefillTokS)} tok/s`) : '—'}</small></div>
    </div>
    <div className="api-usage-highlight" data-highlight="ttft">
      <div><span><Gauge size={13} aria-hidden="true"/>{layout.hlTtft}</span><strong>{measured ? number(s.ttftS.p50, 2) : '—'}{measured && s.ttftS.p50 != null && <em>{layout.hlUnitSecond} · P50</em>}</strong>
        <small>{measured && s.ttftS.p95 != null ? `P95 ${number(s.ttftS.p95, 2)} ${layout.hlUnitSecond}` : '—'}</small></div>
      {measured && <UsageSparkline values={buckets.map(bucket => bucket.firstTokenS)} color="blue"/>}
    </div>
    <div className={`api-usage-highlight${power.kind === 'live' ? '' : ' is-muted'}`} data-highlight="power" data-power={power.kind}>
      <div><span><Zap size={13} aria-hidden="true"/>{layout.hlPower}</span>
        <strong>{power.kind === 'live' ? number(power.watts) : power.kind === 'stopped' ? '—' : layout.hlUnsupported}{power.kind === 'live' && <em>W</em>}</strong>
        <small>{powerNote || '—'}</small>
        <small className="api-usage-highlight-note">{layout.hlEnergyUnsupported}</small></div>
      {power.kind === 'live' && power.samples.some(value => value != null) && <UsageSparkline values={power.samples} color="gold"/>}
    </div>
  </section>;
}
