// Shared D2 visual primitives: ring gauge, tick meter, dot axis, hardware glyphs and a task timeline.
// They only draw values passed in; callers decide when data is unknown and show 未实测 instead.
import type { ReactNode } from 'react';
import './d2-visuals.css';

export interface RingPart { value: number; tone: 'expert' | 'model' | 'ram' | 'ramSoft' | 'warn' | 'ok' }
const pct = (value: number) => Math.max(0, Math.min(100, value));

export function D2Ring({ parts, value, unit, label, size = 104, threshold, empty }: { parts: RingPart[]; value: ReactNode; unit?: ReactNode; label?: ReactNode; size?: number; threshold?: number; empty?: boolean }) {
  const r = 44, c = 2 * Math.PI * r; let offset = 0;
  return <figure className={`d2-ring${empty ? ' is-empty' : ''}`} style={{ width: size }}>
    <svg viewBox="0 0 112 112" role="img" aria-label={typeof label === 'string' ? label : undefined}>
      <circle className="d2-ring-track" r={r} cx="56" cy="56"/>
      {!empty && parts.map((part, index) => { const length = c * pct(part.value) / 100; const node = <circle key={index} className={`d2-ring-arc t-${part.tone}`} r={r} cx="56" cy="56" strokeDasharray={`${length} ${c}`} strokeDashoffset={-offset} transform="rotate(-90 56 56)"/>; offset += length; return node; })}
      {threshold !== undefined && <line className="d2-ring-threshold" x1="56" y1="3" x2="56" y2="15" transform={`rotate(${pct(threshold) * 3.6} 56 56)`}/>}
    </svg>
    <span className="d2-ring-center"><b className="d2-num">{value}</b>{unit && <small>{unit}</small>}</span>
    {label && <figcaption>{label}</figcaption>}
  </figure>;
}

export function D2Ticks({ value, extra = 0, count = 24, tone = 'ram', label }: { value: number; extra?: number; count?: number; tone?: 'ram' | 'soft' | 'ok'; label?: string }) {
  return <span className={`d2-ticks t-${tone}`} role="meter" aria-label={label} aria-valuemin={0} aria-valuemax={100} aria-valuenow={Math.round(pct(value))}>
    {Array.from({ length: count }, (_, index) => { const position = (index + .5) / count * 100; return <i key={index} className={position < value ? 'f' : position < value + extra ? 'x' : ''}/>; })}
  </span>;
}

export function D2DotAxis({ value, max, limit, warn, label }: { value?: number; max: number; limit?: number; warn?: boolean; label?: string }) {
  return <span className="d2-axis" role="img" aria-label={label}>
    {limit !== undefined && <span className="d2-axis-limit" style={{ left: `${pct(limit / max * 100)}%` }}/>}
    {value !== undefined && <i className={warn ? 'is-warn' : ''} style={{ left: `${pct(value / max * 100)}%` }}/>}
  </span>;
}

export function D2Glyph({ kind }: { kind: 'cpu' | 'ram' | 'gpu' }) {
  return <svg className="d2-glyph" viewBox="0 0 48 48" aria-hidden="true">
    {kind === 'cpu' && <><rect x="12" y="12" width="24" height="24" rx="3"/><rect className="d2-glyph-core" x="18" y="18" width="12" height="12" rx="1.5"/><path d="M17 6v6M24 6v6M31 6v6M17 36v6M24 36v6M31 36v6M6 17h6M6 24h6M6 31h6M36 17h6M36 24h6M36 31h6"/></>}
    {kind === 'ram' && <><rect x="4" y="15" width="40" height="16" rx="2"/><path className="d2-glyph-core" d="M9 20h5v6H9zM17 20h5v6h-5zM25 20h5v6h-5zM33 20h5v6h-5z"/><path d="M8 31v4M14 31v4M20 31v4M28 31v4M34 31v4M40 31v4"/></>}
    {kind === 'gpu' && <><rect x="4" y="13" width="40" height="20" rx="3"/><circle cx="17" cy="23" r="6"/><circle cx="31" cy="23" r="6"/><path d="M17 19v8M13 23h8M31 19v8M27 23h8M10 33v4h16v-4"/></>}
  </svg>;
}

export interface TimelinePoint { at: number; tone: 'ok' | 'off' | 'bad' | 'run'; label: string; onSelect?: () => void; active?: boolean }
export function D2Timeline({ points, start, end, startLabel, endLabel, middleLabel }: { points: TimelinePoint[]; start: number; end: number; startLabel: string; endLabel: string; middleLabel?: string }) {
  const span = Math.max(1, end - start);
  return <div className="d2-timeline">
    <span className="d2-timeline-axis"/>
    {points.map((point, index) => <button key={index} type="button" className={`d2-timeline-dot t-${point.tone}${point.active ? ' is-active' : ''}`} style={{ left: `${pct((point.at - start) / span * 100)}%` }} aria-label={point.label} data-tooltip={point.label} onClick={point.onSelect}/>)}
    <span className="d2-timeline-label is-start">{startLabel}</span>{middleLabel && <span className="d2-timeline-label is-middle">{middleLabel}</span>}<span className="d2-timeline-label is-end">{endLabel}</span>
  </div>;
}

/** Hardware readings shared by several pages; every field is optional because /metrics may be absent. */
export interface HardwareReading { vramUsed?: number; vramTotal?: number; ramUsed?: number; ramTotal?: number; expertBytes?: number; gpuName?: string; pcie?: string; cores?: number; threads?: number }
const n = (value: unknown) => typeof value === 'number' && Number.isFinite(value) ? value : undefined;
const o = (value: unknown): Record<string, unknown> => value && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : {};
export function readHardware(raw: Record<string, unknown> | undefined): HardwareReading {
  const hw = o(raw?.hardware), st = o(raw?.hardware_static), engine = o(raw?.engine);
  const gen = n(hw.gpu_pcie_gen), width = n(hw.gpu_pcie_width);
  const expertMib = n(engine.expert_cache_mib);
  return { vramUsed: n(hw.gpu_mem_used), vramTotal: n(hw.gpu_mem_total), ramUsed: n(hw.ram_used), ramTotal: n(hw.ram_total), expertBytes: expertMib === undefined ? n(engine.expert_bytes) : expertMib * 1024 ** 2,
    gpuName: typeof st.gpu_name === 'string' ? st.gpu_name : undefined, pcie: gen !== undefined ? `PCIe ${gen}.0${width ? ` ×${width}` : ''}` : undefined, cores: n(st.cores), threads: n(st.threads) };
}
export const gib = (bytes?: number, digits = 1) => bytes === undefined ? '–' : (bytes / 1024 ** 3).toLocaleString(undefined, { maximumFractionDigits: digits });
