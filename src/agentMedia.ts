import type { Provider } from './types';
import { tokenPlanPresets } from './tokenPlans';
import { modelError } from './modelClient';

export type MediaKind = 'image' | 'video';
export type MediaRoute = { providerId: string; adapter: string; model: string; baseUrl: string };
// API shapes and modality separation adapted from OpenMAIC lib/media (MIT).
export const mediaAdapters = [
  { id: 'openai-image', kind: 'image', name: 'OpenAI Images 兼容', models: ['gpt-image-1', 'gpt-image-1.5'] },
  { id: 'nano-banana', kind: 'image', name: 'Gemini 图片', models: ['gemini-2.5-flash-image', 'gemini-3.1-flash-image-preview'] },
  { id: 'seedream', kind: 'image', name: 'Seedream', models: ['doubao-seedream-4-5-251128', 'doubao-seedream-5-0-260128'] },
  { id: 'minimax-image', kind: 'image', name: 'MiniMax 图片', models: ['image-01', 'image-01-live'] },
  { id: 'seedance', kind: 'video', name: 'Seedance', models: ['doubao-seedance-2-0-260128', 'doubao-seedance-1-5-pro-251215'] },
  { id: 'minimax-video', kind: 'video', name: 'MiniMax 视频', models: ['MiniMax-Hailuo-2.3', 'MiniMax-Hailuo-02', 'T2V-01'] },
  { id: 'grok-video', kind: 'video', name: 'Grok 视频', models: ['grok-imagine-video'] }
] as const;
export function loadMediaRoutes(): Partial<Record<MediaKind, MediaRoute>> {
  try { return JSON.parse(localStorage.getItem('parallel.media-routes') || '{}'); } catch { return {}; }
}
export function resolveMediaRoute(kind: MediaKind, providers: Provider[]) {
  const route = loadMediaRoutes()[kind];
  if (!route || !route.model.trim()) throw new Error(`请在设置中选择${kind === 'image' ? '图片' : '视频'}生成模型`);
  if (!mediaAdapters.some(a => a.id === route.adapter && a.kind === kind)) throw new Error('请选择对应的生成接口');
  const provider = providers.find(p => p.id === route.providerId && p.enabled);
  if (!provider || (provider.requiresApiKey !== false && !provider.key.trim())) throw new Error('生成模型的供应商尚未连接');
  const plan = tokenPlanPresets.find(p => p.id === localStorage.getItem('parallel.active-token-plan'));
  const target = plan?.modalities[kind];
  const usesPlan = plan?.modalities.llm?.providerId === provider.id;
  if (usesPlan && (!target || target.providerId !== route.adapter || !target.models?.includes(route.model))) {
    throw new Error('所选模型不在当前 Token Plan 的对应能力中，请选择套餐模型或在设置中停用套餐');
  }
  const baseUrl = (usesPlan ? target!.baseUrl : route.baseUrl.trim() || provider.baseUrl).replace(/\/+$/, '');
  if (!/^https?:\/\//.test(baseUrl)) throw new Error('生成接口地址无效');
  return { ...route, baseUrl, provider, usesPlan };
}

type Payload = {
  id?: string; task_id?: string; request_id?: string; status?: string;
  data?: { url?: string; b64_json?: string }[];
  candidates?: { content?: { parts?: { inlineData?: { data: string; mimeType: string } }[] } }[];
  content?: { video_url?: string }; video?: { url?: string }; file_id?: string;
  file?: { download_url?: string }; error?: { message?: string };
  base_resp?: { status_code: number; status_msg: string };
  image_urls?: string[];
};
function safeMediaUrl(url: string | undefined, kind: MediaKind): string {
  if (!url || !(/^https?:\/\//.test(url) || (kind === 'image' && /^data:image\/(png|jpeg|webp);base64,/.test(url)))) throw new Error('服务没有返回可用的媒体文件');
  return url;
}
export async function generateMedia(kind: MediaKind, prompt: string, providers: Provider[], signal: AbortSignal, onStatus: (status: string) => void): Promise<string> {
  const route = resolveMediaRoute(kind, providers);
  const { provider, adapter, model } = route;
  let base = route.baseUrl;
  if (adapter.startsWith('minimax-')) base = base.replace(/\/anthropic\/v1$|\/v1$/, '');
  if ((adapter === 'seedance' || adapter === 'seedream') && !/\/api\//.test(base)) base += '/api/v3';
  if (adapter === 'nano-banana' && !/\/v1(beta)?$/.test(base)) base += '/v1beta';
  const request = async (path: string, body?: unknown): Promise<Payload> => {
    const response = await fetch('/api/model', { method: 'POST', signal, headers: { 'content-type': 'application/json' }, body: JSON.stringify({
      url: base + path, method: body === undefined ? 'GET' : 'POST', body,
      headers: { 'content-type': 'application/json', ...(adapter === 'nano-banana' ? { 'x-goog-api-key': provider.key } : provider.key ? { authorization: 'Bearer ' + provider.key } : {}) }
    }) });
    if (!response.ok) throw await modelError(response, provider.name);
    const result = await response.json() as Payload;
    if (result.error?.message || result.base_resp?.status_code) throw new Error(result.error?.message || result.base_resp?.status_msg);
    return result;
  };
  onStatus(`${provider.name} · ${model} · 正在提交`);
  if (kind === 'image') {
    if (adapter === 'nano-banana') {
      const result = await request(`/models/${encodeURIComponent(model)}:generateContent`, { contents: [{ parts: [{ text: prompt }] }], generationConfig: { responseModalities: ['TEXT', 'IMAGE'] } });
      const part = result.candidates?.[0]?.content?.parts?.find(p => p.inlineData)?.inlineData;
      return safeMediaUrl(part ? `data:${part.mimeType};base64,${part.data}` : undefined, kind);
    }
    if (adapter === 'minimax-image') {
      const result = await request('/v1/image_generation', { model, prompt, aspect_ratio: '1:1', response_format: 'url', n: 1 });
      const data = result.data as unknown as { image_urls?: string[] };
      return safeMediaUrl(data?.image_urls?.[0], kind);
    }
    const result = await request('/images/generations', { model, prompt, n: 1, size: adapter === 'seedream' ? '2K' : '1024x1024' });
    const item = result.data?.[0];
    return safeMediaUrl(item?.b64_json ? 'data:image/png;base64,' + item.b64_json : item?.url, kind);
  }
  const seedance = adapter === 'seedance';
  const minimax = adapter === 'minimax-video';
  const path = seedance ? '/contents/generations/tasks' : minimax ? '/v1/video_generation' : '/videos/generations';
  const result = await request(path, seedance
    ? { model, content: [{ type: 'text', text: prompt }], ratio: '16:9', duration: 5, resolution: '720p' }
    : { model, prompt, duration: 6, ...(minimax ? { resolution: '720P' } : {}) });
  const taskId = seedance ? result.id : minimax ? result.task_id : result.request_id;
  if (!taskId) throw new Error('服务未返回视频任务编号');
  onStatus(`${provider.name} · ${model} · 任务 ${taskId}`);
  for (let attempt = 0; attempt < 120; attempt++) {
    await new Promise<void>((resolve, reject) => {
      const abort = () => { clearTimeout(timer); reject(new DOMException('Aborted', 'AbortError')); };
      const timer = setTimeout(() => { signal.removeEventListener('abort', abort); resolve(); }, 5000);
      signal.addEventListener('abort', abort, { once: true });
      if (signal.aborted) abort();
    });
    const poll = await request(seedance ? path + '/' + encodeURIComponent(taskId) : minimax ? '/v1/query/video_generation?task_id=' + encodeURIComponent(taskId) : '/videos/' + encodeURIComponent(taskId));
    const status = poll.status?.toLowerCase();
    if (['failed', 'fail', 'expired', 'cancelled', 'error'].includes(status || '')) throw new Error('视频任务失败：' + (poll.error?.message || poll.status));
    if (['succeeded', 'success', 'done'].includes(status || '')) {
      if (minimax) {
        if (!poll.file_id) throw new Error('视频任务完成但没有文件编号');
        const file = await request('/v1/files/retrieve?file_id=' + encodeURIComponent(poll.file_id));
        return safeMediaUrl(file.file?.download_url, kind);
      }
      return safeMediaUrl(seedance ? poll.content?.video_url : poll.video?.url, kind);
    }
  }
  throw new Error(`视频仍未完成，任务编号：${taskId}。请到供应商查看，避免重复生成。`);
}
