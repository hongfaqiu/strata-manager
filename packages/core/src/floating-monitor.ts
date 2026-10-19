import type { AppLanguage } from "./languages";
import type {
  FloatingMonitorAction,
  FloatingMonitorLayout,
  FloatingMonitorMetric,
  FloatingMonitorPreferences,
  ResolvedFloatingMonitorPreferences,
  TrayIconDisplay,
} from './types';

export interface FloatingMonitorMetricDefinition {
  id: FloatingMonitorMetric;
  label: { 'zh-CN': string; en: string };
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

export const FLOATING_MONITOR_SHORT_LABELS: Record<'zh-CN' | 'en', Record<FloatingMonitorMetric, string>> = {
  'zh-CN': { generation: '生成', prefill: '读取', gpu: 'GPU', vram: '显存', cpu: 'CPU', ram: '内存', temperature: '温度', power: '功耗', running: '运行', queued: '排队', cache: '缓存' },
  en: { generation: 'Gen', prefill: 'Read', gpu: 'GPU', vram: 'VRAM', cpu: 'CPU', ram: 'RAM', temperature: 'Temp', power: 'Power', running: 'Run', queued: 'Queue', cache: 'Cache' },
};

export const FLOATING_MONITOR_DISPLAY_UNITS: Record<FloatingMonitorMetric, string> = {
  generation: 't/s', prefill: 't/s', gpu: '%', vram: 'GiB', cpu: '%', ram: 'GiB',
  temperature: '°C', power: 'W', running: '', queued: '', cache: '%',
};

export const FLOATING_MONITOR_VALUE_CHARACTERS: Record<FloatingMonitorMetric, number> = {
  generation: 6, prefill: 6, gpu: 3, vram: 5, cpu: 3, ram: 5, temperature: 3, power: 4, running: 4, queued: 4, cache: 3,
};

/** Automatic text/graph colors, verified against the matching desktop surface. */
export const FLOATING_MONITOR_PALETTES: Record<'light' | 'dark', Record<FloatingMonitorMetric, string>> = {
  light: {
    generation: '#147d4e', prefill: '#176db4', gpu: '#a85010', vram: '#0c7383', cpu: '#7e45b1', ram: '#4e5cba',
    temperature: '#bb3f48', power: '#8a6508', running: '#127568', queued: '#a25318', cache: '#6650b3',
  },
  dark: {
    generation: '#68e7a5', prefill: '#75bdff', gpu: '#ffbb75', vram: '#5edbe8', cpu: '#c49af7', ram: '#a3b3ff',
    temperature: '#ff959e', power: '#efd16a', running: '#61d8b9', queued: '#f7ae72', cache: '#b5a2fa',
  },
};

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
  showStatus: false,
  snapToEdge: false,
  metricColors: {},
  mode: 'floating',
  trayIconDisplay: 'status',
};

/** Tray icon choices in menu order; the native side accepts the same ids. */
export const TRAY_ICON_DISPLAYS: readonly TrayIconDisplay[] = ['none', 'status', 'generation', 'vram', 'gpu'];

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
    ? Math.min(36, Math.max(8, Math.round(source.fontSize))) : FLOATING_MONITOR_DEFAULTS.fontSize;
  const metricColors: Partial<Record<FloatingMonitorMetric, string>> = {};
  if (source.metricColors && typeof source.metricColors === 'object' && !Array.isArray(source.metricColors)) {
    for (const [metric, color] of Object.entries(source.metricColors)) {
      if (validMetrics.has(metric) && typeof color === 'string' && /^#[0-9a-fA-F]{6}$/.test(color)) {
        metricColors[metric as FloatingMonitorMetric] = color.toLowerCase();
      }
    }
  }
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
    showStatus: source.showStatus === true,
    snapToEdge: source.snapToEdge === true,
    metricColors,
    // Retired taskbar preferences fall back to the supported desktop strip.
    mode: 'floating',
    trayIconDisplay: typeof source.trayIconDisplay === 'string' && (TRAY_ICON_DISPLAYS as readonly string[]).includes(source.trayIconDisplay)
      ? source.trayIconDisplay as TrayIconDisplay : 'status',
  };
}

