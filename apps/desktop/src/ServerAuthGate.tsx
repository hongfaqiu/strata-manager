import { useState } from 'react';
import * as core from '@strata-manager/core';

/** Minimal token gate for the headless Web panel (light theme by default). */
export function ServerAuthGate({
  language,
  onAuthed,
}: {
  language: 'zh-CN' | 'en' | string;
  onAuthed: () => void;
}) {
  const zh = language === 'zh-CN';
  const [token, setToken] = useState('');
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);
  const version = core.serverBootstrap()?.version;

  const submit = async () => {
    const value = token.trim();
    if (value.length < 16) {
      setError(zh ? '令牌至少 16 个字符' : 'Token must be at least 16 characters');
      return;
    }
    setBusy(true);
    setError('');
    core.setServerToken(value);
    try {
      await core.supervisorStatus();
      onAuthed();
    } catch (err) {
      core.clearServerToken();
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="server-auth-gate" data-theme="light">
      <div className="server-auth-card">
        <p className="server-auth-kicker">Strata Manager Server{version ? ` · ${version}` : ''}</p>
        <h1>{zh ? '输入访问令牌' : 'Enter access token'}</h1>
        <p className="server-auth-lead">
          {zh
            ? '无头服务首次启动时会在终端打印令牌，也可读取数据目录里的 server-token 文件。'
            : 'The headless server prints the token on first start, and stores it in the data directory as server-token.'}
        </p>
        <label className="server-auth-field">
          <span>{zh ? 'Bearer 令牌' : 'Bearer token'}</span>
          <input
            type="password"
            autoComplete="off"
            spellCheck={false}
            value={token}
            onChange={event => setToken(event.target.value)}
            onKeyDown={event => {
              if (event.key === 'Enter') void submit();
            }}
          />
        </label>
        {error && (
          <p className="server-auth-error" role="alert">
            {error}
          </p>
        )}
        <button type="button" className="st-btn st-btn--primary" disabled={busy} onClick={() => void submit()}>
          {busy ? (zh ? '验证中…' : 'Checking…') : zh ? '进入面板' : 'Open panel'}
        </button>
      </div>
    </div>
  );
}
