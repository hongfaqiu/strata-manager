import type { ReactNode } from 'react';
import { useTranslation } from 'react-i18next';

export function WorkspaceHeader({variant='official',title,status,actions}:{variant?:'official'|'api';title?:string;breadcrumb?:string;status?:ReactNode;actions?:ReactNode}) {
  const {t}=useTranslation();
  return <header className={`st-header workspace-header workspace-header--${variant}`}><div className="workspace-heading"><h1 id="workspace-page-title">{title??t('apiMonitorTitle')}</h1></div><span className="st-header__spacer"/>{status&&<div className="workspace-header-status">{status}</div>}{actions&&<div className="workspace-header-actions">{actions}</div>}</header>;
}
export function WorkspaceStatusBar({status,activity,actions}:{status?:ReactNode;activity?:ReactNode;actions?:ReactNode}) {
  const {t}=useTranslation();
  return <footer className="workspace-statusbar"><span className="workspace-statusbar-state">{status??t('desktopLocalWorkspace')}</span>{activity&&<span className="workspace-statusbar-activity" role="status" aria-live="polite">{activity}</span>}{actions&&<div className="workspace-statusbar-actions">{actions}</div>}</footer>;
}
export function WorkspaceLayout({variant='official',header,children,statusBar}:{variant?:'official'|'api';header?:ReactNode;children:ReactNode;statusBar?:ReactNode}) {
  return <div className={variant==='api'?'manager-workspace api-monitor-page':'manager-workspace official-app official-surface'}>{header}<main className={variant==='api'?undefined:'official-main'}>{children}</main>{statusBar??<WorkspaceStatusBar/>}</div>;
}
