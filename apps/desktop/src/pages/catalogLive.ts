// Live status for catalog rows: local presence, running download progress, fit, and change tracking.
import { useEffect, useRef, useState } from 'react';
import type { CatalogModel, LocalModel, TaskStatus } from '@strata-manager/core';
import { catalogRequirement, fitState, taskProgress } from './d2Estimates';

export type Fit = 'fits' | 'tight' | 'over';
export interface QuantLive { local: boolean; downloading: boolean; failed: boolean; progress?: number; fit?: Fit }
export interface RowLive { local: number; downloading: boolean; progress?: number; failed: boolean; fit?: Fit; bestQuant?: string }

const isDownloadTask = (task: TaskStatus) => /setup|download|prepare/i.test(task.kind);
const mentions = (text: string, model: CatalogModel, quant: string) => { const lower = text.toLowerCase(); return lower.includes(quant.toLowerCase()) && (lower.includes(model.family) || lower.includes(model.name.toLowerCase())); };

export function quantLive(model: CatalogModel, quant: string, tasks: TaskStatus[], local: LocalModel[] | undefined, machineGB?: number): QuantLive {
  const related = tasks.filter(task => isDownloadTask(task) && mentions(task.message ?? '', model, quant));
  const running = related.find(task => task.state === 'running');
  const latest = related[0];
  const isLocal = !!local?.some(item => { const req = catalogRequirement(`${item.name} ${item.modelPath}`); return req?.family === model.family && req.quant === quant; });
  const ram = model.quantInfo[quant]?.ramGB;
  return { local: isLocal, downloading: !!running, failed: !running && latest?.state === 'failed', progress: running ? taskProgress(running.message) : undefined, fit: ram === undefined ? undefined : fitState(ram, machineGB) };
}

export function rowLive(model: CatalogModel, tasks: TaskStatus[], local: LocalModel[] | undefined, machineGB?: number): RowLive {
  const quants = model.quants.map(quant => ({ quant, ...quantLive(model, quant, tasks, local, machineGB) }));
  const running = quants.find(item => item.downloading);
  const order: Fit[] = ['fits', 'tight', 'over'];
  // A manual-only set (DeepSeek-V4.1-Flash 2.25 bpw) is never the card's suggestion.
  const best = quants.filter(item => item.fit && !model.quantInfo[item.quant]?.manualOnly).sort((a, b) => order.indexOf(a.fit!) - order.indexOf(b.fit!) || (model.quantInfo[b.quant]?.ramGB ?? 0) - (model.quantInfo[a.quant]?.ramGB ?? 0))[0];
  return { local: quants.filter(item => item.local).length, downloading: !!running, progress: running?.progress, failed: quants.some(item => item.failed), fit: best?.fit, bestQuant: best?.fit === 'over' ? undefined : best?.quant };
}

/** Returns ids whose signature changed since the previous render, for ~1.6s, so rows can flash in place. */
export function useChangedRows(signatures: Record<string, string>) {
  const previous = useRef<Record<string, string> | null>(null);
  const [changed, setChanged] = useState<Set<string>>(new Set());
  const key = JSON.stringify(signatures);
  useEffect(() => {
    const before = previous.current; previous.current = signatures;
    if (!before) return;
    const ids = Object.keys(signatures).filter(id => before[id] !== undefined && before[id] !== signatures[id]);
    if (!ids.length) return;
    setChanged(current => new Set([...current, ...ids]));
    const timer = window.setTimeout(() => setChanged(current => { const next = new Set(current); ids.forEach(id => next.delete(id)); return next; }), 1600);
    return () => window.clearTimeout(timer);
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [key]);
  return changed;
}

const SEEN_KEY = 'strata.catalog.seen.v1';
/** Catalog entries that are new or whose quant list/sizes changed since the user last opened this page. */
export function useCatalogNews(catalog: CatalogModel[]) {
  const sign = (model: CatalogModel) => JSON.stringify([model.quants, model.quantInfo, model.snapshotDate]);
  const [news] = useState(() => {
    const result: Record<string, 'new' | 'updated'> = {};
    try {
      const raw = window.localStorage.getItem(SEEN_KEY);
      const seen = raw ? JSON.parse(raw) as Record<string, string> : null;
      if (seen) for (const model of catalog) { if (!(model.id in seen)) result[model.id] = 'new'; else if (seen[model.id] !== sign(model)) result[model.id] = 'updated'; }
    } catch { /* storage unavailable: no badges */ }
    return result;
  });
  useEffect(() => { try { window.localStorage.setItem(SEEN_KEY, JSON.stringify(Object.fromEntries(catalog.map(model => [model.id, sign(model)])))); } catch { /* ignore */ } }, [catalog]);
  return news;
}
