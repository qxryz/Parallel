import type { CloudAsrConfig } from './interpretation';

async function asrFetch(url: string, init: RequestInit): Promise<Response> {
  const headers = Object.fromEntries(new Headers(init.headers).entries());
  const raw = new Request('http://localhost', { method: 'POST', body: init.body });
  if (init.body instanceof FormData) headers['content-type'] = raw.headers.get('content-type')!;
  const bytes = new Uint8Array(await raw.arrayBuffer());
  let binary = '';
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return fetch('/api/model', {
    method: 'POST', headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ url, headers, bodyBase64: btoa(binary) }),
    signal: AbortSignal.timeout(65000)
  });
}

type AsrLocaleMap = Record<string, string>;

const azureLocales: AsrLocaleMap = {
  en: 'en-US', zh: 'zh-CN', ja: 'ja-JP', ko: 'ko-KR', de: 'de-DE', fr: 'fr-FR',
  es: 'es-ES', it: 'it-IT', pt: 'pt-BR', ru: 'ru-RU', ar: 'ar-SA', hi: 'hi-IN'
};

function asEmpty(error: unknown): boolean {
  const message = error instanceof Error ? error.message : String(error ?? '');
  return message.includes('empty') || message.includes('too short');
}

async function errorText(response: Response): Promise<string> {
  return response.text().catch(() => response.statusText);
}

/**
 * 各供应商的转写请求格式与 OpenMAIC lib/audio/asr-providers.ts 保持一致。
 * 浏览器录音是 webm：OpenAI 兼容接口与 Azure 直接收，Qwen 用 base64 JSON。
 */
export async function transcribeAudio(blob: Blob, config: CloudAsrConfig): Promise<string> {
  const needsWav = config.providerId === 'qwen-asr' || config.providerId === 'funasr-asr' || config.providerId === 'lemonade-asr';
  const audio = needsWav ? await convertToWav(blob) : blob;
  switch (config.providerId) {
    case 'qwen-asr': return transcribeQwen(audio, config);
    case 'azure-asr': return transcribeAzure(audio, config);
    case 'openai-whisper': return transcribeWhisperCompatible(audio, config, 'OpenAI');
    case 'funasr-asr': return transcribeWhisperCompatible(audio, config, 'FunASR');
    case 'lemonade-asr': return transcribeWhisperCompatible(audio, config, 'Lemonade');
    default:
      if (config.providerId.startsWith('custom-asr-')) return transcribeWhisperCompatible(audio, config, '自定义服务');
      throw new Error('unsupported asr provider: ' + config.providerId);
  }
}

export function isAsrReady(config: CloudAsrConfig): boolean {
  if (!config.preset.requiresApiKey) return Boolean(config.baseUrl);
  return Boolean(config.apiKey.trim() && config.baseUrl);
}

/** OpenAI 兼容 multipart：OpenAI Whisper、FunASR、Lemonade、自定义 */
async function transcribeWhisperCompatible(blob: Blob, config: CloudAsrConfig, label: string): Promise<string> {
  const baseUrl = config.baseUrl.replace(/\/+$/, '');
  const formData = new FormData();
  formData.set('file', blob, blob.type.includes('wav') ? 'audio.wav' : blob.type.includes('mp4') ? 'audio.m4a' : blob.type.includes('ogg') ? 'audio.ogg' : 'audio.webm');
  if (config.modelId) formData.set('model', config.modelId);
  formData.set('response_format', 'json');
  if (config.language && config.language !== 'auto') formData.set('language', config.language);
  const response = await asrFetch(baseUrl + '/audio/transcriptions', {
    method: 'POST',
    headers: config.apiKey ? { Authorization: 'Bearer ' + config.apiKey } : {},
    body: formData
  });
  if (!response.ok) {
    const text = await errorText(response);
    if (text.includes('audio is empty') || text.includes('too short')) return '';
    throw new Error(label + ' 语音识别失败（HTTP ' + response.status + '）：' + text.slice(0, 160));
  }
  const payload = await response.json() as { text?: string };
  return typeof payload.text === 'string' ? payload.text : '';
}

/** DashScope base64 JSON：Qwen3 ASR */
async function transcribeQwen(blob: Blob, config: CloudAsrConfig): Promise<string> {
  const baseUrl = config.baseUrl.replace(/\/+$/, '');
  const encoded = await blobToBase64(blob);
  const body: Record<string, unknown> = {
    model: config.modelId || 'qwen3-asr-flash',
    input: { messages: [{ role: 'user', content: [{ audio: 'data:audio/wav;base64,' + encoded }] }] }
  };
  if (config.language && config.language !== 'auto') {
    body.parameters = { asr_options: { language: config.language } };
  }
  const response = await asrFetch(baseUrl + '/services/aigc/multimodal-generation/generation', {
    method: 'POST',
    headers: {
      Authorization: 'Bearer ' + config.apiKey,
      'Content-Type': 'application/json; charset=utf-8',
      'X-DashScope-Audio-Format': 'wav'
    },
    body: JSON.stringify(body)
  });
  if (!response.ok) {
    const text = await errorText(response);
    if (text.includes('audio is empty')) return '';
    throw new Error('Qwen 语音识别失败（HTTP ' + response.status + '）：' + text.slice(0, 160));
  }
  const payload = await response.json() as {
    output?: { choices?: Array<{ message?: { content?: Array<{ text?: string }> } }> };
  };
  const content = payload.output?.choices?.[0]?.message?.content;
  return content?.[0]?.text || '';
}

