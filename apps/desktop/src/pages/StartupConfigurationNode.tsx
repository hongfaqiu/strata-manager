import { useEffect, useRef, useState } from 'react';
import { Plus, Trash2 } from 'lucide-react';
import type { JsonObject } from '@strata-manager/core';
import { Dropdown } from '../OfficialControls';

const types = ['string', 'number', 'boolean', 'object', 'array', 'null'] as const;
type ValueType = typeof types[number];
const valueType = (value: unknown): ValueType => value === null ? 'null' : Array.isArray(value) ? 'array' : typeof value === 'object' ? 'object' : typeof value === 'number' ? 'number' : typeof value === 'boolean' ? 'boolean' : 'string';
const emptyValue = (type: ValueType): unknown => ({ string: '', number: 0, boolean: false, object: {}, array: [], null: null })[type];

function NumericValue({ value, disabled, label, onChange, onIssue }: { value: number; disabled: boolean; label: string; onChange: (value: number) => void; onIssue: (message: string) => void }) {
  const [text, setText] = useState(String(value));
  useEffect(() => setText(String(value)), [value]);
  return <input className="st-input" inputMode="decimal" aria-label={label} disabled={disabled} value={text} onChange={event => {
    const next = event.target.value; setText(next);
    if (!next.trim() || !Number.isFinite(Number(next))) { onIssue(`${label}: number / 数值`); return; }
    onIssue(''); onChange(Number(next));
  }}/>;
}

/** All JSON fields keep their native types; type changes are explicit user actions. */
export function ConfigurationNode({ value, path, disabled, zh, onChange, onIssue }: { value: unknown; path: string[]; disabled: boolean; zh: boolean; onChange: (value: unknown) => void; onIssue: (path: string, message: string, removedIndex?: number) => void }) {
  const [newKey, setNewKey] = useState('');
  const arrayKeys = useRef({ next: 0, keys: [] as number[] });
  if (Array.isArray(value)) while (arrayKeys.current.keys.length < value.length) arrayKeys.current.keys.push(arrayKeys.current.next++);
  const kind = valueType(value); const label = path.join('.') || (zh ? '完整配置' : 'Full configuration');
  const issueKey = JSON.stringify(path);
  const changeType = (next: string) => { onIssue(issueKey, ''); onChange(emptyValue(next as ValueType)); };
  return <div className={`startup-config-node is-${kind}`}>
    {path.length > 0 && <div className="startup-config-node-heading"><code>{path.at(-1)}</code><Dropdown compact ariaLabel={`${label} ${zh ? '数据类型' : 'type'}`} disabled={disabled} value={kind} options={types.map(type => ({ value: type, label: type }))} onValueChange={changeType}/></div>}
    {kind === 'object' ? <div className="startup-config-children">{Object.entries(value as JsonObject).filter(([key]) => path.length > 0 || key !== 'args').map(([key, child]) => <div className="startup-config-child" key={key}><ConfigurationNode value={child} path={[...path, key]} disabled={disabled} zh={zh} onIssue={onIssue} onChange={next => onChange({ ...value as JsonObject, [key]: next })}/><button className="startup-remove-value" type="button" disabled={disabled} aria-label={`${zh ? '移除字段' : 'Remove field'} ${[...path, key].join('.')}`} onClick={() => { const next = { ...value as JsonObject }; delete next[key]; onIssue(JSON.stringify([...path, key]), ''); onChange(next); }}><Trash2 size={14}/></button></div>)}<div className="startup-add-value"><input className="st-input" aria-label={`${label} ${zh ? '新字段名称' : 'new field name'}`} disabled={disabled} value={newKey} placeholder={zh ? '新增字段名称' : 'New field name'} onChange={event => setNewKey(event.target.value)}/><button type="button" disabled={disabled || !newKey || Object.hasOwn(value as object, newKey) || (path.length === 0 && newKey === 'args')} onClick={() => { onChange({ ...value as JsonObject, [newKey]: '' }); setNewKey(''); }}><Plus size={14}/>{zh ? '添加字段' : 'Add field'}</button></div></div>
      : kind === 'array' ? <div className="startup-config-children">{(value as unknown[]).map((child, index) => <div className="startup-config-child" key={arrayKeys.current.keys[index]}><ConfigurationNode value={child} path={[...path, String(index)]} disabled={disabled} zh={zh} onIssue={onIssue} onChange={next => { const array = [...value as unknown[]]; array[index] = next; onChange(array); }}/><button className="startup-remove-value" type="button" disabled={disabled} aria-label={`${zh ? '移除项目' : 'Remove item'} ${label}[${index}]`} onClick={() => { arrayKeys.current.keys.splice(index, 1); onIssue(issueKey, '', index); onChange((value as unknown[]).filter((_, position) => position !== index)); }}><Trash2 size={14}/></button></div>)}<button type="button" disabled={disabled} onClick={() => onChange([...(value as unknown[]), ''])}><Plus size={14}/>{zh ? '添加数组项目' : 'Add array item'}</button></div>
      : kind === 'boolean' ? <Dropdown ariaLabel={label} value={String(value)} options={[{ value: 'true', label: 'true' }, { value: 'false', label: 'false' }]} disabled={disabled} onValueChange={next => onChange(next === 'true')}/>
      : kind === 'number' ? <NumericValue value={value as number} label={label} disabled={disabled} onChange={onChange} onIssue={message => onIssue(issueKey, message)}/>
      : kind === 'null' ? <code className="startup-null-value">null</code>
      : <input className="st-input" type={/secret|password|api.?key|authorization/i.test(path.at(-1) ?? '') ? 'password' : 'text'} aria-label={label} value={String(value ?? '')} disabled={disabled} onChange={event => onChange(event.target.value)}/>}
  </div>;
}
