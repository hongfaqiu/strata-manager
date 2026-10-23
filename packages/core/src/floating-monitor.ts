import type { AppLanguage } from "./languages";
import type {
  FloatingMonitorAction,
  FloatingMonitorLayout,
  FloatingMonitorMetric,
  FloatingMonitorPreferences,
  FloatingMonitorRows,
  FloatingMonitorShortcut,
  ResolvedFloatingMonitorPreferences,
  TaskbarWidgetColorItem,
  TaskbarWidgetItem,
  TaskbarWidgetPreferences,
  TaskbarWidgetRing,
  TaskbarWidgetRows,
} from './types';

/** Canonical order; must match TaskbarWidget ITEMS in the Rust host. */
export const TASKBAR_WIDGET_ITEMS: readonly TaskbarWidgetItem[] = ['generation', 'prefill', 'gpu', 'vram', 'temperature', 'status'];
export const TASKBAR_WIDGET_RINGS: readonly TaskbarWidgetRing[] = ['gpu', 'vram', 'context', 'off'];
export const TASKBAR_WIDGET_ROWS: readonly TaskbarWidgetRows[] = ['auto', 'single', 'double'];
export const TASKBAR_WIDGET_DEFAULTS: TaskbarWidgetPreferences = { ring: 'gpu', items: ['generation', 'prefill'] };

/** Same order as COLOR_ITEMS in taskbar_widget.rs. */
export const TASKBAR_WIDGET_COLOR_ITEMS: readonly TaskbarWidgetColorItem[] = ['generation', 'prefill', 'gpu', 'vram', 'temperature', 'context'];
/** Tuned defaults of the native widget (Palette::metric); temperature is graded, shown here at <60 ℃. */
export const TASKBAR_WIDGET_PALETTE: Record<'light' | 'dark', Record<TaskbarWidgetColorItem, string>> = {
  dark: { generation: '#4ade80', prefill: '#60c8fa', gpu: '#fb923c', vram: '#c4a5fd', temperature: '#4ade80', context: '#2dd4bf' },
  light: { generation: '#15803d', prefill: '#0369a1', gpu: '#c2410c', vram: '#7e22ce', temperature: '#15803d', context: '#0f766e' },
};
/** Typical Windows 11 taskbar backgrounds. */
export const TASKBAR_BACKGROUNDS = { light: '#f3f3f3', dark: '#202020' } as const;
/** Presets that keep ≥3:1 contrast on both the light and the dark taskbar. */
export const TASKBAR_WIDGET_COLOR_PRESETS: readonly string[] = ['#059669', '#0d9488', '#0891b2', '#3b82f6', '#8b5cf6', '#db2777', '#ef4444', '#ea580c'];

/** `#rgb`/`#rrggbb` in any case → lowercase `#rrggbb`; anything else → undefined (same as parse_hex_color). */
export function normalizeHexColor(value: unknown): string | undefined {
  if (typeof value !== 'string') return undefined;
  const digits = /^#([0-9a-f]{3}|[0-9a-f]{6})$/i.exec(value.trim())?.[1];
  if (!digits) return undefined;
  const hex = digits.length === 3 ? [...digits].map(c => c + c).join('') : digits;
  return `#${hex.toLowerCase()}`;
}

function luminance(hex: string): number {
  const channel = (offset: number) => {
    const value = parseInt(hex.slice(offset, offset + 2), 16) / 255;
    return value <= 0.03928 ? value / 12.92 : ((value + 0.055) / 1.055) ** 2.4;
  };
  return 0.2126 * channel(1) + 0.7152 * channel(3) + 0.0722 * channel(5);
}

/** WCAG contrast ratio between two colours (1–21); NaN for invalid input. */
export function colorContrast(a: string, b: string): number {
  const x = normalizeHexColor(a), y = normalizeHexColor(b);
  if (!x || !y) return Number.NaN;
  const [lx, ly] = [luminance(x), luminance(y)];
  return (Math.max(lx, ly) + 0.05) / (Math.min(lx, ly) + 0.05);
}

