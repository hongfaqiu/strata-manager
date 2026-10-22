import { useEffect, useRef, useState, type KeyboardEvent as ReactKeyboardEvent, type PointerEvent as ReactPointerEvent } from 'react';
import { createPortal } from 'react-dom';
import { useTranslation } from 'react-i18next';
import { Maximize2, Minimize2, X } from 'lucide-react';
import * as core from '@strata-manager/core';
import { OfficialIcon } from '../OfficialIcon';
import './chat-render.css';
import type { HtmlPreviewItem } from './htmlPreviewContext';
import { clampPreviewWidth, htmlFileName, MAX_PREVIEW_CHARS, PREVIEW_SANDBOX, PREVIEW_SCHEME, PREVIEW_WIDTH, withPreviewPolicy } from './htmlPreview';

type Frame = { src?: string; srcDoc?: string } | { error: string };

/** Desktop: the page is served from the isolated `strata-preview` scheme with a no-network CSP header. Browser mode: srcdoc + the same CSP. */
async function openFrame(html: string): Promise<Frame> {
  if (html.length > MAX_PREVIEW_CHARS) throw new Error('HTML > 4 MiB');
  if (core.isTauri()) {
    const id = await core.registerHtmlPreview(html);
    const { convertFileSrc } = await import('@tauri-apps/api/core');
    return { src: convertFileSrc(id, PREVIEW_SCHEME) };
  }
  return { srcDoc: withPreviewPolicy(html) };
}

async function saveHtml(html: string): Promise<string | null> {
  const name = htmlFileName(html);
  if (core.isTauri()) {
    const { save } = await import('@tauri-apps/plugin-dialog');
    const selected = await save({ defaultPath: name, filters: [{ name: 'HTML', extensions: ['html', 'htm'] }] });
    if (!selected) return null;
    return core.saveHtmlPreview(/\.html?$/i.test(selected) ? selected : `${selected}.html`, html);
  }
  const url = URL.createObjectURL(new Blob([html], { type: 'text/html;charset=utf-8' })), link = document.createElement('a');
  link.href = url; link.download = name; link.click();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
  return name;
}

export function readPreviewWidth(): number {
  try { return Number(localStorage.getItem(PREVIEW_WIDTH.storageKey)) || PREVIEW_WIDTH.fallback; } catch { return PREVIEW_WIDTH.fallback; }
}
export function storePreviewWidth(width: number) {
  try { localStorage.setItem(PREVIEW_WIDTH.storageKey, String(Math.round(width))); } catch { /* private mode: width lasts for this session */ }
}

/**
 * The chat's right-hand preview (like Codex artifacts): one page at a time, opening another block replaces it.
 * `overlay` turns it into a drawer over the chat when the window is too narrow for both side by side.
 */
