// Isolated fixture: chat answers with LaTeX and a ```html block, and the generation settings with the thinking budget.
// No service, model or native IO is used; ?view=math|html|chat|settings, ?en for English.
// view=chat is the real chat page with the HTML preview panel; ?tick re-renders it every 300 ms with new callbacks, like the
// app's metric polls do (the HTML block must keep its state and the panel must stay open through that).
import { useEffect, useState } from 'react';
import { createRoot } from 'react-dom/client';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import i18n from '../../src/i18n';
import type { ChatMessage, ChatOptions } from '@strata-manager/core';
import { ChatMessageView } from '../../src/ChatMessageView';
import { ChatPage } from '../../src/pages/ChatPage';
import { SamplingDrawer, officialSamplingDefaults, defaultChatPreferences } from '../../src/ChatSettings';
import '../../src/official/tokens.css';
import '../../src/official/components.css';
import '../../src/styles.css';
import '../../src/official-alignment.css';
import '../../src/official-controls.css';
import '../../src/official/scoped-components.css';
import '../../src/official/scoped-app.css';
import '../../src/official-pages.css';

const params = new URLSearchParams(location.search), en = params.has('en'), view = params.get('view') ?? 'math';
void i18n.changeLanguage(en ? 'en' : 'zh-CN'); document.documentElement.lang = en ? 'en' : 'zh-CN';
const query = new QueryClient({ defaultOptions: { queries: { retry: false } } });
const at = Date.UTC(2026, 9, 21, 9, 30);
const math: ChatMessage[] = [
  { id: 'q1', role: 'user', content: en ? 'Derive g(r) inside a uniform planet. Budget: $5 to $10.' : '推导均匀行星内部的 g(r)。预算 $5 到 $10。', createdAt: at },
  { id: 'a1', role: 'assistant', createdAt: at + 1, usage: { completion_tokens: 182 }, elapsedMs: 4200, firstTokenMs: 300, content: [
    en ? 'Apply Gauss\'s law for gravity to a sphere of radius $r \\le R$:' : '对半径 $r \\le R$ 的同心球面应用引力高斯定律：',
    '',
    '$$\\oint \\vec{g}\\cdot d\\vec{A} = -4\\pi G\\, M_{\\text{enc}}(r)$$',
    '',
    en ? 'By symmetry \\(\\vec g\\) is radial, so \\(g\\,(4\\pi r^2) = -4\\pi G\\,\\tfrac{4}{3}\\pi r^3\\rho\\), hence' : '由对称性 \\(\\vec g\\) 沿径向，所以 \\(g\\,(4\\pi r^2) = -4\\pi G\\,\\tfrac{4}{3}\\pi r^3\\rho\\)，因此',
    '',
    '\\[\\boxed{g(r) = -\\frac{4\\pi G\\rho}{3}\\,r}\\]',
    '',
    en ? 'Money stays text: it costs $5 and $10. Code stays code: `echo $HOME`.' : '金额保持原文：花费 $5 和 $10。代码保持原样：`echo $HOME`。',
  ].join('\n') },
];
const page = `<!doctype html>
<html><head><title>Bouncing balls</title><link rel="stylesheet" href="https://fonts.googleapis.com/css2?family=Inter:wght@400;600&display=swap"><style>body{margin:0;font:14px Inter,system-ui;background:#0f172a;color:#e2e8f0}canvas{display:block}p{position:absolute;top:8px;left:12px;margin:0}</style></head>
<body><p id="n"></p><canvas id="c"></canvas><script>
const c=document.getElementById('c'),x=c.getContext('2d');c.width=920;c.height=480;
const balls=Array.from({length:14},(_,i)=>({x:40+i*50,y:60+(i%5)*40,r:10+(i%4)*5,h:i*26}));
for(const b of balls){x.beginPath();x.arc(b.x,b.y+120,b.r,0,7);x.fillStyle='hsl('+b.h+' 80% 60%)';x.fill();}
const parentAccess=(()=>{try{return String(!!parent.document)}catch(e){return 'blocked'}})();
const csp=[];document.addEventListener('securitypolicyviolation',e=>csp.push(e.blockedURI));
(async()=>{await fetch('https://fonts.googleapis.com/css2?family=Inter').catch(()=>{});await fetch('http://ipc.localhost/plugin').catch(()=>{});await new Promise(r=>setTimeout(r,50));
const blocked=host=>csp.some(u=>u.includes(host))?'blocked':'allowed';
document.getElementById('n').textContent='Canvas · '+balls.length+' balls · network: '+blocked('fonts.googleapis.com')+' · ipc: '+blocked('ipc.localhost')+' · parent access: '+parentAccess;})();
</script></body></html>`;
const html: ChatMessage[] = [
  { id: 'q2', role: 'user', content: en ? 'Make a small canvas demo page.' : '做一个小的 canvas 演示页面。', createdAt: at },
  { id: 'a2', role: 'assistant', createdAt: at + 1, usage: { completion_tokens: 240 }, content: `${en ? 'Here is a single-file page:' : '这是一个单文件页面：'}\n\n\`\`\`html\n${page}\n\`\`\`` },
];

