import { useEffect, useRef, useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import { Check, Copy, Crosshair, FolderOpen, Layers, Minus, Plus, RotateCcw, SlidersHorizontal, Undo2 } from 'lucide-react';
import type { AppLanguage, JsonObject } from '@strata-manager/core';
import * as core from '@strata-manager/core';
import { OfficialDialog, Segmented, Slider, Toggle } from '../OfficialControls';
import './startup-control-vector.css';

type Field = 'scale' | 'first' | 'last' | 'direction';
const SCALE_MIN = 0, SCALE_MAX = 2, SCALE_STEP = 0.05;

/** Long paths keep the drive/root and the file name; the full path is in the tooltip. */
export function shortPath(path: string, max = 72): string {
  if (path.length <= max) return path;
  const cut = Math.max(path.lastIndexOf('\\'), path.lastIndexOf('/'));
  const name = cut >= 0 ? path.slice(cut) : path.slice(-max + 12);
  const head = Math.max(8, max - name.length - 1);
  return `${path.slice(0, head)}…${name}`;
}

/**
 * 无审查模式 (Uncensored mode): one plain switch for the control vector that ships with the Strata
 * runtime (`<cwd>\data\experimental-speed-projection\…gguf`), written as upstream setup.py writes it.
 * Every technical control (path, custom file, strength, layer range, mode, direction, presets,
 * per-request field, upstream notes) lives in the 「高级设置」 dialog. Nothing is downloaded.
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
  const [copied, setCopied] = useState(false);
  const [advanced, setAdvanced] = useState<'closed' | 'open'>('closed');
  const dragging = useRef<'first' | 'last' | null>(null);
  const enabled = !!state?.enabled;
  const activeFile = enabled ? state!.settings.file : customFile || bundled || '';
  useEffect(() => { setEdits({}); }, [enabled, activeFile]);
  const check = useQuery({ queryKey: ['control-vector-check', activeFile], queryFn: () => core.inspectControlVector(activeFile), enabled: desktop && !!activeFile, retry: false, staleTime: 15000 });
  if (!draft || !state) return null;

  const availability = core.controlVectorAvailability(engineFlags, mac);
  const usingBundled = !!activeFile && core.isBundledControlVector(activeFile);
  const fileProblem = check.data ? core.controlVectorCheckMessage(check.data, zh) : null;
  const maxLayer = check.data?.status === 'ok' ? check.data.maxLayer ?? null : null;
  const current: core.ControlVectorSettings = enabled ? { ...state.settings, ...edits } : { file: activeFile, ...core.CONTROL_VECTOR_PRESET };
  const fieldError = enabled ? core.controlVectorError(current, maxLayer) : null;
  const switchBlocked = !enabled && (!availability.available || !activeFile || !!fileProblem);
  const reason = !availability.available ? (zh ? availability.reason!.zh : availability.reason!.en)
    : !activeFile ? (zh ? '配置里没有 cwd（Strata 安装目录），无法定位随附的控制向量；可改用其他文件。' : 'The configuration has no cwd (the Strata folder), so the bundled vector cannot be located; use another file.')
    : fileProblem && !enabled ? `${usingBundled ? (zh ? '随附的控制向量不可用：' : 'The bundled vector is unavailable: ') : ''}${fileProblem}` : '';
  const checkError = check.error ? core.normalizeError(check.error).message : '';

  // Detail chip (advanced dialog): source and layer count, or the file problem.
  const source = usingBundled ? (zh ? '随附向量' : 'Bundled') : (zh ? '自定义文件' : 'Custom file');
  const chip: { tone: 'ok' | 'muted' | 'warn'; text: string; tip: string } =
    !availability.available ? { tone: 'muted', text: mac ? (zh ? 'Mac 版暂不支持' : 'Not on Mac yet') : (zh ? `需引擎 ${core.CONTROL_VECTOR_MIN_ENGINE}+` : `Needs engine ${core.CONTROL_VECTOR_MIN_ENGINE}+`), tip: reason }
    : !activeFile ? { tone: 'muted', text: zh ? '未定位向量' : 'No vector located', tip: reason }
    : check.isFetching ? { tone: 'muted', text: zh ? '检查中…' : 'Checking…', tip: activeFile }
    : check.data?.status === 'ok' ? { tone: 'ok', text: `${source} · ${check.data.layers} ${zh ? '层' : 'layers'}`, tip: zh ? `控制向量 · ${check.data.layers} 层方向（最高第 ${check.data.maxLayer} 层）` : `Control vector · ${check.data.layers} layer directions (up to layer ${check.data.maxLayer})` }
    : fileProblem ? { tone: 'warn', text: check.data?.status === 'missing' ? (zh ? '未找到文件' : 'File not found') : (zh ? '文件无效' : 'Invalid file'), tip: fileProblem }
    : checkError ? { tone: 'warn', text: zh ? '无法检查' : 'Check failed', tip: checkError }
    : { tone: 'muted', text: source, tip: activeFile };
  // Main chip: plain words only; the technical sentence is the tooltip.
  const status: { tone: 'ok' | 'muted' | 'warn'; text: string; tip: string } =
    chip.tone === 'ok' ? { tone: 'ok', text: zh ? '已就绪' : 'Ready', tip: chip.text }
    : !availability.available ? chip
    : !activeFile || check.data?.status === 'missing' ? { tone: chip.tone, text: zh ? '未找到向量' : 'Vector not found', tip: chip.tip }
    : fileProblem ? { tone: 'warn', text: zh ? '向量文件无效' : 'Invalid vector file', tip: chip.tip }
    : chip;
  // One plain sentence under the switch when it cannot be used; the technical reason stays in the tooltip and the dialog.
  const plainReason = !availability.available ? (mac ? (zh ? 'Mac 版引擎暂不支持此功能。' : 'The Mac engine does not support this yet.') : (zh ? `当前 Strata 引擎版本过旧，升级到 ${core.CONTROL_VECTOR_MIN_ENGINE} 或更高版本后可用。` : `The Strata engine is too old; update to ${core.CONTROL_VECTOR_MIN_ENGINE} or newer to use this.`))
    : !activeFile ? (zh ? '找不到模型包自带的向量（配置里没有 cwd，即 Strata 安装目录）。可在高级设置中选择文件。' : 'The bundled vector cannot be found (no cwd, the Strata folder, in the configuration). You can choose a file in Advanced settings.')
    : fileProblem && !enabled ? (check.data?.status === 'missing' ? (usingBundled ? (zh ? '没有找到模型包自带的向量文件。可在高级设置中选择其他文件。' : 'The bundled vector file is missing. You can choose another file in Advanced settings.') : (zh ? '没有找到所选的向量文件。可在高级设置中更换。' : 'The chosen vector file is missing. You can change it in Advanced settings.')) : (zh ? '向量文件无法使用，详情见高级设置。' : 'The vector file cannot be used; see Advanced settings.'))
    : '';

  const turnOn = () => onApply({ file: activeFile, ...core.CONTROL_VECTOR_PRESET });
  const apply = (patch: Partial<Record<Field, string>> & { mode?: core.ControlVectorMode }) => {
    const next = { ...current, ...patch };
    if (patch.direction?.startsWith('single:') && next.mode !== 'project') next.mode = 'project';
    if (patch.mode === 'add' && next.direction !== 'per-layer') next.direction = 'per-layer';
    const { mode: _mode, ...fields } = patch;
    if (patch.mode) setEdits({}); else setEdits(previous => ({ ...previous, ...fields }));
    if (!core.controlVectorError(next, maxLayer)) onApply(next);
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
  const copyPath = async () => { try { await navigator.clipboard.writeText(activeFile); setCopied(true); setTimeout(() => setCopied(false), 1200); } catch { /* clipboard unavailable */ } };
  const fieldsDisabled = disabled || !enabled || state.multiple;
  const flag = (name: string) => showParameterNames ? <code className="startup-control-vector-flag">{name}</code> : null;

  // Layer strip: one bar per vector layer; the highlighted run is the range the vector applies to.
  const layerCount = maxLayer ?? Math.max(Number(current.last) || 0, Number(core.CONTROL_VECTOR_PRESET.last));
  const first = current.first.trim() ? Number(current.first) : 1;
  const last = current.last.trim() ? Number(current.last) : layerCount;
  const engineRange = !current.first.trim() && !current.last.trim();
  const single = /^single:(\d+)$/.exec(current.direction);
  const singleLayer = single ? Number(single[1]) : null;
  const clampLayer = (value: number) => Math.max(1, Math.min(layerCount, Math.round(value)));
  const setRange = (a: number, b: number) => apply({ first: String(Math.min(a, b)), last: String(Math.max(a, b)) });
  const moveEnd = (end: 'first' | 'last', layer: number) => end === 'first' ? setRange(Math.min(layer, last), last) : setRange(first, Math.max(layer, first));
  /** Pointer on the strip moves the nearer end (and keeps dragging that end). */
  const pickBar = (layer: number): 'first' | 'last' => {
    const end = Math.abs(layer - first) <= Math.abs(layer - last) ? 'first' : 'last';
    moveEnd(end, layer);
    return end;
  };
  const layerAt = (event: { clientX: number; currentTarget: { getBoundingClientRect(): { left: number; width: number } } }) => {
    const box = event.currentTarget.getBoundingClientRect();
    return clampLayer(Math.floor((event.clientX - box.left) / Math.max(1, box.width) * layerCount) + 1);
  };
  const scaleNumber = Number(current.scale);

  const info = zh ? [
    `上游预设：强度 1.0 · 第 4–44 层 · project · per-layer`,
    `引擎默认（不写参数）：第 1 层到最后一层 · add · per-layer；层范围留空即引擎默认。`,
    `按请求：请求体加 "${core.CONTROL_VECTOR_REQUEST_FIELD}": false 可关闭单次请求（OpenAI 与 Anthropic 接口）；对话设置有同名开关；配置默认值是采样中的「默认实验投影」（sampling.${core.CONTROL_VECTOR_REQUEST_FIELD}）。切换会清空一次对话缓存；关闭时输出与原模型逐 token 一致。`,
    `随附向量：上游文档（data/experimental-speed-projection/README.md）称其为「拒答方向投影」：开启后模型拒绝的请求大幅减少（上游测试集 50 条中 1 条，关闭时 50 条），这会移除一项安全行为，生成内容由使用者负责。它不是提速优化：同样文本每 token 慢约 0.2–0.4%，并会轻微改变普通回答。`,
    `适用：原版 Qwen3.8-Flash-Next，不适用于 Swift 1.5；需要 Strata 引擎 ${core.CONTROL_VECTOR_MIN_ENGINE} 起，Mac 版引擎尚未支持。`,
  ] : [
    'Upstream preset: strength 1.0 · layers 4–44 · project · per-layer',
    'Engine defaults when a flag is absent: layer 1 to the last · add · per-layer; leave the range empty for the engine default.',
    `Per request: send "${core.CONTROL_VECTOR_REQUEST_FIELD}": false in a request body to turn it off for that request (OpenAI and Anthropic APIs); the chat settings have the same switch; the configuration default is "Default experimental speed projection" in Sampling (sampling.${core.CONTROL_VECTOR_REQUEST_FIELD}). Switching drops the conversation cache once; off, output is token-for-token the stock model's.`,
    'Bundled vector: upstream (data/experimental-speed-projection/README.md) describes it as a refusal-direction projection: the model declines far fewer requests (1 of 50 vs 50 of 50 on its test set). This removes a safety behaviour and you are responsible for what the model writes with it on. It is not a speed optimization: about 0.2–0.4% slower per token on the same text, and it shifts ordinary answers slightly.',
    `Applies to: the original Qwen3.8-Flash-Next, not Swift 1.5; needs Strata engine ${core.CONTROL_VECTOR_MIN_ENGINE}+, not yet on the Mac engine.`,
  ];

  const preset = core.CONTROL_VECTOR_PRESET;
  const customized = enabled && (!usingBundled || current.scale !== preset.scale || current.first !== preset.first || current.last !== preset.last || current.mode !== preset.mode || current.direction !== preset.direction);
  const description = usingBundled || !activeFile
    ? (zh ? '减少模型拒答，使用模型包自带的官方向量。保存并重启模型后生效。' : 'Fewer refusals, using the official vector that ships with the model pack. Applies after saving and restarting the model.')
    : (zh ? '减少模型拒答，使用你在高级设置中选择的向量文件。保存并重启模型后生效。' : 'Fewer refusals, using the vector file chosen in Advanced settings. Applies after saving and restarting the model.');

  const panel = (
    <div className="startup-control-vector-advanced" data-testid="control-vector-advanced" data-enabled={enabled ? 'true' : 'false'}>
      <div className="startup-control-vector-head">
        <span className="startup-control-vector-tech">{zh ? '技术名称：控制向量（Control Vector）' : 'Technical name: control vector'}</span>
        <span className="startup-control-vector-chip" data-tone={chip.tone} data-testid="control-vector-chip" data-tooltip={chip.tip}>{chip.tone === 'ok' && <Check size={12} aria-hidden/>}{chip.text}</span>
        {flag('--control-vector-scaled')}
      </div>
      {reason && (!enabled || !availability.available) && <p className="startup-control-vector-reason" role="status" data-testid="control-vector-reason">{reason}</p>}

      <div className="startup-control-vector-file">
        <code data-testid="control-vector-path" data-path={activeFile} data-tooltip={activeFile || undefined}>{activeFile ? shortPath(activeFile) : (zh ? '（未知：配置缺少 cwd）' : '(unknown: no cwd in the configuration)')}</code>
        {activeFile && <button type="button" className="startup-control-vector-icon" aria-label={zh ? '复制路径' : 'Copy path'} data-tooltip={copied ? (zh ? '已复制' : 'Copied') : (zh ? '复制路径' : 'Copy path')} onClick={() => void copyPath()}>{copied ? <Check size={14} aria-hidden/> : <Copy size={14} aria-hidden/>}</button>}
        {desktop && <button type="button" className="startup-control-vector-text" disabled={disabled || state.multiple} onClick={() => void chooseFile()}><FolderOpen size={14} aria-hidden/>{zh ? '改用其他文件' : 'Use another file'}</button>}
        {!usingBundled && bundled && <button type="button" className="startup-control-vector-text" disabled={disabled || state.multiple} onClick={useBundled}><Undo2 size={14} aria-hidden/>{zh ? '恢复随附向量' : 'Use the bundled vector'}</button>}
      </div>
      {pickError && <p className="startup-control-vector-error" role="alert">{pickError}</p>}
      {!enabled && <p className="startup-control-vector-hint">{zh ? '打开无审查模式后可调整下面的参数。' : 'Turn on Uncensored mode to change the settings below.'}</p>}

      <div className="startup-control-vector-grid">
        <div className="startup-control-vector-cell">
          <div className="startup-control-vector-label"><span>{zh ? '强度' : 'Strength'}</span>{flag('FILE:S')}<input className="startup-control-vector-num" inputMode="decimal" aria-label={zh ? '强度' : 'Strength'} disabled={fieldsDisabled} value={current.scale} onChange={event => apply({ scale: event.target.value })}/></div>
          <Slider ariaLabel={zh ? '强度滑块' : 'Strength slider'} min={SCALE_MIN} max={SCALE_MAX} step={SCALE_STEP} disabled={fieldsDisabled} value={Number.isFinite(scaleNumber) ? Math.max(SCALE_MIN, Math.min(SCALE_MAX, scaleNumber)) : 1} onValueChange={value => apply({ scale: core.formatScale(Math.round(value * 100) / 100) })}/>
          <div className="startup-control-vector-scale"><span>0</span><span>1.0</span><span>2.0</span></div>
        </div>

        <div className="startup-control-vector-cell startup-control-vector-layers-cell">
          <div className="startup-control-vector-label"><span>{zh ? '层范围' : 'Layers'}</span>{flag('--control-vector-layer-range')}
            <span className="startup-control-vector-range">
              <input className="startup-control-vector-num" inputMode="numeric" aria-label={zh ? '起始层' : 'First layer'} placeholder="1" disabled={fieldsDisabled} value={current.first} onChange={event => apply({ first: event.target.value })}/>
              <span aria-hidden>–</span>
              <input className="startup-control-vector-num" inputMode="numeric" aria-label={zh ? '结束层' : 'Last layer'} placeholder={String(layerCount)} disabled={fieldsDisabled} value={current.last} onChange={event => apply({ last: event.target.value })}/>
            </span>
          </div>
          <div className="startup-control-vector-strip" data-testid="control-vector-strip" data-engine-range={engineRange ? 'true' : 'false'} data-disabled={fieldsDisabled ? 'true' : 'false'} data-tooltip={engineRange ? (zh ? '全部层（引擎默认）' : 'All layers (engine default)') : (zh ? `第 ${first}–${last} 层，共 ${layerCount} 层` : `Layers ${first}–${last} of ${layerCount}`)}
            onPointerDown={event => { if (fieldsDisabled) return; const end = pickBar(layerAt(event)); dragging.current = end; event.currentTarget.setPointerCapture?.(event.pointerId); }}
            onPointerMove={event => { if (dragging.current) moveEnd(dragging.current, layerAt(event)); }}
            onPointerUp={() => { dragging.current = null; }} onPointerCancel={() => { dragging.current = null; }}>
            <div className="startup-control-vector-bars" aria-hidden>
              {Array.from({ length: layerCount }, (_, index) => index + 1).map(layer => <span key={layer} data-on={layer >= first && layer <= last ? 'true' : 'false'} data-single={layer === singleLayer ? 'true' : undefined}/>)}
            </div>
            <span className="startup-control-vector-handle" aria-hidden style={{ left: `${(clampLayer(first) - 0.5) / layerCount * 100}%` }}/>
            <span className="startup-control-vector-handle" aria-hidden style={{ left: `${(clampLayer(last) - 0.5) / layerCount * 100}%` }}/>
            <input type="range" className="startup-control-vector-sr" aria-label={zh ? '起始层滑块' : 'First layer slider'} min={1} max={layerCount} step={1} disabled={fieldsDisabled} value={clampLayer(first)} onChange={event => setRange(Math.min(Number(event.target.value), last), last)}/>
            <input type="range" className="startup-control-vector-sr" aria-label={zh ? '结束层滑块' : 'Last layer slider'} min={1} max={layerCount} step={1} disabled={fieldsDisabled} value={clampLayer(last)} onChange={event => setRange(first, Math.max(Number(event.target.value), first))}/>
          </div>
          <div className="startup-control-vector-scale"><span>1</span><span>{maxLayer ?? '…'}</span></div>
        </div>

        <div className="startup-control-vector-cell">
          <div className="startup-control-vector-label"><span>{zh ? '模式' : 'Mode'}</span>{flag('--cvec-mode')}</div>
          <div data-tooltip={zh ? 'project：从隐藏状态中移除该方向（上游预设）\nadd：叠加该方向（引擎默认）' : 'project: removes the direction from hidden states (upstream preset)\nadd: adds the direction (engine default)'}>
            <Segmented ariaLabel={zh ? '控制向量模式' : 'Control vector mode'} value={current.mode} onValueChange={mode => apply({ mode: mode as core.ControlVectorMode })} options={[{ value: 'project', label: 'project', icon: <Minus size={13} aria-hidden/>, disabled: fieldsDisabled }, { value: 'add', label: 'add', icon: <Plus size={13} aria-hidden/>, disabled: fieldsDisabled }]}/>
          </div>
        </div>

        <div className="startup-control-vector-cell">
          <div className="startup-control-vector-label"><span>{zh ? '方向' : 'Direction'}</span>{flag('--cvec-dir')}</div>
          <div className="startup-control-vector-direction">
            <div data-tooltip={zh ? 'per-layer：每层用各自的方向\nsingle:L：所有层都用第 L 层的方向（仅 project）' : 'per-layer: each layer uses its own direction\nsingle:L: every layer uses layer L\'s direction (project only)'}>
              <Segmented ariaLabel={zh ? '控制向量方向' : 'Control vector direction'} value={single ? 'single' : 'per-layer'} onValueChange={value => apply({ direction: value === 'single' ? `single:${singleLayer ?? 20}` : 'per-layer' })} options={[{ value: 'per-layer', label: 'per-layer', icon: <Layers size={13} aria-hidden/>, disabled: fieldsDisabled }, { value: 'single', label: 'single', icon: <Crosshair size={13} aria-hidden/>, disabled: fieldsDisabled || current.mode !== 'project' }]}/>
            </div>
            {single && <input className="startup-control-vector-num" inputMode="numeric" aria-label={zh ? '方向层 L' : 'Direction layer L'} disabled={fieldsDisabled} value={single[1]} onChange={event => apply({ direction: `single:${event.target.value}` })}/>}
          </div>
        </div>
      </div>
      {fieldError && <p className="startup-control-vector-error" role="alert">{fieldError}</p>}
      {enabled && <div className="startup-control-vector-actions"><button type="button" className="startup-control-vector-text" disabled={disabled || state.multiple} onClick={() => { setEdits({}); onApply({ ...current, ...core.CONTROL_VECTOR_PRESET }); }}><RotateCcw size={13} aria-hidden/>{zh ? '恢复上游预设' : 'Restore upstream preset'}</button></div>}

      <ul className="startup-control-vector-notes" data-testid="control-vector-notes">{info.map(line => <li key={line}>{line}</li>)}</ul>
      <p className="startup-control-vector-foot">{zh ? <>单次请求可关：<code>"{core.CONTROL_VECTOR_REQUEST_FIELD}": false</code> · 保存并重启模型后生效</> : <>Off per request: <code>"{core.CONTROL_VECTOR_REQUEST_FIELD}": false</code> · applies after saving and restarting the model</>}</p>
    </div>
  );

  return (
    <section className="startup-control-vector" data-testid="startup-control-vector" data-enabled={enabled ? 'true' : 'false'} aria-label={zh ? '无审查模式' : 'Uncensored mode'}>
      <div className="startup-control-vector-main">
        <span className="startup-control-vector-switch"><Toggle ariaLabel={zh ? '启用无审查模式' : 'Enable Uncensored mode'} checked={enabled} disabled={disabled || switchBlocked} tooltip={switchBlocked ? reason : undefined} onCheckedChange={on => { setPickError(''); if (on) turnOn(); else onApply(null); }}/></span>
        <div className="startup-control-vector-copy">
          <div className="startup-control-vector-title"><strong>{zh ? '无审查模式' : 'Uncensored mode'}</strong><span className="startup-control-vector-chip" data-tone={status.tone} data-testid="control-vector-status" data-tooltip={status.tip || undefined}>{status.tone === 'ok' && <Check size={12} aria-hidden/>}{status.text}</span></div>
          <p className="startup-control-vector-desc">{description}</p>
          {plainReason && (!enabled || !availability.available) && <p className="startup-control-vector-reason" role="status" data-testid="control-vector-plain-reason" data-tooltip={reason}>{plainReason}</p>}
          {state.multiple && <p className="startup-control-vector-reason" role="status">{zh ? '当前配置加载了多个控制向量，请在下方完整参数列表中编辑；这里的开关只能整体关闭。' : 'This configuration loads several control vectors; edit them in the full argument list below. The switch here can only turn them all off.'}</p>}
          {enabled && <p className="startup-control-vector-note" data-testid="control-vector-note">{zh ? '模型会回答更多原本拒绝的问题，请自行把关内容。' : 'The model will answer more questions it would have declined; review what it writes.'}</p>}
        </div>
        <div className="startup-control-vector-side">
          {customized && <span className="startup-control-vector-customized" data-testid="control-vector-customized">{zh ? '已自定义' : 'Customized'}</span>}
          <button type="button" className="startup-control-vector-advanced-button" data-testid="control-vector-open-advanced" onClick={() => setAdvanced('open')}><SlidersHorizontal size={14} aria-hidden/>{zh ? '高级设置' : 'Advanced settings'}</button>
        </div>
      </div>
      {advanced === 'open' && <OfficialDialog wide title={zh ? '无审查模式 · 高级设置' : 'Uncensored mode · Advanced settings'} onClose={() => setAdvanced('closed')}>{panel}</OfficialDialog>}
    </section>
  );
}
