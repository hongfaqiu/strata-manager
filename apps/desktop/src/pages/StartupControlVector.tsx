import { useEffect, useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import type { AppLanguage, JsonObject } from '@strata-manager/core';
import * as core from '@strata-manager/core';
import { Dropdown, Segmented, Toggle } from '../OfficialControls';
import './startup-control-vector.css';

type Field = 'scale' | 'first' | 'last' | 'direction';

/**
 * 控制向量（Control Vector）: one switch for the vector that ships with the Strata runtime
 * (`<cwd>\data\experimental-speed-projection\…gguf`), written as upstream setup.py writes it.
 * Strength, layer range, mode and direction are visible advanced fields prefilled with that preset;
 * a different GGUF is an optional override. Nothing is downloaded.
 */
export function StartupControlVector({ language, draft, disabled, desktop, showParameterNames, engineFlags, mac, onApply }: {
  language: AppLanguage;
  draft?: JsonObject;
  disabled?: boolean;
  desktop: boolean;
  showParameterNames: boolean;
  engineFlags?: readonly string[] | null;
  mac: boolean;
  onApply: (settings: core.ControlVectorSettings | null) => void;
}) {
  const zh = language === 'zh-CN';
  const state = draft ? core.readControlVector(draft) : null;
  const bundled = core.bundledControlVectorPath(typeof draft?.cwd === 'string' ? draft.cwd : null);
  const [customFile, setCustomFile] = useState('');
  const [edits, setEdits] = useState<Partial<Record<Field, string>>>({});
  const [pickError, setPickError] = useState('');
  const enabled = !!state?.enabled;
  const activeFile = enabled ? state!.settings.file : customFile || bundled || '';
  useEffect(() => { setEdits({}); }, [enabled, activeFile]);
  const check = useQuery({ queryKey: ['control-vector-check', activeFile], queryFn: () => core.inspectControlVector(activeFile), enabled: desktop && !!activeFile, retry: false, staleTime: 15000 });
  if (!draft || !state) return null;

  const availability = core.controlVectorAvailability(engineFlags, mac);
  const usingBundled = !!activeFile && core.isBundledControlVector(activeFile);
  const fileProblem = check.data ? core.controlVectorCheckMessage(check.data, zh) : null;
  const maxLayer = check.data?.status === 'ok' ? check.data.maxLayer ?? null : null;
  const current: core.ControlVectorSettings = { ...state.settings, ...edits };
  const fieldError = enabled ? core.controlVectorError(current, maxLayer) : null;
  const switchBlocked = !enabled && (!availability.available || !activeFile || !!fileProblem);
  const reason = !availability.available ? (zh ? availability.reason!.zh : availability.reason!.en)
    : !activeFile ? (zh ? '配置里没有 cwd（Strata 安装目录），无法定位随附的控制向量；可在下方选择文件。' : 'The configuration has no cwd (the Strata folder), so the bundled vector cannot be located; choose a file below.')
    : fileProblem && !enabled ? `${usingBundled ? (zh ? '随附的控制向量不可用：' : 'The bundled vector is unavailable: ') : ''}${fileProblem}` : '';

  const turnOn = () => onApply({ file: activeFile, ...core.CONTROL_VECTOR_PRESET });
  const edit = (field: Field, value: string) => {
    const next = { ...current, [field]: value };
    if (field === 'direction' && value.startsWith('single:') && next.mode !== 'project') next.mode = 'project';
    setEdits(previous => ({ ...previous, [field]: value }));
    if (!core.controlVectorError(next, maxLayer)) onApply(next);
  };
  const setMode = (mode: string) => {
    const next = { ...current, mode: mode as core.ControlVectorMode, direction: mode === 'add' && current.direction !== 'per-layer' ? 'per-layer' : current.direction };
    setEdits({}); if (!core.controlVectorError(next, maxLayer)) onApply(next);
  };
  const chooseFile = async () => {
    setPickError('');
    try {
      const { open } = await import('@tauri-apps/plugin-dialog');
      const selected = await open({ multiple: false, directory: false, filters: [{ name: 'GGUF', extensions: ['gguf'] }] });
      if (typeof selected !== 'string') return;
      if (selected.includes(',')) { setPickError(zh ? '路径包含逗号，引擎会把它当成多个文件。' : 'The path contains a comma, which the engine reads as several files.'); return; }
      setCustomFile(selected);
      if (enabled) onApply({ ...current, file: selected });
    } catch (failure) { setPickError(core.normalizeError(failure).message); }
  };
  const useBundled = () => { setCustomFile(''); if (enabled && bundled) onApply({ ...current, file: bundled }); };
  const statusText = !activeFile ? '' : check.isFetching ? (zh ? '正在检查文件…' : 'Checking the file…')
    : check.data?.status === 'ok' ? (zh ? `已找到 · 控制向量 · ${check.data.layers} 层方向（最高第 ${check.data.maxLayer} 层）` : `Found · control vector · ${check.data.layers} layer directions (up to layer ${check.data.maxLayer})`)
    : fileProblem ?? (check.error ? (zh ? `无法检查文件：${core.normalizeError(check.error).message}` : `Could not check the file: ${core.normalizeError(check.error).message}`) : '');
  const label = (zhText: string, enText: string, flag?: string) => <><span className="st-label">{zh ? zhText : enText}</span>{showParameterNames && flag && <code>{flag}</code>}</>;
  const fieldsDisabled = disabled || !enabled || state.multiple;

  return (
    <section className="startup-control-vector" data-testid="startup-control-vector" data-enabled={enabled ? 'true' : 'false'} aria-label={zh ? '控制向量（Control Vector）' : 'Control vector'}>
      <div className="startup-control-vector-head">
        <div>
          <strong>{zh ? '控制向量（Control Vector）' : 'Control vector'}</strong>
          <p>{zh ? `在启动参数中加载 llama.cpp 格式的控制向量（Strata 引擎 ${core.CONTROL_VECTOR_MIN_ENGINE} 起）。默认关闭；开启后使用 Strata 随附的向量和上游 setup 的预设。` : `Loads a llama.cpp-format control vector at launch (Strata engine ${core.CONTROL_VECTOR_MIN_ENGINE}+). Off by default; on uses the vector shipped with Strata and upstream setup's preset.`}</p>
        </div>
        <Toggle ariaLabel={zh ? '启用控制向量' : 'Enable control vector'} checked={enabled} disabled={disabled || switchBlocked} tooltip={switchBlocked ? reason : undefined} onCheckedChange={on => { setPickError(''); if (on) turnOn(); else onApply(null); }}/>
      </div>
      {reason && (!enabled || !availability.available) && <p className="startup-control-vector-reason" role="status" data-testid="control-vector-reason">{reason}</p>}
      {state.multiple && <p className="startup-control-vector-reason" role="status">{zh ? '当前配置加载了多个控制向量，请在下方完整参数列表中编辑；这里的开关只能整体关闭。' : 'This configuration loads several control vectors; edit them in the full argument list below. The switch here can only turn them all off.'}</p>}

      <div className="startup-control-vector-file">
        <span className="st-label">{usingBundled ? (zh ? '随附向量路径' : 'Bundled vector') : (zh ? '自定义向量文件' : 'Custom vector file')}</span>
        <code data-testid="control-vector-path">{activeFile || (zh ? '（未知：配置缺少 cwd）' : '(unknown: no cwd in the configuration)')}</code>
        {statusText && <small data-status={check.data?.status ?? (check.error ? 'error' : 'pending')}>{statusText}</small>}
        <div className="startup-control-vector-file-actions">
          {desktop && <button type="button" disabled={disabled || state.multiple} onClick={() => void chooseFile()}>{zh ? '改用其他文件…' : 'Use another file…'}</button>}
          {!usingBundled && bundled && <button type="button" disabled={disabled || state.multiple} onClick={useBundled}>{zh ? '恢复随附向量' : 'Use the bundled vector'}</button>}
        </div>
        {pickError && <small className="startup-control-vector-error" role="alert">{pickError}</small>}
      </div>

      <div className="startup-control-vector-grid">
        <label className="st-field">{label('强度', 'Strength', '--control-vector-scaled FILE:S')}<input className="st-input" inputMode="decimal" aria-label={zh ? '强度' : 'Strength'} disabled={fieldsDisabled} value={enabled ? current.scale : core.CONTROL_VECTOR_PRESET.scale} onChange={event => edit('scale', event.target.value)}/></label>
        <div className="st-field">{label('层范围（含两端）', 'Layer range (inclusive)', '--control-vector-layer-range A B')}<div className="startup-control-vector-range"><input className="st-input" inputMode="numeric" aria-label={zh ? '起始层' : 'First layer'} placeholder="1" disabled={fieldsDisabled} value={enabled ? current.first : core.CONTROL_VECTOR_PRESET.first} onChange={event => edit('first', event.target.value)}/><span>–</span><input className="st-input" inputMode="numeric" aria-label={zh ? '结束层' : 'Last layer'} placeholder={zh ? '最后一层' : 'last'} disabled={fieldsDisabled} value={enabled ? current.last : core.CONTROL_VECTOR_PRESET.last} onChange={event => edit('last', event.target.value)}/></div></div>
        <div className="st-field">{label('模式', 'Mode', '--cvec-mode')}<Segmented ariaLabel={zh ? '控制向量模式' : 'Control vector mode'} value={enabled ? current.mode : core.CONTROL_VECTOR_PRESET.mode} onValueChange={setMode} options={[{ value: 'project', label: 'project', disabled: fieldsDisabled }, { value: 'add', label: 'add', disabled: fieldsDisabled }]}/><small className="startup-control-vector-hint">{zh ? 'project：从隐藏状态移除该方向；add：叠加该方向' : 'project removes the direction from hidden states; add adds it'}</small></div>
        <div className="st-field">{label('方向', 'Direction', '--cvec-dir')}<Dropdown editable ariaLabel={zh ? '控制向量方向' : 'Control vector direction'} disabled={fieldsDisabled} value={enabled ? current.direction : core.CONTROL_VECTOR_PRESET.direction} editableDisplayValue={enabled ? current.direction : core.CONTROL_VECTOR_PRESET.direction} options={[{ value: 'per-layer', label: zh ? 'per-layer（每层各自方向）' : 'per-layer (each layer its own)' }, { value: 'single:20', label: zh ? 'single:L（所有层用第 L 层方向，仅 project）' : 'single:L (layer L for all, project only)' }]} onValueChange={value => edit('direction', value)}/></div>
      </div>
      {fieldError && <p className="startup-control-vector-error" role="alert">{fieldError}</p>}
      <div className="startup-control-vector-preset">
        <small>{zh ? `上游预设：强度 1.0、第 4–44 层、project、per-layer。引擎自身默认（不写参数时）：第 1 层到最后一层、add、per-layer。层范围留空即用引擎默认。` : 'Upstream preset: strength 1.0, layers 4–44, project, per-layer. Engine defaults when a flag is absent: layer 1 to the last, add, per-layer. Leave the range empty for the engine default.'}</small>
        {enabled && <button type="button" disabled={disabled || state.multiple} onClick={() => { setEdits({}); onApply({ ...current, ...core.CONTROL_VECTOR_PRESET }); }}>{zh ? '恢复上游预设' : 'Restore upstream preset'}</button>}
      </div>

      <dl className="startup-control-vector-notes">
        <div><dt>{zh ? '按请求切换' : 'Per request'}</dt><dd>{zh ? <>加载后默认对每个请求生效。请求体加 <code>"{core.CONTROL_VECTOR_REQUEST_FIELD}": false</code> 可对单次请求关闭（OpenAI 与 Anthropic 接口）；对话设置中也有同名开关。配置默认值是采样分类中的「默认实验投影」（<code>sampling.{core.CONTROL_VECTOR_REQUEST_FIELD}</code>）。切换会清空一次对话缓存；关闭时输出与原模型逐 token 一致。</> : <>Once loaded it applies to every request. Send <code>"{core.CONTROL_VECTOR_REQUEST_FIELD}": false</code> in a request body to turn it off for that request (OpenAI and Anthropic APIs); the chat settings have the same switch. The configuration default is "Default experimental speed projection" in Sampling (<code>sampling.{core.CONTROL_VECTOR_REQUEST_FIELD}</code>). Switching drops the conversation cache once; off, output is token-for-token the stock model's.</>}</dd></div>
        <div><dt>{zh ? '随附向量说明' : 'About the bundled vector'}</dt><dd>{zh ? '上游文档（data/experimental-speed-projection/README.md）称其为「拒答方向投影」：开启后模型拒绝的请求大幅减少（上游测试集 50 条中 1 条，关闭时 50 条），这会移除一项安全行为，生成内容由使用者负责。它不是提速优化：同样文本每 token 慢约 0.2–0.4%，并会轻微改变普通回答。只适用于原版 Qwen3.8-Flash-Next，不适用于 Swift 1.5；Mac 版引擎尚未支持。' : 'Upstream (data/experimental-speed-projection/README.md) describes it as a refusal-direction projection: the model declines far fewer requests (1 of 50 vs 50 of 50 on its test set). This removes a safety behaviour and you are responsible for what the model writes with it on. It is not a speed optimization: about 0.2–0.4% slower per token on the same text, and it shifts ordinary answers slightly. Only for the original Qwen3.8-Flash-Next, not Swift 1.5; not yet on the Mac engine.'}</dd></div>
      </dl>
      <p className="startup-control-vector-footnote">{zh ? '保存并重启模型后生效。' : 'Takes effect after saving and restarting the model.'}</p>
    </section>
  );
}