/** Taskbar themes on which `color` falls below 3:1 (value text may be hard to read). */
export function lowContrastTaskbars(color: string, minimum = 3): ('light' | 'dark')[] {
  return (['light', 'dark'] as const).filter(theme => !(colorContrast(color, TASKBAR_BACKGROUNDS[theme]) >= minimum));
}

function normalizeTaskbarColors(value: unknown): TaskbarWidgetPreferences['colors'] {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) return undefined;
  const source = value as Record<string, unknown>;
  const colors: Partial<Record<TaskbarWidgetColorItem, string>> = {};
  for (const item of TASKBAR_WIDGET_COLOR_ITEMS) {
    const color = normalizeHexColor(source[item]);
    if (color) colors[item] = color;
  }
  return Object.keys(colors).length ? colors : undefined;
}

/** Same rules as WidgetPrefs::normalize: allowlist, canonical order, never empty, validated colours. */
export function normalizeTaskbarWidgetPreferences(value?: unknown): TaskbarWidgetPreferences {
  const source = value !== null && typeof value === 'object' && !Array.isArray(value)
    ? value as Record<string, unknown> : {};
  const items = Array.isArray(source.items)
    ? TASKBAR_WIDGET_ITEMS.filter(item => (source.items as unknown[]).includes(item))
    : [...TASKBAR_WIDGET_DEFAULTS.items];
  let ring = TASKBAR_WIDGET_RINGS.find(candidate => candidate === source.ring) ?? TASKBAR_WIDGET_DEFAULTS.ring;
  if (ring === 'off' && items.length === 0) ring = 'gpu';
  const colors = normalizeTaskbarColors(source.colors);
  const rows = source.rows === 'single' || source.rows === 'double' ? source.rows : undefined;
  return { ring, items, ...(colors ? { colors } : {}), ...(rows ? { rows } : {}) };
}

/** Toggle one item, refusing to leave the widget with nothing to show. Colours are kept. */
export function toggleTaskbarWidgetItem(preferences: TaskbarWidgetPreferences, item: TaskbarWidgetItem): TaskbarWidgetPreferences {
  const items = preferences.items.includes(item)
    ? preferences.items.filter(current => current !== item)
    : TASKBAR_WIDGET_ITEMS.filter(current => current === item || preferences.items.includes(current));
  if (preferences.ring === 'off' && items.length === 0) return preferences;
  return { ...preferences, items };
}

/** Set (valid hex) or clear (undefined/invalid) one metric's custom colour. */
export function setTaskbarWidgetColor(preferences: TaskbarWidgetPreferences, item: TaskbarWidgetColorItem, color?: string): TaskbarWidgetPreferences {
  const next: Partial<Record<TaskbarWidgetColorItem, string>> = { ...preferences.colors };
  const value = normalizeHexColor(color);
  if (value) next[item] = value; else delete next[item];
  return normalizeTaskbarWidgetPreferences({ ...preferences, colors: next });
}

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
  fontSize: 16,
  layout: 'strip',
  rows: 'double',
  metrics: ['generation', 'prefill', 'gpu', 'vram', 'cpu', 'ram'],
  showGraphs: true,
  showLabels: true,
  showUnits: true,
  showStatus: false,
  snapToEdge: false,
  metricColors: {},
  mode: 'floating',
  taskbarEnabled: false,
  taskbar: TASKBAR_WIDGET_DEFAULTS,
};

/**
 * Global show/hide shortcut presets (same list as monitor_shortcut::PRESETS).
 * Alt+A (WeChat) and Ctrl+Alt+A (QQ) are screenshot keys, so they are never offered.
 */
export const FLOATING_MONITOR_SHORTCUTS: readonly FloatingMonitorShortcut[] = ['Ctrl+Alt+M', 'Ctrl+Alt+K', 'Ctrl+Shift+M', ''];
export const FLOATING_MONITOR_DEFAULT_SHORTCUT: FloatingMonitorShortcut = 'Ctrl+Alt+M';

