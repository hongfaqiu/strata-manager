import type { MetricSnapshot } from '@strata-manager/core';
import './service-telemetry-statusbar.css';

export interface ServiceTelemetryStatusBarProps {
  language: 'zh-CN' | 'en';
  hasProfile: boolean;
  online: boolean;
  connecting: boolean;
  stopped?: boolean;
  metric?: MetricSnapshot;
  unavailable: boolean;
  stateLabel: (state: string) => string;
}

const validNumber = (value: number | null | undefined): value is number =>
  typeof value === 'number' && Number.isFinite(value) && value >= 0;

export function ServiceTelemetryStatusBar({ language, hasProfile, online, connecting, stopped = false, metric, unavailable, stateLabel }: ServiceTelemetryStatusBarProps) {
  const text = (zh: string, en: string) => language === 'zh-CN' ? zh : en;
  const state = !hasProfile ? 'none' : stopped ? 'stopped' : connecting ? 'connecting' : !online ? 'disconnected' : unavailable ? 'unavailable' : metric?.state ?? 'waiting';
  const labels: Record<string, string> = {
    none: text('选择模型', 'Select a model'),
    connecting: text('正在连接', 'Connecting'),
    disconnected: text('服务已离线', 'Service offline'),
    stopped: text('服务未启动', 'Service not started'),
    unavailable: text('监控不可用', 'Metrics unavailable'),
    waiting: text('正在获取监控', 'Loading metrics'),
  };
  const status = labels[state] ?? stateLabel(state);
  const showMetrics = hasProfile && online && !connecting && !unavailable && !!metric && !['error', 'failed', 'disconnected'].includes(state);
  const reading = state === 'reading' || state === 'prefill';
  // normalizeMetrics returns the last request's decode rate outside generation.
  // Only idle may present that historical rate, with an explicit recent label.
  const speed = showMetrics ? state === 'generating' ? metric.decodeTokS : reading ? metric.prefillTokS : state === 'idle' ? metric.decodeTokS : null : null;
  const speedLabel = reading ? text('读取', 'Reading') : state === 'generating' ? text('生成', 'Generation') : text('最近生成', 'Last generation');
  const format = (value: number, digits = 0) => value.toLocaleString(language, { maximumFractionDigits: digits, minimumFractionDigits: digits });

  return <footer className="workspace-statusbar service-telemetry-statusbar" aria-label={text('服务监控', 'Service telemetry')} data-state={state}>
    <span className="workspace-statusbar-state service-telemetry-state"><span className="service-telemetry-dot" aria-hidden="true"/>{status}</span>
    {showMetrics && <div className="service-telemetry-values">
      {validNumber(speed) && <span className="service-telemetry-value service-telemetry-speed"><span>{speedLabel}</span><strong>{format(speed, 1)}</strong><span>tok/s</span></span>}
      <span className="service-telemetry-value"><span>{text('运行', 'Running')}</span><strong>{validNumber(metric.running) ? format(metric.running) : '–'}</strong></span>
      <span className="service-telemetry-value"><span>{text('排队', 'Queued')}</span><strong>{validNumber(metric.queued) ? format(metric.queued) : '–'}</strong></span>
    </div>}
  </footer>;
}
