import { resolveVisionEngine } from './modelRouting';
import type { Provider } from './types';

// 扫描件识别：普通文字 PDF 永远先由内置读取器检测，只有无文字层时才调用这里选择的服务。

export type PdfProviderId = 'unpdf' | 'vlm' | 'mineru' | 'mineru-cloud' | 'alidocmind';

export type PdfProviderPreset = {
  id: PdfProviderId;
  name: string;
  description: string;
  features: string[];
  badge: string;
  requiresApiKey?: boolean;
  requiresAkSk?: boolean;
  needsBaseUrl?: boolean;
  defaultBaseUrl?: string;
};

export const pdfProviderCatalog: PdfProviderPreset[] = [
  {
    id: 'unpdf',
    name: '本地读取',
    description: '只处理已有文字层的文档，扫描件不上传',
    features: ['本地', '文字层'],
    badge: '默认'
  },
  {
    id: 'vlm',
    name: '视觉模型 VLM',
    description: '扫描页没有文字层时，使用“翻译引擎”中指定的视觉模型识别文字和位置',
    features: ['扫描件', '图表', '文字框'],
    badge: '模型路由'
  },
  {
    id: 'mineru',
    name: 'MinerU',
    description: '仅在扫描件没有文字层时调用自部署服务',
    features: ['扫描件', '公式', '表格'],
    badge: '自部署',
    needsBaseUrl: true,
    defaultBaseUrl: 'http://localhost:8888'
  },
  {
    id: 'mineru-cloud',
    name: 'MinerU Cloud',
    description: '仅在扫描件没有文字层时调用官方云服务',
    features: ['扫描件', '公式', '表格'],
    badge: '云端',
    requiresApiKey: true
  },
  {
    id: 'alidocmind',
    name: '阿里 DocMind',
    description: '阿里云文档智能解析，复杂版面与扫描件更稳',
    features: ['公式', '表格', 'OCR'],
    badge: '云端',
    requiresAkSk: true
  }
];

export type PdfProviderConfig = {
  baseUrl: string;
  apiKey: string;
  accessKeyId: string;
  accessKeySecret: string;
};

const CONFIG_KEY = 'parallel.pdf-providers';
const ACTIVE_KEY = 'parallel.pdf-provider';

function emptyConfigs(): Record<PdfProviderId, PdfProviderConfig> {
  const next = {} as Record<PdfProviderId, PdfProviderConfig>;
  for (const preset of pdfProviderCatalog) {
    next[preset.id] = { baseUrl: preset.defaultBaseUrl || '', apiKey: '', accessKeyId: '', accessKeySecret: '' };
  }
  return next;
}

export function loadPdfProviderConfigs(): Record<PdfProviderId, PdfProviderConfig> {
  try {
    const saved = JSON.parse(localStorage.getItem(CONFIG_KEY) || '{}') as Record<string, Partial<PdfProviderConfig>>;
    const next = emptyConfigs();
    for (const preset of pdfProviderCatalog) {
      const item = saved[preset.id] || {};
      next[preset.id] = {
        baseUrl: item.baseUrl || preset.defaultBaseUrl || '',
        apiKey: item.apiKey || '',
        accessKeyId: item.accessKeyId || '',
        accessKeySecret: item.accessKeySecret || ''
      };
    }
    return next;
  } catch {
    return emptyConfigs();
  }
}

export function savePdfProviderConfigs(configs: Record<PdfProviderId, PdfProviderConfig>): void {
  localStorage.setItem(CONFIG_KEY, JSON.stringify(configs));
}

export function loadActivePdfProviderId(): PdfProviderId {
  const saved = localStorage.getItem(ACTIVE_KEY) as PdfProviderId | null;
  return pdfProviderCatalog.some(item => item.id === saved) ? saved! : 'unpdf';
}

export function saveActivePdfProviderId(id: PdfProviderId): void {
  localStorage.setItem(ACTIVE_KEY, id);
}

export function isPdfProviderReady(preset: PdfProviderPreset, config?: PdfProviderConfig): boolean {
  if (!config) return preset.id === 'unpdf';
  if (preset.requiresApiKey && !config.apiKey.trim()) return false;
  if (preset.requiresAkSk && !(config.accessKeyId.trim() && config.accessKeySecret.trim())) return false;
  if (preset.needsBaseUrl && !config.baseUrl.trim()) return false;
  return true;
}

export async function testPdfProvider(id: PdfProviderId, config?: PdfProviderConfig): Promise<{ ok: boolean; message: string }> {
  const item = config || loadPdfProviderConfigs()[id];
  const response = await fetch('/api/pdf/test', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({
      providerId: id,
      baseUrl: item.baseUrl,
      apiKey: item.apiKey,
      accessKeyId: item.accessKeyId,
      accessKeySecret: item.accessKeySecret
    })
  });
  const payload = await response.json().catch(() => null) as { ok?: boolean; message?: string } | null;
  return { ok: !!payload?.ok, message: payload?.message || '连接失败' };
}

// 导入 PDF 时把当前引擎配置随请求带给本地服务。
export function pdfEngineHeaders(providers: Provider[] = []): Record<string, string> {
  const id = loadActivePdfProviderId();
  const config = loadPdfProviderConfigs()[id];
  const headers: Record<string, string> = { 'x-pdf-provider': id };
  if (id === 'vlm') {
    const engine = resolveVisionEngine(providers);
    if (!engine) return headers;
    headers['x-vision-base-url'] = encodeURIComponent(engine.provider.baseUrl);
    headers['x-vision-api-key'] = encodeURIComponent(engine.provider.key);
    headers['x-vision-model'] = encodeURIComponent(engine.provider.model);
    headers['x-vision-engine-name'] = encodeURIComponent(engine.name);
    headers['x-vision-protocol'] = engine.provider.protocol || 'openai';
    return headers;
  }
  if (config?.baseUrl.trim()) headers['x-pdf-base-url'] = encodeURIComponent(config.baseUrl.trim());
  if (config?.apiKey.trim()) headers['x-pdf-api-key'] = encodeURIComponent(config.apiKey.trim());
  if (config?.accessKeyId.trim()) headers['x-pdf-ak'] = encodeURIComponent(config.accessKeyId.trim());
  if (config?.accessKeySecret.trim()) headers['x-pdf-sk'] = encodeURIComponent(config.accessKeySecret.trim());
  return headers;
}
