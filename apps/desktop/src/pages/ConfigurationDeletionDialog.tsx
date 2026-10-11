import { useEffect, useRef, useState } from 'react';
import { Archive, LoaderCircle, RefreshCw, Trash2 } from 'lucide-react';
import * as core from '@strata-manager/core';
import type { ServiceProfile } from '@strata-manager/core';
import { OfficialDialog } from '../OfficialControls';
import './configuration-deletion-dialog.css';

export interface ConfigurationDeletionDialogProps {
  profile: ServiceProfile;
  language: 'zh-CN' | 'en';
  onClose: () => void;
  onDeleted: (profile: ServiceProfile) => void | Promise<unknown>;
}

const words = {
  'zh-CN': {
    title: '删除配置', path: '实际 JSON 文件',
    description: '此 JSON 将移入应用的配置归档目录，保留可恢复的副本。模型文件和其他配置保留。正在运行的配置需要先停止服务。',
    cancel: '取消', close: '关闭', confirm: '确认删除配置', deleting: '正在删除…', refreshing: '正在刷新…',
    deleted: '配置已删除，可恢复副本已保留。', archivedPath: '可恢复副本',
    refreshFailed: '配置已删除，但列表刷新失败：', retryRefresh: '重新刷新列表',
  },
  en: {
    title: 'Delete configuration', path: 'Actual JSON file',
    description: 'This JSON file will be moved to the application archive, keeping a recoverable copy. Model files and other configurations are retained. Stop this configuration’s service before deleting it.',
    cancel: 'Cancel', close: 'Close', confirm: 'Confirm configuration deletion', deleting: 'Deleting…', refreshing: 'Refreshing…',
    deleted: 'Configuration deleted. A recoverable copy has been kept.', archivedPath: 'Recoverable copy',
    refreshFailed: 'Configuration deleted, but the list could not refresh: ', retryRefresh: 'Refresh the list again',
  },
} as const;

export function ConfigurationDeletionDialog(props: ConfigurationDeletionDialogProps) {
  return <ConfigurationDeletionSession key={`${props.profile.id}\0${props.profile.configPath}`} {...props} />;
}

function ConfigurationDeletionSession({ profile, language, onClose, onDeleted }: ConfigurationDeletionDialogProps) {
  const w = words[language];
  const target = useRef({ ...profile }).current;
  const mounted = useRef(true);
  const pending = useRef(false);
  const archived = useRef(false);
  const [busy, setBusy] = useState(false);
  const [archivedPath, setArchivedPath] = useState<string | null>(null);
  const [failure, setFailure] = useState<{ stage: 'delete' | 'refresh'; message: string } | null>(null);
  useEffect(() => {
    mounted.current = true;
    return () => { mounted.current = false; };
  }, []);

  const close = () => { if (!pending.current) onClose(); };
  const refresh = async () => {
    if (!mounted.current) return;
    try {
      await onDeleted(target);
      if (mounted.current) onClose();
    } catch (error) {
      if (mounted.current) setFailure({ stage: 'refresh', message: core.normalizeError(error).message });
    }
  };
  const remove = async () => {
    if (pending.current || archived.current || !mounted.current) return;
    pending.current = true;
    setBusy(true); setFailure(null);
    try {
      const result = await core.deleteConfiguration(target);
      archived.current = true;
      if (mounted.current) {
        setArchivedPath(result.archivedPath);
        await refresh();
      }
    } catch (error) {
      if (mounted.current) setFailure({ stage: 'delete', message: core.normalizeError(error).message });
    } finally {
      pending.current = false;
      if (mounted.current) setBusy(false);
    }
  };
  const retryRefresh = async () => {
    if (pending.current || !archived.current || !mounted.current) return;
    pending.current = true;
    setBusy(true); setFailure(null);
    try { await refresh(); }
    finally { pending.current = false; if (mounted.current) setBusy(false); }
  };

  return <OfficialDialog title={w.title} onClose={close} wide>
    <div className="configuration-deletion-dialog" aria-busy={busy}>
      <strong className="configuration-deletion-name">{target.name}</strong>
      <dl className="configuration-deletion-path"><dt>{w.path}</dt><dd><code>{target.configPath}</code></dd></dl>
      <p>{w.description}</p>
      {archivedPath !== null && <div className="configuration-deletion-completed">
        <p role="status"><Archive size={16} aria-hidden="true" />{w.deleted}</p>
        <dl className="configuration-deletion-path"><dt>{w.archivedPath}</dt><dd><code>{archivedPath}</code></dd></dl>
      </div>}
      {failure && <p className="notice error configuration-deletion-error" role="alert">{failure.stage === 'refresh' ? w.refreshFailed : ''}{failure.message}</p>}
      <div className="configuration-deletion-actions">
        <button type="button" disabled={busy} onClick={close}>{archivedPath !== null ? w.close : w.cancel}</button>
        {archivedPath !== null
          ? failure?.stage === 'refresh' && <button type="button" disabled={busy} onClick={() => void retryRefresh()}><RefreshCw size={15} aria-hidden="true" />{w.retryRefresh}</button>
          : <button type="button" className="danger" disabled={busy} onClick={() => void remove()}>{busy ? <LoaderCircle size={15} className="spin" aria-hidden="true" /> : <Trash2 size={15} aria-hidden="true" />}{busy ? w.deleting : w.confirm}</button>}
        {busy && archivedPath !== null && <span className="configuration-deletion-refreshing" role="status"><LoaderCircle size={15} className="spin" aria-hidden="true" />{w.refreshing}</span>}
      </div>
    </div>
  </OfficialDialog>;
}