/** Azure Fast Transcription REST */
async function transcribeAzure(blob: Blob, config: CloudAsrConfig): Promise<string> {
  let endpoint = config.baseUrl.replace(/\/+$/, '');
  if (endpoint.includes('{region}')) throw new Error('azure-region');
  if (/\.stt\.speech\.microsoft\.com$/i.test(endpoint)) {
    endpoint = endpoint.replace(/\.stt\.speech\.microsoft\.com$/i, '.api.cognitive.microsoft.com');
  }
  if (!endpoint.includes('/speechtotext/transcriptions:transcribe')) {
    endpoint += '/speechtotext/transcriptions:transcribe';
  }
  const url = new URL(endpoint);
  if (!url.searchParams.get('api-version')) url.searchParams.set('api-version', '2025-10-15');
  const formData = new FormData();
  formData.append('audio', blob, blob.type.includes('mp4') ? 'recording.m4a' : blob.type.includes('ogg') ? 'recording.ogg' : 'recording.webm');
  if (config.language && config.language !== 'auto') {
    const locale = azureLocales[config.language] || config.language;
    formData.append('definition', JSON.stringify({ locales: [locale] }));
  }
  let response: Response;
  try {
    response = await asrFetch(url.toString(), {
      method: 'POST',
      headers: { 'Ocp-Apim-Subscription-Key': config.apiKey },
      body: formData
    });
  } catch (error) {
    if (asEmpty(error)) return '';
    throw new Error('Azure 语音识别请求失败，请检查网络与区域地址');
  }
  if (!response.ok) {
    const text = await errorText(response);
    throw new Error('Azure 语音识别失败（HTTP ' + response.status + '）：' + text.slice(0, 160));
  }
  const payload = await response.json() as {
    combinedPhrases?: Array<{ text?: string }>;
    phrases?: Array<{ text?: string }>;
  };
  const combined = (payload.combinedPhrases || []).map(item => item.text || '').filter(Boolean).join(' ');
  const phrases = (payload.phrases || []).map(item => item.text || '').filter(Boolean).join(' ');
  return combined || phrases || '';
}

function blobToBase64(blob: Blob): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => {
      const result = String(reader.result || '');
      resolve(result.slice(result.indexOf(',') + 1));
    };
    reader.onerror = () => reject(new Error('audio read failed'));
    reader.readAsDataURL(blob);
  });
}

async function convertToWav(blob: Blob): Promise<Blob> {
  if (blob.type.includes('wav')) return blob;
  const AudioContextClass = window.AudioContext || (window as unknown as { webkitAudioContext: typeof AudioContext }).webkitAudioContext;
  const context = new AudioContextClass();
  try {
    const decoded = await context.decodeAudioData((await blob.arrayBuffer()).slice(0));
    const channels = decoded.numberOfChannels;
    const mono = new Float32Array(decoded.length);
    for (let channel = 0; channel < channels; channel += 1) {
      const data = decoded.getChannelData(channel);
      for (let index = 0; index < data.length; index += 1) mono[index] += data[index] / channels;
    }
    const buffer = new ArrayBuffer(44 + mono.length * 2);
    const view = new DataView(buffer);
    const write = (offset: number, value: string) => {
      for (let index = 0; index < value.length; index += 1) view.setUint8(offset + index, value.charCodeAt(index));
    };
    write(0, 'RIFF');
    view.setUint32(4, 36 + mono.length * 2, true);
    write(8, 'WAVE');
    write(12, 'fmt ');
    view.setUint32(16, 16, true);
    view.setUint16(20, 1, true);
    view.setUint16(22, 1, true);
    view.setUint32(24, decoded.sampleRate, true);
    view.setUint32(28, decoded.sampleRate * 2, true);
    view.setUint16(32, 2, true);
    view.setUint16(34, 16, true);
    write(36, 'data');
    view.setUint32(40, mono.length * 2, true);
    for (let index = 0; index < mono.length; index += 1) {
      const sample = Math.max(-1, Math.min(1, mono[index]));
      view.setInt16(44 + index * 2, sample < 0 ? sample * 0x8000 : sample * 0x7fff, true);
    }
    return new Blob([buffer], { type: 'audio/wav' });
  } finally {
    void context.close().catch(() => undefined);
  }
}
