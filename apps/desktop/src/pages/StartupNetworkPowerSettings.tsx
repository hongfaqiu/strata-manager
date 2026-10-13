import { useState } from 'react';
import { CircleHelp } from 'lucide-react';
import { startupServiceEndpoint, STARTUP_TUNING_FIELDS, type StartupFieldSpec } from '@strata-manager/core';
import { Dialog } from '../components';
import { Dropdown } from '../OfficialControls';

interface Props {
  zh: boolean;
  disabled: boolean;
  fallbackBaseUrl: string;
  showParameterNames: boolean;
  fieldValue: (field: StartupFieldSpec) => string;
  onFieldChange: (field: StartupFieldSpec, value: string) => void;
}

const field = (key: string) => STARTUP_TUNING_FIELDS.find(item => item.key === key)!;
const hostField = field('host');
const portField = field('port');
const wattsField = field('manager_gpu_power_limit_watts');
const deviceField = field('manager_gpu_power_limit_device');

/** Frequently needed listener and device settings remain visible beside advanced tuning. */
export function StartupNetworkPowerSettings({ zh, disabled, fallbackBaseUrl, showParameterNames, fieldValue, onFieldChange }: Props) {
  const [help, setHelp] = useState<'network' | 'power' | null>(null);
  const hostValue = fieldValue(hostField);
  const portValue = fieldValue(portField);
  const fallback = new URL(fallbackBaseUrl);
  const fallbackHost = fallback.hostname === 'localhost' ? '127.0.0.1' : fallback.hostname;
  const fallbackPort = Number(fallback.port || (fallback.protocol === 'https:' ? 443 : 80));
  let endpoint: ReturnType<typeof startupServiceEndpoint> | undefined;
  let endpointError = '';
  try { endpoint = startupServiceEndpoint({ host: hostValue === 'localhost' ? '127.0.0.1' : hostValue || fallbackHost, port: portValue === '' ? fallbackPort : Number(portValue) }); }
  catch (failure) { endpointError = failure instanceof Error ? failure.message : String(failure); }
  const apiAddress = endpoint && (endpoint.wildcard ? `http://${endpoint.host === '0.0.0.0' ? (zh ? '<本机局域网 IP>' : '<computer LAN IP>') : (zh ? '[<本机 IPv6>]' : '[<computer IPv6>]')}:${endpoint.port}/v1` : `${endpoint.baseUrl}/v1`);
  const label = (item: StartupFieldSpec) => zh ? item.zh : item.en;
  const heading = (kind: 'network' | 'power', title: string) => <div className="startup-service-heading">
    <h3>{title}</h3>
    <button type="button" className="setup-tuning-help-button" aria-label={zh ? `${title}帮助` : `${title} help`} aria-haspopup="dialog" aria-expanded={help === kind} data-tooltip={zh ? '帮助' : 'Help'} onClick={() => setHelp(kind)}><CircleHelp size={16}/></button>
  </div>;
  const numberInput = (item: StartupFieldSpec, placeholder: string) => <label className="st-field">
    <span className="st-label">{label(item)}</span>
    {showParameterNames && <code>{item.key}</code>}
    <input className="st-input" inputMode={item.kind === 'integer' ? 'numeric' : 'decimal'} aria-label={label(item)} disabled={disabled} value={item.group === 'power' && fieldValue(item) === 'null' ? '' : fieldValue(item)} placeholder={placeholder} onChange={event => onFieldChange(item, event.target.value)}/>
  </label>;
  return <div className="startup-network-power">
    <section className="startup-service-settings" aria-label={zh ? '网络访问' : 'Network access'}>
      {heading('network', zh ? '网络访问' : 'Network access')}
      <div className="startup-service-fields">
        {numberInput(portField, zh ? `留空保留 ${fallbackPort}` : `Empty: keep ${fallbackPort}`)}
        <div className="st-field"><span className="st-label">{label(hostField)}</span>{showParameterNames && <code>host</code>}<Dropdown editable ariaLabel={label(hostField)} disabled={disabled} value={hostValue} editableDisplayValue={hostValue} placeholder={zh ? `留空保留 ${fallbackHost}` : `Empty: keep ${fallbackHost}`} options={[
          { value: '', label: zh ? `留空保留 ${fallbackHost}` : `Empty: keep ${fallbackHost}` },
          { value: '127.0.0.1', label: zh ? '127.0.0.1 · 仅本机' : '127.0.0.1 · This computer' },
          { value: 'localhost', label: zh ? 'localhost · 仅本机' : 'localhost · This computer' },
          { value: '0.0.0.0', label: zh ? '0.0.0.0 · 局域网' : '0.0.0.0 · LAN' },
          { value: '::', label: ':: · IPv6' },
        ]} onValueChange={value => onFieldChange(hostField, value)}/></div>
      </div>
      {endpointError ? <p className="startup-service-hint runtime-config-error" role="alert">{endpointError}</p> : endpoint && <div className="startup-service-addresses">
        <span>{zh ? '启动后 API' : 'API after startup'}</span><code>{apiAddress}</code>
      </div>}
    </section>
    <section className="startup-service-settings" aria-label={zh ? 'GPU 功耗' : 'GPU power'}>
      {heading('power', zh ? 'GPU 功耗' : 'GPU power')}
      <div className="startup-service-fields">{numberInput(wattsField, zh ? '保持原设置' : 'Keep current limit')}{numberInput(deviceField, zh ? '默认 0' : 'Default: 0')}</div>
      <p className="startup-service-hint">{zh ? 'NVIDIA · 影响整张显卡' : 'NVIDIA · Applies to the whole GPU'}</p>
    </section>
    <p className="startup-service-apply-note">{zh ? '保存后，下次启动或重启生效' : 'Applies on the next start or restart'}</p>
    {help && <Dialog title={help === 'network' ? (zh ? '网络访问帮助' : 'Network access help') : (zh ? 'GPU 功耗帮助' : 'GPU power help')} onClose={() => setHelp(null)}><div className="setup-tuning-help-content">
      {help === 'network' ? <>
        <p>{zh ? '留空沿用当前主机与端口。127.0.0.1 / localhost 仅供本机使用；0.0.0.0 开放 IPv4 局域网访问，:: 开放 IPv6 网络访问，也可输入本机指定 IP。' : 'Empty fields keep the current host and port. 127.0.0.1 / localhost allow local access only; 0.0.0.0 allows IPv4 LAN access and :: allows IPv6 network access. You can also enter a specific local IP.'}</p>
        <p>{zh ? '其他设备需用这台电脑的局域网 IP 替换地址中的占位符，并允许防火墙对此端口的入站连接。' : 'Other devices use this computer’s LAN IP in place of the address placeholder. Allow inbound connections on this port in the firewall.'}</p>
        <p>{zh ? '启用 API Key 时，客户端需携带相同密钥。密钥在公共设置的「服务连接与 API Key」中管理。' : 'When an API key is enabled, clients must send the same key. Manage it under “Service connection and API key” in shared settings.'}</p>
        {endpoint && <p>{zh ? '应用连接地址：' : 'Manager connection: '}<code>{endpoint.baseUrl}/v1</code></p>}
      </> : <>
        <p>{zh ? '留空保留显卡原有设置。启动模型时，将功耗上限应用到指定 NVIDIA 显卡；GPU 编号默认 0。' : 'Leave the limit empty to keep the existing GPU setting. The selected NVIDIA GPU receives the power limit when the model starts; the default GPU index is 0.'}</p>
        <p>{zh ? '可用范围与权限由驱动决定，设置会影响选中显卡上的所有程序。' : 'The driver determines the supported range and required permissions. This setting affects all programs on the selected GPU.'}</p>
        <p>{zh ? '停止受管服务后恢复启动前的上限；如其他程序已修改该上限，则保留其修改。' : 'Stopping the managed service restores the previous limit, while preserving later changes made by other programs.'}</p>
      </>}
    </div></Dialog>}
  </div>;
}
