import { useEffect, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { useTranslation } from 'react-i18next';
import * as core from '@strata-manager/core';
import { OfficialCopyButton } from '../OfficialCopyButton';
import { OfficialIcon } from '../OfficialIcon';
import { Segmented } from '../OfficialControls';
import './chat-render.css';
import { htmlFileName, MAX_PREVIEW_CHARS, PREVIEW_SANDBOX, PREVIEW_SCHEME, withPreviewPolicy } from './htmlPreview';

type Frame = { src?: string; srcDoc?: string } | { error: string };

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

const FullIcon = ({ exit }: { exit?: boolean }) => <svg className="st-icon st-icon--sm" width={16} height={16} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={2} strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">{exit ? <path d="M9 4v5H4M15 4v5h5M9 20v-5H4M15 20v-5h5"/> : <path d="M4 9V4h5M20 9V4h-5M4 15v5h5M20 15v5h-5"/>}</svg>;

/** A ```html block: Code by default, Preview runs the page in a sandboxed frame once the answer is complete. */
export function HtmlCodeBlock({ code, language, streaming, children, onCopy, onMessage }: {
  code: string; language: string; streaming: boolean; children: React.ReactNode;
  onCopy: (value: string) => void | Promise<boolean | void>; onMessage?: (message: string, error?: boolean) => void;
}) {
  const { t } = useTranslation();
  const [mode, setMode] = useState<'code' | 'preview'>('code');
  const [frame, setFrame] = useState<Frame | null>(null);
  const [revision, setRevision] = useState(0);
  const [full, setFull] = useState(false);
  const live = useRef(true);
  useEffect(() => () => { live.current = false; }, []);
  const previewing = mode === 'preview' && !streaming;
  useEffect(() => {
    if (!previewing) { setFrame(null); setFull(false); return; }
    let current = true;
    openFrame(code).then(next => { if (current) setFrame(next); }, error => { if (current) setFrame({ error: error instanceof Error ? error.message : String(error) }); });
    return () => { current = false; };
  }, [previewing, code, revision]);
  useEffect(() => {
    if (!full) return;
    const close = (event: KeyboardEvent) => { if (event.key === 'Escape') setFull(false); };
    window.addEventListener('keydown', close);
    return () => window.removeEventListener('keydown', close);
  }, [full]);
  const save = () => { saveHtml(code).then(path => { if (path && live.current) onMessage?.(t('htmlPreviewSaved', { path })); }, error => onMessage?.(core.normalizeError(error).message, true)); };
  const iframe = frame && !('error' in frame) ? <iframe key={revision} className="st-html-preview__frame" title={t('htmlPreviewTitle')} sandbox={PREVIEW_SANDBOX} referrerPolicy="no-referrer" allow="" {...frame}/> : null;
  const actions = <>
    <button type="button" className="st-btn st-btn--icon" aria-label={t('htmlPreviewReload')} data-tooltip={t('htmlPreviewReload')} onClick={() => setRevision(value => value + 1)}><OfficialIcon name="refresh" size={16}/></button>
    <button type="button" className="st-btn st-btn--icon" aria-label={full ? t('htmlPreviewExitFullscreen') : t('htmlPreviewFullscreen')} data-tooltip={full ? t('htmlPreviewExitFullscreen') : t('htmlPreviewFullscreen')} onClick={() => setFull(value => !value)}><FullIcon exit={full}/></button>
    <button type="button" className="st-btn st-btn--icon" aria-label={t('htmlPreviewSave')} data-tooltip={t('htmlPreviewSave')} onClick={save}><OfficialIcon name="download" size={16}/></button>
  </>;
  return <div className="st-code st-code--html" data-mode={previewing ? 'preview' : 'code'}>
    <div className="st-code__head">
      <span>{language}</span>
      <div className="st-code__tools">
        <span className="st-html-toggle" data-tooltip={streaming ? t('htmlPreviewStreaming') : undefined}>
          <Segmented ariaLabel={t('htmlPreviewView')} value={previewing ? 'preview' : 'code'} onValueChange={value => setMode(value as 'code' | 'preview')} options={[{ value: 'code', label: t('htmlCodeTab') }, { value: 'preview', label: t('htmlPreviewTab'), disabled: streaming }]}/>
        </span>
        {previewing && actions}
        <OfficialCopyButton value={code} onCopy={onCopy} label={t('copyCode')}/>
      </div>
    </div>
    {previewing ? <div className="st-html-preview">
      {frame && 'error' in frame ? <p className="msg-error" role="alert">{t('htmlPreviewFailed')} · {frame.error}</p> : <div className="st-html-preview__viewport">{full ? <div className="st-html-preview__placeholder muted small">{t('htmlPreviewFullscreen')}…</div> : iframe}</div>}
      <div className="st-html-preview__note muted small"><OfficialIcon name="info" size={16}/>{t('htmlPreviewSandbox')}</div>
    </div> : <pre>{children}</pre>}
    {previewing && full && iframe && createPortal(<div className="st-html-full" role="dialog" aria-modal="true" aria-label={t('htmlPreviewTitle')}>
      <div className="st-html-full__bar"><strong>{t('htmlPreviewTitle')}</strong><span className="muted small">{t('htmlPreviewSandbox')}</span><div className="st-code__tools">{actions}</div></div>
      {iframe}
    </div>, document.body)}
  </div>;
}
