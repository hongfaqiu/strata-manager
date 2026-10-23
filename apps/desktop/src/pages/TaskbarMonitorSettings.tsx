import type { AppLanguage } from '@strata-manager/core';
import { useRef, useState, type CSSProperties } from 'react';
import { LoaderCircle } from 'lucide-react';

import {
  TASKBAR_WIDGET_COLOR_ITEMS, TASKBAR_WIDGET_COLOR_PRESETS, TASKBAR_WIDGET_ITEMS, TASKBAR_WIDGET_PALETTE,
  lowContrastTaskbars, normalizeTaskbarWidgetPreferences, setTaskbarWidgetColor, toggleTaskbarWidgetItem,
  type TaskbarWidgetColorItem, type TaskbarWidgetItem, type TaskbarWidgetPreferences, type TaskbarWidgetRing, type TaskbarWidgetRows,
} from '@strata-manager/core';
import { Panel } from '../components';
import { Checkbox, Segmented, Toggle } from '../OfficialControls';
import './taskbar-monitor-settings.css';

interface Props {
  enabled: boolean;
  widget: TaskbarWidgetPreferences;
  desktop: boolean;
  language: AppLanguage;
  modeStatus?: { mode: string; supported: boolean; active: boolean; visible?: boolean; message?: string };
  onWidgetChange: (next: TaskbarWidgetPreferences) => void;
  onEnabledChange?: (enabled: boolean) => Promise<void>;
}

/** Same wording as the native right-click menu (taskbar_widget::item_menu_label). */
export const TASKBAR_ITEM_COPY: Record<'zh-CN' | 'en', Record<TaskbarWidgetItem, string>> = {
  'zh-CN': { generation: '生成速度', prefill: '预填充速度', gpu: 'GPU 负载', vram: '显存占用', temperature: 'GPU 温度', status: '服务状态' },
  en: { generation: 'Generation speed', prefill: 'Prefill speed', gpu: 'GPU load', vram: 'VRAM usage', temperature: 'GPU temperature', status: 'Service status' },
};
const SHORT: Record<'zh-CN' | 'en', Record<TaskbarWidgetItem, string>> = {
  'zh-CN': { generation: '生成', prefill: '预填充', gpu: 'GPU', vram: '显存', temperature: '温度', status: '状态' },
  en: { generation: 'Gen', prefill: 'Prefill', gpu: 'GPU', vram: 'VRAM', temperature: 'Temp', status: 'Status' },
};
/** Example reading; number and compact unit are drawn separately like the native widget. */
const EXAMPLE: Record<Exclude<TaskbarWidgetItem, 'status'>, [string, string]> = {
  generation: ['21.3', 't/s'], prefill: ['3.2k', 't/s'], gpu: ['76', '%'], vram: ['19.8', 'GB'], temperature: ['52', '℃'],
};
/** Colour rows also cover the ring-only context metric. */
const COLOR_COPY: Record<'zh-CN' | 'en', Record<TaskbarWidgetColorItem, string>> = {
  'zh-CN': { ...TASKBAR_ITEM_COPY['zh-CN'], context: '上下文占用' },
  en: { ...TASKBAR_ITEM_COPY.en, context: 'Context usage' },
};
const RING_EXAMPLE: Record<Exclude<TaskbarWidgetRing, 'off'>, number> = { gpu: 76, vram: 83, context: 37 };
/** Same unit-radius polygons as taskbar_widget::glyph_points (spark = generation, arrow = prefill). */
export const TASKBAR_GLYPHS = {
  generation: '0,-1 0.28,-0.28 1,0 0.28,0.28 0,1 -0.28,0.28 -1,0 -0.28,-0.28',
  prefill: '-1,-0.18 0.1,-0.18 0.1,-0.72 1,0 0.1,0.72 0.1,0.18 -1,0.18',
} as const;
function Glyph({ item }: { item: 'generation' | 'prefill' }) {
  return <svg className="taskbar-widget-preview-glyph" viewBox="-1 -1 2 2" width="8" height="8" aria-hidden="true"><polygon points={TASKBAR_GLYPHS[item]}/></svg>;
}

