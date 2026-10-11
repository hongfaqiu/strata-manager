import { useCallback, useEffect, useRef, useState } from 'react';
import { Dialog } from './components';

export type SaveDraft = () => Promise<boolean>;

/** Run an action only after edits are saved or explicitly discarded. */
export function useDraftGuard(dirty: boolean, saveDraft: SaveDraft, language: 'zh-CN' | 'en') {
  const latest = useRef({ dirty, saveDraft }); latest.current = { dirty, saveDraft };
  const [pending, setPending] = useState<(() => void) | null>(null);
  const [saving, setSaving] = useState(false);
  const savingRef = useRef(false);
  const [error, setError] = useState('');
  const cancelled = useRef<(() => void) | undefined>(undefined);
  useEffect(() => () => cancelled.current?.(), []);
  const zh = language === 'zh-CN';
  const request = useCallback((action: () => void, onCancel?: () => void) => {
    if (savingRef.current) { onCancel?.(); return; }
    if (!latest.current.dirty) { action(); return; }
    cancelled.current?.(); cancelled.current = onCancel;
    setError(''); setPending(() => action);
  }, []);
  const requestAsync = useCallback(<T,>(action: () => Promise<T>): Promise<T | false> => new Promise((resolve, reject) => {
    request(() => { void action().then(resolve, reject); }, () => resolve(false));
  }), [request]);
  const cancel = () => { if (!savingRef.current) { cancelled.current?.(); cancelled.current = undefined; setPending(null); } };
  const discard = () => { if (!savingRef.current && pending) { cancelled.current = undefined; setPending(null); pending(); } };
  const save = async () => {
    if (!pending || savingRef.current) return;
    savingRef.current = true; setSaving(true); setError('');
    try {
      if (await latest.current.saveDraft()) { cancelled.current = undefined; setPending(null); pending(); }
      else setError(zh ? '尚未保存成功，请检查配置页面中的错误。草稿已保留。' : 'Saving did not complete. Check the configuration error; your draft is preserved.');
    } catch (cause) { setError(String(cause)); }
    finally { savingRef.current = false; setSaving(false); }
  };
  return { request, requestAsync, dialog: pending && <Dialog title={zh ? '有未保存的改动' : 'Unsaved changes'} onClose={cancel}>
    <p>{zh ? '保存后继续，或放弃改动。取消会保留当前草稿。保存配置不会重启模型服务。' : 'Save to continue, or discard your changes. Cancel keeps the current draft. Saving configuration does not restart the model service.'}</p>
    {error && <p role="alert" className="notice error">{error}</p>}
    <div className="dialog-footer"><button disabled={saving} onClick={cancel}>{zh ? '取消' : 'Cancel'}</button><button disabled={saving} onClick={discard}>{zh ? '放弃改动' : 'Discard changes'}</button><button className="primary" disabled={saving} onClick={() => void save()}>{saving ? (zh ? '保存中…' : 'Saving…') : (zh ? '保存并继续' : 'Save and continue')}</button></div>
  </Dialog> };
}
