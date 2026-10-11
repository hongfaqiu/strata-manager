import type { MetricSnapshot } from '@strata-manager/core';
import { PictureInPicture2 } from 'lucide-react';
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
  desktop?: boolean;
  onOpenFloating?: () => void;
}

const validNumber = (value: number | null | undefined): value is number =>
  typeof value === 'number' && Number.isFinite(value) && value >= 0;

export function ServiceTelemetryStatusBar({ language, hasProfile, online, connecting, stopped = false, metric, unavailable, stateLabel, desktop = false, onOpenFloating }: ServiceTelemetryStatusBarProps) {
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
  const showMetrics = hasProfile && online && !stopped && !connecting && !unavailable && !!metric && !['error', 'failed', 'disconnected'].includes(state);
  const reading = state === 'reading' || state === 'prefill';
  // normalizeMetrics returns the last request's decode rate outside generation.
  // Only idle may present that historical rate, with an explicit recent label.
  const speed = showMetrics ? state === 'generating' ? metric.decodeTokS : reading ? metric.prefillTokS : state === 'idle' ? metric.decodeTokS : null : null;
  const speedLabel = reading ? text('读取', 'Reading') : state === 'idle' ? text('最近生成', 'Last generation') : text('生成', 'Generation');
  const format = (value: number, digits = 0) => value.toLocaleString(language, { maximumFractionDigits: digits, minimumFractionDigits: digits });
  const number = (value: number | null | undefined, suffix = '', digits = 0) => validNumber(value) ? `${format(value, digits)}${suffix}` : '–';
  const percent = (value: number | null | undefined) => validNumber(value) && value <= 100 ? number(value, '%') : '–';
  const floatingLabel = text('打开监控浮条', 'Open floating monitor');

  return <footer className="workspace-statusbar service-telemetry-statusbar" aria-label={text('服务监控', 'Service telemetry')} data-state={state}>
    <span className="workspace-statusbar-state service-telemetry-state" title={status}><span className="service-telemetry-dot" aria-hidden="true"/>{status}</span>
    {showMetrics && <div className="service-telemetry-values" aria-label={text('服务监控指标', 'Service telemetry values')} tabIndex={0}>
      <span className="service-telemetry-value service-telemetry-speed"><span>{speedLabel}</span><strong>{number(speed, '', 1)}</strong><span>tok/s</span></span>
      <span className="service-telemetry-value"><span>{text('运行', 'Running')}</span><strong>{number(metric.running)}</strong></span>
      <span className="service-telemetry-value" data-busy={validNumber(metric.queued) && metric.queued > 0}><span>{text('排队', 'Queued')}</span><strong>{number(metric.queued)}</strong></span>
      <span className="service-telemetry-value service-telemetry-gpu"><span>GPU</span><strong>{percent(metric.gpuUtil)}</strong></span>
      <span className="service-telemetry-value service-telemetry-cpu"><span>CPU</span><strong>{percent(metric.cpuUtil)}</strong></span>
      <span className="service-telemetry-value service-telemetry-temperature" title={text('GPU 温度', 'GPU temperature')}><span>{text('温度', 'Temp')}</span><strong>{number(metric.gpuTemperature, '°C')}</strong></span>
      <span className="service-telemetry-value service-telemetry-power" title={text('GPU 功耗', 'GPU power')}><span>{text('功耗', 'Power')}</span><strong>{number(metric.gpuPower, ' W')}</strong></span>
    </div>}
    {desktop && onOpenFloating && <button type="button" className="service-telemetry-floating" onClick={onOpenFloating} aria-label={floatingLabel} title={floatingLabel}><PictureInPicture2 size={14}/></button>}
  </footer>;
}
