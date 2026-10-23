import type { AppLanguage } from '@strata-manager/core';
import { useEffect, useId, useRef, useState, type CSSProperties, type PointerEvent } from 'react';
import { GripVertical } from 'lucide-react';
import { FLOATING_MONITOR_DISPLAY_UNITS, FLOATING_MONITOR_METRICS, FLOATING_MONITOR_PALETTES, FLOATING_MONITOR_SHORT_LABELS, FLOATING_MONITOR_VALUE_CHARACTERS, floatingMonitorDimensions, normalizeFloatingMonitorPreferences, reorderFloatingMonitorMetrics, type FloatingMonitorMetric, type FloatingMonitorPreferences, type MetricSnapshot } from '@strata-manager/core';

import { monitorValues, type MonitorPoint } from './floatingMonitorHistory';
import { formatFloatingMonitorValue } from './floatingMonitorPresentation';
import { telemetrySparkline } from './serviceStatusTelemetry';
import './floating-monitor-content.css';

interface Props {
  preferences: FloatingMonitorPreferences; language: AppLanguage; metric?: MetricSnapshot;
  history: MonitorPoint[]; status: string; loaded?: boolean; sampledAt?: number; message?: string;
  /** Only the settings preview provides this callback; live monitor dragging stays native. */
  onReorder?: (metrics: FloatingMonitorMetric[]) => void;
  /** Room on screen; a single row wider than this uses two rows (matches the window size). */
  maxWidth?: number;
}

interface PreviewDrag {
  metric: FloatingMonitorMetric;
  pointerId: number;
  startX: number;
  startY: number;
  order: string;
  active: boolean;
  targetIndex: number | null;
  targetMetric: FloatingMonitorMetric | null;
  edge: 'before' | 'after';
  element: HTMLDivElement;
}

