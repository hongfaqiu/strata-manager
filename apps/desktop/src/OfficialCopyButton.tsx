import { useEffect, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { OfficialIcon } from './OfficialIcon';

export function OfficialCopyButton({value,onCopy,label,size=20,hidden=false}:{value:string;onCopy:(value:string)=>void|Promise<boolean|void>;label?:string;size?:number;hidden?:boolean}) {
  const {t}=useTranslation();const [copied,setCopied]=useState(false);const timer=useRef<ReturnType<typeof setTimeout>|undefined>(undefined);
  useEffect(()=>()=>clearTimeout(timer.current),[]);
  return <button className="st-btn st-btn--icon" hidden={hidden} aria-label={label??t('copy')} title={copied?t('copied'):t('copy')} onClick={()=>{void Promise.resolve(onCopy(value)).then(result=>{if(result===false)return;setCopied(true);clearTimeout(timer.current);timer.current=setTimeout(()=>setCopied(false),1500);});}}><OfficialIcon name={copied?'check':'copy'} size={size}/></button>;
}
