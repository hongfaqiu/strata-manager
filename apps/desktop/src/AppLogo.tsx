import logo from '../../../assets/icon.svg';

export function AppLogo({ size = 32, className = '' }: { size?: number; className?: string }) {
  return <img className={`app-logo ${className}`} src={logo} width={size} height={size} alt="" aria-hidden="true" draggable={false}/>;
}