export function FloatingMonitorContent({ preferences, language, metric, history, status, loaded = true, sampledAt, message, onReorder, maxWidth }: Props) {
  const value = normalizeFloatingMonitorPreferences(preferences), dimensions = floatingMonitorDimensions(value, language, maxWidth);
  const values = monitorValues(metric, loaded, false), zh = language === 'zh-CN';
  const hintId = useId();
  const grid = useRef<HTMLDivElement>(null);
  const drag = useRef<PreviewDrag | null>(null);
  const [dragView, setDragView] = useState<Pick<PreviewDrag, 'metric' | 'targetMetric' | 'edge'> | null>(null);
  const [announcement, setAnnouncement] = useState('');
  const [transientMessage, setTransientMessage] = useState('');
  const showHeader = value.showStatus || value.showSampleTime;
  const order = value.metrics.join('|');
  const clearDrag = () => {
    const current = drag.current;
    drag.current = null;
    setDragView(null);
    if (current?.element.hasPointerCapture(current.pointerId)) current.element.releasePointerCapture(current.pointerId);
    return current;
  };
  useEffect(() => {
    if (drag.current && drag.current.order !== order) clearDrag();
  }, [order]);
  useEffect(() => {
    setTransientMessage(message ?? '');
    if (!message) return;
    const timer = setTimeout(() => setTransientMessage(''), 4000);
    return () => clearTimeout(timer);
  }, [message]);

  const announceOrder = (id: FloatingMonitorMetric, position: number) => {
    const label = FLOATING_MONITOR_METRICS.find(item => item.id === id)!.label[(language === 'zh-CN' ? 'zh-CN' : 'en')];
    setAnnouncement(zh ? `${label}已移至第 ${position + 1} 位，共 ${value.metrics.length} 项。` : `${label} moved to position ${position + 1} of ${value.metrics.length}.`);
  };
  const startDrag = (event: PointerEvent<HTMLDivElement>, id: FloatingMonitorMetric) => {
    if (!onReorder || event.button !== 0 || !event.isPrimary || drag.current) return;
    event.stopPropagation();
    event.currentTarget.focus({ preventScroll: true });
    drag.current = {
      metric: id, pointerId: event.pointerId, startX: event.clientX, startY: event.clientY,
      order, active: false, targetIndex: null, targetMetric: null, edge: 'before', element: event.currentTarget,
    };
    event.currentTarget.setPointerCapture(event.pointerId);
  };
  const moveDrag = (event: PointerEvent<HTMLDivElement>) => {
    const current = drag.current;
    if (!current || current.pointerId !== event.pointerId || !grid.current) return;
    if (!current.active && Math.hypot(event.clientX - current.startX, event.clientY - current.startY) < 5) return;
    event.preventDefault();
    event.stopPropagation();
    current.active = true;
    const bounds = grid.current.getBoundingClientRect();
    const inside = event.clientX >= bounds.left && event.clientX <= bounds.right && event.clientY >= bounds.top && event.clientY <= bounds.bottom;
    const cells = [...grid.current.querySelectorAll<HTMLDivElement>('.floating-monitor-cell')];
    let nearest: { element: HTMLDivElement; distance: number; index: number } | undefined;
    if (inside) cells.forEach((element, index) => {
      const box = element.getBoundingClientRect();
      const dx = Math.max(box.left - event.clientX, 0, event.clientX - box.right);
      const dy = Math.max(box.top - event.clientY, 0, event.clientY - box.bottom);
      const distance = dx * dx + dy * dy;
      if (!nearest || distance < nearest.distance) nearest = { element, distance, index };
    });
    if (nearest) {
      const box = nearest.element.getBoundingClientRect();
      current.edge = event.clientX < box.left + box.width / 2 ? 'before' : 'after';
      const slot = nearest.index + (current.edge === 'after' ? 1 : 0);
      const source = value.metrics.indexOf(current.metric);
      current.targetIndex = Math.min(value.metrics.length - 1, slot > source ? slot - 1 : slot);
      current.targetMetric = value.metrics[nearest.index] ?? null;
    } else {
      current.targetIndex = null;
      current.targetMetric = null;
    }
    setDragView(previous => previous?.metric === current.metric && previous.targetMetric === current.targetMetric && previous.edge === current.edge
      ? previous : { metric: current.metric, targetMetric: current.targetMetric, edge: current.edge });
  };
  const finishDrag = (event: PointerEvent<HTMLDivElement>) => {
    if (drag.current?.pointerId !== event.pointerId) return;
    // Pointer-up may arrive at a newer location than the last move event.
    // A click without an active drag must never become a reorder here.
    if (drag.current.active) moveDrag(event);
    const bounds = grid.current?.getBoundingClientRect();
    const inside = bounds && event.clientX >= bounds.left && event.clientX <= bounds.right && event.clientY >= bounds.top && event.clientY <= bounds.bottom;
    const current = clearDrag();
    if (!current?.active || !onReorder) return;
    event.preventDefault();
    event.stopPropagation();
    if (inside && current.order === order && current.targetIndex !== null && current.targetIndex !== value.metrics.indexOf(current.metric)) {
      onReorder(reorderFloatingMonitorMetrics(value.metrics, current.metric, current.targetIndex));
      announceOrder(current.metric, current.targetIndex);
    } else setAnnouncement(zh ? '顺序未更改。' : 'Order unchanged.');
  };
  const cancelDrag = () => {
    if (!drag.current) return;
    clearDrag();
    setAnnouncement(zh ? '已取消排序，顺序未更改。' : 'Reordering cancelled. Order unchanged.');
  };

  return <section className="floating-monitor-content" data-layout={value.layout} data-rows={dimensions.rows} data-inline={dimensions.inline || undefined} data-reorderable={!!onReorder} aria-label={status} title={[status, message].filter(Boolean).join(' · ')} style={{ '--monitor-font': `${value.fontSize}px`, '--monitor-label-font': `${Math.max(8, Math.round(value.fontSize * .7))}px`, '--monitor-number-height': `${Math.ceil(value.fontSize * 1.4)}px`, '--monitor-header-height': `${Math.ceil(value.fontSize * .85) + 4}px`, '--monitor-columns': dimensions.columns, '--monitor-gap': `${dimensions.gap}px`, '--monitor-column-widths': dimensions.columnWidths.map(width => `${width}px`).join(' ') } as CSSProperties}>
    {showHeader && <header className="floating-monitor-content-header">
      {value.showStatus && <span className="floating-monitor-state" role="status"><i aria-hidden="true"/>{status}</span>}
      <span>{transientMessage || (value.showSampleTime && sampledAt ? new Date(sampledAt).toLocaleTimeString(language, { hour12: false }) : '')}</span>
    </header>}
    {!value.showStatus && <span className="floating-monitor-reorder-announcement" role="status">{status}</span>}
    {!showHeader && transientMessage && <span className="floating-monitor-message" role="status">{transientMessage}</span>}
    <div className="floating-monitor-grid" ref={grid} role={onReorder ? 'list' : undefined} aria-label={onReorder ? zh ? '拖拽排列监控指标' : 'Reorder monitor metrics' : undefined}>
      {value.metrics.map((id, index) => {
        const definition = FLOATING_MONITOR_METRICS.find(item => item.id === id)!;
        const last = (id === 'generation' && metric?.state !== 'generating' || id === 'prefill' && !['reading', 'prefill'].includes(metric?.state ?? '')) && values[id] !== null;
        const fullLabel = `${last ? zh ? '最近' : 'Last ' : ''}${definition.label[(language === 'zh-CN' ? 'zh-CN' : 'en')]}`;
        const label = FLOATING_MONITOR_SHORT_LABELS[(language === 'zh-CN' ? 'zh-CN' : 'en')][id];

        const number = values[id];
        const formatted = formatFloatingMonitorValue(number, id, language, true, FLOATING_MONITOR_VALUE_CHARACTERS[id]);
        const unit = FLOATING_MONITOR_DISPLAY_UNITS[id];
        const graph = telemetrySparkline(history.map(point => ({ at: point.at, decode: point.values[id], prefill: null, gpu: null })), 'decode', ['gpu', 'cpu'].includes(id) ? 100 : undefined);
        const isDragging = dragView?.metric === id;
        const insertion = dragView?.targetMetric === id ? dragView.edge : undefined;
        return <div key={id} className="floating-monitor-cell" data-metric={id} data-dragging={isDragging || undefined} data-insert={insertion}
          style={{ '--metric-light': FLOATING_MONITOR_PALETTES.light[id], '--metric-dark': FLOATING_MONITOR_PALETTES.dark[id], '--metric-custom': value.metricColors[id] } as CSSProperties}
          title={`${fullLabel}: ${formatted.fullText}${definition.unit ? ` ${definition.unit}` : ''}`}
          role={onReorder ? 'listitem' : 'group'} tabIndex={onReorder ? 0 : undefined}
          aria-label={`${fullLabel}: ${formatted.fullText} ${definition.unit}`}
          aria-posinset={onReorder ? index + 1 : undefined} aria-setsize={onReorder ? value.metrics.length : undefined}
          aria-describedby={onReorder ? hintId : undefined} aria-keyshortcuts={onReorder ? 'Alt+ArrowUp Alt+ArrowDown' : undefined}
          onPointerDown={onReorder ? event => startDrag(event, id) : undefined}
          onPointerMove={onReorder ? moveDrag : undefined} onPointerUp={onReorder ? finishDrag : undefined}
          onPointerCancel={onReorder ? cancelDrag : undefined} onLostPointerCapture={onReorder ? cancelDrag : undefined}
          onKeyDown={onReorder ? event => {
            if (event.key === 'Escape' && drag.current) { event.preventDefault(); cancelDrag(); return; }
            if (!event.altKey || !['ArrowUp', 'ArrowDown', 'ArrowLeft', 'ArrowRight'].includes(event.key)) return;
            event.preventDefault();
            cancelDrag();
            const target = index + (event.key === 'ArrowUp' || event.key === 'ArrowLeft' ? -1 : 1);
            if (target < 0 || target >= value.metrics.length) return;
            onReorder(reorderFloatingMonitorMetrics(value.metrics, id, target));
            announceOrder(id, target);
          } : undefined}>
          {onReorder && <GripVertical className="floating-monitor-drag-handle" size={11} aria-hidden="true"/>}
          <div className="floating-monitor-reading">{value.showLabels && <span className="floating-monitor-label">{label}</span>}<div className="floating-monitor-number"><strong>{formatted.text}</strong>{value.showUnits && unit && <small>{unit}</small>}</div></div>
          {value.showGraphs && <svg className="floating-monitor-graph" viewBox="0 0 160 48" preserveAspectRatio="none" aria-label={`${label} · ${zh ? '最近采样趋势，独立刻度' : 'Recent samples, independent scale'}`} role="img">
            <path className="floating-monitor-baseline" d="M4,44 L156,44"/>
            {graph.paths.map((path, i) => <path key={i} d={path}/>)}
            {graph.last && <circle cx={graph.last.x} cy={graph.last.y} r="2"/>}
          </svg>}
        </div>;
      })}
    </div>
    {onReorder && <>
      <span id={hintId} className="floating-monitor-reorder-announcement">{zh ? '拖拽指标调整顺序，松手保存。也可按 Alt 加方向键排序，Escape 取消拖拽。' : 'Drag a metric and release to save its position. Or use Alt plus arrow keys. Escape cancels dragging.'}</span>
      <span className="floating-monitor-reorder-announcement" role="status" aria-live="polite" aria-atomic="true">{announcement}</span>
    </>}
  </section>;
}