/** Saved shortcut → effective one: missing or unknown → default, `''` → off. */
export function resolveFloatingMonitorShortcut(value?: unknown): FloatingMonitorShortcut {
  return FLOATING_MONITOR_SHORTCUTS.find(shortcut => shortcut === value) ?? FLOATING_MONITOR_DEFAULT_SHORTCUT;
}

const validMetrics = new Set<string>(FLOATING_MONITOR_METRICS.map(metric => metric.id));
const validActions = new Set<string>([
  'main', 'chat', 'monitoring', 'usage', 'tasks', 'quickBenchmark', 'copyApiUrl', 'refresh', 'pause', 'pin',
]);

/**
 * Keys of retired features that must not survive a settings round trip.
 * `showInTray` drove the separate "托盘监控" tray icon with its own readout; that icon
 * was removed and the taskbar widget (任务栏监控) is the only background readout.
 */
export const RETIRED_FLOATING_MONITOR_KEYS = ['showInTray'] as const;

/** Copy persisted floating-monitor settings without retired keys; never mutates the input. */
export function withoutRetiredFloatingMonitorKeys(value?: unknown): Record<string, unknown> {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) return {};
  const copy: Record<string, unknown> = { ...value as Record<string, unknown> };
  for (const key of RETIRED_FLOATING_MONITOR_KEYS) delete copy[key];
  return copy;
}

export const FLOATING_MONITOR_ROWS: readonly FloatingMonitorRows[] = ['single', 'double'];

/**
 * Rows for saved settings. A saved single/double wins. Otherwise (missing, or
 * `auto` from an unreleased build) the retired preset decides: 紧凑单行
 * (`compact`) becomes one row, 清晰双行 (`twoRow`), the panel and anything
 * else become two rows, so the default strip looks exactly as before.
 */
export function migrateFloatingMonitorRows(layout: unknown, rows: unknown): FloatingMonitorRows {
  if (rows === 'single' || rows === 'double') return rows;
  return layout === 'compact' ? 'single' : 'double';
}

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
    fontSize,
    layout: source.layout === 'panel' ? 'panel' : 'strip',
    rows: migrateFloatingMonitorRows(source.layout, source.rows),
    metrics: metrics.length ? metrics : [...FLOATING_MONITOR_DEFAULTS.metrics],
    showGraphs: source.showGraphs !== false,
    showLabels: source.showLabels !== false,
    showUnits: source.showUnits !== false,
    showStatus: source.showStatus === true,
    snapToEdge: source.snapToEdge === true,
    metricColors,
    // The strip mode is always the desktop strip; the Windows taskbar widget
    // is a separate opt-in (taskbarEnabled) restored by the native host.
    mode: 'floating',
    taskbarEnabled: source.taskbarEnabled === true,
    taskbar: normalizeTaskbarWidgetPreferences(source.taskbar),
    // Kept only once the user picked one, so older settings keep the default.
    ...(typeof source.shortcut === 'string' ? { shortcut: resolveFloatingMonitorShortcut(source.shortcut) } : {}),
  };
}

export const FLOATING_MONITOR_PRESETS: Record<FloatingMonitorLayout, ResolvedFloatingMonitorPreferences> = {
  strip: normalizeFloatingMonitorPreferences(),
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
  /** One-row strip: labels sit beside the value instead of above it. */
  inline: boolean;
  /** Horizontal gap between cells. */
  gap: number;
}

/** Widest strip the native window accepts (floating_monitor.rs MAX_WIDTH). */
export const FLOATING_MONITOR_MAX_WIDTH = 1120;

/**
 * Rows the strip is asked for (before the fit check in floatingMonitorDimensions).
 * The panel is always a two-column grid.
 */
export function floatingMonitorStripRows(preferences: FloatingMonitorPreferences): 1 | 2 | 'grid' {
  const { layout, rows } = normalizeFloatingMonitorPreferences(preferences);
  if (layout === 'panel') return 'grid';
  return rows === 'single' ? 1 : 2;
}