/** Static example of the native widget (dark taskbar palette), using the same item/ring rules. */
export function TaskbarWidgetPreview({ widget, language }: { widget: TaskbarWidgetPreferences; language: AppLanguage }) {
  const copy = language === 'zh-CN' ? 'zh-CN' : 'en';
  const percent = widget.ring === 'off' ? 0 : RING_EXAMPLE[widget.ring];
  // One row (taskbar_widget::single_row): no captions, speeds side by side.
  // `auto` is previewed on the default 48 px taskbar, where it uses two rows.
  const single = widget.rows === 'single';
  // On two rows both speeds share one stacked column (taskbar_widget::stacks_speeds).
  const stacked = !single && widget.items.includes('generation') && widget.items.includes('prefill');
  const showDot = !widget.items.includes('status');
  const custom = (item: TaskbarWidgetItem | TaskbarWidgetColorItem, variable: string) => {
    const color = item === 'status' ? undefined : widget.colors?.[item];
    return color ? { [variable]: color } as CSSProperties : undefined;
  };
  return <div className="taskbar-widget-preview" data-rows={single ? 'single' : 'double'} aria-hidden="true">
    {widget.ring === 'off'
      ? showDot && <i className="taskbar-widget-preview-dot"/>
      : <span className="taskbar-widget-preview-ring" data-ring={widget.ring} style={custom(widget.ring, '--ring')}>
        <svg viewBox="0 0 36 36" width="28" height="28">
          <circle cx="18" cy="18" r="15" className="track"/>
          <circle cx="18" cy="18" r="15" className="value" pathLength="100" strokeDasharray={`${percent} 100`} transform="rotate(-90 18 18)"/>
          <text x="18" y="18" dominantBaseline="central" textAnchor="middle">{percent}</text>
        </svg>
        {showDot && <i className="taskbar-widget-preview-dot"/>}
      </span>}
    {widget.items.map(item => stacked && item === 'prefill' ? null : stacked && item === 'generation'
      ? <span key="speeds" className="taskbar-widget-preview-stack" data-item="speeds">
        {(['generation', 'prefill'] as const).map(line => <b key={line} className="taskbar-widget-preview-line" data-item={line} style={custom(line, '--metric')}>
          <Glyph item={line}/>{EXAMPLE[line][0]}<small>{EXAMPLE[line][1]}</small>
        </b>)}
      </span>
      : <span key={item} className="taskbar-widget-preview-metric" data-item={item} style={custom(item, '--metric')}>
      {item === 'status'
        ? <b className="taskbar-widget-preview-value">{copy === 'zh-CN' ? '运行中' : 'Busy'}</b>
        : <b className="taskbar-widget-preview-value">{single && (item === 'generation' || item === 'prefill') && <Glyph item={item}/>}{EXAMPLE[item][0]}<small>{EXAMPLE[item][1]}</small></b>}
      {!single && <em>{SHORT[copy][item]}</em>}
    </span>)}
  </div>;
}

