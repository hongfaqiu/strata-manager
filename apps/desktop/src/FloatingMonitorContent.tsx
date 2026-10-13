import type { CSSProperties } from 'react';
import { FLOATING_MONITOR_METRICS, floatingMonitorDimensions, normalizeFloatingMonitorPreferences, type FloatingMonitorPreferences, type MetricSnapshot } from '@strata-manager/core';
import { monitorValues, type MonitorPoint } from './floatingMonitorHistory';
import { telemetrySparkline } from './serviceStatusTelemetry';
import './floating-monitor-content.css';

interface Props {
  preferences: FloatingMonitorPreferences; language: 'zh-CN' | 'en'; metric?: MetricSnapshot;
  history: MonitorPoint[]; status: string; loaded?: boolean; sampledAt?: number; message?: string;
}

export function FloatingMonitorContent({ preferences, language, metric, history, status, loaded = true, sampledAt, message }: Props) {
  const value = normalizeFloatingMonitorPreferences(preferences), dimensions = floatingMonitorDimensions(value);
  const values = monitorValues(metric, loaded, false), zh = language === 'zh-CN';
  return <section className="floating-monitor-content" data-layout={value.layout} style={{ '--monitor-font': `${value.fontSize}px`, '--monitor-label-font': `${Math.max(10, Math.round(value.fontSize * .7))}px`, '--monitor-columns': dimensions.columns } as CSSProperties}>
    <header className="floating-monitor-content-header"><span className="floating-monitor-state" role="status"><i aria-hidden="true"/>{status}</span><span title={message}>{(message !== status ? message : '') || (value.showSampleTime && sampledAt ? new Date(sampledAt).toLocaleTimeString(language, { hour12: false }) : '')}</span></header>
    <div className="floating-monitor-grid">
      {value.metrics.map(id => {
        const definition = FLOATING_MONITOR_METRICS.find(item => item.id === id)!;
        const last = (id === 'generation' && metric?.state !== 'generating' || id === 'prefill' && !['reading', 'prefill'].includes(metric?.state ?? '')) && values[id] !== null;
        const label = `${last ? zh ? '最近' : 'Last ' : ''}${definition.label[language]}`;
        const number = values[id];
        const formatted = number === null ? '—' : number.toLocaleString(language, { maximumFractionDigits: ['generation', 'prefill', 'vram', 'ram'].includes(id) ? 1 : 0 });
        const graph = telemetrySparkline(history.map(point => ({ at: point.at, decode: point.values[id], prefill: null, gpu: null })), 'decode', ['gpu', 'cpu'].includes(id) ? 100 : undefined);
        const showLabel = value.showLabels || id === 'generation' || id === 'prefill';
        return <div key={id} className="floating-monitor-cell" data-metric={id} title={`${label}: ${formatted} ${value.showUnits ? definition.unit : ''}`}>
          <div className="floating-monitor-reading">{showLabel && <span className="floating-monitor-label">{label}</span>}<strong>{formatted}</strong>{value.showUnits && definition.unit && <small>{definition.unit}</small>}</div>
          {value.showGraphs && <svg className="floating-monitor-graph" viewBox="0 0 160 48" preserveAspectRatio="none" aria-label={`${label} · ${zh ? '最近采样趋势，独立刻度' : 'Recent samples, independent scale'}`} role="img">
            <path className="floating-monitor-baseline" d="M4,44 L156,44"/>
            {graph.paths.map((path, i) => <path key={i} d={path}/>)}
            {graph.last && <circle cx={graph.last.x} cy={graph.last.y} r="2"/>}
          </svg>}
        </div>;
      })}
    </div>
  </section>;
}
