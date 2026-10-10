import { useCallback, useEffect, useId, useRef, useState } from 'react';
import { LoaderCircle, RefreshCw, Trash2 } from 'lucide-react';
import * as core from '@strata-manager/core';
import type { ServiceProfile } from '@strata-manager/core';
import { OfficialDialog } from '../OfficialControls';

type DeletionPlan = Awaited<ReturnType<typeof core.planModelDeletion>>;
type DeletionResult = Awaited<ReturnType<typeof core.deleteModelFiles>>;

export interface ModelDeletionDialogProps {
  modelName: string;
  profiles: ServiceProfile[];
  language: 'zh-CN' | 'en';
  disabled?: boolean;
  onClose: () => void;
  onDeleted: () => void | Promise<unknown>;
}

const words = {
  'zh-CN': {
    title: '删除模型文件',
    description: '将永久删除下列模型权重文件。JSON 配置和 Strata 运行环境保留；之后需要重新下载模型才能再次使用。',
    checking: '正在检查模型文件与引用…',
    files: '个文件', total: '合计', empty: '没有可删除的模型文件。',
    blocked: '当前无法删除', retry: '重新检查', cancel: '取消', close: '关闭',
    confirmLabel: '输入模型名以确认', confirmHint: '请输入上方显示的完整模型名。',
    confirm: '永久删除模型文件', deleting: '正在删除…', deleted: '模型文件已删除，JSON 配置已保留。',
    refreshFailed: '模型文件已删除，但列表刷新失败：',
  },
  en: {
    title: 'Delete model files',
    description: 'Permanently deletes the model weights listed below. JSON configurations and the Strata runtime are retained. Download the model again before using it.',
    checking: 'Checking model files and references…',
    files: 'files', total: 'Total', empty: 'There are no model files to delete.',
    blocked: 'Deletion is blocked', retry: 'Check again', cancel: 'Cancel', close: 'Close',
    confirmLabel: 'Enter the model name to confirm', confirmHint: 'Enter the full model name shown above.',
    confirm: 'Permanently delete model files', deleting: 'Deleting…', deleted: 'Model files deleted. JSON configurations retained.',
    refreshFailed: 'Model files deleted, but the list could not refresh: ',
  },
} as const;

const fileSize = (bytes: number, language: 'zh-CN' | 'en') => {
  const units = ['B', 'KiB', 'MiB', 'GiB', 'TiB'];
  const power = bytes > 0 ? Math.min(4, Math.floor(Math.log(bytes) / Math.log(1024))) : 0;
  return `${(bytes / 1024 ** power).toLocaleString(language, { maximumFractionDigits: power ? 2 : 0 })} ${units[power]}`;
};

/** A preview never deletes files. The explicit confirmation submits that exact file snapshot. */
export function ModelDeletionDialog({ modelName, profiles, language, disabled = false, onClose, onDeleted }: ModelDeletionDialogProps) {
  const w = words[language];
  const uid = useId();
  const mounted = useRef(true);
  const epoch = useRef(0);
  const pending = useRef(false);
  const completed = useRef(false);
  const [plan, setPlan] = useState<DeletionPlan | null>(null);
  const [checking, setChecking] = useState(true);
  const [deleting, setDeleting] = useState(false);
  const [deleted, setDeleted] = useState<DeletionResult | null>(null);
  const [confirmationName, setConfirmationName] = useState('');
  const [error, setError] = useState('');

  const loadPlan = useCallback(async () => {
    if (pending.current || completed.current) return;
    const requestEpoch = ++epoch.current;
    setChecking(true); setError(''); setPlan(null); setConfirmationName('');
    try {
      const next = await core.planModelDeletion(profiles);
      if (mounted.current && epoch.current === requestEpoch) setPlan(next);
    } catch (failure) {
      if (mounted.current && epoch.current === requestEpoch) setError(core.normalizeError(failure).message);
    } finally {
      if (mounted.current && epoch.current === requestEpoch) setChecking(false);
    }
  }, [profiles]);
  useEffect(() => {
    mounted.current = true;
    void loadPlan();
    return () => { mounted.current = false; epoch.current++; };
  }, [loadPlan]);

  const canConfirm = !!plan && !plan.blockedReason && plan.files.length > 0 && confirmationName === modelName && !checking && !deleting && !deleted && !disabled;
  const close = () => { if (!pending.current) onClose(); };
  const remove = async () => {
    if (!canConfirm || pending.current || completed.current || !plan) return;
    pending.current = true; setDeleting(true); setError('');
    try {
      const result = await core.deleteModelFiles(profiles, plan.files);
      completed.current = true;
      if (mounted.current) setDeleted(result);
      try {
        await onDeleted();
        if (mounted.current) onClose();
      } catch (failure) {
        if (mounted.current) setError(w.refreshFailed + core.normalizeError(failure).message);
      }
    } catch (failure) {
      if (mounted.current) {
        setError(core.normalizeError(failure).message);
        // A changed file set or new reference requires another preview and confirmation.
        setPlan(null); setConfirmationName('');
      }
    } finally {
      pending.current = false;
      if (mounted.current) setDeleting(false);
    }
  };

  return <OfficialDialog title={w.title} onClose={close} wide>
    <div className="model-deletion-dialog">
      <strong className="model-deletion-name">{modelName}</strong>
      <p>{w.description}</p>
      {checking && <p className="model-deletion-checking" role="status"><LoaderCircle size={16} className="spin" />{w.checking}</p>}
      {plan && <>
        <div className="model-deletion-summary"><span>{plan.files.length} {w.files}</span><strong>{w.total} {fileSize(plan.totalBytes, language)}</strong></div>
        {!!plan.files.length && <ul className="model-deletion-files">{plan.files.map(file => <li key={file.path}><code>{file.path}</code><span>{fileSize(file.sizeBytes, language)}</span></li>)}</ul>}
        {!plan.files.length && <p className="model-deletion-empty">{w.empty}</p>}
        {plan.blockedReason && <p className="model-deletion-error" role="alert"><strong>{w.blocked}: </strong>{plan.blockedReason}</p>}
        {!plan.blockedReason && !!plan.files.length && !deleted && <label className="model-deletion-confirm" htmlFor={`${uid}-name`}>
          <span>{w.confirmLabel}</span>
          <input id={`${uid}-name`} value={confirmationName} disabled={deleting || disabled} onChange={event => setConfirmationName(event.target.value)} autoComplete="off" spellCheck={false} aria-describedby={`${uid}-hint`} />
          <small id={`${uid}-hint`}>{w.confirmHint}</small>
        </label>}
      </>}
      {deleted && <p className="model-deletion-success" role="status">{w.deleted}</p>}
      {error && <p className="model-deletion-error" role="alert">{error}</p>}
      <div className="dialog-footer">
        {!deleted && <button disabled={checking || deleting || disabled} onClick={() => void loadPlan()}><RefreshCw size={15} />{w.retry}</button>}
        <button disabled={deleting} onClick={close}>{deleted ? w.close : w.cancel}</button>
        {!deleted && <button className="danger" disabled={!canConfirm} onClick={() => void remove()}>{deleting ? <><LoaderCircle size={15} className="spin" />{w.deleting}</> : <><Trash2 size={15} />{w.confirm}</>}</button>}
      </div>
    </div>
  </OfficialDialog>;
}
