import spriteUrl from './official/sprite.svg';

export function OfficialIcon({ name, size = 20, className = '' }: { name: string; size?: number; className?: string }) {
  return <svg className={`st-icon ${size === 16 ? 'st-icon--sm' : size === 24 ? 'st-icon--lg' : ''} ${className}`} width={size} height={size} aria-hidden="true"><use href={`${spriteUrl}#i-${name}`} /></svg>;
}