export function HtmlPreviewPanel({ item, width, available, overlay, onWidthChange, onClose, onMessage }: {
  item: HtmlPreviewItem; width: number; available: number; overlay: boolean;
  onWidthChange: (width: number, done: boolean) => void; onClose: () => void; onMessage?: (message: string, error?: boolean) => void;
}) {
  const { t } = useTranslation();
  const [frame, setFrame] = useState<Frame | null>(null);
  const [revision, setRevision] = useState(0);
  const [full, setFull] = useState(false);
  const [dragging, setDragging] = useState(false);
  const closeButton = useRef<HTMLButtonElement>(null);
  const live = useRef(true);
  useEffect(() => () => { live.current = false; }, []);
  useEffect(() => {
    setFrame(null);
    let current = true;
    openFrame(item.code).then(next => { if (current) setFrame(next); }, error => { if (current) setFrame({ error: error instanceof Error ? error.message : String(error) }); });
    return () => { current = false; };
  }, [item.code, revision]);
  useEffect(() => { if (overlay) closeButton.current?.focus(); }, [overlay, item.id]);
  useEffect(() => {
    if (!full && !overlay) return;
    const onKey = (event: KeyboardEvent) => { if (event.key !== 'Escape') return; if (full) setFull(false); else onClose(); };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [full, overlay, onClose]);
  const save = () => { saveHtml(item.code).then(path => { if (path && live.current) onMessage?.(t('htmlPreviewSaved', { path })); }, error => onMessage?.(core.normalizeError(error).message, true)); };
  const startDrag = (event: ReactPointerEvent<HTMLDivElement>) => {
    if (event.button !== 0) return;
    event.preventDefault();
    const handle = event.currentTarget, startX = event.clientX, startWidth = width;
    handle.setPointerCapture(event.pointerId); setDragging(true);
    let last = startWidth;
    const move = (next: PointerEvent) => { last = clampPreviewWidth(startWidth + startX - next.clientX, available); onWidthChange(last, false); };
    const end = () => { handle.removeEventListener('pointermove', move); handle.removeEventListener('pointerup', end); handle.removeEventListener('pointercancel', end); setDragging(false); onWidthChange(last, true); };
    handle.addEventListener('pointermove', move); handle.addEventListener('pointerup', end); handle.addEventListener('pointercancel', end);
  };
  const nudge = (event: ReactKeyboardEvent<HTMLDivElement>) => {
    const step = event.shiftKey ? 64 : 16;
    if (event.key === 'ArrowLeft' || event.key === 'ArrowRight') { event.preventDefault(); onWidthChange(clampPreviewWidth(width + (event.key === 'ArrowLeft' ? step : -step), available), true); }
  };
  const title = item.title || t('htmlPreviewTitle');
  const iframe = frame && !('error' in frame) ? <iframe key={`${item.id}:${revision}`} className="st-html-preview__frame" title={title} sandbox={PREVIEW_SANDBOX} referrerPolicy="no-referrer" allow="" {...frame}/> : null;
  const tools = <>
    <button type="button" className="st-btn st-btn--icon" aria-label={t('htmlPreviewReload')} data-tooltip={t('htmlPreviewReload')} onClick={() => setRevision(value => value + 1)}><OfficialIcon name="refresh" size={16}/></button>
    <button type="button" className="st-btn st-btn--icon" aria-label={full ? t('htmlPreviewExitFullscreen') : t('htmlPreviewFullscreen')} data-tooltip={full ? t('htmlPreviewExitFullscreen') : t('htmlPreviewFullscreen')} onClick={() => setFull(value => !value)}>{full ? <Minimize2 size={16}/> : <Maximize2 size={16}/>}</button>
    <button type="button" className="st-btn st-btn--icon" aria-label={t('htmlPreviewSave')} data-tooltip={t('htmlPreviewSave')} onClick={save}><OfficialIcon name="download" size={16}/></button>
  </>;
  const panelWidth = overlay ? undefined : clampPreviewWidth(width, available);
  return <>
    {overlay && <button type="button" className="chat-preview-scrim" aria-label={t('htmlPreviewClose')} tabIndex={-1} onClick={onClose}/>}
    <aside className={`chat-preview${overlay ? ' chat-preview--overlay' : ''}${dragging ? ' is-resizing' : ''}`} style={panelWidth ? { width: panelWidth } : undefined} aria-label={t('htmlPreviewTitle')} data-preview-id={item.id}>
      {!overlay && <div className="chat-preview__resize" role="separator" aria-orientation="vertical" aria-label={t('htmlPreviewResize')} aria-valuemin={PREVIEW_WIDTH.min} aria-valuenow={panelWidth} tabIndex={0} onPointerDown={startDrag} onKeyDown={nudge} onDoubleClick={() => onWidthChange(clampPreviewWidth(PREVIEW_WIDTH.fallback, available), true)}/>}
      <header className="chat-preview__head">
        <div className="chat-preview__title"><strong data-tooltip={title}>{title}</strong><span>HTML</span></div>
        <div className="chat-preview__tools">{tools}<button ref={closeButton} type="button" className="st-btn st-btn--icon" aria-label={t('htmlPreviewClose')} data-tooltip={t('htmlPreviewClose')} onClick={onClose}><X size={16}/></button></div>
      </header>
      <div className="chat-preview__body">
        {frame && 'error' in frame ? <p className="msg-error" role="alert">{t('htmlPreviewFailed')} · {frame.error}</p> : full ? <div className="st-html-preview__placeholder muted small">{t('htmlPreviewFullscreen')}…</div> : iframe}
      </div>
      <div className="st-html-preview__note muted small"><OfficialIcon name="info" size={16}/>{t('htmlPreviewSandbox')}</div>
    </aside>
    {full && iframe && createPortal(<div className="st-html-full" role="dialog" aria-modal="true" aria-label={title}>
      <div className="st-html-full__bar"><strong>{title}</strong><span className="muted small">{t('htmlPreviewSandbox')}</span><div className="st-code__tools">{tools}</div></div>
      {iframe}
    </div>, document.body)}
  </>;
}
