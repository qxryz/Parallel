import { useEffect, useMemo, useRef, useState } from 'react';
import type { PointerEvent as ReactPointerEvent } from 'react';
import {
  Box, CheckCircle2, ChevronDown, CreditCard, Eye, EyeOff, Image as ImageIcon,
  FileText, Globe, MessageSquare, Mic, Plus, RotateCcw, ScanLine, ScrollText, Search, Settings, Trash2, Video,
  Volume2, X, Zap
} from 'lucide-react';
import type { Provider } from '../types';
import { asrProviderCatalog, type AsrProviderId } from '../asrProviders';
import { planOverriddenProviders, resolveEngineForTask, resolveVisionEngine, type TaskKind } from '../modelRouting';
import { openMaicProviderCatalog } from '../openmaicProviders';
import { localModelGet, localModelRequest, modelError, trimBaseUrl } from '../modelClient';
import {
  isServiceReady, loadServiceConfigs, saveServiceConfigs, serviceTranslateText,
  translateServiceCatalog, type ServiceConfig, type TranslateServiceId
} from '../translateServices';
import {
  tokenPlanModalityOrder, tokenPlanPresets,
  type TokenPlanModality, type TokenPlanPreset
} from '../tokenPlans';
import { loadActivePdfProviderId, pdfProviderCatalog, saveActivePdfProviderId, type PdfProviderId } from '../pdfProviders';
import {
  loadPdfTranslationSettings, savePdfTranslationSettings, type PdfTranslationSettings
} from '../pdfTranslationSettings';
import { ActivityLogPage } from './ActivityLogPage';
import { MediaRouteSettings } from './MediaRouteSettings';
import { applyAppearance } from '../uiTheme';

type SettingsSection = 'general' | 'services' | 'providers' | 'plans' | 'asr' | 'document' | 'routes' | 'logs';
type Status = { kind: 'idle' | 'testing' | 'success' | 'error'; message?: string };

const sections: { id: SettingsSection; label: string; group: string; icon: typeof Settings }[] = [
  { id: 'routes', label: '模型与引擎', group: '工作', icon: Zap },
  { id: 'document', label: '文档处理', group: '工作', icon: ScanLine },
  { id: 'asr', label: '语音识别', group: '工作', icon: Mic },
  { id: 'logs', label: '文本翻译日志', group: '工作', icon: ScrollText },
  { id: 'services', label: '翻译服务', group: '连接', icon: Globe },
  { id: 'providers', label: '模型供应商', group: '连接', icon: MessageSquare },
  { id: 'plans', label: 'Token Plan', group: '连接', icon: CreditCard },
  { id: 'general', label: '通用', group: '其他', icon: Settings }
];

const modalityLabels: Record<TokenPlanModality, string> = {
  llm: '模型', image: '图像', video: '视频', tts: '语音', webSearch: '联网搜索'
};
const modalityIcons: Record<TokenPlanModality, typeof MessageSquare> = {
  llm: MessageSquare, image: ImageIcon, video: Video, tts: Volume2, webSearch: Search
};