/** Per-metric colour rows: swatch + presets + reset. One override applies to light and dark taskbars. */
function TaskbarColorSettings({ widget, desktop, language, onWidgetChange }: { widget: TaskbarWidgetPreferences; desktop: boolean; language: AppLanguage; onWidgetChange: (next: TaskbarWidgetPreferences) => void }) {
  const zh = language === 'zh-CN';
  const copy = zh ? 'zh-CN' : 'en';
  const [editing, setEditing] = useState<TaskbarWidgetColorItem | null>(null);
  const set = (item: TaskbarWidgetColorItem, color?: string) => onWidgetChange(setTaskbarWidgetColor(widget, item, color));
  const themeName = (theme: 'light' | 'dark') => zh ? (theme === 'light' ? '浅色' : '深色') : theme;
  return <section id="settings-taskbar-colors" className="taskbar-monitor-settings-colors" aria-labelledby="taskbar-monitor-colors">
    <h3 id="taskbar-monitor-colors">{zh ? '颜色' : 'Colors'}</h3>
    <ul>
      {TASKBAR_WIDGET_COLOR_ITEMS.map(item => {
        const color = widget.colors?.[item];
        const open = editing === item;
        const low = color ? lowContrastTaskbars(color) : [];
        const state = color ? color.toUpperCase() : item === 'temperature' ? (zh ? '默认 · 按温度变色' : 'Default · by temperature') : (zh ? '默认 · 跟随任务栏' : 'Default · follows taskbar');
        return <li key={item} className={open ? 'is-open' : undefined}>
          <div className="taskbar-color-row">
            <button type="button" className="taskbar-color-swatch" disabled={!desktop} aria-expanded={open} aria-controls={`taskbar-color-${item}`}
              aria-label={`${COLOR_COPY[copy][item]}：${zh ? '选择颜色' : 'choose color'}`} onClick={() => setEditing(open ? null : item)}
              style={color ? { background: color } : { background: `linear-gradient(135deg, ${TASKBAR_WIDGET_PALETTE.light[item]} 50%, ${TASKBAR_WIDGET_PALETTE.dark[item]} 50%)` }}/>
            <span className="taskbar-color-name">{COLOR_COPY[copy][item]}</span>
            <span className="taskbar-color-state">{state}</span>
            {color && <button type="button" className="taskbar-color-reset" disabled={!desktop} onClick={() => set(item)}>{zh ? '恢复默认' : 'Reset'}</button>}
          </div>
          {open && <div id={`taskbar-color-${item}`} className="taskbar-color-picker">
            {TASKBAR_WIDGET_COLOR_PRESETS.map(preset => <button key={preset} type="button" className="taskbar-color-preset" style={{ background: preset }}
              aria-label={preset} aria-pressed={color === preset} disabled={!desktop} onClick={() => set(item, preset)}/>)}
            <label className="taskbar-color-custom">
              <input type="color" value={color ?? TASKBAR_WIDGET_PALETTE.dark[item]} disabled={!desktop} onChange={event => set(item, event.currentTarget.value)}/>
              <span>{zh ? '自定义…' : 'Custom…'}</span>
            </label>
          </div>}
          {low.length > 0 && <p className="taskbar-color-warning" role="note">{zh
            ? `在${low.map(themeName).join('、')}任务栏上对比度较低，可能不易看清。`
            : `Low contrast on the ${low.map(themeName).join(' and ')} taskbar; it may be hard to read.`}</p>}
        </li>;
      })}
    </ul>
    <p className="taskbar-monitor-settings-hint">{zh ? '默认颜色会随任务栏深浅色自动切换；自定义颜色在两种任务栏上都使用同一颜色。服务状态圆点的颜色固定。' : 'Default colors switch with the taskbar’s light/dark mode; a custom color is used on both. The service-state dot keeps its fixed colors.'}</p>
  </section>;
}

