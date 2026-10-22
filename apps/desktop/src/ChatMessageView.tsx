import type { AppLanguage } from "@strata-manager/core";
import { Children, createContext, isValidElement, memo, useContext, useEffect, useMemo, useRef, useState, type ReactNode } from 'react';
import { useTranslation } from 'react-i18next';
import ReactMarkdown from 'react-markdown';
import remarkGfm from 'remark-gfm';
import remarkMath from 'remark-math';
import type { Options as MarkdownOptions } from 'react-markdown';
import type { ChatMessage, ToolEvent } from '@strata-manager/core';
import { OfficialIcon } from './OfficialIcon';
import { OfficialCopyButton } from './OfficialCopyButton';
import { ChatExecutionStatus } from './ChatExecutionStatus';
import { MathView } from './chat/MathView';
import { HtmlCodeBlock } from './chat/HtmlCodeBlock';
import { prepareMathMarkdown } from './chat/chatMath';
import { isHtmlLanguage } from './chat/htmlPreview';

type Copy=(value:string)=>void|Promise<boolean|void>;type Notify=(text:string,error?:boolean)=>void;
/**
 * What code blocks need from their message. It travels by context so the Markdown `components` below can be one module-level
 * object: an inline components object (pre: () => …) is a new component type on every render, and React then remounts every code
 * block (an HTML block lost its Preview choice each time the app re-rendered, e.g. on a metrics poll).
 */
