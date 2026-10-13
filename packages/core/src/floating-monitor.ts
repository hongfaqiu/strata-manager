import type {
  FloatingMonitorAction,
  FloatingMonitorLayout,
  FloatingMonitorMetric,
  FloatingMonitorPreferences,
  ResolvedFloatingMonitorPreferences,
} from './types';

export interface FloatingMonitorMetricDefinition {
  id: FloatingMonitorMetric;
  label: Record<'zh-CN' | 'en', string>;
  unit: string;
}

export const FLOATING_MONITOR_METRICS: FloatingMonitorMetricDefinition[] = [
  { id: 'generation', label: { 'zh-CN': '生成', en: 'Generation' }, unit: 'tok/s' },
  { id: 'prefill', label: { 'zh-CN': '读取', en: 'Prefill' }, unit: 'tok/s' },
  { id: 'gpu', label: { 'zh-CN': 'GPU', en: 'GPU' }, unit: '%' },
  { id: 'vram', label: { 'zh-CN': '显存', en: 'VRAM' }, unit: 'GiB' },
  { id: 'cpu', label: { 'zh-CN': 'CPU', en: 'CPU' }, unit: '%' },
  { id: 'ram', label: { 'zh-CN': '内存', en: 'RAM' }, unit: 'GiB' },
  { id: 'temperature', label: { 'zh-CN': '温度', en: 'Temperature' }, unit: '°C' },
  { id: 'power', label: { 'zh-CN': '功耗', en: 'Power' }, unit: 'W' },
  { id: 'running', label: { 'zh-CN': '运行', en: 'Running' }, unit: '' },
  { id: 'queued', label: { 'zh-CN': '排队', en: 'Queued' }, unit: '' },
  { id: 'cache', label: { 'zh-CN': '最近缓存', en: 'Last cache' }, unit: '%' },
];

export const FLOATING_MONITOR_DEFAULTS: ResolvedFloatingMonitorPreferences = {
  actions: [],
  alwaysOnTop: true,
  showSampleTime: false,
  showInTray: false,
  fontSize: 16,
  layout: 'twoRow',
  metrics: ['generation', 'prefill', 'gpu', 'vram', 'cpu', 'ram'],
  showGraphs: true,
  showLabels: true,
  showUnits: true,
  mode: 'floating',
};

const validMetrics = new Set<string>(FLOATING_MONITOR_METRICS.map(metric => metric.id));
const validActions = new Set<string>([
  'main', 'chat', 'monitoring', 'usage', 'tasks', 'quickBenchmark', 'copyApiUrl', 'refresh', 'pause', 'pin',
]);

/** Resolve old or malformed persisted preferences without mutating input settings. */
export function normalizeFloatingMonitorPreferences(value?: unknown): ResolvedFloatingMonitorPreferences {
  const source = value !== null && typeof value === 'object' && !Array.isArray(value)
    ? value as Record<string, unknown> : {};
  const actions = Array.isArray(source.actions)
    ? [...new Set(source.actions.filter((action): action is FloatingMonitorAction => typeof action === 'string' && validActions.has(action)))].slice(0, 6)
    : [];
  const metrics = Array.isArray(source.metrics)
    ? [...new Set(source.metrics.filter((metric): metric is FloatingMonitorMetric => typeof metric === 'string' && validMetrics.has(metric)))].slice(0, 8)
    : [];
  const fontSize = typeof source.fontSize === 'number' && Number.isFinite(source.fontSize)
    ? Math.min(24, Math.max(12, Math.round(source.fontSize))) : FLOATING_MONITOR_DEFAULTS.fontSize;
  return {
    actions,
    alwaysOnTop: source.alwaysOnTop !== false,
    showSampleTime: source.showSampleTime === true,
    showInTray: source.showInTray === true,
    fontSize,
    layout: source.layout === 'compact' || source.layout === 'panel' ? source.layout : 'twoRow',
    metrics: metrics.length ? metrics : [...FLOATING_MONITOR_DEFAULTS.metrics],
    showGraphs: source.showGraphs !== false,
    showLabels: source.showLabels !== false,
    showUnits: source.showUnits !== false,
    mode: source.mode === 'taskbar' ? 'taskbar' : 'floating',
  };
}

export const FLOATING_MONITOR_PRESETS: Record<FloatingMonitorLayout, ResolvedFloatingMonitorPreferences> = {
  compact: normalizeFloatingMonitorPreferences({
    layout: 'compact', fontSize: 14, metrics: ['generation', 'gpu', 'vram'], showGraphs: false, showLabels: false,
  }),
  twoRow: normalizeFloatingMonitorPreferences(),
  panel: normalizeFloatingMonitorPreferences({
    layout: 'panel', fontSize: 18,
    metrics: ['generation', 'prefill', 'gpu', 'vram', 'cpu', 'ram', 'temperature', 'power'],
  }),
};

export interface FloatingMonitorDimensions {
  width: number;
  height: number;
  columns: number;
  rows: number;
}

/** Logical pixels shared by the content layout and native floating window. */
export function floatingMonitorDimensions(preferences: FloatingMonitorPreferences): FloatingMonitorDimensions {
  const { layout, metrics, fontSize, showLabels, showGraphs } = normalizeFloatingMonitorPreferences(preferences);
  const count = Math.max(1, metrics.length);
  const columns = layout === 'compact' ? Math.min(count, 4) : layout === 'twoRow' ? Math.ceil(count / 2) : 2;
  const rows = layout === 'compact' ? Math.ceil(count / 4) : layout === 'twoRow' ? Math.min(count, 2) : Math.ceil(count / 2);
  const cellWidth = layout === 'compact'
    ? Math.ceil(fontSize * 5.5 + (showLabels ? 60 : 12))
    : layout === 'twoRow' ? Math.ceil(fontSize * 7.5 + (showLabels ? 64 : 20)) : Math.ceil(fontSize * 7 + 32);
  const labelFont = Math.max(10, Math.round(fontSize * 0.7));
  const cellHeight = Math.ceil(fontSize * 1.4) + (showGraphs ? 20 : 0) + (layout === 'panel' && showLabels ? labelFont + 6 : 4);
  const headerHeight = Math.ceil(fontSize * 1.2) + 10;
  return {
    width: Math.max(220, columns * cellWidth + (columns - 1) * 8 + 20),
    height: Math.max(40, rows * cellHeight + (rows - 1) * 8 + headerHeight + 20),
    columns,
    rows,
  };
}
