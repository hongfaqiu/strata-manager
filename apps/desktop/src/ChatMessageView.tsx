import type { AppLanguage } from "@strata-manager/core";
import { Children, isValidElement, memo, useEffect, useRef, useState, type ReactNode } from 'react';
import { useTranslation } from 'react-i18next';
import ReactMarkdown from 'react-markdown';
import remarkGfm from 'remark-gfm';
import type { ChatMessage, ToolEvent } from '@strata-manager/core';
import { OfficialIcon } from './OfficialIcon';
import { OfficialCopyButton } from './OfficialCopyButton';
import { ChatExecutionStatus } from './ChatExecutionStatus';

function CodeBlock({ children, onCopy }: {children?:ReactNode;onCopy:(value:string)=>void|Promise<boolean|void>}) {
  const {t}=useTranslation(); const child=Children.toArray(children)[0]; const props=isValidElement<{children?:ReactNode;className?:string}>(child)?child.props:{};
  const text=String(props.children??'').replace(/\n$/,''); const language=props.className?.replace(/^language-/,'')??'';
  return <div className="st-code"><div className="st-code__head"><span>{language}</span><OfficialCopyButton value={text} onCopy={onCopy} label={t('copyCode')}/></div><pre>{children}</pre></div>;
}
const Markdown = memo(function Markdown({text,onCopy}:{text:string;onCopy:(value:string)=>void|Promise<boolean|void>}) {
  return <ReactMarkdown remarkPlugins={[remarkGfm]} components={{pre:({children})=><CodeBlock onCopy={onCopy}>{children}</CodeBlock>,code:({node:_node,title,className,children,...props})=><code className={className??'inline'} {...props} data-tooltip={title}>{children}</code>,a:({node:_node,title,...props})=><a {...props} data-tooltip={title}/>,img:({node:_node,title,...props})=><img {...props} data-tooltip={title}/>}}>{text}</ReactMarkdown>;
});
function ToolCall({tool,language,stateLabel}:{tool:ToolEvent;language:string;stateLabel:(state:string)=>string}) {
  const {t}=useTranslation(); const [open,setOpen]=useState(false); const raw=tool.raw??{}; const state=tool.status; const args=tool.arguments==null?'':JSON.stringify(tool.arguments,null,2); const preview=tool.result??args.replace(/\s+/g,' ');
  const cls=state==='writing'?'st-badge--reading':state==='running'?'st-badge--generating':state==='error'?'st-badge--error':state==='skipped'?'st-badge--queued':'';
  return <details className="st-collapse tool-call" data-state={state} onToggle={event=>setOpen(event.currentTarget.open)}><summary><OfficialIcon name="tool" size={16}/><span className="tool-call__name" data-tooltip={tool.name}>{tool.tool??tool.name??t('toolCall')}</span>{tool.server&&<span className="muted small">{tool.server}</span>}<span className="tool-call__preview muted">{preview.slice(0,200)}</span><span className={`st-badge ${cls}`}>{stateLabel(state)}</span>{typeof raw.ms==='number'&&state!=='skipped'&&<span className="muted small">{(raw.ms/1000).toLocaleString(language,{maximumFractionDigits:1})} s</span>}<OfficialIcon name="chevron" size={16} className="st-chev"/></summary><div className="st-collapse__body">{open&&<><div className="tool-call__label">{t('toolArguments')}</div><pre className="tool-call__pre">{args||t('toolWriting')}</pre>{tool.result!=null&&<><div className="tool-call__label">{t(tool.ok===false?'error':'toolResult')}{typeof raw.chars==='number'&&` · ${t('toolCharacters',{count:raw.chars})}`}{raw.truncated===true&&`, ${t('toolTruncated')}`}</div><pre className="tool-call__pre">{tool.result}</pre></>}</>}</div></details>;
}
export const ChatMessageView = memo(function ChatMessageView({message,language,showReasoning,streaming,stateLabel,onCopy}:{message:ChatMessage;language:AppLanguage;showReasoning:boolean;streaming:boolean;stateLabel:(state:string)=>string;onCopy:(value:string)=>void|Promise<boolean|void>}) {
  const {t}=useTranslation(); const reasoning=useRef<HTMLDetailsElement>(null); const touched=useRef(false); const thinkingNow=streaming&&!message.content;
  useEffect(()=>{if(reasoning.current&&!touched.current)reasoning.current.open=thinkingNow&&showReasoning;},[thinkingNow,showReasoning]);
  const fmt=(value:number,digits=1)=>value.toLocaleString(language,{maximumFractionDigits:digits});
  const n=typeof message.usage?.completion_tokens==='number'?message.usage.completion_tokens:typeof message.usage?.output_tokens==='number'?message.usage.output_tokens:null;
  const elapsed=message.elapsedMs!=null?Math.max(0,(message.elapsedMs-(message.firstTokenMs??0))/1000):null;
  const ran=message.tools?.filter(tool=>['done','error','completed'].includes(tool.status)).length??0;
  const limit=message.tools?.find(tool=>tool.status==='limit');
  const meta=streaming?'':[n?`${t('tokenCount',{count:n})}${!message.execution&&elapsed!=null&&elapsed>0.25?` · ${fmt(n/elapsed)} tok/s`:''}`:'',message.stopped?t('stopped'):'',ran?t('toolCallCount',{count:ran}):'',limit?t('toolRoundLimit',{count:limit.raw?.max_rounds??'—'}):''].filter(Boolean).join(' · ');
  const answer:ReactNode[]=[];let position=0;(message.tools??[]).filter(tool=>tool.status!=='limit').forEach((tool,index)=>{const at=Math.min(Math.max(tool.at??0,position),message.content.length);if(at>position)answer.push(<Markdown key={`text-${index}`} text={message.content.slice(position,at)} onCopy={onCopy}/>);answer.push(<ToolCall key={tool.id??index} tool={tool} language={language} stateLabel={stateLabel}/>);position=at;});if(position<message.content.length)answer.push(<Markdown key="tail" text={message.content.slice(position)} onCopy={onCopy}/>);
  if(message.role==='user')return <div className="st-msg st-msg--user">{!!message.attachments?.length&&<div className="msg-images">{message.attachments.map(file=>file.type==='image'?<img src={file.content} alt={file.name} key={file.id}/>:<span className="chip" key={file.id}><OfficialIcon name="attach" size={16}/>{file.name}</span>)}</div>}<div className="st-bubble">{message.content}</div><div className="st-msg__meta">{t('you')} · {new Date(message.createdAt).toLocaleTimeString(language,{hour:'2-digit',minute:'2-digit'})}</div></div>;
  return <div className="st-msg st-msg--assistant">{message.execution&&<ChatExecutionStatus execution={message.execution} streaming={streaming} language={language}/>}<details ref={reasoning} className="st-collapse think" hidden={!message.reasoning}><summary onClick={()=>{touched.current=true;}}><OfficialIcon name="thinking" size={16}/><span className="think-title">{thinkingNow?t('thinkingNow'):message.reasoningMs!=null?t('thoughtFor',{seconds:fmt(message.reasoningMs/1000)}):t('thoughts')}</span><OfficialIcon name="chevron" size={16} className="st-chev"/></summary><div className="st-collapse__body thinking">{message.reasoning}</div></details><div className={`st-bubble ${streaming&&!!message.content?'cursor':''}`}>{message.error && <div className="msg-error" role="alert">{message.stopped?t('stopped'):message.error}</div>}{!message.content&&streaming&&!message.tools?.length?message.reasoning?<span className="muted cursor">{t('writingAnswer')}</span>:<span className="cursor"/>:<>{answer}</>}</div><div className="st-msg__meta"><span className="meta-text">{meta}</span><OfficialCopyButton value={message.content} onCopy={onCopy} label={t('copyAnswer')} hidden={streaming||!message.content} size={16}/></div></div>;
});