export function TaskbarMonitorSettings({ enabled, widget, desktop, language, modeStatus, onWidgetChange, onEnabledChange }: Props) {
  const zh = language === 'zh-CN';
  const copy = zh ? 'zh-CN' : 'en';
  const value = normalizeTaskbarWidgetPreferences(widget);
  const supported = desktop && modeStatus?.supported === true;
  const active = modeStatus?.mode === 'taskbar' && modeStatus.active;
  const [pending, setPending] = useState(false);
  const [error, setError] = useState('');
  const busy = useRef(false);
  const toggle = async (next: boolean) => {
    if (!supported || busy.current || !onEnabledChange) return;
    busy.current = true; setPending(true); setError('');
    try { await onEnabledChange(next); }
    catch (reason) { setError(reason instanceof Error ? reason.message : String(reason)); }
    finally { busy.current = false; setPending(false); }
  };
  const ringOptions: { value: TaskbarWidgetRing; label: string }[] = [
    { value: 'gpu', label: zh ? 'GPU 负载' : 'GPU load' },
    { value: 'vram', label: zh ? '显存占用' : 'VRAM usage' },
    { value: 'context', label: zh ? '上下文' : 'Context' },
    { value: 'off', label: zh ? '不显示' : 'None' },
  ];
  const rowOptions: { value: TaskbarWidgetRows; label: string }[] = [
    { value: 'auto', label: zh ? '自动' : 'Auto' },
    { value: 'single', label: zh ? '单行' : 'One row' },
    { value: 'double', label: zh ? '两行' : 'Two rows' },
  ];
  const status = !desktop ? (zh ? '请在桌面应用中使用。' : 'Available in the desktop app.')
    : !supported ? (zh ? '仅支持 Windows 10 / 11 主屏任务栏。' : 'Windows 10 / 11 primary taskbar only.')
    : active ? modeStatus?.message
    : enabled && modeStatus?.message ? modeStatus.message
    : zh ? '默认关闭。开启后显示在通知区左侧；右键可调整内容或关闭。' : 'Off by default. Shown left of the notification area; right-click it to adjust or close.';
  return <Panel className="taskbar-monitor-settings" title={zh ? '任务栏监控（Windows）' : 'Taskbar monitor (Windows)'} action={
    <div className="taskbar-monitor-settings-switch">
      <span>{active ? (zh ? '开' : 'On') : (zh ? '关' : 'Off')}</span>
      {pending && <LoaderCircle size={13} className="spin" aria-hidden="true"/>}
      <Toggle ariaLabel={zh ? '任务栏监控' : 'Taskbar monitor'} checked={active} disabled={!supported || pending || !onEnabledChange} onCheckedChange={next => void toggle(next)}/>
    </div>
  }>
    <p className="taskbar-monitor-settings-status" role="status">{status}</p>
    {error && <p className="floating-monitor-settings-error" role="alert">{error}</p>}
    <div className="taskbar-monitor-settings-body">
      <div className="taskbar-monitor-settings-stage" aria-label={zh ? '任务栏监控示例预览' : 'Taskbar monitor example preview'}>
        <span className="taskbar-monitor-settings-stage-label">{zh ? '示例' : 'Example'}</span>
        <div className="taskbar-monitor-settings-taskbar"><TaskbarWidgetPreview widget={value} language={language}/><span className="taskbar-monitor-settings-clock">14:32<br/>2026/10/19</span></div>
        <TaskbarColorSettings widget={value} desktop={desktop} language={language} onWidgetChange={onWidgetChange}/>
      </div>
      <div className="taskbar-monitor-settings-options">
        <section aria-labelledby="taskbar-monitor-ring">
          <h3 id="taskbar-monitor-ring">{zh ? '圆环显示' : 'Ring shows'}</h3>
          <Segmented ariaLabel={zh ? '圆环显示' : 'Ring shows'} value={value.ring} options={ringOptions.map(option => ({ ...option, disabled: !desktop || (option.value === 'off' && value.items.length === 0) }))} onValueChange={ring => onWidgetChange(normalizeTaskbarWidgetPreferences({ ...value, ring }))}/>
          {value.ring === 'context' && <p className="taskbar-monitor-settings-hint">{zh ? '上下文占用 = 当前（空闲时为上一次）请求的输入加输出 Token ÷ 模型最大上下文；读不到时圆环留空。' : 'Context usage = input plus output tokens of the current (or, when idle, the last) request ÷ the model’s maximum context. The ring stays empty when unknown.'}</p>}
        </section>
        <section aria-labelledby="taskbar-monitor-rows">
          <h3 id="taskbar-monitor-rows">{zh ? '文字行数' : 'Text rows'}</h3>
          <Segmented ariaLabel={zh ? '文字行数' : 'Text rows'} value={value.rows ?? 'auto'} options={rowOptions.map(option => ({ ...option, disabled: !desktop }))} onValueChange={rows => onWidgetChange(normalizeTaskbarWidgetPreferences({ ...value, rows }))}/>
          <p className="taskbar-monitor-settings-hint">{zh ? '单行更矮更紧凑：不显示指标名称，靠单位和图标区分（% 为 GPU、GB 为显存、℃ 为温度，星形为生成、箭头为预填充）。自动：小图标任务栏用单行，默认高度用两行。' : 'One row is shorter and tighter: captions are dropped and units and glyphs tell items apart (% GPU, GB VRAM, ℃ temperature, spark generation, arrow prefill). Auto uses one row on a small-icon taskbar and two rows at the default height.'}</p>
        </section>
        <section aria-labelledby="taskbar-monitor-items">
          <h3 id="taskbar-monitor-items">{zh ? '显示内容' : 'Shown items'}</h3>
          <div className="taskbar-monitor-settings-items">
            {TASKBAR_WIDGET_ITEMS.map(item => {
              const checked = value.items.includes(item);
              const locked = checked && value.ring === 'off' && value.items.length === 1;
              return <label key={item} className="taskbar-monitor-settings-item">
                <Checkbox checked={checked} disabled={!desktop || locked} onChange={() => onWidgetChange(toggleTaskbarWidgetItem(value, item))}/>
                <span>{TASKBAR_ITEM_COPY[copy][item]}</span>
              </label>;
            })}
          </div>
          <p className="taskbar-monitor-settings-hint">{zh ? '宽度随所选内容变化；与任务栏右键「自定义内容」同步。同时显示生成和预填充速度时，两项上下叠成一列：上行是生成（星形），下行是预填充（箭头）。GPU 温度仅在显卡上报时出现在右键菜单中。' : 'Width follows the selection and stays in sync with the widget’s right-click “Customize” menu. With both speeds shown they stack in one column: generation on top (spark), prefill below (arrow). GPU temperature appears in that menu only when the GPU reports it.'}</p>
        </section>
      </div>
    </div>
  </Panel>;
}
