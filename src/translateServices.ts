import type { SlideData } from './types';
import { localModelGet, localModelRequest, modelError } from './modelClient';

// 翻译服务：接现成翻译接口（kiss-translator 同款思路），与模型引擎并行的另一类引擎。
export type TranslateServiceId = 'microsoft' | 'google' | 'deepl' | 'deeplx' | 'tencent' | 'volcengine' | 'yandex';

export type TranslateServicePreset = {
  id: TranslateServiceId;
  name: string;
  description: string;
  requiresKey: boolean;
  keyPlaceholder?: string;
  needsBaseUrl?: boolean;
  defaultBaseUrl?: string;
  batch: boolean;
};

export const translateServiceCatalog: TranslateServicePreset[] = [
  { id: 'microsoft', name: '微软翻译', description: 'Edge 内置引擎，免费无需密钥，支持整批翻译', requiresKey: false, batch: true },
  { id: 'google', name: 'Google 翻译', description: 'Google 免费网页接口，无需密钥', requiresKey: false, batch: false },
  { id: 'deepl', name: 'DeepL', description: '官方 API，免费版密钥以 :fx 结尾', requiresKey: true, keyPlaceholder: '输入 DeepL API Key', batch: true },
  { id: 'deeplx', name: 'DeepLX', description: '自建 DeepLX 服务，默认本机 1188 端口', requiresKey: false, needsBaseUrl: true, defaultBaseUrl: 'http://localhost:1188/translate', batch: false },
  { id: 'tencent', name: '腾讯交互翻译', description: '腾讯 TranSmart 免费接口，支持整批翻译', requiresKey: false, batch: true },
  { id: 'volcengine', name: '火山翻译', description: '字节跳动免费网页接口，无需密钥', requiresKey: false, batch: false },
  { id: 'yandex', name: 'Yandex 翻译', description: 'Yandex 免费接口，无需密钥', requiresKey: false, batch: false }
];

export type ServiceConfig = { enabled: boolean; key: string; baseUrl: string };

const STORAGE_KEY = 'parallel.translate-services';

export function loadServiceConfigs(): Record<string, ServiceConfig> {
  try {
    const saved = JSON.parse(localStorage.getItem(STORAGE_KEY) || '{}') as Record<string, Partial<ServiceConfig>>;
    const next: Record<string, ServiceConfig> = {};
    for (const preset of translateServiceCatalog) {
      const item = saved[preset.id] || {};
      next[preset.id] = {
        enabled: !!item.enabled,
        key: item.key || '',
        baseUrl: item.baseUrl || preset.defaultBaseUrl || ''
      };
    }
    return next;
  } catch {
    return {};
  }
}

export function saveServiceConfigs(configs: Record<string, ServiceConfig>): void {
  localStorage.setItem(STORAGE_KEY, JSON.stringify(configs));
}

export function isServiceReady(preset: TranslateServicePreset, config?: ServiceConfig): boolean {
  if (!config?.enabled) return false;
  if (preset.requiresKey && !config.key.trim()) return false;
  if (preset.needsBaseUrl && !config.baseUrl.trim()) return false;
  return true;
}

export function serviceEngineName(serviceId: string): string {
  return translateServiceCatalog.find(item => item.id === serviceId)?.name || serviceId;
}

// —— 语言代码 ——

function normalize(language: string): 'zh' | 'en' | 'ja' | 'auto' {
  const value = language.trim().toLowerCase();
  if (!value || value === 'auto') return 'auto';
  if (value.startsWith('zh') || language.includes('中文')) return 'zh';
  if (value.startsWith('en') || language.includes('英')) return 'en';
  if (value.startsWith('ja') || value.startsWith('jp') || language.includes('日')) return 'ja';
  return 'auto';
}

function serviceLang(id: TranslateServiceId, language: string): string {
  const base = normalize(language);
  if (base === 'auto') return '';
  switch (id) {
    case 'microsoft':
      return base === 'zh' ? 'zh-Hans' : base;
    case 'yandex':
      return base === 'zh' ? 'zh' : base;
    case 'deepl':
    case 'deeplx':
      return base === 'zh' ? 'ZH' : base === 'en' ? 'EN' : 'JA';
    case 'tencent':
    case 'volcengine':
      return base;
    default:
      return base === 'zh' ? 'zh-CN' : base;
  }
}

