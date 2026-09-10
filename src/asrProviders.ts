export type AsrProviderId =
  | 'browser-native'
  | 'openai-whisper'
  | 'qwen-asr'
  | 'azure-asr'
  | 'funasr-asr'
  | 'lemonade-asr'
  | `custom-asr-${string}`;

export type AsrProviderConfig = {
  id: AsrProviderId;
  name: string;
  requiresApiKey: boolean;
  defaultBaseUrl?: string;
  baseUrlPlaceholder?: string;
  icon: string;
  models: { id: string; name: string }[];
  defaultModelId: string;
  languages: string[];
  formats: string[];
  /** 本机局域网服务，只在服务启动时可用 */
  local?: boolean;
  /** 云端转写的录音分段间隔（毫秒），浏览器识别为 0 */
  chunkIntervalMs: number;
};

// Synced from OpenMAIC lib/audio/constants.ts (MIT, THU-MAIC).
export const asrProviderCatalog: AsrProviderConfig[] = [
  {
    id: 'browser-native',
    name: '浏览器识别',
    requiresApiKey: false,
    icon: '',
    models: [],
    defaultModelId: '',
    languages: ['zh-CN', 'en-US'],
    formats: ['webm'],
    chunkIntervalMs: 0
  },
  {
    id: 'openai-whisper',
    name: 'OpenAI Whisper',
    requiresApiKey: true,
    defaultBaseUrl: 'https://api.openai.com/v1',
    baseUrlPlaceholder: 'https://api.openai.com/v1',
    icon: '/logos/openai.svg',
    models: [
      { id: 'gpt-4o-mini-transcribe', name: 'GPT-4o Mini Transcribe' },
      { id: 'gpt-4o-transcribe', name: 'GPT-4o Transcribe' },
    ],
    defaultModelId: 'gpt-4o-mini-transcribe',
    languages: ['auto', 'zh', 'en', 'ja', 'ko', 'es', 'fr', 'de', 'ru'],
    formats: ['mp3', 'mp4', 'm4a', 'wav', 'webm'],
    chunkIntervalMs: 5000
  },
  {
    id: 'qwen-asr',
    name: 'Qwen ASR（阿里云百炼）',
    requiresApiKey: true,
    defaultBaseUrl: 'https://dashscope.aliyuncs.com/api/v1',
    baseUrlPlaceholder: 'https://dashscope.aliyuncs.com/api/v1',
    icon: '/logos/qwen.svg',
    models: [{ id: 'qwen3-asr-flash', name: 'Qwen3 ASR Flash' }],
    defaultModelId: 'qwen3-asr-flash',
    languages: ['auto', 'zh', 'yue', 'en', 'ja', 'ko', 'de', 'fr', 'ru', 'es', 'pt', 'ar', 'it', 'hi'],
    formats: ['mp3', 'wav', 'webm', 'm4a', 'flac'],
    chunkIntervalMs: 5000
  },
  {
    id: 'azure-asr',
    name: 'Azure 语音识别',
    requiresApiKey: true,
    defaultBaseUrl: 'https://{region}.api.cognitive.microsoft.com',
    baseUrlPlaceholder: 'https://你的区域.api.cognitive.microsoft.com',
    icon: '/logos/azure.svg',
    models: [],
    defaultModelId: '',
    languages: ['auto', 'en', 'zh', 'ja', 'ko', 'de', 'fr', 'es', 'it', 'pt', 'ru', 'ar', 'hi'],
    formats: ['wav', 'ogg', 'webm', 'mp3', 'flac', 'm4a'],
    chunkIntervalMs: 5000
  },
  {
    id: 'funasr-asr',
    name: 'FunASR（本机）',
    requiresApiKey: false,
    defaultBaseUrl: 'http://localhost:8000/v1',
    baseUrlPlaceholder: 'http://localhost:8000/v1',
    icon: '',
    models: [
      { id: 'sensevoice', name: 'SenseVoiceSmall' },
      { id: 'paraformer', name: 'Paraformer' },
      { id: 'fun-asr-nano', name: 'Fun-ASR-Nano' },
    ],
    defaultModelId: 'sensevoice',
    languages: ['auto', 'zh', 'en', 'ja', 'ko', 'yue'],
    formats: ['wav'],
    local: true,
    chunkIntervalMs: 5000
  },
  {
    id: 'lemonade-asr',
    name: 'Lemonade ASR（本机）',
    requiresApiKey: false,
    defaultBaseUrl: 'http://localhost:13305/v1',
    baseUrlPlaceholder: 'http://localhost:13305/v1',
    icon: '/logos/lemonade.svg',
    models: [
      { id: 'Whisper-Base', name: 'Whisper Base' },
      { id: 'Whisper-Large-v3', name: 'Whisper Large v3' },
      { id: 'Whisper-Large-v3-Turbo', name: 'Whisper Large v3 Turbo' },
      { id: 'Whisper-Medium', name: 'Whisper Medium' },
      { id: 'Whisper-Small', name: 'Whisper Small' },
      { id: 'Whisper-Tiny', name: 'Whisper Tiny' },
    ],
    defaultModelId: 'Whisper-Base',
    languages: ['auto', 'zh', 'en', 'ja', 'ko', 'es', 'fr', 'de', 'ru', 'ar', 'pt', 'it', 'hi'],
    formats: ['wav'],
    local: true,
    chunkIntervalMs: 5000
  }
];

export function getAsrProvider(id: string): AsrProviderConfig | undefined {
  return asrProviderCatalog.find(item => item.id === id);
}