interface BlockContext{messageId:string;base:number;streaming:boolean;onCopy:Copy;onMessage?:Notify}
const MessageBlocks=createContext<BlockContext|null>(null);
type MdNode={position?:{start?:{offset?:number}}};
function CodeBlock({ children, node }: {children?:ReactNode;node?:MdNode}) {
  const {t}=useTranslation(); const block=useContext(MessageBlocks); const child=Children.toArray(children)[0]; const props=isValidElement<{children?:ReactNode;className?:string}>(child)?child.props:{};
  const text=String(props.children??'').replace(/\n$/,''); const classes=props.className??''; const onCopy=block?.onCopy??(()=>{});
  if(/\bmath-display\b/.test(classes))return <div className="st-math-block"><MathView tex={text} block/></div>;
  const language=classes.replace(/^language-/,'');
  if(isHtmlLanguage(language))return <HtmlCodeBlock id={`${block?.messageId??''}:${(block?.base??0)+(node?.position?.start?.offset??0)}`} code={text} language={language} streaming={block?.streaming??false} onCopy={onCopy}>{children}</HtmlCodeBlock>;
  return <div className="st-code"><div className="st-code__head"><span>{language}</span><OfficialCopyButton value={text} onCopy={onCopy} label={t('copyCode')}/></div><pre>{children}</pre></div>;
}
const remarkPlugins:NonNullable<MarkdownOptions['remarkPlugins']>=[remarkGfm,[remarkMath,{singleDollarTextMath:false}]];
/** Module-level on purpose (see BlockContext): the element types must stay the same across renders. */
export const chatMarkdownComponents:NonNullable<MarkdownOptions['components']>={
  pre:({node,children})=><CodeBlock node={node as MdNode|undefined}>{children}</CodeBlock>,
  code:({node:_node,title,className,children,...props})=>/\bmath-inline\b/.test(className??'')?<MathView tex={String(children??'')}/>:<code className={className??'inline'} {...props} data-tooltip={title}>{children}</code>,
  a:({node:_node,title,...props})=><a {...props} data-tooltip={title}/>,
  img:({node:_node,title,...props})=><img {...props} data-tooltip={title}/>,
};
/** Math is found by chat/chatMath.ts (money and code stay text) and drawn by KaTeX, loaded only when an answer has a formula. */
const Markdown = memo(function Markdown({text,messageId,base,streaming,onCopy,onMessage}:{text:string;messageId:string;base:number;streaming:boolean;onCopy:Copy;onMessage?:Notify}) {
  const source=useMemo(()=>prepareMathMarkdown(text),[text]);
  const block=useMemo<BlockContext>(()=>({messageId,base,streaming,onCopy,onMessage}),[messageId,base,streaming,onCopy,onMessage]);
  return <MessageBlocks.Provider value={block}><ReactMarkdown remarkPlugins={remarkPlugins} components={chatMarkdownComponents}>{source}</ReactMarkdown></MessageBlocks.Provider>;
});
function ToolCall({tool,language,stateLabel}:{tool:ToolEvent;language:string;stateLabel:(state:string)=>string}) {
  const {t}=useTranslation(); const [open,setOpen]=useState(false); const raw=tool.raw??{}; const state=tool.status; const args=tool.arguments==null?'':JSON.stringify(tool.arguments,null,2); const preview=tool.result??args.replace(/\s+/g,' ');
  const cls=state==='writing'?'st-badge--reading':state==='running'?'st-badge--generating':state==='error'?'st-badge--error':state==='skipped'?'st-badge--queued':'';
  return <details className="st-collapse tool-call" data-state={state} onToggle={event=>setOpen(event.currentTarget.open)}><summary><OfficialIcon name="tool" size={16}/><span className="tool-call__name" data-tooltip={tool.name}>{tool.tool??tool.name??t('toolCall')}</span>{tool.server&&<span className="muted small">{tool.server}</span>}<span className="tool-call__preview muted">{preview.slice(0,200)}</span><span className={`st-badge ${cls}`}>{stateLabel(state)}</span>{typeof raw.ms==='number'&&state!=='skipped'&&<span className="muted small">{(raw.ms/1000).toLocaleString(language,{maximumFractionDigits:1})} s</span>}<OfficialIcon name="chevron" size={16} className="st-chev"/></summary><div className="st-collapse__body">{open&&<><div className="tool-call__label">{t('toolArguments')}</div><pre className="tool-call__pre">{args||t('toolWriting')}</pre>{tool.result!=null&&<><div className="tool-call__label">{t(tool.ok===false?'error':'toolResult')}{typeof raw.chars==='number'&&` · ${t('toolCharacters',{count:raw.chars})}`}{raw.truncated===true&&`, ${t('toolTruncated')}`}</div><pre className="tool-call__pre">{tool.result}</pre></>}</>}</div></details>;
}
export const ChatMessageView = memo(function ChatMessageView({message,language,showReasoning,streaming,stateLabel,onCopy,onMessage}:{message:ChatMessage;language:AppLanguage;showReasoning:boolean;streaming:boolean;stateLabel:(state:string)=>string;onCopy:Copy;onMessage?:Notify}) {
  const {t}=useTranslation(); const reasoning=useRef<HTMLDetailsElement>(null); const touched=useRef(false); const thinkingNow=streaming&&!message.content;
  useEffect(()=>{if(reasoning.current&&!touched.current)reasoning.current.open=thinkingNow&&showReasoning;},[thinkingNow,showReasoning]);
  const fmt=(value:number,digits=1)=>value.toLocaleString(language,{maximumFractionDigits:digits});
  const n=typeof message.usage?.completion_tokens==='number'?message.usage.completion_tokens:typeof message.usage?.output_tokens==='number'?message.usage.output_tokens:null;
  const elapsed=message.elapsedMs!=null?Math.max(0,(message.elapsedMs-(message.firstTokenMs??0))/1000):null;
  const ran=message.tools?.filter(tool=>['done','error','completed'].includes(tool.status)).length??0;
  const limit=message.tools?.find(tool=>tool.status==='limit');
  const meta=streaming?'':[n?`${t('tokenCount',{count:n})}${!message.execution&&elapsed!=null&&elapsed>0.25?` · ${fmt(n/elapsed)} tok/s`:''}`:'',message.stopped?t('stopped'):'',ran?t('toolCallCount',{count:ran}):'',limit?t('toolRoundLimit',{count:limit.raw?.max_rounds??'—'}):''].filter(Boolean).join(' · ');
  const answer:ReactNode[]=[];let position=0;(message.tools??[]).filter(tool=>tool.status!=='limit').forEach((tool,index)=>{const at=Math.min(Math.max(tool.at??0,position),message.content.length);if(at>position)answer.push(<Markdown key={`text-${index}`} text={message.content.slice(position,at)} messageId={message.id} base={position} streaming={streaming} onCopy={onCopy} onMessage={onMessage}/>);answer.push(<ToolCall key={tool.id??index} tool={tool} language={language} stateLabel={stateLabel}/>);position=at;});if(position<message.content.length)answer.push(<Markdown key="tail" text={message.content.slice(position)} messageId={message.id} base={position} streaming={streaming} onCopy={onCopy} onMessage={onMessage}/>);
  if(message.role==='user')return <div className="st-msg st-msg--user">{!!message.attachments?.length&&<div className="msg-images">{message.attachments.map(file=>file.type==='image'?<img src={file.content} alt={file.name} key={file.id}/>:<span className="chip" key={file.id}><OfficialIcon name="attach" size={16}/>{file.name}</span>)}</div>}<div className="st-bubble">{message.content}</div><div className="st-msg__meta">{t('you')} · {new Date(message.createdAt).toLocaleTimeString(language,{hour:'2-digit',minute:'2-digit'})}</div></div>;
  return <div className="st-msg st-msg--assistant">{message.execution&&<ChatExecutionStatus execution={message.execution} streaming={streaming} language={language}/>}<details ref={reasoning} className="st-collapse think" hidden={!message.reasoning}><summary onClick={()=>{touched.current=true;}}><OfficialIcon name="thinking" size={16}/><span className="think-title">{thinkingNow?t('thinkingNow'):message.reasoningMs!=null?t('thoughtFor',{seconds:fmt(message.reasoningMs/1000)}):t('thoughts')}</span><OfficialIcon name="chevron" size={16} className="st-chev"/></summary><div className="st-collapse__body thinking">{message.reasoning}</div></details><div className={`st-bubble ${streaming&&!!message.content?'cursor':''}`}>{message.error && <div className="msg-error" role="alert">{message.stopped?t('stopped'):message.error}</div>}{!message.content&&streaming&&!message.tools?.length?message.reasoning?<span className="muted cursor">{t('writingAnswer')}</span>:<span className="cursor"/>:<>{answer}</>}</div><div className="st-msg__meta"><span className="meta-text">{meta}</span><OfficialCopyButton value={message.content} onCopy={onCopy} label={t('copyAnswer')} hidden={streaming||!message.content} size={16}/></div></div>;
});
