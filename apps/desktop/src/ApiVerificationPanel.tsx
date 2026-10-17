import type { AppLanguage } from "@strata-manager/core";
import { useEffect, useRef, useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import { Check, CircleHelp, CircleSlash, LoaderCircle, Minus, X } from 'lucide-react';
import * as core from '@strata-manager/core';
import type { ApiVerificationKind, ApiVerificationReport, ApiVerificationStage, ApiVerificationStep, ServiceProfile } from '@strata-manager/core';
import { Segmented } from './OfficialControls';
import './service-access.css';

const explanations: Record<string, [string, string]> = {
  VERIFICATION_NOT_READY: ['模型未就绪，未发送推理。请先启动或加载模型。', 'The model is not ready; no inference was sent. Start or load it first.'],
  VERIFICATION_IDENTITY: ['该地址没有返回正常的 Strata 服务。', 'The endpoint did not identify a healthy Strata service.'],
  VERIFICATION_MODEL_MISSING: ['模型列表里没有当前模型 ID。', 'The selected model ID is missing from the model list.'],
  VERIFICATION_MODEL_CHANGED: ['验证期间模型变了，请重新选择后再试。', 'The model changed during verification; select it again and retry.'],
  VERIFICATION_IDENTITY_CHANGED: ['服务、引擎或加载状态变了，未发送推理。请重新验证。', 'The service, engine or load state changed; no inference was sent. Verify again.'],
  VERIFICATION_CAPABILITY_UNAVAILABLE: ['服务报告此能力不可用，未发送推理。', 'The service reported that this capability is unavailable; no inference was sent.'],
  VERIFICATION_VISION_UNAVAILABLE: ['服务未确认支持图片，未发送图片推理。', 'The service did not confirm image support; no image inference was sent.'],
  VERIFICATION_AUTH: ['鉴权失败，请检查客户端密钥。', 'Authentication failed. Check the client access key.'],
  VERIFICATION_NOT_FOUND: ['接口或模型不存在，请检查地址和运行时版本。', 'The endpoint or model was not found. Check the address and runtime version.'],
  VERIFICATION_TIMEOUT: ['超过 60 秒，已取消。', 'Exceeded 60 seconds; cancellation was requested.'],
  VERIFICATION_TOOL_STRUCTURE: ['没有返回完整的 tool_call 结构。未执行任何工具。', 'No complete tool_call was returned. No tool was executed.'],
  VERIFICATION_UNEXPECTED_MCP: ['服务返回了不应出现的 MCP 执行事件。', 'The server returned unexpected MCP execution events.'],
  VERIFICATION_RESPONSE: ['请求成功，但回答与预期不符。', 'The request completed, but the answer did not match.'],
  VERIFICATION_TRUNCATED: ['回答达到输出上限，无法确认结果。', 'The response hit the output limit; the result is unverified.'],
  VERIFICATION_TRANSPORT: ['请求失败，请查看服务状态或诊断。结果不含原始响应。', 'The request failed. Check status or diagnostics; raw responses are not kept.'],
  CANCELLED: ['已取消。', 'Cancelled.'],
};

const stages: ApiVerificationStage[] = ['health', 'models', 'capabilities', 'inference'];
type RowState = ApiVerificationStep['state'] | 'pending' | 'skipped';
const seconds = (ms: number) => `${(ms / 1000).toFixed(1)} s`;

export function ApiVerificationPanel({ profile, model, ready, language, identityToken }: { profile: ServiceProfile; model?: string; ready: boolean; language: AppLanguage; identityToken?: string }) {
  const zh = language === 'zh-CN';
  const [kind, setKind] = useState<ApiVerificationKind>('text');
  const [steps, setSteps] = useState<ApiVerificationStep[]>([]), [report, setReport] = useState<ApiVerificationReport>();
  const [busy, setBusy] = useState(false);
  const [invalidated, setInvalidated] = useState(false);
  const [now, setNow] = useState(() => performance.now());
  const current = useRef<AbortController | undefined>(undefined), generation = useRef(0), runningAt = useRef(new Map<ApiVerificationStage, number>());
  useEffect(() => {
    generation.current++; current.current?.abort(); current.current = undefined;
    setSteps([]); setReport(undefined); setBusy(false); setInvalidated(false);
    return () => { generation.current++; current.current?.abort(); };
  }, [profile.id, profile.baseUrl, model, ready, identityToken]);
  // Live per-step timer while a check is running; display only.
  useEffect(() => {
    if (!busy) return;
    const timer = window.setInterval(() => setNow(performance.now()), 100);
    return () => window.clearInterval(timer);
  }, [busy]);
  const identity = useQuery({ queryKey: ['api-verification-result-identity', profile.id, profile.baseUrl, report?.startedAt], enabled: ready && report?.state === 'passed',
    queryFn: () => core.readServiceCapabilityIdentity(profile), retry: false, refetchInterval: 5000, refetchOnWindowFocus: true });
  const changed = report?.state === 'passed' && (identity.isError || !!identity.data && !core.sameServiceCapabilityIdentity(report.identity, identity.data));
  useEffect(() => { if (changed) setInvalidated(true); }, [changed]);
  const reset = () => { setReport(undefined); setSteps([]); runningAt.current.clear(); };
  const start = async () => {
    if (current.current || !ready) return;
    const controller = new AbortController(), run = ++generation.current;
    current.current = controller; setBusy(true); reset(); setInvalidated(false);
    const result = await core.verifyApi(profile, { kind, model, ready }, step => {
      if (generation.current !== run) return;
      if (step.state === 'running') runningAt.current.set(step.stage, performance.now());
      setSteps(previous => [...previous.filter(item => item.stage !== step.stage), step]);
    }, controller.signal);
    if (generation.current !== run) return;
    current.current = undefined; setBusy(false); setReport(result); setSteps(result.steps);
  };
  const label = (stage: ApiVerificationStage) => stage === 'health' ? (zh ? '服务身份与就绪' : 'Service identity') : stage === 'models' ? (zh ? '模型列表' : 'Model list') : stage === 'capabilities' ? (zh ? '能力信息' : 'Capabilities') : kind === 'tools' ? (zh ? '测试请求 · 工具调用' : 'Test request · tool call') : kind === 'vision' ? (zh ? '测试请求 · 图片' : 'Test request · image') : (zh ? '测试请求 · 文本' : 'Test request · text');
  const stateText: Record<RowState, string> = { pending: zh ? '等待' : 'Pending', running: zh ? '进行中' : 'Running', passed: zh ? '通过' : 'Passed', failed: zh ? '未通过' : 'Failed', cancelled: zh ? '已取消' : 'Cancelled', skipped: zh ? '已跳过' : 'Skipped' };
  const finished = !!report && !busy;
  const rows = stages.map(stage => {
    const step = steps.find(item => item.stage === stage);
    const state: RowState = step?.state ?? (finished ? 'skipped' : 'pending');
    return { stage, step, state };
  });
  const icon = (state: RowState) => state === 'running' ? <LoaderCircle size={14} className="spin"/> : state === 'passed' ? <Check size={14} strokeWidth={2.5}/> : state === 'failed' ? <X size={14} strokeWidth={2.5}/> : state === 'cancelled' ? <CircleSlash size={13}/> : state === 'skipped' ? <Minus size={14}/> : <span className="api-verification-dot"/>;
  const featureId = kind === 'tools' ? 'tools' : kind === 'vision' ? 'images' : 'chat';
  const capabilities = report?.capabilities?.filter(item => item.id === 'chat' || item.id === featureId) ?? [];
  const capabilityName = (id: string) => id === 'chat' ? (zh ? '文本接口' : 'Chat API') : kind === 'tools' ? (zh ? '工具调用' : 'Tool calling') : (zh ? '图片输入' : 'Image input');
  const capabilityState = (state: string) => state === 'available' ? (zh ? '可用' : 'Available') : state === 'unavailable' ? (zh ? '不支持' : 'Unsupported') : state === 'restartRequired' ? (zh ? '需重启' : 'Restart required') : (zh ? '未核验' : 'Unverified');
  const stale = invalidated || changed;
  const details = zh
    ? ['· 依次检查服务身份、模型列表和能力信息', '· 再发一次测试请求：最多 256 token，整体限时 60 秒', '· 工具测试只检查返回结构，不执行 MCP', '· 图片测试使用内置的红色小图', '· 不保存正文和密钥；不会启动服务或加载模型'].join('\n')
    : ['· Checks service identity, the model list and capabilities', '· Then sends one test request: up to 256 tokens, 60 seconds total', '· Tool checks only inspect the structure and never run MCP', '· Image checks use a built-in small red image', '· Results exclude bodies and keys; never starts a service or loads a model'].join('\n');
  return <section className="api-verification-panel" aria-label={zh ? 'API 在线验证' : 'API verification'} data-state={busy ? 'running' : report?.state ?? 'idle'}>
    <header className="api-verification-head">
      <div><h3>{zh ? '在线验证' : 'Verify the API'}</h3><p>{zh ? '向当前服务发一次限时、限量的测试请求。' : 'Sends one small, time-limited test request to this service.'}</p></div>
      <button type="button" className="st-btn st-btn--icon api-verification-help" data-tooltip={details} aria-label={zh ? '验证说明' : 'About verification'} aria-description={details}><CircleHelp size={15}/></button>
    </header>
    <div className="api-verification-controls">
      <Segmented ariaLabel={zh ? '验证类型' : 'Verification type'} value={kind} onValueChange={value => { if (!busy) { setKind(value as ApiVerificationKind); reset(); } }} options={[{ value: 'text', label: zh ? '文本' : 'Text', disabled: busy }, { value: 'tools', label: zh ? '工具结构' : 'Tool structure', disabled: busy }, { value: 'vision', label: zh ? '图片' : 'Image', disabled: busy }]}/>
      <div className="actions">{busy && <button type="button" onClick={() => current.current?.abort()}>{zh ? '取消验证' : 'Cancel'}</button>}<button type="button" className="primary" disabled={busy || !ready} onClick={() => void start()}>{busy ? (zh ? '验证中…' : 'Verifying…') : (zh ? '开始验证' : 'Start verification')}</button></div>
    </div>
    {!ready && <p className="notice" role="status">{zh ? '模型未就绪，暂不能验证。这里不会启动服务或加载模型。' : 'The model is not ready. Verification never starts a service or loads a model.'}</p>}
    <ol className="api-verification-steps" aria-live="polite" data-idle={!busy && !report ? 'true' : undefined}>
      {rows.map(({ stage, step, state }) => {
        const started = runningAt.current.get(stage);
        const time = state === 'running' ? (started ? seconds(Math.max(0, now - started)) : '') : step && state !== 'skipped' ? seconds(step.elapsedMs) : '';
        const reason = step?.code ? explanations[step.code]?.[zh ? 0 : 1] ?? (zh ? '验证未完成。' : 'Verification incomplete.') : '';
        return <li key={stage} className="api-verification-step" data-state={state}>
          <span className="api-verification-icon" aria-hidden="true">{icon(state)}</span>
          <span className="api-verification-label">{label(stage)}<span className="sr-only">{` · ${stateText[state]}`}</span></span>
          <span className="api-verification-time">{step?.httpStatus ? `HTTP ${step.httpStatus} · ` : ''}{state === 'skipped' || state === 'cancelled' ? stateText[state] : time}</span>
          {reason && state !== 'passed' && <p className="api-verification-reason">{reason}</p>}
        </li>;
      })}
    </ol>
    {report && !busy && !stale && <div className="api-verification-result" data-state={report.state} role="status">
      <span className="api-verification-result-icon" aria-hidden="true">{report.state === 'passed' ? <Check size={14} strokeWidth={2.5}/> : report.state === 'failed' ? <X size={14} strokeWidth={2.5}/> : <CircleSlash size={13}/>}</span>
      <strong>{report.state === 'passed' ? (zh ? '本次验证通过' : 'This test passed') : report.state === 'failed' ? (zh ? '验证未通过' : 'Verification failed') : (zh ? '验证已取消' : 'Verification cancelled')}</strong>
      <span className="api-verification-total">{seconds(report.elapsedMs)}</span>
      {report.state === 'passed' && <small>{zh ? '仅代表这次测试，客户端完整流程请实际试用。' : 'Covers this test only; try the full workflow in your client.'}</small>}
    </div>}
    {capabilities.length > 0 && !stale && <div className="api-verification-capabilities" role="status">
      <span>{zh ? '测试前能力' : 'Capabilities before test'}</span>
      {capabilities.map(item => <span key={item.id} className="api-verification-chip" data-state={item.state}>{capabilityName(item.id)} · {capabilityState(item.state)}</span>)}
      {capabilities.some(item => item.state === 'unknown') && <small>{zh ? '未核验不代表不支持。' : 'Unverified does not mean unsupported.'}</small>}
    </div>}
    {stale && <p className="notice" role="status">{zh ? '服务或引擎已变化，本次结果已失效，请重新验证。' : 'The service or engine changed. This result is no longer current; verify again.'}</p>}
  </section>;
}
