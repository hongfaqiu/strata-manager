import { useId, useRef, useState } from 'react';
import { ArrowDown, ArrowUp, Check, ChevronDown, LoaderCircle, Monitor, PanelBottom, RotateCcw, SquareArrowOutUpRight } from 'lucide-react';
import {
  FLOATING_MONITOR_DEFAULTS, FLOATING_MONITOR_METRICS, FLOATING_MONITOR_PRESETS,
  floatingMonitorDimensions, normalizeFloatingMonitorPreferences, normalizeMetrics,
  type FloatingMonitorLayout, type FloatingMonitorMetric, type FloatingMonitorMode, type FloatingMonitorPreferences,
} from '@strata-manager/core';
import { Panel } from '../components';
import { Checkbox, Segmented, Slider, Toggle } from '../OfficialControls';
import { FloatingMonitorContent } from '../FloatingMonitorContent';
import type { MonitorPoint } from '../floatingMonitorHistory';
import './floating-monitor-settings.css';

interface Props {
  preferences: FloatingMonitorPreferences;
  desktop: boolean;
  language: 'zh-CN' | 'en';
  onChange: (next: FloatingMonitorPreferences) => void;
  onOpen: () => void;
  onModeChange?: (mode: FloatingMonitorMode) => Promise<void>;
  modeStatus?: { mode: string; supported: boolean; active: boolean; message?: string };
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

export function FloatingMonitorSettings({ preferences, desktop, language, onChange, onOpen, onModeChange, modeStatus }: Props) {
  const zh = language === 'zh-CN';
  const id = useId();
  const value = normalizeFloatingMonitorPreferences(preferences);
  const dimensions = floatingMonitorDimensions(value);
  const [changingMode, setChangingMode] = useState<FloatingMonitorMode | null>(null);
  const [modeError, setModeError] = useState('');
  const [announcement, setAnnouncement] = useState('');
  const modeChangePending = useRef(false);
  const activeMode = modeStatus?.active && (modeStatus.mode === 'floating' || modeStatus.mode === 'taskbar') ? modeStatus.mode : value.mode;
  const update = (patch: Partial<FloatingMonitorPreferences>) => onChange(normalizeFloatingMonitorPreferences({ ...value, ...patch }));

  const applyPreset = (layout: FloatingMonitorLayout) => {
    const preset = FLOATING_MONITOR_PRESETS[layout];
    update({ layout, fontSize: preset.fontSize, metrics: [...preset.metrics], showGraphs: preset.showGraphs, showLabels: preset.showLabels, showUnits: preset.showUnits });
  };

  const changeMode = async (mode: FloatingMonitorMode) => {
    if (!desktop || !onModeChange || modeChangePending.current || mode === activeMode) return;
    modeChangePending.current = true;
    setChangingMode(mode);
    setModeError('');
    try { await onModeChange(mode); }
    catch (error) { setModeError(error instanceof Error ? error.message : String(error)); }
    finally { modeChangePending.current = false; setChangingMode(null); }
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
    const label = FLOATING_MONITOR_METRICS.find(item => item.id === metric)?.label[language] ?? metric;
    setAnnouncement(zh ? `${label}已移至第 ${target + 1} 位` : `${label} moved to position ${target + 1}`);
  };

  const displayedMetrics = [
    ...value.metrics.map(metric => FLOATING_MONITOR_METRICS.find(item => item.id === metric)!),
    ...FLOATING_MONITOR_METRICS.filter(metric => !value.metrics.includes(metric.id)),
  ];
  const modeDescription = modeStatus?.message || (activeMode === 'taskbar'
    ? modeStatus?.active ? (zh ? '监控正在任务栏中显示。' : 'The monitor is visible in the taskbar.') : (zh ? '任务栏监控未启动。' : 'The taskbar monitor is not running.')
    : (zh ? '按住浮条任意位置拖动，右键或 Shift+F10 打开操作菜单。' : 'Drag anywhere on the strip. Right-click or press Shift+F10 for actions.'));
  const displayOptions = [
    { key: 'showGraphs' as const, title: zh ? '实时折线' : 'Live graphs', hint: zh ? '读取蓝色，生成绿色。' : 'Blue for prefill, green for generation.' },
    { key: 'showLabels' as const, title: zh ? '指标标签' : 'Metric labels', hint: zh ? '读取与生成名称始终显示。' : 'Prefill and generation names remain visible.' },
    { key: 'showUnits' as const, title: zh ? '数值单位' : 'Value units', hint: zh ? '显示 tok/s、GiB 等单位。' : 'Show units such as tok/s and GiB.' },
    { key: 'showSampleTime' as const, title: zh ? '采样时间' : 'Sample time', hint: zh ? '显示最近一次采样时间。' : 'Show the most recent sample time.' },
    { key: 'alwaysOnTop' as const, title: zh ? '浮条置顶' : 'Keep strip on top', hint: zh ? '桌面浮条保持在其他窗口上方。' : 'Keep the floating strip above other windows.' },
  ];

  return <div id="settings-floating-monitor"><Panel className="floating-monitor-settings" title={zh ? '桌面监控' : 'Desktop monitor'} action={
    <button type="button" disabled={!desktop || changingMode !== null} onClick={onOpen}>
      <SquareArrowOutUpRight size={14} aria-hidden="true"/>
      {activeMode === 'taskbar' ? (zh ? '打开任务栏监控' : 'Open taskbar monitor') : (zh ? '打开浮动条' : 'Open floating monitor')}
    </button>
  }>
    {!desktop && <p className="floating-monitor-settings-hint" role="status">{zh ? '请在桌面应用中使用监控。' : 'Use monitoring in the desktop app.'}</p>}

    <div className="floating-monitor-settings-mode">
      <Segmented value={activeMode} ariaLabel={zh ? '监控显示方式' : 'Monitor display mode'} onValueChange={mode => void changeMode(mode as FloatingMonitorMode)} options={[
        { value: 'floating', label: zh ? '桌面浮条' : 'Floating strip', icon: <Monitor size={15} aria-hidden="true"/>, disabled: !desktop || !onModeChange || changingMode !== null },
        { value: 'taskbar', label: zh ? '常驻任务栏（实验）' : 'Taskbar (experimental)', icon: <PanelBottom size={15} aria-hidden="true"/>, disabled: !desktop || !onModeChange || changingMode !== null || modeStatus?.supported === false },
      ]}/>
      <p className="floating-monitor-settings-hint" role="status" aria-live="polite">
        {changingMode ? <><LoaderCircle size={13} className="spin" aria-hidden="true"/>{zh ? '正在切换显示方式…' : 'Switching display mode…'}</> : modeDescription}
      </p>
      {modeStatus?.supported === false && <p className="floating-monitor-settings-hint">{zh ? '当前系统不支持常驻任务栏，可使用桌面浮条。' : 'Taskbar mode is unavailable on this system. Use the floating strip.'}</p>}
      {modeError && <p className="floating-monitor-settings-error" role="alert">{zh ? '切换失败：' : 'Could not switch: '}{modeError}</p>}
    </div>

    <section className="floating-monitor-settings-preview" aria-label={zh ? '桌面监控示例预览' : 'Example floating monitor preview'}>
      <div className="floating-monitor-settings-preview-heading">
        <span>{zh ? '桌面外观预览' : 'Floating appearance preview'}<small>{zh ? '示例数据' : 'Example data'}</small></span>
        <span>{dimensions.width} × {dimensions.height} px</span>
      </div>
      <div className="floating-monitor-settings-preview-scroll" tabIndex={0} aria-label={zh ? '预览，可横向滚动' : 'Preview, scroll horizontally'}>
        <div className="floating-monitor-settings-preview-content" style={{ width: dimensions.width }}>
          <FloatingMonitorContent preferences={value} language={language} metric={exampleMetric} history={exampleHistory} status={zh ? '示例数据' : 'Example data'}/>
        </div>
      </div>
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
        <Slider id={`${id}-font-slider`} ariaLabel={zh ? '监控字号' : 'Monitor font size'} min={12} max={24} step={1} value={value.fontSize} disabled={!desktop} onValueChange={fontSize => update({ fontSize })}/>
        <div className="floating-monitor-settings-font-range"><span>12 px</span><span>24 px</span></div>
      </section>
    </div>

    <section className="floating-monitor-settings-metrics" aria-labelledby={`${id}-metrics`}>
      <h3 id={`${id}-metrics`}>{zh ? '显示指标' : 'Visible metrics'}<span>{value.metrics.length} / 8</span></h3>
      <p id={`${id}-sort-hint`} className="floating-monitor-settings-hint">{zh ? '选择 1–8 项。使用箭头按钮或 Alt + ↑ / ↓ 调整顺序。' : 'Choose 1–8 metrics. Use the arrow buttons or Alt + ↑ / ↓ to reorder.'}</p>
      <div className="floating-monitor-settings-metric-list">
        {displayedMetrics.map(metric => {
          const index = value.metrics.indexOf(metric.id);
          const selected = index >= 0;
          const atLimit = !selected && value.metrics.length >= 8;
          const label = metric.label[language];
          return <div key={metric.id} className={`floating-monitor-settings-metric${selected ? ' selected' : ''}`} onKeyDown={event => {
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
          </div>;
        })}
      </div>
      <span className="floating-monitor-settings-announcement" role="status" aria-live="polite">{announcement}</span>
    </section>

    <div className="floating-monitor-settings-display-options">
      {displayOptions.map(option => <div key={option.key} className="setting-toggle floating-monitor-settings-option">
        <span><strong>{option.title}</strong><small>{option.hint}</small></span>
        <Toggle ariaLabel={option.title} checked={value[option.key]} disabled={!desktop} onCheckedChange={checked => update({ [option.key]: checked })}/>
      </div>)}
    </div>

    <details className="floating-monitor-settings-more">
      <summary>{zh ? '更多设置' : 'More settings'}<ChevronDown size={14} aria-hidden="true"/></summary>
      <div className="setting-toggle floating-monitor-settings-option">
        <span><strong>{zh ? '普通托盘图标' : 'Standard tray icon'}</strong><small>{zh ? '在系统通知区域显示状态和速度，点击图标打开监控。' : 'Show status and speed in the system notification area. Click its icon to open the monitor.'}</small></span>
        <Toggle ariaLabel={zh ? '在系统托盘显示监控' : 'Show monitor in the system tray'} checked={value.showInTray} disabled={!desktop} onCheckedChange={showInTray => update({ showInTray })}/>
      </div>
    </details>

    <div className="floating-monitor-settings-footer">
      <span><Check size={13} aria-hidden="true"/>{zh ? '设置自动保存' : 'Settings save automatically'}</span>
      <button type="button" disabled={!desktop} onClick={() => update({
        layout: FLOATING_MONITOR_DEFAULTS.layout, fontSize: FLOATING_MONITOR_DEFAULTS.fontSize, metrics: [...FLOATING_MONITOR_DEFAULTS.metrics],
        showGraphs: true, showLabels: true, showUnits: true, showSampleTime: false, alwaysOnTop: true,
      })}><RotateCcw size={14} aria-hidden="true"/>{zh ? '恢复显示默认' : 'Reset appearance'}</button>
    </div>
  </Panel></div>;
}
