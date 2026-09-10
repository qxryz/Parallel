import { useState } from 'react';
import { Check, FileScan, X, Zap } from 'lucide-react';
import {
  isPdfProviderReady, loadActivePdfProviderId, loadPdfProviderConfigs, pdfProviderCatalog,
  saveActivePdfProviderId, savePdfProviderConfigs, testPdfProvider,
  type PdfProviderConfig, type PdfProviderId
} from '../pdfProviders';
import { resolveVisionEngine } from '../modelRouting';
import type { Provider } from '../types';

type Status = { kind: 'idle' | 'testing' | 'success' | 'error'; message?: string };

export function ScanRecognitionDialog({ fileName, providers: modelProviders, onClose, onContinue }: {
  fileName: string;
  providers: Provider[];
  onClose: () => void;
  onContinue: () => void;
}) {
  const initial = loadActivePdfProviderId();
  const visionEngine = resolveVisionEngine(modelProviders);
  const fallbackId: PdfProviderId = visionEngine ? 'vlm' : 'mineru';
  const [providerId, setProviderId] = useState<PdfProviderId>(initial === 'unpdf' || initial === 'alidocmind' || (initial === 'vlm' && !visionEngine) ? fallbackId : initial);
  const [configs, setConfigs] = useState(() => loadPdfProviderConfigs());
  const [status, setStatus] = useState<Status>({ kind: 'idle' });
  const providers = pdfProviderCatalog.filter(item => item.id === 'mineru' || item.id === 'mineru-cloud' || (item.id === 'vlm' && visionEngine));
  const provider = providers.find(item => item.id === providerId) || providers[0];
  const config = configs[provider.id];

  const patch = (update: Partial<PdfProviderConfig>) => {
    const next = { ...configs, [provider.id]: { ...config, ...update } };
    setConfigs(next);
    savePdfProviderConfigs(next);
    setStatus({ kind: 'idle' });
  };
  const select = (id: PdfProviderId) => {
    setProviderId(id);
    saveActivePdfProviderId(id);
    setStatus({ kind: 'idle' });
  };
  const test = async () => {
    setStatus({ kind: 'testing' });
    const result = await testPdfProvider(provider.id, config).catch(error => ({
      ok: false, message: error instanceof Error ? error.message : '连接失败'
    }));
    setStatus({ kind: result.ok ? 'success' : 'error', message: result.message });
  };
  const continueImport = () => {
    savePdfProviderConfigs(configs);
    saveActivePdfProviderId(provider.id);
    onContinue();
  };

  return <div className="lw-dialog-backdrop" role="presentation">
    <section className="lw-scan-dialog" role="dialog" aria-modal="true" aria-labelledby="scan-title">
      <header>
        <span><FileScan size={19}/></span>
        <div><strong id="scan-title">这是一份扫描文稿</strong><small>{fileName}</small></div>
        <button onClick={onClose} aria-label="关闭"><X size={17}/></button>
      </header>
      <p>需要先识别页面文字，才能继续翻译。</p>
      <div className="lw-scan-options">
        {providers.map(item => <button key={item.id} className={provider.id === item.id ? 'active' : ''} onClick={() => select(item.id)}>
          <span><strong>{item.id === 'vlm' && visionEngine ? `${visionEngine.name} · ${visionEngine.provider.model}` : item.name}</strong><small>{item.id === 'vlm' ? '使用已指定的视觉模型' : item.id === 'mineru' ? '使用你的本机或服务器' : '使用官方云服务'}</small></span>
          {provider.id === item.id && <Check size={15}/>} 
        </button>)}
      </div>
      {provider.needsBaseUrl && <label>服务地址<input value={config.baseUrl} onChange={event => patch({ baseUrl: event.target.value })} placeholder="http://localhost:8888"/></label>}
      {provider.requiresApiKey && <label>API Key<input type="password" autoComplete="new-password" value={config.apiKey} onChange={event => patch({ apiKey: event.target.value })} placeholder="输入 API Key"/></label>}
      {status.message && <div className={'lw-scan-status ' + status.kind}>{status.message}</div>}
      <footer>
        <button className="secondary" disabled={status.kind === 'testing'} onClick={() => void test()}><Zap size={14}/>{status.kind === 'testing' ? '测试中' : '测试连接'}</button>
        <button className="primary" disabled={provider.id === 'vlm' ? !visionEngine : !isPdfProviderReady(provider, config)} onClick={continueImport}>识别并继续</button>
      </footer>
    </section>
  </div>;
}