function ChatFixture() {
  const [tick, setTick] = useState(0);
  useEffect(() => { if (!params.has('tick')) return; const id = setInterval(() => setTick(value => value + 1), 300); return () => clearInterval(id); }, []);
  const messages = [...html, { id: 'q3', role: 'user', content: en ? 'And a second one?' : '再来一个？', createdAt: at + 2 }, { id: 'a3', role: 'assistant', createdAt: at + 3, content: `${en ? 'A plain card:' : '一个简单卡片：'}\n\n\`\`\`html\n<!doctype html><title>${en ? 'Card' : '卡片'}</title><style>body{font:16px system-ui;padding:24px}</style><h1>Hello</h1><p>${en ? 'Second page' : '第二个页面'}</p>\n\`\`\`\n\n\`\`\`js\nconsole.log('not html');\n\`\`\`` }] as ChatMessage[];
  const conversation = { id: 'c1', profileId: 'p1', title: en ? 'Canvas demo' : 'Canvas 演示', messages, createdAt: at, updatedAt: at } as never;
  const noop = () => {};
  return <div className="official-app official-surface" data-tick={tick}><main className="official-main"><ChatPage conversation={conversation} conversations={[conversation]} activeConversationId="c1" profile={{ id: 'p1', name: 'Local' } as never} online supportsImages={false} modelName="Qwen3.8-Flash" language={en ? 'en' : 'zh-CN'} draft="" onDraftChange={noop} attachments={[]} streaming={false} showReasoning={false} onSend={async () => {}} onCancel={noop} onNewConversation={noop} onExport={noop} onOpenSampling={noop} onAddFiles={async () => {}} onRemoveAttachment={noop} stateLabel={s => s} onCopy={() => {}} onMessage={() => void tick} onSelectConversation={noop} onRenameConversation={noop} onDeleteConversation={noop}/></main></div>;
}

function Fixture() {
  const [options, setOptions] = useState<ChatOptions>({ ...officialSamplingDefaults, model: 'Qwen3.8-Flash', thinkingBudgetTokens: 4096 });
  if (view === 'settings') return <QueryClientProvider client={query}><SamplingDrawer options={options} preferences={defaultChatPreferences} models={['Qwen3.8-Flash']} hasProjection={false} online={false} onApply={next => setOptions(next)} onClose={() => {}} onError={() => {}} onMessage={() => {}}/></QueryClientProvider>;
  if (view === 'chat') return <ChatFixture/>;
  const messages = view === 'html' ? html : math;
  return <main className="official-surface" style={{ padding: 24, maxWidth: 820, margin: 'auto' }}><div className="chat">{messages.map(message => <ChatMessageView key={message.id} message={message} language={en ? 'en' : 'zh-CN'} showReasoning={false} streaming={false} stateLabel={s => s} onCopy={() => {}}/>)}</div></main>;
}
createRoot(document.getElementById('root')!).render(<Fixture/>);