export const FLOATING_MONITOR_PRESETS: Record<FloatingMonitorLayout, ResolvedFloatingMonitorPreferences> = {
  compact: normalizeFloatingMonitorPreferences({
    layout: 'compact', fontSize: 14, metrics: ['generation', 'gpu', 'vram'], showGraphs: false, showLabels: true,
  }),
  twoRow: normalizeFloatingMonitorPreferences(),
  panel: normalizeFloatingMonitorPreferences({
    layout: 'panel', fontSize: 18,
    metrics: ['generation', 'prefill', 'gpu', 'vram', 'cpu', 'ram', 'temperature', 'power'],
  }),
};

/** Move a metric to its final zero-based index, always returning a fresh array. */
export function reorderFloatingMonitorMetrics(
  metrics: readonly FloatingMonitorMetric[],
  from: FloatingMonitorMetric,
  targetIndex: number,
): FloatingMonitorMetric[] {
  const reordered = [...metrics];
  const sourceIndex = reordered.indexOf(from);
  if (sourceIndex < 0 || !validMetrics.has(from) || !Number.isInteger(targetIndex)) return reordered;
  const destinationIndex = Math.min(reordered.length - 1, Math.max(0, targetIndex));
  reordered.splice(sourceIndex, 1);
  reordered.splice(destinationIndex, 0, from);
  return reordered;
}

export interface FloatingMonitorDimensions {
  width: number;
  height: number;
  columns: number;
  rows: number;
  columnWidths: number[];
}

/** Logical pixels shared by the content layout and native floating window. */
export function floatingMonitorDimensions(preferences: FloatingMonitorPreferences, language: AppLanguage = 'zh-CN'): FloatingMonitorDimensions {
  const { layout, metrics, fontSize, showLabels, showUnits, showGraphs, showStatus, showSampleTime } = normalizeFloatingMonitorPreferences(preferences);
  const count = Math.max(1, metrics.length);
  const columns = layout === 'compact' ? Math.min(count, 4) : layout === 'twoRow' ? Math.ceil(count / 2) : 2;
  const rows = layout === 'compact' ? Math.ceil(count / 4) : layout === 'twoRow' ? Math.min(count, 2) : Math.ceil(count / 2);
  const labelFont = Math.max(8, Math.round(fontSize * 0.7));
  const compact = layout === 'compact';
  const padding = compact ? 4 : 5;
  const textWidth = (text: string) => [...text].reduce((width, character) => width + ((character.codePointAt(0) ?? 0) <= 127 ? 0.5 : 1) * labelFont, 0);
  const columnWidths = Array.from({ length: columns }, () => 0);
  metrics.forEach((metric, index) => {
    const unit = FLOATING_MONITOR_DISPLAY_UNITS[metric];
    const valueWidth = FLOATING_MONITOR_VALUE_CHARACTERS[metric] * 0.58 * fontSize + (showUnits && unit ? textWidth(unit) + (compact ? 2 : 3) : 0);
    const labelWidth = showLabels ? textWidth(FLOATING_MONITOR_SHORT_LABELS[language === 'zh-CN' ? 'zh-CN' : 'en'][metric]) : 0;
    const cellWidth = Math.ceil(Math.max(valueWidth, labelWidth) + 4);
    const column = index % columns;
    columnWidths[column] = Math.max(columnWidths[column] ?? 0, cellWidth);
  });
  const cellHeight = Math.ceil(fontSize * 1.4) + (showLabels ? labelFont + 2 : 0) + (showGraphs ? compact ? 16 : 18 : 0);
  const headerHeight = showStatus || showSampleTime ? Math.ceil(fontSize * 0.85) + 4 : 0;
  return {
    width: Math.max(96, columnWidths.reduce((total, width) => total + width, 0) + (columns - 1) * 2 + padding * 2),
    height: Math.max(24, rows * cellHeight + (rows - 1) * 2 + headerHeight + padding * 2),
    columns,
    rows,
    columnWidths,
  };
}