// —— 请求 ——

type ServiceRequest = { url: string; headers: Record<string, string>; body?: unknown; method: 'GET' | 'POST' };

function buildRequest(
  id: TranslateServiceId,
  texts: string[],
  to: string,
  config: ServiceConfig
): ServiceRequest {
  switch (id) {
    case 'microsoft': {
      const query = new URLSearchParams({ from: '', to, isEnterpriseClient: 'false' });
      return {
        url: 'https://edge.microsoft.com/translate/translatetext?' + query.toString(),
        headers: { 'content-type': 'application/json' },
        body: texts,
        method: 'POST'
      };
    }
    case 'google': {
      const query = new URLSearchParams({ client: 'gtx', dt: 't', dj: '1', ie: 'UTF-8', sl: 'auto', tl: to, q: texts.join(' ') });
      return { url: 'https://translate.googleapis.com/translate_a/single?' + query.toString(), headers: {}, method: 'GET' };
    }
    case 'deepl': {
      const host = config.key.trim().endsWith(':fx') ? 'https://api-free.deepl.com/v2' : 'https://api.deepl.com/v2';
      return {
        url: host + '/translate',
        headers: { 'content-type': 'application/json', Authorization: 'DeepL-Auth-Key ' + config.key.trim() },
        body: { text: texts, target_lang: to },
        method: 'POST'
      };
    }
    case 'deeplx':
      return {
        url: config.baseUrl.trim(),
        headers: { 'content-type': 'application/json' },
        body: { text: texts.join('\n'), source_lang: 'auto', target_lang: to },
        method: 'POST'
      };
    case 'tencent':
      return {
        url: 'https://transmart.qq.com/api/imt',
        headers: { 'content-type': 'application/json', referer: 'https://transmart.qq.com/zh-CN/index' },
        body: {
          header: { fn: 'auto_translation', client_key: 'browser-chrome-110.0.0-Mac OS-df4bd4c5-a65d-44b2-a40f-42f34f3535f2-1677486696487' },
          type: 'plain',
          model_category: 'normal',
          source: { text_list: texts, lang: 'auto' },
          target: { lang: to }
        },
        method: 'POST'
      };
    case 'volcengine':
      return {
        url: 'https://translate.volcengine.com/crx/translate/v1',
        headers: { 'content-type': 'application/json' },
        body: { source_language: 'auto', target_language: to, text: texts.join(' ') },
        method: 'POST'
      };
    case 'yandex': {
      let nonce = '';
      for (let i = 0; i < 32; i++) nonce += Math.floor(Math.random() * 16).toString(16);
      const query = new URLSearchParams({
        // Yandex Free 当前会拒绝 source_lang=auto；本产品的文档工作流为英文原文。
        id: nonce + '-0-0', srv: 'android', source_lang: 'en', target_lang: to, text: texts.join('\n')
      });
      return { url: 'https://translate.yandex.net/api/v1/tr.json/translate?' + query.toString(), headers: {}, method: 'POST' };
    }
  }
}

// 统一解析各服务返回，输出与输入等长的译文数组
async function callService(
  id: TranslateServiceId,
  texts: string[],
  to: string,
  config: ServiceConfig
): Promise<string[]> {
  const request = buildRequest(id, texts, to, config);
  const response = request.method === 'GET'
    ? await localModelGet(request.url, request.headers)
    : await localModelRequest(request.url, request.headers, request.body);
  if (!response.ok) throw await modelError(response, serviceEngineName(id));
  const raw = await response.json().catch(() => null);
  const fail = () => new Error(serviceEngineName(id) + ' 没有返回译文');
  switch (id) {
    case 'microsoft': {
      const list = raw as Array<{ translations?: { text?: string }[] }> | null;
      if (!Array.isArray(list)) throw fail();
      return list.map(item => (item.translations || []).map(t => t.text || '').join(''));
    }
    case 'google': {
      const payload = raw as { sentences?: { trans?: string }[] } | null;
      const text = (payload?.sentences || []).map(item => item.trans || '').join('');
      if (!text) throw fail();
      return [text];
    }
    case 'deepl': {
      const payload = raw as { translations?: { text?: string }[] } | null;
      if (!Array.isArray(payload?.translations)) throw fail();
      return payload!.translations!.map(item => item.text || '');
    }
    case 'deeplx': {
      const payload = raw as { code?: number; data?: string } | null;
      if (!payload?.data) throw fail();
      return [payload.data];
    }
    case 'tencent': {
      const payload = raw as { auto_translation?: string[] } | null;
      if (!Array.isArray(payload?.auto_translation)) throw fail();
      return payload!.auto_translation!;
    }
    case 'volcengine': {
      const payload = raw as { translation?: string } | null;
      if (!payload?.translation) throw fail();
      return [payload.translation];
    }
    case 'yandex': {
      const payload = raw as { text?: string[] } | null;
      const text = (payload?.text || []).join('');
      if (!text) throw fail();
      return [text];
    }
  }
}

