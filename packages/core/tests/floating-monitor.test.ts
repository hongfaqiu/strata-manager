import { describe, expect, it } from 'vitest';
import {
  FLOATING_MONITOR_DEFAULTS,
  FLOATING_MONITOR_METRICS,
  FLOATING_MONITOR_PALETTES,
  FLOATING_MONITOR_PRESETS,
  floatingMonitorDimensions,
  floatingMonitorStripRows,
  FLOATING_MONITOR_MAX_WIDTH,
  floatingMonitorSingleRowFallback,
  firstRunFloatingMonitorPreferences,
  migrateFloatingMonitorRows,
  normalizeFloatingMonitorPreferences,
  reorderFloatingMonitorMetrics,
  normalizeTaskbarWidgetPreferences,
  toggleTaskbarWidgetItem,
  setTaskbarWidgetColor,
  normalizeHexColor,
  colorContrast,
  lowContrastTaskbars,
  RETIRED_FLOATING_MONITOR_KEYS,
  withoutRetiredFloatingMonitorKeys,
  TASKBAR_WIDGET_COLOR_PRESETS,
  TASKBAR_WIDGET_PALETTE,
  FLOATING_MONITOR_SHORTCUTS,
  resolveFloatingMonitorShortcut,
} from '../src/floating-monitor';
import type { FloatingMonitorMetric, FloatingMonitorPreferences } from '../src/types';

/** The retired 紧凑单行 bundle as it migrates: strip + one row, 14 px, three metrics, no graphs. */
const SMALL_SINGLE = normalizeFloatingMonitorPreferences({
  layout: 'strip', rows: 'single', fontSize: 14, metrics: ['generation', 'gpu', 'vram'], showGraphs: false,
});

