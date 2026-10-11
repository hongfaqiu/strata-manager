import type { ReactNode } from 'react';
import { useTranslation } from 'react-i18next';
import { ChevronLeft, ChevronRight } from 'lucide-react';
import { AppLogo } from '../AppLogo';

export interface NavigationItem { id:string; label:string; group:string; icon:ReactNode }
interface SidebarProps {
  items:NavigationItem[];page:string;profiles?:{id:string;name:string}[];activeId?:string;disabled?:boolean;
  collapsed:boolean;showBrand?:boolean;
  onNavigate:(page:string)=>void;onProfile?:(value:string)=>void;onCollapse:()=>void;
}
export function Sidebar({items,page,collapsed,showBrand=true,onNavigate,onCollapse}:SidebarProps) {
  const {t}=useTranslation();const groups=[...new Set(items.map(item=>item.group))];
  return <aside className={`manager-nav official-surface ${collapsed?'is-collapsed':''}`}>
    {showBrand && <div className="manager-brand-row"><div className="manager-brand" aria-label="Strata Manager"><AppLogo/><span className="manager-brand-name">Strata <em>Manager</em></span></div></div>}
    <nav id="manager-navigation" aria-label={t('desktopNavigation')}>{groups.map(group=><div className="manager-nav-group" key={group} role="group" aria-label={group||undefined}>{group&&<span className="manager-nav-label">{group}</span>}{items.filter(item=>item.group===group).map(item=><button key={item.id} className={`manager-nav-item ${page===item.id?'active':''}`} title={item.label} aria-label={item.label} aria-current={page===item.id?'page':undefined} onClick={()=>onNavigate(item.id)}>{item.icon}<span>{item.label}</span></button>)}</div>)}</nav>
    <div className="manager-nav-bottom"><button className="manager-nav-item nav-collapse" title={t(collapsed?'expandSidebar':'collapseSidebar')} aria-label={t(collapsed?'expandSidebar':'collapseSidebar')} aria-expanded={!collapsed} aria-controls="manager-navigation" onClick={onCollapse}>{collapsed?<ChevronRight size={18}/>:<ChevronLeft size={18}/>}<span>{t(collapsed?'expandSidebar':'collapseSidebar')}</span></button></div>
  </aside>;
}
export function AppLayout({sidebar,collapsed,children}:{sidebar:ReactNode;collapsed:boolean;children:ReactNode}) {
  return <div className={`manager-shell desktop-shell ${collapsed?'nav-collapsed':''}`}>{sidebar}{children}</div>;
}
