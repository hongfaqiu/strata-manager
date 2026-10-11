import React, { Profiler, useCallback, useEffect, useMemo, useState } from 'react';
import { createRoot } from 'react-dom/client';
import { ChatMessageView } from '../../src/ChatMessageView';
import type { ChatMessage } from '@strata-manager/core';
import '../../src/i18n';

const query = new URLSearchParams(location.search);
const count = Number(query.get('count') ?? 20), baseline = query.get('mode') === 'baseline';
const text = ('## Synthetic answer\n\n**Evidence** and `code`, with a [local link](#sample).\n\n| Field | Value |\n| --- | --- |\n| latency | 12 ms |\n\n```ts\nconst result = input.map(value => value + 1);\n```\n\n').repeat(10);
const measurement = { durations: [] as number[], committed: -1, chars: text.length, step: () => {} };
Object.assign(window, { __performance: measurement });
function Harness() {
  const [tick, setTick] = useState(0);
  const messages = useMemo(() => Array.from({ length: count }, (_, index): ChatMessage => ({ id: `synthetic-${index}`, role: 'assistant', content: text, createdAt: 0 })), []);
  const stableCopy = useCallback(() => true, []), stableLabel = useCallback((state: string) => state, []);
  measurement.step = () => setTick(value => value + 1);
  useEffect(() => { measurement.committed = tick; }, [tick]);
  // Baseline recreates the callbacks exactly as App did before stabilization,
  // forcing historical Markdown to render. Optimized keeps historical props.
  const onCopy = baseline ? () => true : stableCopy;
  const stateLabel = baseline ? (state: string) => state : stableLabel;
  return <Profiler id="synthetic-chat" onRender={(_, phase, duration) => { if (phase === 'update') measurement.durations.push(duration); }}>
    {messages.map(message => <ChatMessageView key={message.id} message={message} language="zh-CN" showReasoning streaming={false} stateLabel={stateLabel} onCopy={onCopy}/>)}
    <ChatMessageView message={{ id: 'stream', role: 'assistant', content: `${text}\n\nDelta ${tick}`, createdAt: 0 }} language="zh-CN" showReasoning streaming stateLabel={stateLabel} onCopy={onCopy}/>
  </Profiler>;
}
createRoot(document.getElementById('root')!).render(<Harness/>);
