import type { AppLanguage } from "@strata-manager/core";
import { useEffect, useRef, useState } from 'react';
import { Copy, ImageDown, LoaderCircle } from 'lucide-react';
import * as core from '@strata-manager/core';
import { Dialog } from '../components';
import { saveBenchmarkPng } from './benchmarkImageSave';

export type BenchmarkImagePreview = { name: string; intent: 'copy' | 'save'; blob?: Blob; url?: string; error?: string };

export function BenchmarkImagePreviewDialog({ image, language, onClose }: { image: BenchmarkImagePreview; language: AppLanguage; onClose: () => void }) {
  const text = (cn: string, en: string) => language === 'zh-CN' ? cn : en;
  const [ready, setReady] = useState(false), [busy, setBusy] = useState<'copy' | 'save'>(), [message, setMessage] = useState<{ text: string; error?: boolean }>();
  const active = useRef(true), working = useRef(false);
  useEffect(() => { active.current = true; return () => { active.current = false; }; }, []);
  const perform = async (action: 'copy' | 'save') => {
    if (!ready || !image.blob || working.current) return;
    working.current = true; setBusy(action); setMessage(undefined);
    try {
      if (action === 'copy') {
        if (!navigator.clipboard?.write || typeof ClipboardItem === 'undefined') throw new Error(text('当前环境不支持复制图片，请另存为 PNG。', 'Image clipboard is unavailable. Save the PNG instead.'));
        await navigator.clipboard.write([new ClipboardItem({ 'image/png': image.blob })]);
        if (active.current) setMessage({ text: text('图片已复制。', 'Image copied.') });
      } else {
        const path = await saveBenchmarkPng(image.name, image.blob);
        if (active.current && path) setMessage({ text: text(`图片已保存：${path}`, `Image saved: ${path}`) });
      }
    } catch (error) { if (active.current) setMessage({ text: core.normalizeError(error).message, error: true }); }
    finally { working.current = false; if (active.current) setBusy(undefined); }
  };
  return <Dialog title={text('结果图片预览', 'Result image preview')} wide onClose={onClose}>
    <div className="benchmark-image-preview">
      <div className="benchmark-image-preview-canvas" aria-busy={!image.url && !image.error}>
        {image.url ? <img src={image.url} alt={text('Benchmark 结果图片', 'Benchmark result image')} onLoad={() => setReady(true)} onError={() => { setReady(false); setMessage({ text: text('图片加载失败，请关闭预览后重试。', 'Image failed to load. Close the preview and retry.'), error: true }); }}/>
          : <p role={image.error ? 'alert' : 'status'}>{image.error || <><LoaderCircle size={18} className="spin"/>{text('正在生成预览…', 'Generating preview…')}</>}</p>}
      </div>
      {message && <p className={`notice${message.error ? ' error' : ''}`} role={message.error ? 'alert' : 'status'}>{message.text}</p>}
      <div className="benchmark-image-preview-actions">
        <button type="button" disabled={!!busy} onClick={onClose}>{text('关闭', 'Close')}</button>
        <button type="button" className={image.intent === 'copy' ? 'st-btn st-btn--primary' : 'st-btn'} disabled={!ready || !!busy} onClick={() => void perform('copy')}>{busy === 'copy' ? <LoaderCircle size={15} className="spin"/> : <Copy size={15}/>} {text('复制图片', 'Copy image')}</button>
        <button type="button" className={image.intent === 'save' ? 'st-btn st-btn--primary' : 'st-btn'} disabled={!ready || !!busy} onClick={() => void perform('save')}>{busy === 'save' ? <LoaderCircle size={15} className="spin"/> : <ImageDown size={15}/>} {text('另存为 PNG', 'Save PNG as')}</button>
      </div>
    </div>
  </Dialog>;
}
