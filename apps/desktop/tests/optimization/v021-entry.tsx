import { createRoot } from 'react-dom/client';
import i18n from 'i18next';
import { initReactI18next, I18nextProvider } from 'react-i18next';
import { languageResources } from '../../src/i18n';
import { ModelsLead, RequirementMeter, EnvironmentDevices } from '../../src/pages/D2PageStrips';
import '../../src/official/tokens.css';
import '../../src/official/components.css';
import '../../src/styles.css';
import '../../src/pages/d2-visuals.css';
import '../../src/pages/service-manager.css';

void i18n.use(initReactI18next).init({
  resources: languageResources,
  lng: 'zh-CN',
  fallbackLng: 'en',
  interpolation: { escapeValue: false },
});

const environment = {
  os: 'Windows 11',
  arch: 'x86_64',
  cpuName: 'AMD Ryzen 9 7950X',
  totalMemory: 31 * 1024 ** 3,
  availableMemory: 18 * 1024 ** 3,
  gpus: ['NVIDIA GeForce RTX 4090, 560.94, 24564 MiB'],
  python: 'Python 3.12.0',
  git: 'git version 2.45.0',
  appVersion: '0.2.1-dev',
};

function App() {
  return (
    <I18nextProvider i18n={i18n}>
      <main className="v021-preview" style={{ padding: 24, maxWidth: 960, margin: '0 auto' }}>
        <h1 style={{ fontSize: 20, marginBottom: 16 }}>v0.2.1 改进预览（隔离演示）</h1>
        <ModelsLead hardware={{}} environment={environment} models={2} configurations={3} online={false} />
        <div style={{ marginTop: 16 }} className="st-card" data-testid="v021-req">
          <h2 style={{ fontSize: 14, margin: '12px 16px 0' }}>模型配置 · Q2_0</h2>
          <div style={{ padding: '0 16px 16px' }}>
            <RequirementMeter label="Qwen3.8-Flash-Next Q2_0 strata-q2_0.json" machineGB={31} vramGB={24} />
          </div>
        </div>
        <div style={{ marginTop: 16 }}>
          <EnvironmentDevices hardware={{}} environment={environment} />
        </div>
        <div className="service-manager-hint model-config-repair" style={{ marginTop: 16 }}>
          <p>请先修复配置或模型文件，再使用这份配置。</p>
          <span>Python 运行依赖缺失：regex, jinja2（检测的 Python：D:\Strata\.venv\Scripts\python.exe）</span>
          <div className="service-manager-repair-actions">
            <button type="button" className="primary">修复运行环境</button>
            <button type="button">复制诊断信息</button>
          </div>
        </div>
        <p className="st-pill" style={{ marginTop: 16, display: 'inline-flex', alignItems: 'center', gap: 8, padding: '6px 12px', borderRadius: 999 }}>
          <span className="st-pill__dot" />已发现模型，点启用
        </p>
      </main>
    </I18nextProvider>
  );
}

createRoot(document.getElementById('root')!).render(<App />);
