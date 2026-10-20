import type { AppLanguage } from '@strata-manager/core';
import { useEffect, useId, useRef, useState } from 'react';
import { ArrowDown, ArrowUp, Check, LoaderCircle, RotateCcw } from 'lucide-react';

import {
  FLOATING_MONITOR_DEFAULTS, FLOATING_MONITOR_METRICS, FLOATING_MONITOR_PALETTES, FLOATING_MONITOR_PRESETS,
  floatingMonitorDimensions, normalizeFloatingMonitorPreferences, normalizeMetrics,
  type FloatingMonitorLayout, type FloatingMonitorMetric, type FloatingMonitorPreferences,
} from '@strata-manager/core';
import { Panel } from '../components';
import { Checkbox, Slider, Toggle } from '../OfficialControls';
import { FloatingMonitorContent } from '../FloatingMonitorContent';
import type { MonitorPoint } from '../floatingMonitorHistory';
import './floating-monitor-settings.css';

interface Props {
  preferences: FloatingMonitorPreferences;
  desktop: boolean;
  language: AppLanguage;
  onChange: (next: FloatingMonitorPreferences) => void;
  onOpen: () => void;
  onVisibilityChange?: (visible: boolean) => Promise<void>;
  modeStatus?: { mode: string; supported: boolean; active: boolean; visible?: boolean; message?: string };
}

const exampleMetric = normalizeMetrics({
  live: { state: 'generating', tok_s: 48.6, prefill_tok_s_mean: 1280, running: 1, queued: 0 },
  hardware: { gpu_util: 76, gpu_mem_used: 19.8 * 1024 ** 3, gpu_mem_total: 24 * 1024 ** 3, cpu: 22, ram_used: 28.4 * 1024 ** 3, ram_total: 64 * 1024 ** 3, gpu_temp: 62, gpu_power: 184 },
  requests: [{ hit_rate: 0.72 }],
});

// Fixed example samples belong only to the explicitly labelled appearance preview.
const exampleHistory: MonitorPoint[] = [0.66, 0.78, 0.73, 0.87, 0.93, 0.84, 1.04, 0.91, 1.07, 0.98, 0.94, 1].map((factor, index) => ({
  at: (index + 1) * 1000,
  values: {
    generation: 48.6 * factor, prefill: 1280 * (1.8 - 0.8 * factor),
    gpu: 76 * factor, vram: 19.8 * (0.95 + 0.05 * factor), cpu: 22 * factor, ram: 28.4 * (0.97 + 0.03 * factor),
    temperature: 62 * (0.9 + 0.1 * factor), power: 184 * factor, running: 1, queued: 0, cache: null,
  },
}));