describe('floating monitor preferences', () => {
  it('defaults to a readable two-row monitor', () => {
    expect(normalizeFloatingMonitorPreferences()).toEqual({
      actions: [], alwaysOnTop: true, showSampleTime: false,
      fontSize: 16, layout: 'strip', rows: 'double',
      metrics: ['generation', 'prefill', 'gpu', 'vram', 'cpu', 'ram'],
      showGraphs: true, showLabels: true, showUnits: true, mode: 'floating', snapToEdge: false, showStatus: false, metricColors: {},
      taskbarEnabled: false, taskbar: { ring: 'gpu', items: ['generation', 'prefill'] },
    });
  });

  it.each([null, [], true, 12, 'compact', { fontSize: '24', metrics: 'gpu', layout: true, mode: 'dock' }].map(value => ({ value })))(
    'accepts malformed or absent persisted settings: $value', ({ value }) => {
      expect(normalizeFloatingMonitorPreferences(value)).toEqual(FLOATING_MONITOR_DEFAULTS);
    },
  );

  it('retains legacy preferences and adds the new defaults', () => {
    const legacy: FloatingMonitorPreferences = {
      actions: ['main', 'refresh'], alwaysOnTop: false, showSampleTime: true,
    };
    expect(normalizeFloatingMonitorPreferences(legacy)).toEqual({ ...FLOATING_MONITOR_DEFAULTS, ...legacy });
  });

  it('drops the retired tray-monitor switch from old settings without touching the input', () => {
    const saved = { showInTray: true, alwaysOnTop: false, futureKey: 'kept', taskbarEnabled: true };
    expect(normalizeFloatingMonitorPreferences(saved)).not.toHaveProperty('showInTray');
    expect(normalizeFloatingMonitorPreferences(saved)).toMatchObject({ alwaysOnTop: false, taskbarEnabled: true });
    expect(withoutRetiredFloatingMonitorKeys(saved)).toEqual({ alwaysOnTop: false, futureKey: 'kept', taskbarEnabled: true });
    expect(saved.showInTray).toBe(true);
    expect(RETIRED_FLOATING_MONITOR_KEYS).toEqual(['showInTray']);
    for (const value of [undefined, null, [], 'x', 3]) expect(withoutRetiredFloatingMonitorKeys(value)).toEqual({});
  });

  it('keeps metric order while removing duplicates and unknown metrics', () => {
    expect(normalizeFloatingMonitorPreferences({ metrics: ['ram', 'gpu', 'ram', false, 'invalid', 'generation', null] }).metrics)
      .toEqual(['ram', 'gpu', 'generation']);
  });

  it('limits the monitor to the first eight distinct supported metrics', () => {
    expect(normalizeFloatingMonitorPreferences({ metrics: ['cache', 'queued', 'running', 'power', 'temperature', 'ram', 'cpu', 'vram', 'gpu', 'prefill', 'generation'] }).metrics)
      .toEqual(['cache', 'queued', 'running', 'power', 'temperature', 'ram', 'cpu', 'vram']);
  });

  it.each([[], ['unknown', false, null]].map(metrics => ({ metrics })))('restores defaults when there are no supported metrics: $metrics', ({ metrics }) => {
    expect(normalizeFloatingMonitorPreferences({ metrics }).metrics).toEqual(FLOATING_MONITOR_DEFAULTS.metrics);
  });

  it('keeps only the first six distinct supported legacy actions', () => {
    expect(normalizeFloatingMonitorPreferences({ actions: ['pin', 'unknown', 'main', 'pin', null, 'chat', 'monitoring', 'usage', 'tasks', 'refresh'] }).actions)
      .toEqual(['pin', 'main', 'chat', 'monitoring', 'usage', 'tasks']);
  });

  it.each([
    [-999, 8], [0, 8], [7, 8], [8, 8], [11, 11], [12, 12], [15.6, 16], [24, 24], [36, 36], [37, 36], [999, 36],
    [NaN, 16], [Infinity, 16], [-Infinity, 16], ['18', 16], [null, 16],
  ])('normalizes font size %j to %j', (fontSize, expected) => {
    expect(normalizeFloatingMonitorPreferences({ fontSize }).fontSize).toBe(expected);
  });

  it('restores legacy taskbar mode to floating while preserving presentation choices', () => {
    expect(normalizeFloatingMonitorPreferences({
      layout: 'panel', mode: 'taskbar', showGraphs: false, showLabels: false, showUnits: false, snapToEdge: true, showStatus: true,
    })).toMatchObject({ layout: 'panel', mode: 'floating', showGraphs: false, showLabels: false, showUnits: false, snapToEdge: true, showStatus: true });
  });

  it('uses boolean defaults for invalid boolean values', () => {
    expect(normalizeFloatingMonitorPreferences({
      alwaysOnTop: 0, showSampleTime: 'true',
      showGraphs: null, showLabels: 0, showUnits: 'false', snapToEdge: 'true', showStatus: 1,
    })).toEqual(FLOATING_MONITOR_DEFAULTS);
  });

  it('returns fresh arrays without changing input or shared defaults', () => {
    const metrics = ['gpu', 'gpu', 'cpu'];
    const actions = ['main', 'main'];
    const result = normalizeFloatingMonitorPreferences({ metrics, actions });
    result.metrics.push('ram');
    result.actions.push('pin');
    expect(metrics).toEqual(['gpu', 'gpu', 'cpu']);
    expect(actions).toEqual(['main', 'main']);
    const defaults = normalizeFloatingMonitorPreferences();
    defaults.metrics.pop();
    defaults.actions.push('refresh');
    expect(normalizeFloatingMonitorPreferences()).toEqual(FLOATING_MONITOR_DEFAULTS);
  });

  it('normalizes only supported six-digit metric colors while retaining unselected metric overrides', () => {
    expect(normalizeFloatingMonitorPreferences({ metrics: ['gpu'], metricColors: {
      generation: '#AbCdEf', gpu: '#000000', ram: '#ffffff', prefill: '#123', cpu: 'red',
      vram: '#12345678', temperature: ' #112233', power: 'var(--accent)', running: 123456, queued: null, unknown: '#112233',
    } }).metricColors).toEqual({ generation: '#abcdef', gpu: '#000000', ram: '#ffffff' });
  });

  it.each([null, [], true, '#112233', 42].map(metricColors => ({ metricColors })))('ignores a malformed color map: $metricColors', ({ metricColors }) => {
    expect(normalizeFloatingMonitorPreferences({ metricColors }).metricColors).toEqual({});
  });

  it('does not mutate or share custom color maps', () => {
    const metricColors = Object.freeze({ gpu: '#AA5511' });
    const result = normalizeFloatingMonitorPreferences({ metricColors });
    result.metricColors.gpu = '#222222';
    expect(metricColors.gpu).toBe('#AA5511');
    expect(normalizeFloatingMonitorPreferences({ metricColors }).metricColors.gpu).toBe('#aa5511');
    const defaults = normalizeFloatingMonitorPreferences();
    defaults.metricColors.gpu = '#333333';
    expect(normalizeFloatingMonitorPreferences().metricColors).toEqual({});
  });
});