function ensureServiceTranslation(_source: string, translated: string, name: string): string {
  const output = translated.trim();
  if (!output) throw new Error(name + ' 没有返回译文');
  return output;
}

function chunk<T>(items: T[], size: number): T[][] {
  const out: T[][] = [];
  for (let i = 0; i < items.length; i += size) out.push(items.slice(i, i + size));
  return out;
}

async function pool(jobs: Array<() => Promise<void>>, limit: number): Promise<void> {
  let cursor = 0;
  const workers = Array.from({ length: Math.min(limit, jobs.length) }, async () => {
    while (cursor < jobs.length) {
      const job = jobs[cursor];
      cursor += 1;
      await job();
    }
  });
  await Promise.all(workers);
}

// 翻译一组文本：整批接口直接送，单条接口并发请求，顺序与输入一致
export async function serviceTranslateTexts(
  texts: string[],
  serviceId: TranslateServiceId,
  config: ServiceConfig,
  targetLanguage: string,
  onOne?: (index: number, text: string) => void
): Promise<string[]> {
  const preset = translateServiceCatalog.find(item => item.id === serviceId);
  if (!preset) throw new Error('未知的翻译服务');
  if (!isServiceReady(preset, config)) throw new Error('先在设置的翻译服务里启用「' + preset.name + '」');
  const to = serviceLang(serviceId, targetLanguage) || 'zh-CN';
  const results = new Array<string>(texts.length).fill('');
  let failed: Error | null = null;

  if (preset.batch) {
    const groups = chunk(texts.map((text, index) => ({ text, index })), 32);
    await pool(groups.map(group => async () => {
      try {
        const output = await callService(serviceId, group.map(item => item.text), to, config);
        group.forEach((item, offset) => {
          const text = ensureServiceTranslation(item.text, output[offset] || '', preset.name);
          if (text) {
            results[item.index] = text;
            onOne?.(item.index, text);
          }
        });
      } catch (error) {
        failed = error instanceof Error ? error : new Error('翻译失败');
      }
    }), 2);
  } else {
    await pool(texts.map((text, index) => async () => {
      if (!text.trim()) return;
      try {
        const output = await callService(serviceId, [text], to, config);
        const translated = ensureServiceTranslation(text, output[0] || '', preset.name);
        if (translated) {
          results[index] = translated;
          onOne?.(index, translated);
        }
      } catch (error) {
        failed = error instanceof Error ? error : new Error('翻译失败');
      }
    }), 5);
  }
  if (failed && !results.some(Boolean)) throw failed;
  return results;
}

export async function serviceTranslateText(
  text: string,
  serviceId: TranslateServiceId,
  config: ServiceConfig,
  targetLanguage: string
): Promise<string> {
  const results = await serviceTranslateTexts([text], serviceId, config, targetLanguage);
  return results[0] || '';
}

export async function translateSlideWithService(
  slide: SlideData,
  serviceId: TranslateServiceId,
  config: ServiceConfig,
  targetLanguage: string,
  onSegment?: (position: number, text: string) => void
): Promise<string[]> {
  const sources = slide.sentences.map(sentence => sentence.source);
  return serviceTranslateTexts(sources, serviceId, config, targetLanguage, onSegment);
}
