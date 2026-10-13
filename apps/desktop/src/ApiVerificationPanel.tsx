import { useEffect, useRef, useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import * as core from '@strata-manager/core';
import type { ApiVerificationKind, ApiVerificationReport, ApiVerificationStep, ServiceProfile } from '@strata-manager/core';
import { Segmented } from './OfficialControls';
import './service-access.css';

const explanations: Record<string, [string, string]> = {
  VERIFICATION_NOT_READY: ['模型未就绪，未发送推理。请手动启动或加载后重试。', 'The model is not ready; no inference was sent. Start or load it manually first.'],
  VERIFICATION_IDENTITY: ['地址没有返回已确认的 Strata 服务。', 'The endpoint did not identify a healthy Strata service.'],
  VERIFICATION_MODEL_MISSING: ['模型列表中找不到当前模型 ID。', 'The selected model ID is missing from the model list.'],
  VERIFICATION_MODEL_CHANGED: ['验证期间模型已改变，请重新选择并重试。', 'The model changed during verification; select it again and retry.'],
  VERIFICATION_IDENTITY_CHANGED: ['服务、引擎或加载状态已改变，未发送推理。请重新核验。', 'The service, engine or load state changed; no inference was sent. Check again.'],
  VERIFICATION_CAPABILITY_UNAVAILABLE: ['服务明确报告当前测试能力不可用，未发送推理。', 'The service reported that this capability is unavailable; no inference was sent.'],
  VERIFICATION_VISION_UNAVAILABLE: ['健康状态未确认图片能力，未发送图片推理。', 'Health metadata did not confirm image support; no image inference was sent.'],
  VERIFICATION_AUTH: ['鉴权失败，请检查应用访问服务的客户端密钥。', 'Authentication failed. Check the app’s client access key.'],
  VERIFICATION_NOT_FOUND: ['接口或模型未找到，请检查地址与运行时版本。', 'The endpoint or model was not found. Check the address and runtime version.'],
  VERIFICATION_TIMEOUT: ['验证超过 60 秒，已请求取消。', 'Verification exceeded 60 seconds; cancellation was requested.'],
  VERIFICATION_TOOL_STRUCTURE: ['未返回完整的预期 tool_call 结构；未执行任何工具。', 'The expected complete tool_call was not returned. No tool was executed.'],
  VERIFICATION_UNEXPECTED_MCP: ['服务返回了不应出现的 MCP 执行事件，验证未通过。', 'The server returned unexpected MCP execution events; verification failed.'],
  VERIFICATION_RESPONSE: ['接口返回成功，但测试回答未匹配预期。', 'The request completed, but the test answer did not match.'],
  VERIFICATION_TRUNCATED: ['回答达到测试输出上限，无法确认结果。', 'The response reached the test output limit; the result is unverified.'],
  VERIFICATION_TRANSPORT: ['请求失败，请检查服务状态或诊断；原始响应未存入结果。', 'The request failed. Check status or diagnostics; raw responses are excluded from results.'],
  CANCELLED: ['验证已取消。', 'Verification cancelled.'],
};

export function ApiVerificationPanel({ profile, model, ready, language, identityToken }: { profile: ServiceProfile; model?: string; ready: boolean; language: 'zh-CN' | 'en'; identityToken?: string }) {
  const zh = language === 'zh-CN';
  const [kind, setKind] = useState<ApiVerificationKind>('text');
  const [steps, setSteps] = useState<ApiVerificationStep[]>([]), [report, setReport] = useState<ApiVerificationReport>();
  const [busy, setBusy] = useState(false);
  const [invalidated, setInvalidated] = useState(false);
  const current = useRef<AbortController | undefined>(undefined), generation = useRef(0);
  useEffect(() => {
    generation.current++; current.current?.abort(); current.current = undefined;
    setSteps([]); setReport(undefined); setBusy(false); setInvalidated(false);
    return () => { generation.current++; current.current?.abort(); };
  }, [profile.id, profile.baseUrl, model, ready, identityToken]);
  const identity = useQuery({ queryKey: ['api-verification-result-identity', profile.id, profile.baseUrl, report?.startedAt], enabled: ready && report?.state === 'passed',
    queryFn: () => core.readServiceCapabilityIdentity(profile), retry: false, refetchInterval: 5000, refetchOnWindowFocus: true });
  const changed = report?.state === 'passed' && (identity.isError || !!identity.data && !core.sameServiceCapabilityIdentity(report.identity, identity.data));
  useEffect(() => { if (changed) setInvalidated(true); }, [changed]);
  const start = async () => {
    if (current.current || !ready) return;
    const controller = new AbortController(), run = ++generation.current;
    current.current = controller; setBusy(true); setReport(undefined); setSteps([]); setInvalidated(false);
    const result = await core.verifyApi(profile, { kind, model, ready }, step => {
      if (generation.current === run) setSteps(previous => [...previous.filter(item => item.stage !== step.stage), step]);
    }, controller.signal);
    if (generation.current !== run) return;
    current.current = undefined; setBusy(false); setReport(result); setSteps(result.steps);
  };
  const phase = (step: ApiVerificationStep) => step.stage === 'health' ? (zh ? '服务身份与就绪' : 'Identity and readiness') : step.stage === 'models' ? (zh ? '模型发现' : 'Model discovery') : step.stage === 'capabilities' ? (zh ? '读取当前能力证据' : 'Read current capability evidence') : (zh ? '一次推理' : 'One inference');
  const state = (step: ApiVerificationStep) => step.state === 'passed' ? (zh ? '通过' : 'Passed') : step.state === 'running' ? (zh ? '进行中' : 'Running') : step.state === 'cancelled' ? (zh ? '已取消' : 'Cancelled') : (zh ? '未通过' : 'Failed');
  return <section className="api-verification-panel" aria-label={zh ? 'API 在线验证' : 'API verification'}>
    <h3>{zh ? 'API 在线验证' : 'Verify the API'}</h3>
    <p className="subtle">{zh ? '点击后检查服务身份、模型列表，再发送一次最多 256 token 的测试，整体限时 60 秒。工具测试只检查结构，不执行 MCP；图片测试使用内置红色小图。结果不保存正文或密钥。' : 'Checks identity and models, then sends one test capped at 256 tokens and 60 seconds total. Tool checks never execute MCP; image checks use a built-in red image. Results exclude bodies and keys.'}</p>
    <Segmented ariaLabel={zh ? '验证类型' : 'Verification type'} value={kind} onValueChange={value => { if (!busy) { setKind(value as ApiVerificationKind); setReport(undefined); setSteps([]); } }} options={[{ value: 'text', label: zh ? '文本' : 'Text', disabled: busy }, { value: 'tools', label: zh ? '工具结构' : 'Tool structure', disabled: busy }, { value: 'vision', label: zh ? '图片' : 'Image', disabled: busy }]}/>
    {!ready && <p className="notice" role="status">{zh ? '模型未就绪，在线验证不可用。此入口不会启动服务或加载模型。' : 'The model is not ready. Verification never starts a service or loads a model.'}</p>}
    <div className="actions"><button type="button" className="primary" disabled={busy || !ready} onClick={() => void start()}>{busy ? (zh ? '验证中…' : 'Verifying…') : (zh ? '开始验证' : 'Start verification')}</button>{busy && <button type="button" onClick={() => current.current?.abort()}>{zh ? '取消验证' : 'Cancel'}</button>}</div>
    <div aria-live="polite">{steps.map(step => <p key={step.stage}><strong>{phase(step)}</strong> · {state(step)}{step.state !== 'running' && ` · ${(step.elapsedMs / 1000).toFixed(1)} s`}{step.httpStatus && ` · HTTP ${step.httpStatus}`}{step.code && <span className="api-verification-reason">{explanations[step.code]?.[zh ? 0 : 1] ?? (zh ? '验证未完成。' : 'Verification incomplete.')}</span>}</p>)}</div>
    {report?.capabilities && !invalidated && !changed && <p className="subtle" role="status">{zh ? '测试前的能力元数据：' : 'Capability metadata before the test: '}{report.capabilities.filter(item => item.id === 'chat' || item.id === (kind === 'tools' ? 'tools' : kind === 'vision' ? 'images' : 'chat')).map(item => `${item.id === 'chat' ? (zh ? '文本接口' : 'Chat API') : kind === 'tools' ? (zh ? '工具调用' : 'Tool calling') : (zh ? '图片输入' : 'Image input')} · ${item.state === 'available' ? (zh ? '可用' : 'Available') : item.state === 'unavailable' ? (zh ? '不支持' : 'Unsupported') : item.state === 'restartRequired' ? (zh ? '需重启' : 'Restart required') : (zh ? '未核验' : 'Unverified')}`).join('；')}{report.capabilities.some(item => (item.id === 'chat' || item.id === (kind === 'tools' ? 'tools' : kind === 'vision' ? 'images' : 'chat')) && item.state === 'unknown') && (zh ? '。未知项不代表不支持；结果仅证明本次测试。' : '. Unknown does not mean unsupported; results apply only to this test.')}</p>}
    {(invalidated || changed) && <p className="notice" role="status">{zh ? '服务或引擎身份已改变，本次验证结果已失效。请重新验证。' : 'The service or engine identity changed. This result is no longer current; verify again.'}</p>}
    {report?.state === 'passed' && !invalidated && !changed && <p className="notice" role="status">{zh ? '本次验证通过。结果仅代表本次模型与运行时的一次测试，客户端完整流程仍需实际使用验证。' : 'This test passed for the tested model and runtime. Verify the complete workflow in your client application.'}</p>}
  </section>;
}