describe('floating monitor presets and metric catalogue', () => {
  it('offers only the strip (default, two rows) and the larger panel', () => {
    expect(Object.keys(FLOATING_MONITOR_PRESETS)).toEqual(['strip', 'panel']);
    expect(FLOATING_MONITOR_PRESETS.strip).toEqual(FLOATING_MONITOR_DEFAULTS);
    expect(FLOATING_MONITOR_PRESETS.strip).toMatchObject({ layout: 'strip', rows: 'double' });
    expect(FLOATING_MONITOR_PRESETS.panel).toMatchObject({
      layout: 'panel', fontSize: 18,
      metrics: ['generation', 'prefill', 'gpu', 'vram', 'cpu', 'ram', 'temperature', 'power'],
    });
    for (const preset of Object.values(FLOATING_MONITOR_PRESETS)) {
      expect(normalizeFloatingMonitorPreferences(preset)).toEqual(preset);
      expect(preset).toMatchObject({ showLabels: true, showStatus: false, snapToEdge: false });
    }
  });

  it('provides localized labels and units for every available metric', () => {
    expect(FLOATING_MONITOR_METRICS.map(metric => metric.id)).toEqual([
      'generation', 'prefill', 'gpu', 'vram', 'cpu', 'ram', 'temperature', 'power', 'running', 'queued', 'cache',
    ]);
    for (const metric of FLOATING_MONITOR_METRICS) {
      expect(metric.label['zh-CN']).not.toBe('');
      expect(metric.label.en).not.toBe('');
      expect(metric.unit).toBeTypeOf('string');
    }
  });

  it('provides theme-aware default colors with readable contrast on monitor surfaces', () => {
    const luminance = (hex: string) => {
      const channels = [1, 3, 5].map(index => parseInt(hex.slice(index, index + 2), 16) / 255)
        .map(channel => channel <= 0.04045 ? channel / 12.92 : ((channel + 0.055) / 1.055) ** 2.4);
      return channels[0]! * 0.2126 + channels[1]! * 0.7152 + channels[2]! * 0.0722;
    };
    for (const theme of ['light', 'dark'] as const) {
      expect(Object.keys(FLOATING_MONITOR_PALETTES[theme])).toHaveLength(FLOATING_MONITOR_METRICS.length);
      const surface = luminance(theme === 'light' ? '#ffffff' : '#161a1d');
      for (const { id } of FLOATING_MONITOR_METRICS) {
        const color = FLOATING_MONITOR_PALETTES[theme][id];
        expect(color).toMatch(/^#[0-9a-f]{6}$/);
        const foreground = luminance(color);
        expect((Math.max(surface, foreground) + 0.05) / (Math.min(surface, foreground) + 0.05)).toBeGreaterThanOrEqual(4.5);
      }
    }
  });
});

describe('floating monitor dimensions', () => {
  it('sizes the default two rows consistently for web and native windows', () => {
    expect(floatingMonitorDimensions(FLOATING_MONITOR_PRESETS.strip))
      .toEqual({ width: 244, height: 120, columns: 3, rows: 2, columnWidths: [80, 80, 70], inline: false, gap: 2 });
  });

  it('sizes the old compact bundle as one line with labels beside the values', () => {
    expect(floatingMonitorDimensions(SMALL_SINGLE))
      .toEqual({ width: 259, height: 30, columns: 3, rows: 1, columnWidths: [94, 55, 86], inline: true, gap: 7 });
  });

  it('removes inline labels from the width, not the height', () => {
    const withLabels = floatingMonitorDimensions({ ...SMALL_SINGLE, showLabels: true });
    expect(withLabels).toEqual({ width: 259, height: 30, columns: 3, rows: 1, columnWidths: [94, 55, 86], inline: true, gap: 7 });
    expect(floatingMonitorDimensions({ ...SMALL_SINGLE, showLabels: false }))
      .toEqual({ width: 195, height: 30, columns: 3, rows: 1, columnWidths: [71, 37, 63], inline: true, gap: 7 });
  });

  it.each(['strip', 'panel'] as const)('removes label height for every stacked %s row', layout => {
    const preset = FLOATING_MONITOR_PRESETS[layout];
    const withLabels = floatingMonitorDimensions(preset);
    const withoutLabels = floatingMonitorDimensions({ ...preset, showLabels: false });
    const labelHeight = Math.max(8, Math.round(preset.fontSize * 0.7)) + 2;
    expect(withLabels.height - withoutLabels.height).toBe(withLabels.rows * labelHeight);
    expect(withoutLabels.width).toBe(withLabels.width);
  });

  it.each([
    { showStatus: true, showSampleTime: false },
    { showStatus: false, showSampleTime: true },
    { showStatus: true, showSampleTime: true },
  ])('adds only one header when status or sample time is visible: %j', options => {
    expect(floatingMonitorDimensions({ ...SMALL_SINGLE, ...options }))
      .toEqual({ width: 259, height: 46, columns: 3, rows: 1, columnWidths: [94, 55, 86], inline: true, gap: 7 });
  });

  it('keeps five single-row metrics on one row with room for graphs (no more 4 + 1 wrap)', () => {
    expect(floatingMonitorDimensions({
      ...SMALL_SINGLE,
      metrics: ['generation', 'gpu', 'vram', 'cpu', 'ram'],
      showGraphs: true,
    })).toEqual({ width: 414, height: 48, columns: 5, rows: 1, columnWidths: [94, 55, 86, 55, 86], inline: true, gap: 7 });
  });

  it('keeps a single one-row metric stacked within the minimum width', () => {
    expect(floatingMonitorDimensions({ ...SMALL_SINGLE, metrics: ['gpu'] }))
      .toEqual({ width: 96, height: 42, columns: 1, rows: 1, columnWidths: [37], inline: false, gap: 2 });
  });

  it('falls back to two rows when eight single-row metrics at the largest font exceed the window limit', () => {
    expect(floatingMonitorDimensions({
      ...SMALL_SINGLE,
      fontSize: 36,
      metrics: FLOATING_MONITOR_METRICS.slice(0, 8).map(metric => metric.id),
      showGraphs: true,
    })).toEqual({ width: 613, height: 204, columns: 4, rows: 2, columnWidths: [170, 170, 108, 149], inline: false, gap: 2 });
  });

  const sized = { single: SMALL_SINGLE, double: FLOATING_MONITOR_PRESETS.strip, panel: FLOATING_MONITOR_PRESETS.panel };
  it.each([
    { layout: 'single', fontSize: 8, width: 190, height: 24 },
    { layout: 'double', fontSize: 8, width: 151, height: 92 },
    { layout: 'panel', fontSize: 8, width: 106, height: 176 },
    { layout: 'single', fontSize: 36, width: 594, height: 61 },
    { layout: 'double', fontSize: 36, width: 503, height: 204 },
    { layout: 'panel', fontSize: 36, width: 352, height: 400 },
  ] as const)('sizes $layout at $fontSize px without shrinking the selected font', ({ layout, fontSize, width, height }) => {
    const preferences = normalizeFloatingMonitorPreferences({ ...sized[layout], fontSize });
    expect(preferences.fontSize).toBe(fontSize);
    expect(floatingMonitorDimensions(preferences)).toMatchObject({ width, height });
  });

  it('keeps a tiny label-free monitor usable at the minimum window dimensions', () => {
    expect(floatingMonitorDimensions({ ...SMALL_SINGLE, fontSize: 8, showLabels: false, metrics: ['generation'] }))
      .toEqual({ width: 96, height: 24, columns: 1, rows: 1, columnWidths: [47], inline: false, gap: 2 });
  });

  it('sizes a panel with four rows and labels above the values', () => {
    expect(floatingMonitorDimensions(FLOATING_MONITOR_PRESETS.panel))
      .toEqual({ width: 192, height: 252, columns: 2, rows: 4, columnWidths: [90, 90], inline: false, gap: 2 });
  });

  it('keeps six single-row metrics on one line and keeps one metric readable', () => {
    expect(floatingMonitorDimensions({ ...FLOATING_MONITOR_DEFAULTS, fontSize: 14, showGraphs: false, rows: 'single' }))
      .toMatchObject({ width: 515, height: 30, columns: 6, rows: 1, inline: true });
    expect(floatingMonitorDimensions({ ...FLOATING_MONITOR_DEFAULTS, metrics: ['generation'] }))
      .toMatchObject({ width: 96, columns: 1, rows: 1 });
  });

  it('shrinks value budgets when units are hidden', () => {
    expect(floatingMonitorDimensions({ ...SMALL_SINGLE, showUnits: false }))
      .toMatchObject({ width: 215, columnWidths: [76, 47, 68] });
    expect(floatingMonitorDimensions({ ...FLOATING_MONITOR_PRESETS.strip, showUnits: false }))
      .toMatchObject({ width: 185, columnWidths: [60, 60, 51] });
  });

  it('uses localized short labels only when labels are enabled', () => {
    const preferences = { ...SMALL_SINGLE, fontSize: 8, showUnits: false, metrics: ['cache', 'power', 'queued', 'gpu'] as FloatingMonitorMetric[] };
    expect(floatingMonitorDimensions(preferences, 'zh-CN')).toMatchObject({ width: 182, columnWidths: [37, 42, 42, 33] });
    expect(floatingMonitorDimensions(preferences, 'en')).toMatchObject({ width: 194, columnWidths: [41, 46, 46, 33] });
    for (const language of ['zh-CN', 'en'] as const) {
      expect(floatingMonitorDimensions({ ...preferences, showLabels: false }, language)).toMatchObject({ width: 110, columnWidths: [18, 23, 23, 18] });
    }
  });

  it('uses the widest metric in each row-major column without equalizing other columns', () => {
    expect(floatingMonitorDimensions(FLOATING_MONITOR_DEFAULTS).columnWidths).toEqual([80, 80, 70]);
    expect(floatingMonitorDimensions({ ...FLOATING_MONITOR_DEFAULTS, metrics: ['gpu', 'cpu', 'generation', 'prefill', 'vram', 'ram'] }).columnWidths)
      .toEqual([80, 70, 80]);
  });

  it('does not change column widths for current samples or color overrides', () => {
    const expected = floatingMonitorDimensions(FLOATING_MONITOR_DEFAULTS);
    for (const generation of [0, 9.8, 999.9, 12000, 999900000]) {
      const preferences = { ...FLOATING_MONITOR_DEFAULTS, metricColors: { gpu: '#123456' }, liveSample: { generation } };
      expect(floatingMonitorDimensions(preferences)).toEqual(expected);
    }
  });

  it('keeps every supported layout bounded at the largest font and metric count', () => {
    for (const [layout, rows] of [['strip', 'single'], ['strip', 'double'], ['panel', 'double']] as const) {
      const dimensions = floatingMonitorDimensions({
        ...FLOATING_MONITOR_DEFAULTS, layout, rows, fontSize: 36,
        metrics: FLOATING_MONITOR_METRICS.slice(0, 8).map(metric => metric.id),
      });
      expect(dimensions.width).toBeLessThanOrEqual(1020);
      expect(dimensions.height).toBeLessThanOrEqual(640);
      expect(dimensions.columns * dimensions.rows).toBeGreaterThanOrEqual(8);
    }
  });
});

describe('floating monitor text rows (文字行数)', () => {
  const eight = FLOATING_MONITOR_METRICS.slice(0, 8).map(metric => metric.id);

  it('always resolves to single or double; the strip has no auto', () => {
    expect(normalizeFloatingMonitorPreferences({}).rows).toBe('double');
    expect(normalizeFloatingMonitorPreferences({ rows: 'auto' }).rows).toBe('double');
    expect(normalizeFloatingMonitorPreferences({ rows: 'three' }).rows).toBe('double');
    expect(normalizeFloatingMonitorPreferences({ rows: 'single' }).rows).toBe('single');
    expect(normalizeFloatingMonitorPreferences({ rows: 'double' }).rows).toBe('double');
    expect(floatingMonitorStripRows(FLOATING_MONITOR_DEFAULTS)).toBe(2);
    expect(floatingMonitorStripRows({ ...FLOATING_MONITOR_DEFAULTS, rows: 'single' })).toBe(1);
    expect(floatingMonitorStripRows({ ...FLOATING_MONITOR_DEFAULTS, layout: 'panel', rows: 'single' })).toBe('grid');
  });

  it('flags a single row that falls back to two rows', () => {
    expect(floatingMonitorSingleRowFallback({ ...FLOATING_MONITOR_DEFAULTS, rows: 'single' })).toBe(false);
    expect(floatingMonitorSingleRowFallback({ ...FLOATING_MONITOR_DEFAULTS, rows: 'single' }, 'zh-CN', 400)).toBe(true);
    expect(floatingMonitorSingleRowFallback({ ...FLOATING_MONITOR_DEFAULTS, rows: 'double' }, 'zh-CN', 400)).toBe(false);
    expect(floatingMonitorSingleRowFallback({ ...FLOATING_MONITOR_PRESETS.panel, rows: 'single' }, 'zh-CN', 100)).toBe(false);
  });

  it('keeps the default two-row strip unchanged', () => {
    expect(floatingMonitorDimensions({ ...FLOATING_MONITOR_DEFAULTS, rows: 'double' })).toEqual(floatingMonitorDimensions(FLOATING_MONITOR_DEFAULTS));
  });

  it('single row puts every metric on one line with inline labels and a wider, shorter strip', () => {
    expect(floatingMonitorDimensions({ ...FLOATING_MONITOR_DEFAULTS, rows: 'single' }))
      .toEqual({ width: 570, height: 51, columns: 6, rows: 1, columnWidths: [105, 105, 60, 95, 60, 95], inline: true, gap: 8 });
    expect(floatingMonitorDimensions({ ...FLOATING_MONITOR_DEFAULTS, metrics: eight, rows: 'single' }))
      .toMatchObject({ width: 738, height: 51, columns: 8, rows: 1 });
    expect(floatingMonitorDimensions({ ...FLOATING_MONITOR_DEFAULTS, metrics: eight }))
      .toMatchObject({ width: 298, height: 120, columns: 4, rows: 2, inline: false });
  });

  it('two rows splits small metrics evenly instead of 4 + N', () => {
    expect(floatingMonitorDimensions({ ...SMALL_SINGLE, metrics: eight, showGraphs: true, rows: 'double' }))
      .toEqual({ width: 268, height: 112, columns: 4, rows: 2, columnWidths: [71, 71, 47, 63], inline: false, gap: 2 });
    expect(floatingMonitorDimensions({ ...SMALL_SINGLE, metrics: ['generation', 'gpu', 'vram', 'cpu', 'ram'], rows: 'double' }))
      .toMatchObject({ columns: 3, rows: 2 });
  });

  it('falls back to two rows past the native limit or the room on screen', () => {
    expect(FLOATING_MONITOR_MAX_WIDTH).toBe(1120);
    const wide = floatingMonitorDimensions({ ...FLOATING_MONITOR_DEFAULTS, metrics: eight, rows: 'single', fontSize: 36 });
    expect(wide).toMatchObject({ rows: 2, inline: false });
    expect(wide.width).toBeLessThanOrEqual(FLOATING_MONITOR_MAX_WIDTH);
    expect(floatingMonitorDimensions({ ...FLOATING_MONITOR_DEFAULTS, rows: 'single' }, 'zh-CN', 400)).toMatchObject({ width: 244, rows: 2 });
    expect(floatingMonitorDimensions({ ...FLOATING_MONITOR_DEFAULTS, rows: 'single' }, 'zh-CN', 600)).toMatchObject({ width: 570, rows: 1 });
    expect(floatingMonitorDimensions({ ...FLOATING_MONITOR_DEFAULTS, rows: 'single' }, 'zh-CN', Number.NaN)).toMatchObject({ rows: 1 });
  });

  it('ignores the rows choice on the panel', () => {
    expect(floatingMonitorDimensions({ ...FLOATING_MONITOR_PRESETS.panel, rows: 'single' })).toEqual(floatingMonitorDimensions(FLOATING_MONITOR_PRESETS.panel));
  });
});

describe('floating monitor metric reordering', () => {
  const metrics = Object.freeze<FloatingMonitorMetric[]>(['generation', 'gpu', 'vram', 'cpu']);

  it.each([
    { from: 'generation', targetIndex: 2, expected: ['gpu', 'vram', 'generation', 'cpu'] },
    { from: 'cpu', targetIndex: 1, expected: ['generation', 'cpu', 'gpu', 'vram'] },
    { from: 'generation', targetIndex: 3, expected: ['gpu', 'vram', 'cpu', 'generation'] },
    { from: 'cpu', targetIndex: 0, expected: ['cpu', 'generation', 'gpu', 'vram'] },
    { from: 'vram', targetIndex: -100, expected: ['vram', 'generation', 'gpu', 'cpu'] },
    { from: 'gpu', targetIndex: 100, expected: ['generation', 'vram', 'cpu', 'gpu'] },
  ] as const)('places $from at the final index $targetIndex without mutating input', ({ from, targetIndex, expected }) => {
    const result = reorderFloatingMonitorMetrics(metrics, from, targetIndex);
    expect(result).toEqual(expected);
    expect(result).not.toBe(metrics);
    expect(metrics).toEqual(['generation', 'gpu', 'vram', 'cpu']);
  });

  it.each([
    { from: 'gpu', targetIndex: 1 },
    { from: 'ram', targetIndex: 2 },
    { from: 'invalid' as FloatingMonitorMetric, targetIndex: 0 },
    { from: 'gpu', targetIndex: NaN },
    { from: 'gpu', targetIndex: Infinity },
    { from: 'gpu', targetIndex: -Infinity },
    { from: 'gpu', targetIndex: 1.5 },
  ] as const)('returns a fresh unchanged copy for $from at index $targetIndex', ({ from, targetIndex }) => {
    const result = reorderFloatingMonitorMetrics(metrics, from, targetIndex);
    expect(result).toEqual(metrics);
    expect(result).not.toBe(metrics);
    result.push('ram');
    expect(metrics).toEqual(['generation', 'gpu', 'vram', 'cpu']);
  });

  it('handles empty and single-metric selections', () => {
    expect(reorderFloatingMonitorMetrics([], 'gpu', 0)).toEqual([]);
    const single = Object.freeze<FloatingMonitorMetric[]>(['gpu']);
    const result = reorderFloatingMonitorMetrics(single, 'gpu', 100);
    expect(result).toEqual(['gpu']);
    expect(result).not.toBe(single);
  });
});

describe('taskbar widget preferences', () => {
  it('is off by default with a GPU ring and the two speed lines', () => {
    const resolved = normalizeFloatingMonitorPreferences();
    expect(resolved.taskbarEnabled).toBe(false);
    expect(resolved.taskbar).toEqual({ ring: 'gpu', items: ['generation', 'prefill'] });
    expect(normalizeFloatingMonitorPreferences({ taskbarEnabled: 'yes' }).taskbarEnabled).toBe(false);
    expect(normalizeFloatingMonitorPreferences({ taskbarEnabled: true }).taskbarEnabled).toBe(true);
  });

  it('matches the native normalisation: allowlist, canonical order, never empty', () => {
    expect(normalizeTaskbarWidgetPreferences({ ring: 'cpu', items: ['status', 'bad', 'gpu', 'status', 3, 'generation'] }))
      .toEqual({ ring: 'gpu', items: ['generation', 'gpu', 'status'] });
    expect(normalizeTaskbarWidgetPreferences({ ring: 'vram', items: [] })).toEqual({ ring: 'vram', items: [] });
    expect(normalizeTaskbarWidgetPreferences({ ring: 'off', items: [] })).toEqual({ ring: 'gpu', items: [] });
    expect(normalizeTaskbarWidgetPreferences({ ring: 'off', items: 'gpu' })).toEqual({ ring: 'off', items: ['generation', 'prefill'] });
    expect(normalizeTaskbarWidgetPreferences({ ring: 'context', items: ['generation'] })).toEqual({ ring: 'context', items: ['generation'] });
    expect(normalizeTaskbarWidgetPreferences({ ring: 'context', items: [], colors: { context: '#3B82F6' } }))
      .toEqual({ ring: 'context', items: [], colors: { context: '#3b82f6' } });
  });

  it('keeps the taskbar row mode only when it is one or two rows', () => {
    expect(normalizeTaskbarWidgetPreferences({ ring: 'gpu', items: ['gpu'], rows: 'single' })).toEqual({ ring: 'gpu', items: ['gpu'], rows: 'single' });
    expect(normalizeTaskbarWidgetPreferences({ ring: 'gpu', items: ['gpu'], rows: 'double' }).rows).toBe('double');
    // auto is the default and is not stored, matching the native serialisation.
    expect(normalizeTaskbarWidgetPreferences({ ring: 'gpu', items: ['gpu'], rows: 'auto' })).toEqual({ ring: 'gpu', items: ['gpu'] });
    expect(normalizeTaskbarWidgetPreferences({ ring: 'gpu', items: ['gpu'], rows: 3 })).toEqual({ ring: 'gpu', items: ['gpu'] });
    expect(normalizeFloatingMonitorPreferences({ taskbar: { ring: 'vram', items: ['gpu'], rows: 'single' } }).taskbar.rows).toBe('single');
  });

  it('resolves the global shortcut away from WeChat/QQ screenshot keys', () => {
    expect(resolveFloatingMonitorShortcut(undefined)).toBe('Ctrl+Alt+M');
    expect(resolveFloatingMonitorShortcut('')).toBe('');
    expect(resolveFloatingMonitorShortcut('Ctrl+Shift+M')).toBe('Ctrl+Shift+M');
    for (const taken of ['Alt+A', 'Ctrl+Alt+A']) {
      expect(FLOATING_MONITOR_SHORTCUTS).not.toContain(taken);
      expect(resolveFloatingMonitorShortcut(taken)).toBe('Ctrl+Alt+M');
    }
    expect(normalizeFloatingMonitorPreferences()).not.toHaveProperty('shortcut');
    expect(normalizeFloatingMonitorPreferences({ shortcut: '' }).shortcut).toBe('');
    expect(normalizeFloatingMonitorPreferences({ shortcut: 'Alt+A' }).shortcut).toBe('Ctrl+Alt+M');
  });

  it('toggles items in canonical order and keeps at least one element', () => {
    const base = normalizeTaskbarWidgetPreferences();
    expect(toggleTaskbarWidgetItem(base, 'gpu').items).toEqual(['generation', 'prefill', 'gpu']);
    expect(toggleTaskbarWidgetItem({ ring: 'gpu', items: ['status'] }, 'generation').items).toEqual(['generation', 'status']);
    expect(toggleTaskbarWidgetItem(base, 'prefill').items).toEqual(['generation']);
    const last = { ring: 'off' as const, items: ['vram' as const] };
    expect(toggleTaskbarWidgetItem(last, 'vram')).toBe(last);
  });
});

describe('taskbar widget colours', () => {
  it('keeps old preferences unchanged and validates overrides like the native host', () => {
    expect(normalizeTaskbarWidgetPreferences({ ring: 'gpu', items: ['generation'] })).toEqual({ ring: 'gpu', items: ['generation'] });
    expect(normalizeTaskbarWidgetPreferences({ ring: 'gpu', items: ['generation'], colors: {
      generation: '#FF8800', prefill: '#AbC', gpu: ' #00ff00 ', vram: 'red', temperature: '#12345', status: '#ffffff', other: '#000000',
    } })).toEqual({ ring: 'gpu', items: ['generation'], colors: { generation: '#ff8800', prefill: '#aabbcc', gpu: '#00ff00' } });
    for (const broken of [null, '#fff', [1], { generation: 5 }]) {
      expect(normalizeTaskbarWidgetPreferences({ ring: 'gpu', items: ['generation'], colors: broken })).toEqual({ ring: 'gpu', items: ['generation'] });
    }
    for (const bad of ['', '#', 'fff', '#ggg', '#12345', '#1234567', 7]) expect(normalizeHexColor(bad)).toBeUndefined();
    expect(normalizeFloatingMonitorPreferences({ taskbar: { ring: 'vram', items: [], colors: { vram: '#123456' } } }).taskbar)
      .toEqual({ ring: 'vram', items: [], colors: { vram: '#123456' } });
  });

  it('sets, resets and preserves colours across item toggles', () => {
    const base = normalizeTaskbarWidgetPreferences();
    const custom = setTaskbarWidgetColor(base, 'generation', '#3B82F6');
    expect(custom.colors).toEqual({ generation: '#3b82f6' });
    expect(toggleTaskbarWidgetItem(custom, 'gpu').colors).toEqual({ generation: '#3b82f6' });
    expect(setTaskbarWidgetColor(custom, 'generation')).toEqual(base);
    expect(setTaskbarWidgetColor(custom, 'prefill', 'nope')).toEqual(custom);
  });

  it('presets stay readable on both taskbars; defaults pass 4.5:1 on their own taskbar', () => {
    for (const preset of TASKBAR_WIDGET_COLOR_PRESETS) expect(lowContrastTaskbars(preset)).toEqual([]);
    expect(lowContrastTaskbars('#ffffff')).toEqual(['light']);
    expect(lowContrastTaskbars('#000000')).toEqual(['dark']);
    expect(lowContrastTaskbars('bad')).toEqual(['light', 'dark']);
    expect(colorContrast('#000000', '#ffffff')).toBeCloseTo(21, 5);
    for (const color of Object.values(TASKBAR_WIDGET_PALETTE.light)) expect(colorContrast(color, '#f3f3f3')).toBeGreaterThanOrEqual(4.5);
    for (const color of Object.values(TASKBAR_WIDGET_PALETTE.dark)) expect(colorContrast(color, '#202020')).toBeGreaterThanOrEqual(4.5);
  });
});

describe('floating monitor migration from the three old presets', () => {
  const six = [...FLOATING_MONITOR_DEFAULTS.metrics];
  const eight = FLOATING_MONITOR_METRICS.slice(0, 8).map(metric => metric.id);

  it.each([
    { saved: { layout: 'twoRow' }, layout: 'strip', rows: 'double' },
    { saved: { layout: 'compact' }, layout: 'strip', rows: 'single' },
    { saved: { layout: 'panel' }, layout: 'panel', rows: 'double' },
    { saved: {}, layout: 'strip', rows: 'double' },
    { saved: { layout: 'unknown' }, layout: 'strip', rows: 'double' },
    // `auto` from an unreleased build follows the old preset.
    { saved: { layout: 'twoRow', rows: 'auto' }, layout: 'strip', rows: 'double' },
    { saved: { layout: 'compact', rows: 'auto' }, layout: 'strip', rows: 'single' },
    // An explicit choice always wins.
    { saved: { layout: 'twoRow', rows: 'single' }, layout: 'strip', rows: 'single' },
    { saved: { layout: 'compact', rows: 'double' }, layout: 'strip', rows: 'double' },
    { saved: { layout: 'panel', rows: 'single' }, layout: 'panel', rows: 'single' },
    { saved: { layout: 'strip', rows: 'single' }, layout: 'strip', rows: 'single' },
  ] as const)('maps $saved to $layout + $rows', ({ saved, layout, rows }) => {
    const input = JSON.parse(JSON.stringify(saved));
    expect(normalizeFloatingMonitorPreferences(input)).toMatchObject({ layout, rows });
    expect(input).toEqual(saved);
    expect(migrateFloatingMonitorRows((saved as { layout?: string }).layout, (saved as { rows?: string }).rows)).toBe(rows);
  });

  it('keeps an old 清晰双行 strip pixel-identical', () => {
    const old = { actions: [], alwaysOnTop: true, showSampleTime: false, layout: 'twoRow', fontSize: 16, metrics: eight } as unknown as FloatingMonitorPreferences;
    expect(floatingMonitorDimensions(old)).toEqual(floatingMonitorDimensions({ ...FLOATING_MONITOR_DEFAULTS, metrics: eight }));
    expect(floatingMonitorDimensions({ layout: 'twoRow' } as unknown as FloatingMonitorPreferences)).toMatchObject({ width: 244, height: 120 });
  });

  it('turns an old 紧凑单行 strip into a true single row (no 4 + 2 wrap)', () => {
    const old = { layout: 'compact', fontSize: 14, metrics: six, showGraphs: false } as unknown as FloatingMonitorPreferences;
    expect(floatingMonitorDimensions(old)).toMatchObject({ columns: 6, rows: 1, inline: true });
    expect(normalizeFloatingMonitorPreferences(old)).toMatchObject({ layout: 'strip', rows: 'single', fontSize: 14, metrics: six, showGraphs: false });
  });

  it('round-trips: a normalized value never changes again', () => {
    for (const saved of [{ layout: 'compact' }, { layout: 'twoRow', rows: 'auto' }, { layout: 'panel', rows: 'single' }]) {
      const once = normalizeFloatingMonitorPreferences(saved);
      expect(normalizeFloatingMonitorPreferences(once)).toEqual(once);
    }
  });
});

describe('first-run taskbar monitor default', () => {
  it('turns the taskbar monitor on only for a new install where the widget exists (Windows)', () => {
    expect(firstRunFloatingMonitorPreferences(true)).toEqual({ ...normalizeFloatingMonitorPreferences(undefined), taskbarEnabled: true });
    expect(firstRunFloatingMonitorPreferences(false)).toEqual(normalizeFloatingMonitorPreferences(undefined));
    // The desktop strip stays the strip, so it is still available.
    expect(firstRunFloatingMonitorPreferences(true).mode).toBe('floating');
  });

  it('never changes saved settings, including ones without a taskbar choice', () => {
    expect(FLOATING_MONITOR_DEFAULTS.taskbarEnabled).toBe(false);
    expect(normalizeFloatingMonitorPreferences({}).taskbarEnabled).toBe(false);
    expect(normalizeFloatingMonitorPreferences({ taskbarEnabled: false }).taskbarEnabled).toBe(false);
  });
});
