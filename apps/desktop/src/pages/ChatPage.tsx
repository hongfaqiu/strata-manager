import { useEffect, useMemo, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { Pencil, Search } from 'lucide-react';
import type { Attachment, Conversation, ServiceProfile } from '@strata-manager/core';
import { ChatMessageView } from '../ChatMessageView';
import { OfficialIcon } from '../OfficialIcon';
import './chat-history.css';

export interface ChatPageProps {
  conversation?:Conversation;profile?:ServiceProfile;online:boolean;supportsImages:boolean;modelName?:unknown;language:'zh-CN'|'en';
  draft:string;onDraftChange:(value:string)=>void;attachments:Attachment[];streaming:boolean;showReasoning:boolean;
  onSend:()=>Promise<void>;onCancel:()=>void;onNewConversation:()=>void;onExport:(conversation:Conversation)=>void;onOpenSampling:()=>void;
  onAddFiles:(files:File[])=>Promise<void>;onRemoveAttachment:(id:string)=>void;stateLabel:(value:string)=>string;onCopy:(value:string)=>void|Promise<boolean|void>;
  conversations:Conversation[];activeConversationId?:string;
  onSelectConversation:(conversation:Conversation)=>void;onRenameConversation:(conversation:Conversation)=>void;onDeleteConversation:(conversation:Conversation)=>void;
}
export function ChatPage({conversation,profile,online,supportsImages,modelName,language,draft,onDraftChange,attachments,streaming,showReasoning,onSend,onCancel,onNewConversation,onExport,onOpenSampling,onAddFiles,onRemoveAttachment,stateLabel,onCopy,conversations,activeConversationId,onSelectConversation,onRenameConversation,onDeleteConversation}:ChatPageProps) {
  const {t, t:translate}=useTranslation();const files=useRef<HTMLInputElement>(null);const input=useRef<HTMLTextAreaElement>(null);const chatScroll=useRef<HTMLDivElement>(null);const nearBottom=useRef(true);const scrolledConversation=useRef('');const [dragging,setDragging]=useState(false);
  const workspace=useRef<HTMLElement>(null);
  const [search,setSearch]=useState('');
  const [narrow,setNarrow]=useState(()=>window.innerWidth<1000);
  const [historyCollapsed,setHistoryCollapsed]=useState<boolean|null>(null);
  const historyOpen=historyCollapsed===null?!narrow:!historyCollapsed;
  const label=(cn:string,en:string)=>language==='zh-CN'?cn:en;
  const active=activeConversationId??conversation?.id;
  const newConversation=()=>{if(!profile||streaming)return;setSearch('');onNewConversation();if(narrow)setHistoryCollapsed(true);};
  const groups=useMemo(()=>{
    const term=search.trim().toLocaleLowerCase(language);
    const recent=conversations.filter(item=>item.profileId===profile?.id&&(!term||item.title.toLocaleLowerCase(language).includes(term))).sort((a,b)=>b.updatedAt-a.updatedAt);
    const midnight=new Date();midnight.setHours(0,0,0,0);
    const yesterday=new Date(midnight);yesterday.setDate(yesterday.getDate()-1);
    const week=new Date(midnight);week.setDate(week.getDate()-7);
    const byDate=new Map<'today'|'yesterday'|'week'|'earlier',Conversation[]>();
    for(const item of recent){const bucket=item.updatedAt>=midnight.getTime()?'today':item.updatedAt>=yesterday.getTime()?'yesterday':item.updatedAt>=week.getTime()?'week':'earlier';const list=byDate.get(bucket)??[];list.push(item);byDate.set(bucket,list);}
    return [...byDate.entries()];
  },[conversations,profile?.id,search,language]);
  useEffect(()=>{
    const section=workspace.current;if(!section)return;
    const observer=new ResizeObserver(entries=>{const width=entries[0]?.contentRect.width;if(width!==undefined)setNarrow(width<760);});
    observer.observe(section);return()=>observer.disconnect();
  },[]);
  useEffect(()=>{setSearch('');},[profile?.id]);
  useEffect(()=>{const scroll=chatScroll.current;if(scroll&&(scrolledConversation.current!==conversation?.id||nearBottom.current)){scroll.scrollTop=scroll.scrollHeight;nearBottom.current=true;}scrolledConversation.current=conversation?.id??'';},[conversation?.messages,conversation?.id,streaming]);
  useEffect(()=>{if(!draft&&input.current)input.current.style.height='auto';},[draft]);
  return <section ref={workspace} className={`view view--chat chat-workspace${narrow?' chat-workspace--narrow':''}`} id="view-chat" role="tabpanel" aria-labelledby="workspace-page-title">
    {narrow&&historyOpen&&<button type="button" className="chat-history-scrim" aria-label={label('收起聊天历史','Close chat history')} onClick={()=>setHistoryCollapsed(true)}/>}
    <aside className="chat-history" id="chat-history" aria-label={label('聊天历史','Chat history')} hidden={!historyOpen}>
      <div className="chat-history-heading"><strong>{label('聊天历史','Chat history')}</strong></div>
      <button type="button" className="st-btn st-btn--primary chat-history-new" disabled={!profile||streaming} onClick={newConversation}><OfficialIcon name="new-chat" size={16}/>{t('newConversation')}</button>
      <label className="chat-history-search"><Search size={16}/><input type="search" value={search} aria-label={label('搜索本服务的聊天','Search this service’s chats')} placeholder={label('搜索聊天','Search chats')} onChange={event=>setSearch(event.target.value)}/></label>
      <div className="chat-history-list">{groups.length?groups.map(([bucket,items])=><div className="chat-history-group" key={bucket}><h2>{bucket==='today'?label('今天','Today'):bucket==='yesterday'?label('昨天','Yesterday'):bucket==='week'?label('最近 7 天','Previous 7 days'):label('更早','Earlier')}</h2>{items.map(item=><div className={`chat-history-item${item.id===active?' is-active':''}`} key={item.id}>
        <button type="button" className="chat-history-select" aria-current={item.id===active?'true':undefined} title={item.title} disabled={streaming} onClick={()=>{onSelectConversation(item);if(narrow)setHistoryCollapsed(true);}}><span>{item.title||t('unnamed')}</span><small>{new Date(item.updatedAt).toLocaleTimeString(language,{hour:'2-digit',minute:'2-digit'})} · {label(`${item.messages.length} 条消息`,`${item.messages.length} messages`)}</small></button>
        <div className="chat-history-actions"><button type="button" className="st-btn st-btn--icon" disabled={streaming} title={t('renameConversation')} aria-label={`${t('renameConversation')}: ${item.title}`} onClick={()=>onRenameConversation(item)}><Pencil size={14}/></button><button type="button" className="st-btn st-btn--icon chat-history-delete" disabled={streaming} title={t('deleteConversation')} aria-label={`${t('deleteConversation')}: ${item.title}`} onClick={()=>onDeleteConversation(item)}><OfficialIcon name="trash" size={14}/></button></div>
      </div>)}</div>):<p className="chat-history-empty">{search.trim()?label('没有匹配的聊天','No matching chats'):label('本服务还没有聊天记录','No chats for this service yet')}</p>}</div>
    </aside>
    <div className="chat-main"><div className="chat-history-toolbar"><button type="button" className="st-btn st-btn--icon" aria-label={label(historyOpen?'收起聊天历史':'展开聊天历史',historyOpen?'Collapse chat history':'Expand chat history')} aria-controls="chat-history" aria-expanded={historyOpen} onClick={()=>setHistoryCollapsed(historyOpen)}><OfficialIcon name="chat" size={18}/></button><span>{conversation?.title??label('新聊天','New chat')}</span></div>
    <div className="chat-scroll" id="chat-scroll" ref={chatScroll} onScroll={event=>{const scroll=event.currentTarget;nearBottom.current=scroll.scrollHeight-scroll.scrollTop-scroll.clientHeight<120;}}><div className="chat" id="chat">{!conversation?.messages.length ? <div className="chat-empty" id="chat-empty"><div className="chat-empty__title">{t('askAnything')}</div><div className="chat-empty__sub" id="chat-empty-sub">{!profile ? t('chatNeedsProfile') : !online ? t('chatNeedsOnline') : translate('localChatSubtitle',{model:modelName??t('model')})}</div></div> : conversation.messages.map(message => <ChatMessageView key={message.id} message={message} language={language} showReasoning={showReasoning} streaming={streaming && message.id === conversation.messages.at(-1)?.id} stateLabel={stateLabel} onCopy={onCopy} />)}</div></div><div className="composer-wrap"><form className={`st-composer ${dragging ? 'dragging' : ''}`} id="composer" onSubmit={event=>{event.preventDefault();void onSend();}} onDragOver={event=>{event.preventDefault();setDragging(true);}} onDragLeave={()=>setDragging(false)} onDrop={event=>{event.preventDefault();setDragging(false);if(!streaming)void onAddFiles([...event.dataTransfer.files]);}}>
    <div className="attachments" id="attachments" hidden={!attachments.length}>{attachments.map(file=><span className="chip" key={file.id}><OfficialIcon name={file.type==='image'?'image':'attach'} size={16}/>{file.name}<button type="button" className="st-btn st-btn--icon" disabled={streaming} aria-label={`${t('removeAttachment')}: ${file.name}`} onClick={()=>onRemoveAttachment(file.id)}><OfficialIcon name="trash" size={14}/></button></span>)}</div>
    <textarea ref={input} id="input" rows={2} aria-label={t('message')} placeholder={t('askAnythingPlaceholder')} value={draft} disabled={streaming} onChange={event=>{onDraftChange(event.target.value);event.target.style.height='auto';event.target.style.height=`${Math.min(event.target.scrollHeight,innerHeight*.4)}px`;}} onKeyDown={event=>{if(event.key==='Enter'&&!event.shiftKey&&!event.nativeEvent.isComposing){event.preventDefault();void onSend();}}} onPaste={event=>{const list=[...event.clipboardData.files];if(list.length){event.preventDefault();void onAddFiles(list);}}}/>
    <div className="st-composer__bar"><button type="button" className="st-btn st-btn--icon" id="attach-btn" title={t(supportsImages?'attachImage':'attachText')} aria-label={t('attachFileLabel')} disabled={streaming||!profile} onClick={()=>files.current?.click()}><OfficialIcon name="attach"/></button><input ref={files} type="file" id="file" multiple hidden aria-label={t('attachments')} accept="image/*,text/*,.md,.json,.csv,.yaml,.yml,.py,.js,.ts,.tsx,.rs,.log,.sql" onChange={event=>{void onAddFiles([...event.target.files??[]]);event.target.value='';}}/><button type="button" className="st-btn st-btn--icon" id="new-btn" title={t('newChatLabel')} aria-label={t('newChatLabel')} disabled={!profile||streaming} onClick={onNewConversation}><OfficialIcon name="new-chat"/></button><button type="button" className="st-btn st-btn--icon" id="export-btn" title={t('saveChatTitle')} aria-label={t('saveChatLabel')} disabled={!conversation?.messages.length||streaming} onClick={()=>conversation&&onExport(conversation)}><OfficialIcon name="download"/></button><button type="button" className="st-btn st-btn--icon" id="sampling-btn" title={t('samplingAndThinking')} aria-label={t('samplingAndThinking')} onClick={onOpenSampling}><OfficialIcon name="settings"/></button><span className="spacer"/><span className="composer-hint" id="composer-hint">{!streaming&&t('shiftEnterHint')}</span><button type="button" className="st-btn st-btn--secondary" id="stop-btn" hidden={!streaming} onClick={onCancel}><OfficialIcon name="stop" size={16}/>{t('stoppedShort')}</button><button type="submit" className="st-btn st-btn--primary st-btn--send" id="send-btn" hidden={streaming} aria-label={t('send')} disabled={!online||!profile||(!draft.trim()&&!attachments.length)}><OfficialIcon name="send"/></button></div>
  </form></div></div></section>;
}
