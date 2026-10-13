import type { AppLanguage } from "@strata-manager/core";
import type { CommonChatDefaults } from '@strata-manager/core';
import { Field, Panel } from './components';
import { Dropdown, NumberField, Toggle } from './OfficialControls';
import './common-chat-settings-panel.css';

export interface CommonChatSettingsPanelProps {
  value: CommonChatDefaults;
  onChange: (value: CommonChatDefaults) => void;
  language: AppLanguage;
  disabled?: boolean;
  profileName?: string;
  inheritsCommon: boolean;
  onInheritanceChange?: (inherits: boolean) => void;
}

type NumericSetting = 'temperature' | 'topP' | 'topK' | 'maxTokens' | 'seed';

/** App chat defaults remain editable without an active model or a running service. */
export function CommonChatSettingsPanel({ value, onChange, language, disabled = false, profileName, inheritsCommon, onInheritanceChange }: CommonChatSettingsPanelProps) {
  const zh = language === 'zh-CN';
  const text = (cn: string, en: string) => zh ? cn : en;
  const update = <K extends keyof CommonChatDefaults>(key: K, next: CommonChatDefaults[K]) => {
    if (!disabled) onChange({ ...value, [key]: next });
  };
  const setNumber = (key: NumericSetting, input: string) => {
    if (disabled) return;
    if (input === '') {
      if (key === 'maxTokens') update('maxTokens', 0);
      if (key === 'seed') update('seed', null);
      return;
    }
    const next = Number(input);
    if (!Number.isFinite(next) || next < 0 || next > Number.MAX_SAFE_INTEGER) return;
    if (key === 'temperature' && next > 2) return;
    if ((key === 'topK' || key === 'maxTokens' || key === 'seed') && !Number.isInteger(next)) return;
    if (key === 'topP' && (next <= 0 || next > 1)) return;
    if (key === 'topK' && (next < 1 || next > 64)) return;
    if (key === 'seed' && next < 1) return;
    onChange({ ...value, [key]: next });
  };

  return <Panel title={text('公共聊天默认值', 'Common chat defaults')} className="common-chat-settings-panel">
    <p className="common-chat-settings-intro">{text('用于本应用的聊天。新模型默认继承；更改会在继承这些默认值的模型下一次请求时生效，正在生成的回答保持原参数。', 'Used for chat in this app. New models inherit these defaults. Changes apply to the next request for models that inherit them; a response in progress keeps its original settings.')}</p>
    <div className="common-chat-inheritance">
      <div><strong>{text('当前模型使用公共聊天默认值', 'Current model uses common chat defaults')}</strong><small>{profileName ? <><span className="common-chat-profile-name">{profileName}</span>{inheritsCommon ? text(' · 下一次请求使用下方默认值。', ' · The next request uses the defaults below.') : text(' · 保留此模型的专用聊天参数，公共值更改不会覆盖它。', ' · This model keeps its own chat settings; common changes will not overwrite them.')}</> : text('当前没有选择模型；仍可编辑公共默认值。', 'No model is selected. Common defaults can still be edited.')}</small></div>
      <Toggle ariaLabel={text('当前模型使用公共聊天默认值', 'Current model uses common chat defaults')} checked={!!profileName && inheritsCommon} disabled={disabled || !profileName || !onInheritanceChange} onCheckedChange={next => onInheritanceChange?.(next)}/>
    </div>
    <div className="common-chat-settings-grid">
      <Field label={text('推理强度', 'Reasoning effort')} hint={text('关闭、简短、适中或充分思考。', 'Disable reasoning, or use low, medium or high effort.')}>
        <Dropdown ariaLabel={text('公共默认推理强度', 'Common default reasoning effort')} value={value.reasoningEffort} disabled={disabled} onValueChange={next => update('reasoningEffort', next as CommonChatDefaults['reasoningEffort'])} options={[{ value: 'off', label: text('关闭', 'Off') }, { value: 'low', label: text('简短', 'Low') }, { value: 'medium', label: text('适中', 'Medium') }, { value: 'high', label: text('充分', 'High') }]}/>
      </Field>
      <Field label={text('温度', 'Temperature')} hint={text('0–2；0 为贪心，较高的值让回答更多样。', '0–2. 0 uses greedy decoding; higher values give more varied answers.')}>
        <NumberField aria-label={text('公共默认温度', 'Common default temperature')} min={0} max={2} step={0.05} value={value.temperature} disabled={disabled} onChange={event => setNumber('temperature', event.currentTarget.value)}/>
      </Field>
      <Field label="Top P" hint={text('大于 0 且不超过 1；温度为 0 时不参与采样。', 'Greater than 0 and at most 1. Inactive when temperature is 0.')}>
        <NumberField aria-label={text('公共默认 Top P', 'Common default Top P')} min={0.01} max={1} step={0.01} value={value.topP} disabled={disabled || value.temperature === 0} onChange={event => setNumber('topP', event.currentTarget.value)}/>
      </Field>
      <Field label="Top K" hint={text('1–64；温度为 0 时不参与采样。', '1–64. Inactive when temperature is 0.')}>
        <NumberField aria-label={text('公共默认 Top K', 'Common default Top K')} min={1} max={64} step={1} value={value.topK ?? 20} disabled={disabled || value.temperature === 0} onChange={event => setNumber('topK', event.currentTarget.value)}/>
      </Field>
      <Field label={text('最大输出 token', 'Maximum output tokens')} hint={text('0 或留空表示不限，直到回答完成。', '0 or blank means no limit, until the response completes.')}>
        <NumberField aria-label={text('公共默认最大输出 token', 'Common default maximum output tokens')} min={0} step={1} placeholder={text('不限', 'Unlimited')} value={value.maxTokens || ''} disabled={disabled} onChange={event => setNumber('maxTokens', event.currentTarget.value)}/>
      </Field>
      <Field label={text('随机种子', 'Random seed')} hint={text('正整数；留空使用随机种子。', 'A positive integer. Leave blank for a random seed.')}>
        <NumberField aria-label={text('公共默认随机种子', 'Common default random seed')} min={1} step={1} placeholder={text('随机', 'Random')} value={value.seed ?? ''} disabled={disabled} onChange={event => setNumber('seed', event.currentTarget.value)}/>
      </Field>
    </div>
    <Field label={text('系统提示词', 'System prompt')} hint={text('为空时不添加系统提示词。', 'An empty value adds no system prompt.')}>
      <textarea aria-label={text('公共默认系统提示词', 'Common default system prompt')} rows={4} value={value.systemPrompt} disabled={disabled} placeholder={text('为继承模型设置默认角色或回答要求', 'Set a default role or response requirements for inheriting models')} onChange={event => update('systemPrompt', event.currentTarget.value)}/>
    </Field>
    <div className="common-chat-mcp-default">
      <div><strong>{text('在聊天中使用 MCP 工具', 'Use MCP tools in chat')}</strong><small>{text('允许请求使用当前服务配置的工具，实际可用性由模型服务决定。', 'Allow requests to use tools configured on the selected service. Availability depends on that service.')}</small></div>
      <Toggle ariaLabel={text('公共默认启用 MCP 工具', 'Common default enable MCP tools')} checked={value.mcp} disabled={disabled} onCheckedChange={next => update('mcp', next)}/>
    </div>
  </Panel>;
}
