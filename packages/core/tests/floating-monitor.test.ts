import { describe, expect, it } from 'vitest';
import {
  FLOATING_MONITOR_DEFAULTS,
  FLOATING_MONITOR_METRICS,
  FLOATING_MONITOR_PRESETS,
  floatingMonitorDimensions,
  normalizeFloatingMonitorPreferences,
} from '../src/floating-monitor';
import type { FloatingMonitorPreferences } from '../src/types';

describe('floating monitor preferences', () => {
  it('defaults to a readable two-row monitor', () => {
    expect(normalizeFloatingMonitorPreferences()).toEqual({
      actions: [], alwaysOnTop: true, showSampleTime: false, showInTray: false,
      fontSize: 16, layout: 'twoRow',
      metrics: ['generation', 'prefill', 'gpu', 'vram', 'cpu', 'ram'],
      showGraphs: true, showLabels: true, showUnits: true, mode: 'floating',
    });
  });

  it.each([null, [], true, 12, 'compact', { fontSize: '24', metrics: 'gpu', layout: true, mode: 'dock' }].map(value => ({ value })))(
    'accepts malformed or absent persisted settings: $value', ({ value }) => {
      expect(normalizeFloatingMonitorPreferences(value)).toEqual(FLOATING_MONITOR_DEFAULTS);
    },
  );

  it('retains legacy preferences and adds the new defaults', () => {
    const legacy: FloatingMonitorPreferences = {
      actions: ['main', 'refresh'], alwaysOnTop: false, showSampleTime: true, showInTray: true,
    };
    expect(normalizeFloatingMonitorPreferences(legacy)).toEqual({ ...FLOATING_MONITOR_DEFAULTS, ...legacy });
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
    [0, 12], [11, 12], [12, 12], [15.6, 16], [24, 24], [999, 24],
    [NaN, 16], [Infinity, 16], [-Infinity, 16], ['18', 16], [null, 16],
  ])('normalizes font size %j to %j', (fontSize, expected) => {
    expect(normalizeFloatingMonitorPreferences({ fontSize }).fontSize).toBe(expected);
  });

  it('preserves explicit presentation choices', () => {
    expect(normalizeFloatingMonitorPreferences({
      layout: 'panel', mode: 'taskbar', showGraphs: false, showLabels: false, showUnits: false,
    })).toMatchObject({ layout: 'panel', mode: 'taskbar', showGraphs: false, showLabels: false, showUnits: false });
  });

  it('uses boolean defaults for invalid boolean values', () => {
    expect(normalizeFloatingMonitorPreferences({
      alwaysOnTop: 0, showSampleTime: 'true', showInTray: 1,
      showGraphs: null, showLabels: 0, showUnits: 'false',
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
});

describe('floating monitor presets and metric catalogue', () => {
  it('offers compact, readable two-row and larger panel presets', () => {
    expect(FLOATING_MONITOR_PRESETS.compact).toMatchObject({
      layout: 'compact', fontSize: 14, metrics: ['generation', 'gpu', 'vram'], showGraphs: false, showLabels: false,
    });
    expect(FLOATING_MONITOR_PRESETS.twoRow).toEqual(FLOATING_MONITOR_DEFAULTS);
    expect(FLOATING_MONITOR_PRESETS.panel).toMatchObject({
      layout: 'panel', fontSize: 18,
      metrics: ['generation', 'prefill', 'gpu', 'vram', 'cpu', 'ram', 'temperature', 'power'],
    });
    for (const preset of Object.values(FLOATING_MONITOR_PRESETS)) {
      expect(normalizeFloatingMonitorPreferences(preset)).toEqual(preset);
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
});

describe('floating monitor dimensions', () => {
  it('sizes the default two rows consistently for web and native windows', () => {
    expect(floatingMonitorDimensions(FLOATING_MONITOR_PRESETS.twoRow))
      .toEqual({ width: 588, height: 152, columns: 3, rows: 2 });
  });

  it('sizes a compact preset without graphs or labels', () => {
    expect(floatingMonitorDimensions(FLOATING_MONITOR_PRESETS.compact))
      .toEqual({ width: 303, height: 71, columns: 3, rows: 1 });
  });

  it('sizes a panel with four rows and labels above the values', () => {
    expect(floatingMonitorDimensions(FLOATING_MONITOR_PRESETS.panel))
      .toEqual({ width: 344, height: 336, columns: 2, rows: 4 });
  });

  it('wraps compact monitors after four items and keeps one metric readable', () => {
    expect(floatingMonitorDimensions({ ...FLOATING_MONITOR_DEFAULTS, layout: 'compact' }))
      .toMatchObject({ columns: 4, rows: 2 });
    expect(floatingMonitorDimensions({ ...FLOATING_MONITOR_DEFAULTS, metrics: ['generation'] }))
      .toMatchObject({ width: 220, columns: 1, rows: 1 });
  });

  it('keeps every supported layout bounded at the largest font and metric count', () => {
    for (const layout of ['compact', 'twoRow', 'panel'] as const) {
      const dimensions = floatingMonitorDimensions({
        ...FLOATING_MONITOR_DEFAULTS, layout, fontSize: 24,
        metrics: FLOATING_MONITOR_METRICS.slice(0, 8).map(metric => metric.id),
      });
      expect(dimensions.width).toBeLessThanOrEqual(1020);
      expect(dimensions.height).toBeLessThanOrEqual(640);
      expect(dimensions.columns * dimensions.rows).toBeGreaterThanOrEqual(8);
    }
  });
});
