import type { Provider } from './types';

export type TokenPlanModality = 'llm' | 'image' | 'video' | 'tts' | 'webSearch';
export type TokenPlanTarget = { providerId: string; baseUrl: string; protocol?: Provider['protocol']; models?: string[] };
export type TokenPlanPreset = {
  id: string; name: string; websiteUrl: string; apiKeyPlaceholder: string; icon: string;
  modalities: Partial<Record<TokenPlanModality, TokenPlanTarget>>;
};

// Synced from OpenMAIC lib/config/token-plan-presets.ts (MIT, THU-MAIC).
export const tokenPlanPresets: TokenPlanPreset[] = [
  {
    id: 'minimax', name: 'MiniMax', websiteUrl: 'https://platform.minimaxi.com',
    apiKeyPlaceholder: 'sk-...', icon: '/logos/minimax.svg',
    modalities: {
      llm: { providerId: 'minimax', baseUrl: 'https://api.minimaxi.com/anthropic/v1', protocol: 'anthropic', models: ['MiniMax-M3', 'MiniMax-M2.7', 'MiniMax-M2.7-highspeed', 'MiniMax-M2.5', 'MiniMax-M2.5-highspeed', 'MiniMax-M2.1', 'MiniMax-M2.1-highspeed', 'MiniMax-M2'] },
      image: { providerId: 'minimax-image', baseUrl: 'https://api.minimaxi.com', models: ['image-01', 'image-01-live'] },
      video: { providerId: 'minimax-video', baseUrl: 'https://api.minimaxi.com', models: ['MiniMax-Hailuo-2.3', 'MiniMax-Hailuo-02', 'T2V-01-Director', 'T2V-01'] },
      tts: { providerId: 'minimax-tts', baseUrl: 'https://api.minimaxi.com', models: ['speech-2.8-hd', 'speech-2.8-turbo', 'speech-2.6-hd', 'speech-2.6-turbo', 'speech-02-hd', 'speech-02-turbo'] },
      webSearch: { providerId: 'minimax', baseUrl: 'https://api.minimaxi.com' }
    }
  },
  {
    id: 'volcengine-ark', name: '火山方舟 Agent Plan', websiteUrl: 'https://console.volcengine.com/ark',
    apiKeyPlaceholder: 'ark-...', icon: '/logos/volcengine.svg',
    modalities: {
      llm: { providerId: 'doubao', baseUrl: 'https://ark.cn-beijing.volces.com/api/plan/v3', protocol: 'openai', models: ['ark-code-latest', 'doubao-seed-2.0-pro', 'doubao-seed-2.0-code', 'doubao-seed-2.0-lite', 'doubao-seed-2.0-mini', 'deepseek-v4-pro', 'deepseek-v4-flash', 'deepseek-v3.2', 'minimax-m3', 'minimax-m2.7', 'glm-5.2', 'glm-5.1', 'kimi-k2.7-code', 'kimi-k2.6'] },
      image: { providerId: 'seedream', baseUrl: 'https://ark.cn-beijing.volces.com/api/plan/v3', models: ['doubao-seedream-5.0-lite'] },
      video: { providerId: 'seedance', baseUrl: 'https://ark.cn-beijing.volces.com/api/plan/v3', models: ['doubao-seedance-2.0', 'doubao-seedance-1.5-pro'] },
      tts: { providerId: 'doubao-tts', baseUrl: 'https://openspeech.bytedance.com/api/v3/plan/tts' },
      webSearch: { providerId: 'doubao', baseUrl: 'https://open.feedcoopapi.com' }
    }
  }
];

export const tokenPlanModalityOrder: TokenPlanModality[] = ['llm', 'image', 'video', 'tts', 'webSearch'];