export function OpenMaicSettings({
  providers, setProviders, onClose, initialRouteTab = 'translation'
}: {
  providers: Provider[];
  setProviders: (providers: Provider[]) => void;
  onClose: () => void;
  initialRouteTab?: 'translation' | 'assistant' | 'speech';
}) {
  const [section, setSection] = useState<SettingsSection>('routes');
  const [search, setSearch] = useState('');
  const [providerSearch, setProviderSearch] = useState('');
  const [connectedOnly, setConnectedOnly] = useState(false);
  const [modelSearch, setModelSearch] = useState('');
  const [routeTab, setRouteTab] = useState<'translation' | 'assistant' | 'speech'>(initialRouteTab);
  const dialogRef = useRef<HTMLDivElement>(null);
  const searchRef = useRef<HTMLInputElement>(null);
  const [appearance, setAppearance] = useState(() => localStorage.getItem('parallel.appearance') || 'system');
  function changeAppearance(value: string) {
    setAppearance(value);
    localStorage.setItem('parallel.appearance', value);
    applyAppearance(value);
  }
  const [selectedId, setSelectedId] = useState(providers[0]?.id || 'openai');
  const [providerListWidth, setProviderListWidth] = useState(194);
  const [showKey, setShowKey] = useState(false);
  const [status, setStatus] = useState<Record<string, Status>>({});
  const [customModel, setCustomModel] = useState('');
  const [addingProvider, setAddingProvider] = useState(false);
  const [newProvider, setNewProvider] = useState({ name: '', protocol: 'openai' as Provider['protocol'], baseUrl: '', requiresApiKey: true });
  const [selectedPlanId, setSelectedPlanId] = useState<string | null>(null);
  const [planKey, setPlanKey] = useState('');
  const [showPlanKey, setShowPlanKey] = useState(false);
  const [planModality, setPlanModality] = useState<TokenPlanModality>('llm');
  const [asrConfig, setAsrConfig] = useState<Record<string, string>>(() => {
    try { return JSON.parse(localStorage.getItem('parallel.asr-config') || '{}'); }
    catch { return {}; }
  });
  const [showAsrKey, setShowAsrKey] = useState(false);
  const [asrProviderId, setAsrProviderId] = useState<AsrProviderId>(() => {
    try {
      const saved = JSON.parse(localStorage.getItem('parallel.asr-config') || '{}') as { providerId?: AsrProviderId };
      return asrProviderCatalog.some(item => item.id === saved.providerId) ? saved.providerId! : 'browser-native';
    } catch { return 'browser-native'; }
  });
  const [routes, setRoutes] = useState<Record<string, string>>(() => {
    try { return JSON.parse(localStorage.getItem('parallel.model-routes') || '{}'); }
    catch { return {}; }
  });
  const [serviceConfigs, setServiceConfigs] = useState<Record<string, ServiceConfig>>(() => loadServiceConfigs());
  const [serviceStatus, setServiceStatus] = useState<Record<string, Status>>({});
  const [pdfSettings, setPdfSettings] = useState<PdfTranslationSettings>(() => loadPdfTranslationSettings());
  const [scanProviderId, setScanProviderId] = useState<PdfProviderId>(() => loadActivePdfProviderId());

  useEffect(() => {
    const previous = document.activeElement as HTMLElement | null;
    searchRef.current?.focus();
    return () => previous?.focus();
  }, []);
  useEffect(() => {
    function keyboard(event: KeyboardEvent) {
      if (event.key === 'Escape') { event.stopPropagation(); if (search) setSearch(''); else if (addingProvider) setAddingProvider(false); else onClose(); }
      if (event.key === 'Tab') {
        const controls = Array.from(dialogRef.current?.querySelectorAll<HTMLElement>('button:not(:disabled),input:not(:disabled),select:not(:disabled),textarea:not(:disabled),[tabindex="0"]') || []).filter(el => el.offsetParent !== null);
        const first = controls[0], last = controls[controls.length - 1];
        if (event.shiftKey && document.activeElement === first) { event.preventDefault(); last?.focus(); }
        if (!event.shiftKey && document.activeElement === last) { event.preventDefault(); first?.focus(); }
      }
    }
    document.addEventListener('keydown', keyboard);
    return () => document.removeEventListener('keydown', keyboard);
  }, [addingProvider, onClose, search]);

  const sectionTerms: Record<SettingsSection, string> = {
    routes: '模型 路由 翻译引擎 对话 图片 生图 视频 生成 talk agent', document: 'pdf ocr vlm 识别 公式 扫描 排版 文档',
    providers: '供应商 key api 密钥 连接 模型', services: 'google deepl 翻译服务', plans: 'token plan 套餐 订阅',
    asr: '语音 录音 转录 asr', logs: '日志 错误 输入 输出 调用 失败', general: '外观 深色 浅色 主题 通用'
  };
  const searchTerm = search.trim().toLowerCase();
  const matchingSections = searchTerm ? sections.filter(item => `${item.label} ${sectionTerms[item.id]}`.toLowerCase().includes(searchTerm)) : [];
  const matchingProviders = searchTerm ? providers.filter(p => `${p.name} ${p.id}`.toLowerCase().includes(searchTerm)).slice(0, 6) : [];
  const visibleProviders = useMemo(() => providers.filter(provider => {
    const ready = provider.enabled && (provider.requiresApiKey === false || !!provider.key.trim());
    return (!connectedOnly || ready) && `${provider.name} ${provider.id}`.toLowerCase().includes(providerSearch.trim().toLowerCase());
  }), [providers, providerSearch, connectedOnly]);

  const selected = providers.find(provider => provider.id === selectedId) || providers[0];
  const preset = openMaicProviderCatalog.find(item => item.id === selected?.id);
  const selectedPlan = tokenPlanPresets.find(item => item.id === selectedPlanId) || null;
  const providerModels = selected?.models || [];
  const configuredCount = providers.filter(provider => provider.enabled && (provider.requiresApiKey === false || provider.key.trim())).length
    + translateServiceCatalog.filter(service => isServiceReady(service, serviceConfigs[service.id])).length;
  const documentEngine = resolveEngineForTask(providers, 'document-translation');
  const visionEngine = resolveVisionEngine(providers);
  const scanProvider = pdfProviderCatalog.find(item => item.id === scanProviderId) || pdfProviderCatalog[0];

  const patchPdfSettings = (update: Partial<PdfTranslationSettings>) => {
    const next = { ...pdfSettings, ...update };
    setPdfSettings(next);
    savePdfTranslationSettings(next);
  };

  const patchProvider = (id: string, update: Partial<Provider>) => {
    setProviders(providers.map(provider => provider.id === id ? { ...provider, ...update } : provider));
    setStatus(value => ({ ...value, [id]: { kind: 'idle' } }));
  };

  const resetProvider = () => {
    if (!selected || !preset) return;
    patchProvider(selected.id, {
      baseUrl: preset.defaultBaseUrl,
      model: preset.models[0]?.id || '',
      models: preset.models.map(model => ({ ...model })),
      requiresApiKey: preset.requiresApiKey
    });
  };

  const addModel = () => {
    const id = customModel.trim();
    if (!selected || !id || providerModels.some(model => model.id === id)) return;
    patchProvider(selected.id, { models: [...providerModels, { id, name: id }], model: id });
    setCustomModel('');
  };

  const removeModel = (id: string) => {
    if (!selected) return;
    const nextModels = providerModels.filter(model => model.id !== id);
    patchProvider(selected.id, {
      models: nextModels,
      model: selected.model === id ? (nextModels[0]?.id || '') : selected.model
    });
  };

  const verifyConnection = async () => {
    if (!selected) return;
    setStatus(value => ({ ...value, [selected.id]: { kind: 'testing' } }));
    const baseUrl = trimBaseUrl(selected.baseUrl);
    const model = selected.model || selected.models?.[0]?.id || '';
    const testPrompt = 'Translate this sentence into Simplified Chinese. Return only the translation: Revenue grew steadily across all regions.';
    try {
      if (!baseUrl || !model) throw new Error('请先填写 API Host 并选择模型');
      if (selected.protocol === 'bedrock') throw new Error('当前版本尚未支持 AWS 签名，不能用于翻译');
      let url = baseUrl + '/chat/completions';
      let headers: Record<string, string> = { 'Content-Type': 'application/json' };
      let body: unknown = { model, messages: [{ role: 'user', content: testPrompt }], temperature: 0 };

      if (selected.protocol === 'anthropic') {
        url = baseUrl + '/messages';
        headers = selected.key.startsWith('sk-cp-')
          ? { ...headers, authorization: 'Bearer ' + selected.key, 'anthropic-version': '2023-06-01' }
          : { ...headers, 'x-api-key': selected.key, 'anthropic-version': '2023-06-01' };
        body = { model, messages: [{ role: 'user', content: testPrompt }], max_tokens: 2048 };
      } else if (selected.protocol === 'google') {
        url = baseUrl + '/models/' + encodeURIComponent(model) + ':generateContent?key=' + encodeURIComponent(selected.key);
        body = { contents: [{ parts: [{ text: testPrompt }] }], generationConfig: { maxOutputTokens: 64, temperature: 0 } };
      } else if (selected.protocol === 'azure') {
        url = baseUrl.includes('/deployments/')
          ? baseUrl + (baseUrl.includes('/chat/completions') ? '' : '/chat/completions') + (baseUrl.includes('?') ? '' : '?api-version=2024-10-21')
          : baseUrl + '/deployments/' + encodeURIComponent(model) + '/chat/completions?api-version=2024-10-21';
        headers = { ...headers, 'api-key': selected.key };
      } else {
        if (selected.key) headers.Authorization = 'Bearer ' + selected.key;
      }

      const response = await localModelRequest(url, headers, body);
      if (!response.ok) {
        throw await modelError(response, selected.name);
      }
      const payload = await response.json().catch(() => null) as {
        choices?: Array<{ message?: { content?: string | Array<{ type?: string; text?: string }> }; text?: string }>;
        content?: string | Array<{ type?: string; text?: string }>;
        output_text?: string;
        output?: Array<{ content?: Array<{ type?: string; text?: string }> }>;
        candidates?: Array<{ content?: { parts?: Array<{ text?: string }> } }>;
      } | null;
      const blocksText = (blocks: Array<{ type?: string; text?: string }> | undefined) => (blocks || [])
        .filter(block => !block.type || block.type === 'text' || block.type === 'output_text')
        .map(block => block.text || '').join('');
      const choice = payload?.choices?.[0]?.message?.content;
      const reply = (typeof choice === 'string' ? choice : blocksText(choice))
        || payload?.choices?.[0]?.text
        || (typeof payload?.content === 'string' ? payload.content : blocksText(payload?.content))
        || payload?.output_text
        || blocksText((payload?.output || []).flatMap(item => item.content || []))
        || (payload?.candidates?.[0]?.content?.parts || []).map(part => part.text || '').join('');
      if (!reply?.trim()) throw new Error(selected.name + ' 已响应，但没有返回可用内容');
      if (!/[\u3400-\u9fff]/.test(reply)) throw new Error(selected.name + ' 已连接，但没有返回中文译文');
      setStatus(value => ({ ...value, [selected.id]: { kind: 'success', message: '连接成功' } }));
    } catch (error) {
      setStatus(value => ({
        ...value,
        [selected.id]: { kind: 'error', message: error instanceof Error && error.message !== 'Failed to fetch' ? error.message : '无法连接本地模型代理，请确认应用由 npm run dev 启动' }
      }));
    }
  };

  const discoverModels = async () => {
    if (!selected) return;
    setStatus(value => ({ ...value, [selected.id]: { kind: 'testing', message: '正在获取模型…' } }));
    try {
      const baseUrl = selected.baseUrl.replace(/\/+$/, '');
      const auth: Record<string, string> = selected.key ? { Authorization: 'Bearer ' + selected.key } : {};
      const anthropicAuth: Record<string, string> = selected.key
        ? (selected.key.startsWith('sk-cp-')
          ? { Authorization: 'Bearer ' + selected.key, 'anthropic-version': '2023-06-01' }
          : { 'x-api-key': selected.key, 'anthropic-version': '2023-06-01' })
        : {};
      const request = async (url: string, headers: Record<string, string>) => localModelGet(url, headers);
      const listUrl = selected.protocol === 'google'
        ? baseUrl + '/models?key=' + encodeURIComponent(selected.key)
        : baseUrl + '/models';
      const listHeaders = selected.protocol === 'anthropic' ? anthropicAuth : selected.protocol === 'google' ? {} : auth;
      let response = await request(listUrl, listHeaders);
      let payload: { data?: { id: string }[]; models?: Array<{ name?: string }> } | null = null;
      if (response.ok) {
        payload = await response.json() as { data?: { id: string }[]; models?: Array<{ name?: string }> };
      }
      if (!response.ok) throw await modelError(response, selected.name);
      const remoteIds = (payload?.data || []).map(item => item.id).filter(Boolean)
        .concat((payload?.models || []).map(item => (item.name || '').replace(/^models\//, '')).filter(Boolean));
      if (!remoteIds.length) throw new Error('该服务没有返回模型列表');
      const current = selected.models || [];
      const next = [...current];
      let newCount = 0;
      remoteIds.forEach(id => {
        if (!next.some(model => model.id === id)) { next.push({ id, name: id }); newCount += 1; }
      });
      const presetModels = preset?.models || [];
      const recommendedOverlap = presetModels.filter(model => remoteIds.includes(model.id)).length;
      const coversRecommended = presetModels.length > 0 && presetModels.every(model => remoteIds.includes(model.id));
      patchProvider(selected.id, { models: next, model: selected.model || next[0]?.id || '' });
      const summary = '拉取到 ' + remoteIds.length + ' 个模型，新增 ' + newCount + ' 个'
        + '，与推荐模型重复 ' + recommendedOverlap + ' 个'
        + (presetModels.length ? (coversRecommended ? '，已覆盖全部 ' + presetModels.length + ' 个推荐模型' : '，未覆盖全部推荐模型') : '');
      setStatus(value => ({ ...value, [selected.id]: { kind: 'success', message: summary } }));
    } catch (error) {
      setStatus(value => ({ ...value, [selected.id]: { kind: 'error', message: error instanceof Error ? error.message : '获取失败' } }));
    }
  };

  const addProvider = () => {
    const name = newProvider.name.trim();
    const baseUrl = newProvider.baseUrl.trim();
    if (!name || !baseUrl) return;
    const id = 'custom-' + Date.now();
    const next: Provider = {
      id, name, prefix: id, protocol: newProvider.protocol, baseUrl, baseUrlPlaceholder: '',
      model: '', models: [], key: '', enabled: true, requiresApiKey: newProvider.requiresApiKey,
      supportsModelDiscovery: true, icon: '', alternateBaseUrls: []
    };
    setProviders([...providers, next]);
    setSelectedId(id);
    setAddingProvider(false);
    setNewProvider({ name: '', protocol: 'openai', baseUrl: '', requiresApiKey: true });
  };

  const removeProvider = (id: string) => {
    if (!id.startsWith('custom-')) return;
    const next = providers.filter(provider => provider.id !== id);
    setProviders(next);
    setSelectedId(next[0]?.id || '');
  };

  const applyPlan = (plan: TokenPlanPreset) => {
    const key = planKey.trim();
    const llm = plan.modalities.llm;
    if (!key || !llm) return;
    setProviders(providers.map(provider => provider.id === llm.providerId ? {
      ...provider,
      key,
      baseUrl: llm.baseUrl,
      protocol: llm.protocol || provider.protocol,
      model: llm.models?.[0] || provider.model,
      models: llm.models?.map(id => ({ id, name: id })) || provider.models,
      enabled: true
    } : provider));
    localStorage.setItem('parallel.active-token-plan', plan.id);
  };

  const disablePlan = (plan: TokenPlanPreset) => {
    const llmId = plan.modalities.llm?.providerId;
    if (!llmId) return;
    setProviders(providers.map(provider => provider.id === llmId ? { ...provider, key: '', enabled: false } : provider));
    localStorage.removeItem('parallel.active-token-plan');
    setPlanKey('');
  };

  const setRoute = (task: TaskKind, value: string) => {
    const next = { ...routes, [task]: value };
    setRoutes(next);
    localStorage.setItem('parallel.model-routes', JSON.stringify(next));
    if (task === 'document-vision') {
      setScanProviderId('vlm');
      saveActivePdfProviderId('vlm');
    }
  };

  const patchService = (id: TranslateServiceId, update: Partial<ServiceConfig>) => {
    const next = { ...serviceConfigs, [id]: { ...(serviceConfigs[id] || { enabled: false, key: '', baseUrl: '' }), ...update } };
    setServiceConfigs(next);
    saveServiceConfigs(next);
    setServiceStatus(value => ({ ...value, [id]: { kind: 'idle' } }));
  };

  const testService = async (id: TranslateServiceId) => {
    setServiceStatus(value => ({ ...value, [id]: { kind: 'testing' } }));
    try {
      const config = serviceConfigs[id] || { enabled: false, key: '', baseUrl: '' };
      const text = await serviceTranslateText('Hello, this is a connection test.', id, { ...config, enabled: true }, '简体中文');
      setServiceStatus(value => ({ ...value, [id]: { kind: 'success', message: '连接成功：' + text } }));
    } catch (error) {
      setServiceStatus(value => ({
        ...value,
        [id]: { kind: 'error', message: error instanceof Error ? error.message : '测试失败' }
      }));
    }
  };

  const asrPreset = asrProviderCatalog.find(item => item.id === asrProviderId) || asrProviderCatalog[0];
  const patchAsr = (update: Record<string, string>) => {
    const next = { ...asrConfig, ...update };
    setAsrConfig(next);
    localStorage.setItem('parallel.asr-config', JSON.stringify(next));
    window.dispatchEvent(new Event('parallel-asr-config'));
  };
  const selectAsrProvider = (id: AsrProviderId) => {
    setAsrProviderId(id);
    setShowAsrKey(false);
    const preset = asrProviderCatalog.find(item => item.id === id);
    patchAsr({
      providerId: id,
      baseUrl: preset?.defaultBaseUrl || '',
      model: preset?.defaultModelId || '',
      language: asrConfig.language && preset?.languages.includes(asrConfig.language) ? asrConfig.language : (preset?.languages[0] || 'auto')
    });
  };

  const routeOptions = useMemo(() => planOverriddenProviders(providers)
    .filter(provider => provider.protocol !== 'bedrock' && provider.enabled && (provider.requiresApiKey === false || provider.key))
    .flatMap(provider => (provider.models?.length ? provider.models : [{ id: provider.model, name: provider.model }])
      .filter(model => model.id)
      .map(model => ({ value: provider.id + ':' + model.id, label: provider.name + ' · ' + model.name }))), [providers]);

  const serviceOptions = useMemo(() => translateServiceCatalog
    .filter(preset => isServiceReady(preset, serviceConfigs[preset.id]))
    .map(preset => ({ value: 'service:' + preset.id, label: preset.name + ' · 翻译服务' })), [serviceConfigs]);

  const startProviderResize = (event: ReactPointerEvent) => {
    event.preventDefault();
    const startX = event.clientX;
    const startWidth = providerListWidth;
    const move = (next: PointerEvent) => setProviderListWidth(Math.max(160, Math.min(300, startWidth + next.clientX - startX)));
    const end = () => {
      window.removeEventListener('pointermove', move);
      window.removeEventListener('pointerup', end);
    };
    window.addEventListener('pointermove', move);
    window.addEventListener('pointerup', end);
  };

  return <div className="lw-modal-backdrop" onMouseDown={event => event.target === event.currentTarget && onClose()}>
    <div ref={dialogRef} className="om-settings" role="dialog" aria-modal="true" aria-label="设置">
      <header className="om-settings-header">
        <div><strong>设置</strong><span>{sections.find(s => s.id === section)?.label}</span></div>
        <div className="om-settings-search"><Search size={16}/><input ref={searchRef} aria-label="搜索设置" value={search} onChange={e => setSearch(e.target.value)} placeholder="搜索设置、供应商…"/>
          {searchTerm && <div className="om-search-results">
            {matchingSections.map(item => <button key={item.id} onClick={() => { setSection(item.id); if (/图|视频|agent|talk|对话/.test(searchTerm)) setRouteTab('assistant'); setSearch(''); }}><item.icon size={16}/><span>{item.label}</span><small>设置</small></button>)}
            {matchingProviders.map(provider => <button key={provider.id} onClick={() => { setSection('providers'); setSelectedId(provider.id); setShowKey(false); setSearch(''); setProviderSearch(''); setConnectedOnly(false); }}><ProviderIcon provider={provider}/><span>{provider.name}</span><small>供应商</small></button>)}
            {!matchingSections.length && !matchingProviders.length && <p>没有找到相关设置</p>}
          </div>}
        </div>
        <button onClick={onClose} aria-label="关闭"><X size={19}/></button>
      </header>

      <div className="om-settings-shell">
        <nav className="om-settings-nav">
          {sections.map((item, index) => {
            const Icon = item.icon;
            return <div className="om-nav-item" key={item.id}>
              {(index === 0 || sections[index - 1].group !== item.group) && <small>{item.group}</small>}
              <button aria-label={item.label} title={item.label} aria-current={section === item.id ? 'page' : undefined} className={section === item.id ? 'active' : ''} onClick={() => { setSection(item.id); setSearch(''); }}>
                <Icon size={16}/><span>{item.label}</span>
              </button>
            </div>;
          })}
          <div className="om-nav-status"><CheckCircle2 size={15}/><span>{configuredCount} 个服务已连接</span></div>
        </nav>

        {section === 'providers' && <>
          <aside className="om-provider-list" style={{ width: providerListWidth }}>
            <div className="om-provider-filter"><label><Search size={14}/><input aria-label="搜索供应商" placeholder="搜索供应商" value={providerSearch} onChange={e => setProviderSearch(e.target.value)}/></label>
              <div><button className={!connectedOnly ? 'active' : ''} onClick={() => setConnectedOnly(false)}>全部</button><button className={connectedOnly ? 'active' : ''} onClick={() => setConnectedOnly(true)}>已连接</button></div>
            </div>
            <div className="om-provider-scroll">
              {visibleProviders.map(provider => <button key={provider.id} className={selected?.id === provider.id ? 'active' : ''} onClick={() => { setSelectedId(provider.id); setShowKey(false); setModelSearch(''); }}>
                <ProviderIcon provider={provider}/><span>{provider.name}</span>
                {provider.enabled && (provider.requiresApiKey === false || provider.key) && <i title="已连接"/>}
              </button>)}
              {!visibleProviders.length && <p className="om-filter-empty">{connectedOnly ? '没有匹配的已连接供应商' : '没有匹配的供应商'}</p>}
            </div>
            <button className="om-add-provider" onClick={() => setAddingProvider(true)}><Plus size={15}/>添加供应商</button>
          </aside>
          <div className="om-column-resizer" onPointerDown={startProviderResize}/>
          {selected && <main className="om-provider-config">
            <div className="om-config-title">
              <div><ProviderIcon provider={selected}/><div><h2>{selected.name}</h2><span>{selected.protocol === 'openai' ? 'OpenAI 兼容' : selected.protocol}</span></div></div>
              <div className="om-title-actions">
                {preset && <button onClick={resetProvider} title="恢复 OpenMAIC 默认配置"><RotateCcw size={15}/></button>}
                {selected.id.startsWith('custom-') && <button className="danger" onClick={() => removeProvider(selected.id)} title="删除供应商"><Trash2 size={15}/></button>}
                <button role="switch" aria-checked={selected.enabled} aria-label={'启用 ' + selected.name} className={selected.enabled ? 'om-switch on' : 'om-switch'} onClick={() => patchProvider(selected.id, { enabled: !selected.enabled })}><i/></button>
              </div>
            </div>

            <section className="om-config-section">
              <label>API Key</label>
              <div className="om-input-action">
                <div className="om-secret">
                  <input
                    type={showKey ? 'text' : 'password'}
                    autoComplete="new-password"
                    value={selected.key}
                    disabled={selected.requiresApiKey === false}
                    placeholder={selected.requiresApiKey === false ? '此服务不需要密钥' : '输入 API Key'}
                    onChange={event => patchProvider(selected.id, { key: event.target.value })}
                  />
                  <button onClick={() => setShowKey(value => !value)} disabled={selected.requiresApiKey === false}>
                    {showKey ? <EyeOff size={15}/> : <Eye size={15}/>}
                  </button>
                </div>
                <button className="om-test" disabled={status[selected.id]?.kind === 'testing' || (selected.requiresApiKey !== false && !selected.key)} onClick={() => void verifyConnection()}>
                  <Zap size={14}/>{status[selected.id]?.kind === 'testing' ? '测试中' : '测试连接'}
                </button>
              </div>
              {status[selected.id]?.message && <p className={'om-status ' + status[selected.id].kind}>{status[selected.id].message}</p>}
              <label className="om-checkbox"><input type="checkbox" checked={selected.requiresApiKey !== false} onChange={event => patchProvider(selected.id, { requiresApiKey: event.target.checked })}/>需要 API Key</label>
            </section>

            <section className="om-config-section">
              <label>API Host</label>
              <input
                value={selected.baseUrl}
                placeholder={selected.baseUrlPlaceholder || 'https://api.example.com/v1'}
                onChange={event => patchProvider(selected.id, { baseUrl: event.target.value })}
              />
              {!!selected.alternateBaseUrls?.length && <div className="om-host-options">
                {selected.alternateBaseUrls.map(item => <button key={item.url} className={selected.baseUrl === item.url ? 'active' : ''} onClick={() => patchProvider(selected.id, { baseUrl: item.url })}>{item.label}</button>)}
              </div>}
            </section>

            <section className="om-config-section om-model-section">
              <div className="om-section-heading"><div><label>模型</label><span>{providerModels.length} 个</span></div>
                <button onClick={() => void discoverModels()}><Search size={14}/>获取模型</button>
              </div>
              <select value={selected.model} onChange={event => patchProvider(selected.id, { model: event.target.value })}>
                {!providerModels.length && <option value="">尚未添加模型</option>}
                {providerModels.map(model => <option key={model.id} value={model.id}>{model.name} · {model.id}</option>)}
              </select>
              <label className="om-model-search"><Search size={14}/><input aria-label="搜索模型" value={modelSearch} onChange={e => setModelSearch(e.target.value)} placeholder="搜索模型名称或 ID"/></label>
              <div className="om-model-list">
                {providerModels.filter(model => `${model.name} ${model.id}`.toLowerCase().includes(modelSearch.toLowerCase())).map(model => <div key={model.id} className={selected.model === model.id ? 'active' : ''}>
                  <button onClick={() => patchProvider(selected.id, { model: model.id })}><strong>{model.name}</strong><code>{model.id}</code></button>
                  <button onClick={() => removeModel(model.id)} aria-label={'删除 ' + model.name}><Trash2 size={13}/></button>
                </div>)}
              </div>
              <div className="om-add-model"><input value={customModel} onChange={event => setCustomModel(event.target.value)} onKeyDown={event => event.key === 'Enter' && addModel()} placeholder="输入模型 ID"/><button disabled={!customModel.trim()} onClick={addModel}><Plus size={14}/>添加</button></div>
            </section>
          </main>}
        </>}

        {section === 'general' && <main className="om-simple-page">
          <h2>通用</h2>
          <p>调整工作台的显示方式。</p>
          <label className="om-setting-row"><span><strong>外观</strong><small>文稿本身保持原有颜色</small></span><select value={appearance} onChange={e => changeAppearance(e.target.value)}><option value="system">跟随系统</option><option value="light">浅色</option><option value="dark">深色</option></select></label>
          <div className="om-shortcuts"><h3>快捷操作</h3><p><span>上一页 / 下一页</span><kbd>← / →</kbd></p><p><span>打开设置</span><kbd>⌘ / Ctrl + ,</kbd></p><p><span>关闭面板</span><kbd>Esc</kbd></p></div>
        </main>}

        {section === 'services' && <main className="om-simple-page om-services">
          <h2>翻译服务</h2>
          <p>连接翻译接口后，在“模型与引擎”中选择使用。费用由服务供应商计收。</p>
          <div className="om-service-list">
            {translateServiceCatalog.map(preset => {
              const config = serviceConfigs[preset.id] || { enabled: false, key: '', baseUrl: preset.defaultBaseUrl || '' };
              const state = serviceStatus[preset.id];
              return <div key={preset.id} className={config.enabled ? 'om-service-card active' : 'om-service-card'}>
                <header>
                  <div><strong>{preset.name}</strong><small>{preset.description}</small></div>
                  <div className="om-title-actions">
                    <button className="om-test" disabled={state?.kind === 'testing'} onClick={() => void testService(preset.id)}>
                      <Zap size={13}/>{state?.kind === 'testing' ? '测试中' : '测试'}
                    </button>
                    <button className={config.enabled ? 'om-switch on' : 'om-switch'} onClick={() => patchService(preset.id, { enabled: !config.enabled })} aria-label={'启用 ' + preset.name}><i/></button>
                  </div>
                </header>
                {preset.requiresKey && <input
                  type="password"
                  autoComplete="new-password"
                  value={config.key}
                  placeholder={preset.keyPlaceholder || '输入 API Key'}
                  onChange={event => patchService(preset.id, { key: event.target.value })}
                />}
                {preset.needsBaseUrl && <input
                  value={config.baseUrl}
                  placeholder="http://localhost:1188/translate"
                  onChange={event => patchService(preset.id, { baseUrl: event.target.value })}
                />}
                {state?.message && <p className={'om-status ' + state.kind}>{state.message}</p>}
              </div>;
            })}
          </div>
        </main>}

        {section === 'asr' && <main className="om-simple-page om-asr">
          <h2>语音识别</h2>
          <p>同声传译先把讲话转成文字。默认用浏览器内置识别，也可以换成云端服务。</p>
          <div className="om-asr-list">
            {asrProviderCatalog.map(item => <button
              key={item.id}
              className={asrProviderId === item.id ? 'active' : ''}
              onClick={() => selectAsrProvider(item.id)}
            >
              {item.icon
                ? <img src={item.icon} alt=""/>
                : <span className="om-asr-fallback"><Mic size={15}/></span>}
              <span><strong>{item.name}</strong><small>{item.local ? '本机服务' : item.requiresApiKey ? '需要 API Key' : '无需配置'}</small></span>
              {asrProviderId === item.id && <CheckCircle2 size={15}/>}
            </button>)}
          </div>
          {asrProviderId !== 'browser-native' && asrPreset && <>
            {asrPreset.requiresApiKey && <section className="om-config-section">
              <label>API Key</label>
              <div className="om-input-action">
                <div className="om-secret">
                  <input
                    type={showAsrKey ? 'text' : 'password'}
                    autoComplete="new-password"
                    value={asrConfig.apiKey || ''}
                    placeholder="输入 API Key"
                    onChange={event => patchAsr({ apiKey: event.target.value })}
                  />
                  <button onClick={() => setShowAsrKey(value => !value)}>
                    {showAsrKey ? <EyeOff size={15}/> : <Eye size={15}/>}
                  </button>
                </div>
              </div>
            </section>}
            <section className="om-config-section">
              <label>API Host</label>
              <input
                value={asrConfig.baseUrl || asrPreset.defaultBaseUrl || ''}
                placeholder={asrPreset.baseUrlPlaceholder || 'https://api.example.com/v1'}
                onChange={event => patchAsr({ baseUrl: event.target.value })}
              />
            </section>
            {!!asrPreset.models.length && <section className="om-config-section">
              <label>模型</label>
              <select
                value={asrConfig.model || asrPreset.defaultModelId}
                onChange={event => patchAsr({ model: event.target.value })}
              >
                {asrPreset.models.map(model => <option key={model.id} value={model.id}>{model.name} · {model.id}</option>)}
              </select>
            </section>}
            <section className="om-config-section">
              <label>识别语言</label>
              <select
                value={asrConfig.language || asrPreset.languages[0] || 'auto'}
                onChange={event => patchAsr({ language: event.target.value })}
              >
                {asrPreset.languages.map(language => <option key={language} value={language}>{language}</option>)}
              </select>
            </section>
          </>}
        </main>}

        {section === 'plans' && <TokenPlanPage
          providers={providers}
          selected={selectedPlan}
          select={plan => { setSelectedPlanId(plan.id); setPlanKey(providers.find(provider => provider.id === plan.modalities.llm?.providerId)?.key || ''); setPlanModality(tokenPlanModalityOrder.find(item => plan.modalities[item]) || 'llm'); }}
          planKey={planKey}
          setPlanKey={setPlanKey}
          showKey={showPlanKey}
          toggleShow={() => setShowPlanKey(value => !value)}
          modality={planModality}
          setModality={setPlanModality}
          apply={applyPlan}
          disable={disablePlan}
        />}

        {section === 'logs' && <ActivityLogPage/>}

        {section === 'document' && <main className="om-simple-page om-document-page">
          <h2>文档处理</h2>
          <p>查看整页翻译实际使用的引擎与模型，并调整处理方式。</p>
          <section className="om-pipeline-summary">
            <div><span><FileText size={15}/></span><p><strong>翻译与排版</strong><small>{pdfSettings.layoutMode === 'precise' ? 'BabelDOC 精确内核' : 'PDFMathTranslate 快速内核'}</small></p><em>本机</em></div>
            <div><span><ScanLine size={15}/></span><p><strong>页面结构</strong><small>DocLayout-YOLO · DocStructBench ONNX</small></p><em>本地模型</em></div>
            <div><span><MessageSquare size={15}/></span><p><strong>文字翻译</strong><small>{documentEngine ? `${documentEngine.name}${documentEngine.kind === 'model' ? ` · ${documentEngine.provider.model}` : ''}` : '尚未选择'}</small></p><em>{documentEngine?.kind === 'model' ? '模型' : documentEngine ? '服务' : '未配置'}</em></div>
            <div><span><ImageIcon size={15}/></span><p><strong>视觉模型 VLM</strong><small>{visionEngine ? `${visionEngine.name} · ${visionEngine.provider.model}` : '尚未指定视觉模型'}</small></p><em>{scanProvider.id === 'vlm' && visionEngine ? '扫描页' : '未使用'}</em></div>
            <div><span><ScanLine size={15}/></span><p><strong>扫描件</strong><small>{scanProvider.id === 'unpdf' ? '检测到扫描件时再选择识别服务' : scanProvider.name}</small></p><em>按需</em></div>
          </section>

          <section className="om-document-controls">
            <label className="om-setting-row"><span><strong>处理内核</strong><small>精确模式适合演示文稿、表格与复杂版式；快速模式适合普通论文</small></span><select value={pdfSettings.layoutMode} onChange={event => patchPdfSettings({ layoutMode: event.target.value as PdfTranslationSettings['layoutMode'] })}><option value="precise">精确模式 · BabelDOC</option><option value="fast">快速模式 · PDFMathTranslate</option></select></label>
            <label className="om-setting-row"><span><strong>扫描页使用 VLM</strong><small>只在页面没有文字层时识别文字与位置，数字 PDF 不会调用</small></span><input type="checkbox" disabled={!visionEngine} checked={scanProvider.id === 'vlm' && !!visionEngine} onChange={event => { const id: PdfProviderId = event.target.checked ? 'vlm' : 'unpdf'; setScanProviderId(id); saveActivePdfProviderId(id); }}/></label>
            <label className="om-setting-row"><span><strong>并发数</strong><small>同时发送的翻译请求数量</small></span><select value={pdfSettings.threads} onChange={event => patchPdfSettings({ threads: Number(event.target.value) })}>{[1, 2, 3, 4, 6, 8].map(value => <option key={value} value={value}>{value}</option>)}</select></label>
            <label className="om-setting-row"><span><strong>复用翻译缓存</strong><small>继续翻译时不重复请求已经完成的内容</small></span><input type="checkbox" checked={pdfSettings.useCache} onChange={event => patchPdfSettings({ useCache: event.target.checked })}/></label>
            <label className="om-setting-row"><span><strong>兼容模式</strong><small>遇到结构异常的 PDF 时先转换为 PDF/A，速度会变慢</small></span><input type="checkbox" checked={pdfSettings.compatible} onChange={event => patchPdfSettings({ compatible: event.target.checked })}/></label>
            <label className="om-setting-row"><span><strong>压缩嵌入字体</strong><small>减小导出文件大小；出现字体兼容问题时可关闭</small></span><input type="checkbox" checked={pdfSettings.subsetFonts} onChange={event => patchPdfSettings({ subsetFonts: event.target.checked })}/></label>
          </section>

          <details className="om-document-advanced">
            <summary>高级选项</summary>
            <label>自定义版面模型路径<input value={pdfSettings.onnxPath} onChange={event => patchPdfSettings({ onnxPath: event.target.value })} placeholder="留空使用内置 DocLayout-YOLO"/></label>
            <label>公式字体规则<input value={pdfSettings.formulaFontRegex} onChange={event => patchPdfSettings({ formulaFontRegex: event.target.value })} placeholder="留空使用 PDFMathTranslate 默认规则"/></label>
            <label>翻译提示词<textarea value={pdfSettings.prompt} onChange={event => patchPdfSettings({ prompt: event.target.value })} placeholder="留空使用 PDFMathTranslate 默认提示词"/></label>
          </details>
        </main>}

        {section === 'routes' && <main className="om-simple-page om-routes">
          <h2>模型与引擎</h2>
          <p>为翻译、文档对话和内容生成分别选择模型。</p>
          <div className="om-task-tabs" aria-label="配置任务">{([['translation', '文档翻译'], ['assistant', '文档对话'], ['speech', '同声传译']] as const).map(([id, label]) => <button key={id} aria-pressed={routeTab === id} className={routeTab === id ? 'active' : ''} onClick={() => setRouteTab(id)}>{label}</button>)}</div>
          <section className="om-route-group" hidden={routeTab !== 'translation'}>
            <header><strong>文档翻译</strong><small>版面分析由本地 BabelDOC 完成</small></header>
            <label className="om-route-row">
              <span><strong>文字翻译</strong><small>翻译 PDF、PPT 和 HTML 中提取出的正文</small></span>
              <select value={routes['document-translation'] || ''} onChange={event => setRoute('document-translation', event.target.value)}>
                <option value="" disabled>{serviceOptions.length || routeOptions.length ? '选择翻译服务或模型' : '先连接翻译服务或模型'}</option>
                {!!serviceOptions.length && <optgroup label="翻译服务">{serviceOptions.map(option => <option key={option.value} value={option.value}>{option.label}</option>)}</optgroup>}
                {!!routeOptions.length && <optgroup label="模型">{routeOptions.map(option => <option key={option.value} value={option.value}>{option.label}</option>)}</optgroup>}
              </select>
            </label>
            <label className="om-route-row">
              <span><strong>扫描页视觉识别</strong><small>仅在没有文字层时，用 VLM 识别文字框与位置</small></span>
              <select value={routes['document-vision'] || ''} onChange={event => setRoute('document-vision', event.target.value)}>
                <option value="" disabled>{routeOptions.length ? '选择支持图片的模型' : '先连接支持图片的模型'}</option>
                {routeOptions.map(option => <option key={option.value} value={option.value}>{option.label}</option>)}
              </select>
            </label>
          </section>
          <section className="om-route-group" hidden={routeTab !== 'assistant'}>
            <header><strong>文档对话</strong><small>共用供应商密钥，独立选择各项能力</small></header>
            <label className="om-route-row"><span><strong>对话模型</strong><small>阅读文档、回答问题与规划生成内容</small></span>
              <select value={routes['document-assistant'] || ''} onChange={event => setRoute('document-assistant', event.target.value)}>
                <option value="">选择对话模型</option>
                {routeOptions.map(option => <option key={option.value} value={option.value}>{option.label}</option>)}
              </select>
            </label>
            <MediaRouteSettings providers={providers}/>
          </section>
          <section className="om-route-group" hidden={routeTab !== 'speech'}>
            <header><strong>同声传译</strong><small>语音转文字仍在“语音识别”中设置</small></header>
            <label className="om-route-row">
              <span><strong>文字翻译</strong><small>把实时识别结果翻译成目标语言</small></span>
              <select value={routes['realtime-translation'] || ''} onChange={event => setRoute('realtime-translation', event.target.value)}>
                <option value="" disabled>{serviceOptions.length || routeOptions.length ? '选择翻译服务或模型' : '先连接翻译服务或模型'}</option>
                {!!serviceOptions.length && <optgroup label="翻译服务">{serviceOptions.map(option => <option key={option.value} value={option.value}>{option.label}</option>)}</optgroup>}
                {!!routeOptions.length && <optgroup label="模型">{routeOptions.map(option => <option key={option.value} value={option.value}>{option.label}</option>)}</optgroup>}
              </select>
            </label>
          </section>
          <div className="om-route-links"><span>还没有可选模型？</span><button onClick={() => setSection('providers')}>连接供应商</button><button onClick={() => setSection('plans')}>配置 Token Plan</button></div>
        </main>}
      </div>

      {addingProvider && <div className="om-subdialog-backdrop">
        <div className="om-subdialog">
          <header><strong>添加供应商</strong><button onClick={() => setAddingProvider(false)}><X size={17}/></button></header>
          <label>名称<input value={newProvider.name} onChange={event => setNewProvider(value => ({ ...value, name: event.target.value }))} placeholder="供应商名称"/></label>
          <label>API 模式<select value={newProvider.protocol} onChange={event => setNewProvider(value => ({ ...value, protocol: event.target.value as Provider['protocol'] }))}><option value="openai">OpenAI 兼容</option><option value="anthropic">Anthropic</option><option value="google">Google</option></select></label>
          <label>API Host<input value={newProvider.baseUrl} onChange={event => setNewProvider(value => ({ ...value, baseUrl: event.target.value }))} placeholder="https://api.example.com/v1"/></label>
          <label className="om-checkbox"><input type="checkbox" checked={newProvider.requiresApiKey} onChange={event => setNewProvider(value => ({ ...value, requiresApiKey: event.target.checked }))}/>需要 API Key</label>
          <footer><button onClick={() => setAddingProvider(false)}>取消</button><button className="primary" disabled={!newProvider.name.trim() || !newProvider.baseUrl.trim()} onClick={addProvider}><Plus size={14}/>添加</button></footer>
        </div>
      </div>}
    </div>
  </div>;
}

function ProviderIcon({ provider }: { provider: Provider }) {
  const [failed, setFailed] = useState(false);
  return provider.icon && !failed
    ? <img className={'om-provider-icon ' + (['openai', 'openrouter', 'ollama'].includes(provider.id) ? 'mono' : '')} src={provider.icon} alt="" onError={() => setFailed(true)}/>
    : <span className="om-provider-fallback"><Box size={15}/></span>;
}

function TokenPlanPage({
  providers, selected, select, planKey, setPlanKey, showKey, toggleShow, modality,
  setModality, apply, disable
}: {
  providers: Provider[];
  selected: TokenPlanPreset | null;
  select: (plan: TokenPlanPreset) => void;
  planKey: string;
  setPlanKey: (key: string) => void;
  showKey: boolean;
  toggleShow: () => void;
  modality: TokenPlanModality;
  setModality: (modality: TokenPlanModality) => void;
  apply: (plan: TokenPlanPreset) => void;
  disable: (plan: TokenPlanPreset) => void;
}) {
  const enabled = selected ? !!providers.find(provider => provider.id === selected.modalities.llm?.providerId)?.key : false;
  const target = selected?.modalities[modality];
  return <main className="om-plan-page">
    <aside>
      <label>Token Plan</label>
      {tokenPlanPresets.map(plan => {
        const active = !!providers.find(provider => provider.id === plan.modalities.llm?.providerId)?.key;
        return <button key={plan.id} className={selected?.id === plan.id ? 'active' : ''} onClick={() => select(plan)}>
          <img src={plan.icon} alt=""/><span><strong>{plan.name}</strong><small>一组密钥，多种能力</small></span>{active && <CheckCircle2 size={15}/>}
        </button>;
      })}
    </aside>
    <section>
      {!selected ? <div className="om-plan-empty">选择一个 Token Plan</div> : <>
        <div className="om-plan-title"><img src={selected.icon} alt=""/><div><h2>{selected.name}</h2><a href={selected.websiteUrl} target="_blank" rel="noreferrer">服务网站</a></div></div>
        <label>API Key</label>
        <div className="om-input-action">
          <div className="om-secret"><input type={showKey ? 'text' : 'password'} value={planKey} onChange={event => setPlanKey(event.target.value)} placeholder={selected.apiKeyPlaceholder}/><button onClick={toggleShow}>{showKey ? <EyeOff size={15}/> : <Eye size={15}/>}</button></div>
          <button className={enabled ? 'om-plan-toggle on' : 'om-plan-toggle'} disabled={!enabled && !planKey.trim()} onClick={() => enabled ? disable(selected) : apply(selected)}><i/><span>{enabled ? '已启用' : '启用'}</span></button>
          {enabled && planKey.trim() && planKey !== providers.find(provider => provider.id === selected.modalities.llm?.providerId)?.key && <button className="om-test" onClick={() => apply(selected)}>更新密钥</button>}
        </div>
        <div className="om-modality-tabs">
          {tokenPlanModalityOrder.filter(item => selected.modalities[item]).map(item => {
            const Icon = modalityIcons[item];
            return <button key={item} className={modality === item ? 'active' : ''} onClick={() => setModality(item)}><Icon size={14}/>{modalityLabels[item]}</button>;
          })}
        </div>
        {target && <div className="om-plan-models">
          <div><strong>{modalityLabels[modality]}</strong><span>{target.models?.length || 1} 项</span></div>
          <code>{target.baseUrl}</code>
          <ul>{(target.models?.length ? target.models : [target.providerId]).map(model => <li key={model}>{model}</li>)}</ul>
        </div>}
      </>}
    </section>
  </main>;
}