export function FloatingMonitorSettings({ preferences, desktop, language, onChange, onOpen, onVisibilityChange, modeStatus }: Props) {
  const zh = language === 'zh-CN';
  const id = useId();
  const value = normalizeFloatingMonitorPreferences(preferences);
  const dimensions = floatingMonitorDimensions(value, language);
  const [changingVisibility, setChangingVisibility] = useState(false);
  const [visibilityError, setVisibilityError] = useState('');
  const [colorDrafts, setColorDrafts] = useState<Partial<Record<FloatingMonitorMetric, string>>>({});
  const [paletteTheme, setPaletteTheme] = useState<'light' | 'dark'>(() => typeof document !== 'undefined' && document.documentElement.dataset.theme === 'dark' ? 'dark' : 'light');
  const [announcement, setAnnouncement] = useState('');
  const visibilityChangePending = useRef(false);
  // While the Windows taskbar widget is active the desktop strip is hidden.
  const visible = modeStatus?.mode === 'taskbar' && modeStatus.active ? false : modeStatus?.visible ?? modeStatus?.active ?? false;
  const update = (patch: Partial<FloatingMonitorPreferences>) => onChange({ ...preferences, ...normalizeFloatingMonitorPreferences({ ...value, ...patch }) });

  useEffect(() => {
    const root = document.documentElement;
    const updateTheme = () => setPaletteTheme(root.dataset.theme === 'dark' ? 'dark' : 'light');
    const observer = new MutationObserver(updateTheme);
    observer.observe(root, { attributes: true, attributeFilter: ['data-theme'] });
    updateTheme();
    return () => observer.disconnect();
  }, []);

  const setMetricColor = (metric: FloatingMonitorMetric, color?: string) => {
    setColorDrafts(previous => { const next = { ...previous }; delete next[metric]; return next; });
    const normalized = color?.toLowerCase();
    if (normalized === value.metricColors[metric]) return;
    const metricColors = { ...value.metricColors };
    if (normalized) metricColors[metric] = normalized;
    else delete metricColors[metric];
    update({ metricColors });
  };

  const editMetricColor = (metric: FloatingMonitorMetric, color: string) => {
    if (!color || /^#[0-9a-fA-F]{6}$/.test(color)) setMetricColor(metric, color || undefined);
    else setColorDrafts(previous => ({ ...previous, [metric]: color }));
  };

  const applyPreset = (layout: FloatingMonitorLayout) => {
    const preset = FLOATING_MONITOR_PRESETS[layout];
    update({ layout, fontSize: preset.fontSize, metrics: [...preset.metrics], showGraphs: preset.showGraphs, showLabels: preset.showLabels, showUnits: preset.showUnits, showStatus: preset.showStatus });
  };

  const changeVisibility = async (next: boolean) => {
    if (!desktop || visibilityChangePending.current || next === visible || (!next && !onVisibilityChange)) return;
    visibilityChangePending.current = true;
    setChangingVisibility(true);
    setVisibilityError('');
    try {
      if (onVisibilityChange) await onVisibilityChange(next);
      else if (next) await onOpen();
    } catch (error) { setVisibilityError(error instanceof Error ? error.message : String(error)); }
    finally { visibilityChangePending.current = false; setChangingVisibility(false); }
  };

  const toggleMetric = (metric: FloatingMonitorMetric, selected: boolean) => {
    if (!desktop || (selected && value.metrics.length >= 8) || (!selected && value.metrics.length <= 1)) return;
    update({ metrics: selected ? [...value.metrics, metric] : value.metrics.filter(item => item !== metric) });
  };

  const moveMetric = (metric: FloatingMonitorMetric, direction: -1 | 1) => {
    const index = value.metrics.indexOf(metric);
    const target = index + direction;
    if (!desktop || index < 0 || target < 0 || target >= value.metrics.length) return;
    const metrics = [...value.metrics];
    metrics.splice(index, 1);
    metrics.splice(target, 0, metric);
    update({ metrics });
    const label = FLOATING_MONITOR_METRICS.find(item => item.id === metric)?.label[(language === 'zh-CN' ? 'zh-CN' : 'en')] ?? metric;
    setAnnouncement(zh ? `${label}已移至第 ${target + 1} 位` : `${label} moved to position ${target + 1}`);
  };

  const displayedMetrics = [
    ...value.metrics.map(metric => FLOATING_MONITOR_METRICS.find(item => item.id === metric)!),
    ...FLOATING_MONITOR_METRICS.filter(metric => !value.metrics.includes(metric.id)),
  ];
  const displayOptions = [
    { key: 'showGraphs' as const, title: zh ? '实时折线' : 'Live graphs', hint: zh ? '每项指标使用对应颜色绘制趋势。' : 'Each trend uses its metric color.' },
    { key: 'showLabels' as const, title: zh ? '指标标签' : 'Metric labels', hint: zh ? '关闭后隐藏全部指标名称，减少高度。' : 'Hide all metric names to reduce the height.' },
    { key: 'showUnits' as const, title: zh ? '数值单位' : 'Value units', hint: zh ? '显示 tok/s、GiB 等单位。' : 'Show units such as tok/s and GiB.' },
    { key: 'showSampleTime' as const, title: zh ? '采样时间' : 'Sample time', hint: zh ? '显示最近一次采样时间。' : 'Show the most recent sample time.' },
    { key: 'showStatus' as const, title: zh ? '显示状态文字' : 'Show status text', hint: zh ? '在指标上方显示运行状态，默认关闭。' : 'Show the runtime status above metrics. Off by default.' },
    { key: 'snapToEdge' as const, title: zh ? '贴边吸附' : 'Snap to screen edges', hint: zh ? '拖动桌面浮条靠近屏幕边缘时自动贴边。' : 'Snap the floating strip when dragged near a screen edge.' },
    { key: 'alwaysOnTop' as const, title: zh ? '浮条置顶' : 'Keep strip on top', hint: zh ? '桌面浮条保持在其他窗口上方。' : 'Keep the floating strip above other windows.' },
  ];

  return <div id="settings-floating-monitor"><Panel className="floating-monitor-settings" title={zh ? '监控浮条' : 'Monitor strip'} action={
    <div className="floating-monitor-settings-visibility">
      <span>{zh ? '显示监控' : 'Show monitor'}</span>
      {changingVisibility && <LoaderCircle size={13} className="spin" aria-hidden="true"/>}
      <Toggle ariaLabel={zh ? '显示监控' : 'Show monitor'} checked={visible} disabled={!desktop || changingVisibility || (visible && !onVisibilityChange)} onCheckedChange={next => void changeVisibility(next)}/>
    </div>
  }>
    {!desktop && <p className="floating-monitor-settings-hint" role="status">{zh ? '请在桌面应用中使用监控。' : 'Use monitoring in the desktop app.'}</p>}
    {changingVisibility && <p className="floating-monitor-settings-hint" role="status">{zh ? '正在更新监控显示状态…' : 'Updating monitor visibility…'}</p>}
    {visibilityError && <p className="floating-monitor-settings-error" role="alert">{zh ? '显示状态更新失败：' : 'Could not update visibility: '}{visibilityError}</p>}

    <section className="floating-monitor-settings-preview" aria-label={zh ? '桌面监控示例预览' : 'Example floating monitor preview'}>
      <div className="floating-monitor-settings-preview-heading">
        <span>{zh ? '预览' : 'Preview'}<small>{zh ? '示例数据' : 'Example data'}</small></span>
        <span>{dimensions.width} × {dimensions.height} px</span>
      </div>
      <div className="floating-monitor-settings-preview-scroll" tabIndex={0} aria-label={zh ? '预览，可横向滚动' : 'Preview, scroll horizontally'}>
        <div className="floating-monitor-settings-preview-content" style={{ width: dimensions.width }}>
          <FloatingMonitorContent preferences={value} language={language} metric={exampleMetric} history={exampleHistory} status={zh ? '示例数据' : 'Example data'} onReorder={desktop ? metrics => update({ metrics }) : undefined}/>
        </div>
      </div>
      <p className="floating-monitor-settings-preview-hint">{zh ? '拖拽指标排序 · Alt + 方向键' : 'Drag to reorder · Alt + arrow keys'}</p>
    </section>

    <div className="floating-monitor-settings-appearance">
      <section className="floating-monitor-settings-layout" aria-labelledby={`${id}-layout`}>
        <h3 id={`${id}-layout`}>{zh ? '布局预设' : 'Layout presets'}</h3>
        <div className="floating-monitor-settings-layout-tabs" role="group" aria-label={zh ? '布局预设' : 'Layout presets'}>
          {([
            { id: 'compact', label: zh ? '紧凑单行' : 'Compact', hint: zh ? '轻量速览' : 'At a glance' },
            { id: 'twoRow', label: zh ? '清晰双行' : 'Two rows', hint: zh ? '默认推荐' : 'Recommended' },
            { id: 'panel', label: zh ? '详细面板' : 'Panel', hint: zh ? '更多指标' : 'More metrics' },
          ] as const).map(preset => <button type="button" key={preset.id} disabled={!desktop} aria-pressed={value.layout === preset.id} onClick={() => applyPreset(preset.id)}>
            <strong>{preset.label}</strong><small>{preset.hint}</small>
          </button>)}
        </div>
      </section>
      <section className="floating-monitor-settings-font" aria-labelledby={`${id}-font`}>
        <h3 id={`${id}-font`}>{zh ? '字号' : 'Font size'}<output htmlFor={`${id}-font-slider`}>{value.fontSize} px</output></h3>
        <Slider id={`${id}-font-slider`} ariaLabel={zh ? '监控字号' : 'Monitor font size'} min={8} max={36} step={1} value={value.fontSize} disabled={!desktop} onValueChange={fontSize => update({ fontSize })}/>
        <div className="floating-monitor-settings-font-range"><span>8 px</span><span>36 px</span></div>
      </section>
    </div>

    <section className="floating-monitor-settings-metrics" aria-labelledby={`${id}-metrics`}>
      <h3 id={`${id}-metrics`}>{zh ? '显示指标' : 'Visible metrics'}<span>{value.metrics.length} / 8</span></h3>
      <span id={`${id}-sort-hint`} className="floating-monitor-settings-announcement">{zh ? '选择 1–8 项。使用箭头按钮或 Alt + ↑ / ↓ 调整顺序。' : 'Choose 1–8 metrics. Use the arrow buttons or Alt + ↑ / ↓ to reorder.'}</span>
      <div className="floating-monitor-settings-palette-heading">
        <span>{zh ? '选择 1–8 项 · 默认配色跟随主题' : 'Choose 1–8 metrics · Default colors follow theme'}</span>
        <button type="button" disabled={!desktop || (!Object.keys(value.metricColors).length && !Object.keys(colorDrafts).length)} onClick={() => { setColorDrafts({}); update({ metricColors: {} }); }}><RotateCcw size={12} aria-hidden="true"/>{zh ? '恢复全部配色' : 'Reset all colors'}</button>
      </div>
      <div className="floating-monitor-settings-metric-list">
        {displayedMetrics.map(metric => {
          const index = value.metrics.indexOf(metric.id);
          const selected = index >= 0;
          const atLimit = !selected && value.metrics.length >= 8;
          const label = metric.label[(language === 'zh-CN' ? 'zh-CN' : 'en')];
          const customColor = value.metricColors[metric.id];
          const automaticColor = FLOATING_MONITOR_PALETTES[paletteTheme][metric.id];
          const draft = colorDrafts[metric.id];
          const invalidColor = draft !== undefined && draft !== '' && !/^#[0-9a-fA-F]{6}$/.test(draft);

          return <div key={metric.id} className={`floating-monitor-settings-metric${selected ? ' selected' : ''}`} onKeyDown={event => {
            if (event.target instanceof HTMLInputElement && event.target.type !== 'checkbox') return;
            if (selected && event.altKey && (event.key === 'ArrowUp' || event.key === 'ArrowDown')) {
              event.preventDefault();
              moveMetric(metric.id, event.key === 'ArrowUp' ? -1 : 1);
            }
          }}>
            <label className="floating-monitor-settings-metric-name">
              <Checkbox aria-label={label} checked={selected} disabled={!desktop || atLimit || (selected && value.metrics.length === 1)} aria-describedby={`${id}-sort-hint`} onChange={event => toggleMetric(metric.id, event.target.checked)}/>
              <span>{label}</span>
              {selected && <small aria-label={zh ? `第 ${index + 1} 位` : `Position ${index + 1}`}>{index + 1}</small>}
            </label>
            {selected && <div className="floating-monitor-settings-metric-actions">
              <button type="button" disabled={!desktop || index === 0} aria-label={zh ? `上移${label}` : `Move ${label} up`} title={zh ? '上移（Alt + ↑）' : 'Move up (Alt + ↑)'} onClick={() => moveMetric(metric.id, -1)}><ArrowUp size={13} aria-hidden="true"/></button>
              <button type="button" disabled={!desktop || index === value.metrics.length - 1} aria-label={zh ? `下移${label}` : `Move ${label} down`} title={zh ? '下移（Alt + ↓）' : 'Move down (Alt + ↓)'} onClick={() => moveMetric(metric.id, 1)}><ArrowDown size={13} aria-hidden="true"/></button>
            </div>}
            <div className="floating-monitor-settings-color-controls">
              <input type="color" aria-label={zh ? `${label}颜色` : `${label} color`} value={customColor ?? automaticColor} disabled={!desktop} onChange={event => setMetricColor(metric.id, event.target.value)}/>
              <input type="text" className="floating-monitor-settings-color-hex" aria-label={zh ? `${label}颜色值（十六进制）` : `${label} hexadecimal color`} aria-invalid={invalidColor || undefined} aria-describedby={invalidColor ? `${id}-${metric.id}-color-hint` : undefined} value={draft ?? customColor ?? ''} placeholder={automaticColor} spellCheck={false} autoComplete="off" maxLength={32} disabled={!desktop} onChange={event => editMetricColor(metric.id, event.target.value)}/>
              <button type="button" aria-label={zh ? `恢复${label}自动配色` : `Reset ${label} to automatic color`} title={zh ? '恢复自动配色' : 'Restore automatic color'} disabled={!desktop || (!customColor && draft === undefined)} onClick={() => setMetricColor(metric.id)}><RotateCcw size={12} aria-hidden="true"/></button>
              {invalidColor && <small id={`${id}-${metric.id}-color-hint`} className="invalid">{zh ? '格式：#RRGGBB' : 'Format: #RRGGBB'}</small>}
            </div>
          </div>;
        })}
      </div>
      <span className="floating-monitor-settings-announcement" role="status" aria-live="polite">{announcement}</span>
    </section>

    <div className="floating-monitor-settings-display-options">
      {displayOptions.map(option => <div key={option.key} className="setting-toggle floating-monitor-settings-option">
        <span><strong>{option.title}</strong></span>
        <Toggle ariaLabel={option.title} tooltip={option.hint} checked={value[option.key]} disabled={!desktop} onCheckedChange={checked => update({ [option.key]: checked })}/>
      </div>)}
    </div>

    <div className="floating-monitor-settings-footer">
      <span><Check size={13} aria-hidden="true"/>{zh ? '设置自动保存' : 'Settings save automatically'}</span>
      <button type="button" disabled={!desktop} onClick={() => update({
        layout: FLOATING_MONITOR_DEFAULTS.layout, fontSize: FLOATING_MONITOR_DEFAULTS.fontSize, metrics: [...FLOATING_MONITOR_DEFAULTS.metrics],
        showGraphs: true, showLabels: true, showUnits: true, showStatus: false, snapToEdge: false, showSampleTime: false, alwaysOnTop: true,
      })}><RotateCcw size={14} aria-hidden="true"/>{zh ? '恢复显示默认' : 'Reset appearance'}</button>
    </div>
  </Panel></div>;
}