function measureStrip(value: ResolvedFloatingMonitorPreferences, language: AppLanguage, strip: 1 | 2 | 'grid'): FloatingMonitorDimensions {
  const { metrics, fontSize, showLabels, showUnits, showGraphs, showStatus, showSampleTime } = value;
  const count = Math.max(1, metrics.length);
  const columns = strip === 'grid' ? 2 : strip === 1 ? count : Math.ceil(count / 2);
  const rows = strip === 'grid' ? Math.ceil(count / 2) : strip === 1 ? 1 : Math.min(count, 2);
  // A single row of one metric looks the same either way; keep the stacked label.
  const inline = strip === 1 && count > 1;
  const labelFont = Math.max(8, Math.round(fontSize * 0.7));
  const padding = 5;
  const gap = inline ? Math.max(6, Math.round(fontSize * 0.5)) : 2;
  const textWidth = (text: string) => [...text].reduce((width, character) => width + ((character.codePointAt(0) ?? 0) <= 127 ? 0.5 : 1) * labelFont, 0);
  const columnWidths = Array.from({ length: columns }, () => 0);
  metrics.forEach((metric, index) => {
    const unit = FLOATING_MONITOR_DISPLAY_UNITS[metric];
    const valueWidth = FLOATING_MONITOR_VALUE_CHARACTERS[metric] * 0.58 * fontSize + (showUnits && unit ? textWidth(unit) + 3 : 0);
    const labelWidth = showLabels ? textWidth(FLOATING_MONITOR_SHORT_LABELS[language === 'zh-CN' ? 'zh-CN' : 'en'][metric]) : 0;
    const cellWidth = Math.ceil((inline ? labelWidth + (showLabels ? 3 : 0) + valueWidth : Math.max(valueWidth, labelWidth)) + 4);
    const column = index % columns;
    columnWidths[column] = Math.max(columnWidths[column] ?? 0, cellWidth);
  });
  const cellHeight = Math.ceil(fontSize * 1.4) + (showLabels && !inline ? labelFont + 2 : 0) + (showGraphs ? 18 : 0);
  const headerHeight = showStatus || showSampleTime ? Math.ceil(fontSize * 0.85) + 4 : 0;
  return {
    width: Math.max(96, columnWidths.reduce((total, width) => total + width, 0) + (columns - 1) * gap + padding * 2),
    height: Math.max(24, rows * cellHeight + (rows - 1) * 2 + headerHeight + padding * 2),
    columns,
    rows,
    columnWidths,
    inline,
    gap,
  };
}

/**
 * Logical pixels shared by the content layout and native floating window.
 * `maxWidth` is the room on screen (the strip passes its work-area width);
 * the native limit FLOATING_MONITOR_MAX_WIDTH always applies.
 */
export function floatingMonitorDimensions(preferences: FloatingMonitorPreferences, language: AppLanguage = 'zh-CN', maxWidth = FLOATING_MONITOR_MAX_WIDTH): FloatingMonitorDimensions {
  const value = normalizeFloatingMonitorPreferences(preferences);
  const strip = floatingMonitorStripRows(value);
  const measured = measureStrip(value, language, strip);
  const limit = Math.min(FLOATING_MONITOR_MAX_WIDTH, Number.isFinite(maxWidth) && maxWidth > 0 ? maxWidth : FLOATING_MONITOR_MAX_WIDTH);
  // A single row wider than the room it has falls back to two rows.
  return strip === 1 && measured.width > limit ? measureStrip(value, language, 2) : measured;
}

/** 单行 was chosen but does not fit, so the strip shows two rows (settings shows a hint). */
export function floatingMonitorSingleRowFallback(preferences: FloatingMonitorPreferences, language: AppLanguage = 'zh-CN', maxWidth = FLOATING_MONITOR_MAX_WIDTH): boolean {
  return floatingMonitorStripRows(preferences) === 1 && floatingMonitorDimensions(preferences, language, maxWidth).rows !== 1;
}
