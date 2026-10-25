import { useEffect, useState } from 'react';
import { LoaderCircle, Trash2 } from 'lucide-react';
import * as core from '@strata-manager/core';
import type { AppLanguage, BadShard } from '@strata-manager/core';
import { OfficialDialog } from '../OfficialControls';

const words = {
  'zh-CN': {
    action: '删除坏分片并重试', actionOnly: '删除坏分片',
    note: '只删除这个文件，以及它同名的 .done 和 .part 临时文件。',
    cancel: '取消', confirm: '删除并重试', confirmOnly: '删除', deleting: '正在删除…',
    missing: '文件已经不在了',
  },
  en: {
    action: 'Delete bad shard and retry', actionOnly: 'Delete bad shard',
    note: 'Only this file and its matching .done and .part leftovers are deleted.',
    cancel: 'Cancel', confirm: 'Delete and retry', confirmOnly: 'Delete', deleting: 'Deleting…',
    missing: 'The file is already gone',
  },
} as const;
const copy = (language: AppLanguage) => words[language === 'zh-CN' ? 'zh-CN' : 'en'];

const fileSize = (bytes: number, language: AppLanguage) => {
  const units = ['B', 'KiB', 'MiB', 'GiB', 'TiB'];
  const power = bytes > 0 ? Math.min(4, Math.floor(Math.log(bytes) / Math.log(1024))) : 0;
  return `${(bytes / 1024 ** power).toLocaleString(language, { maximumFractionDigits: power ? 1 : 0 })} ${units[power]}`;
};

/** The failed task's kept model shard, asked from the supervisor; null for any other failure. */
export function BadShardAction({ taskId, failed, language, disabled = false, canRetry, onOpen }: {
  taskId: string; failed: boolean; language: AppLanguage; disabled?: boolean; canRetry: boolean;
  onOpen: (shard: BadShard) => void;
}) {
  const w = copy(language);
  const [shard, setShard] = useState<BadShard | null>(null);
  useEffect(() => {
    let current = true;
    setShard(null);
    if (failed) core.taskBadShard(taskId).then(found => { if (current) setShard(found); }, () => { if (current) setShard(null); });
    return () => { current = false; };
  }, [taskId, failed]);
  if (!failed || !shard) return null;
  return <button className="st-btn st-btn--primary" disabled={disabled} onClick={() => onOpen(shard)}><Trash2 size={14} />{canRetry ? w.action : w.actionOnly}</button>;
}

/** Names the exact file first; nothing is deleted until the user confirms. */
export function BadShardDialog({ shard, language, canRetry, onClose, onConfirm }: {
  shard: BadShard; language: AppLanguage; canRetry: boolean;
  onClose: () => void; onConfirm: () => void | Promise<unknown>;
}) {
  const w = copy(language);
  const [working, setWorking] = useState(false);
  const [error, setError] = useState('');
  const confirm = async () => {
    if (working) return;
    setWorking(true); setError('');
    try { await onConfirm(); }
    catch (failure) { setError(core.normalizeError(failure).message); setWorking(false); }
  };
  return <OfficialDialog title={canRetry ? w.action : w.actionOnly} onClose={() => { if (!working) onClose(); }}>
    <div className="bad-shard-dialog">
      <strong className="bad-shard-name">{shard.fileName}</strong>
      <code className="bad-shard-path">{shard.path}</code>
      <span className="bad-shard-size">{shard.sizeBytes === null ? w.missing : fileSize(shard.sizeBytes, language)}</span>
      <p>{w.note}</p>
      {error && <p className="bad-shard-error" role="alert">{error}</p>}
      <div className="dialog-footer">
        <button disabled={working} onClick={onClose}>{w.cancel}</button>
        <button className="danger" disabled={working} onClick={() => void confirm()}>{working ? <><LoaderCircle size={15} className="spin" />{w.deleting}</> : <><Trash2 size={15} />{canRetry ? w.confirm : w.confirmOnly}</>}</button>
      </div>
    </div>
  </OfficialDialog>;
}
