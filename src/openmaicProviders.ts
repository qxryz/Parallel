import type { Provider } from './types';

export type OpenMaicModel = { id: string; name: string };
export type OpenMaicProviderPreset = {
  id: string; name: string; type: NonNullable<Provider['protocol']>; defaultBaseUrl: string;
  baseUrlPlaceholder: string; supportsModelDiscovery: boolean; requiresApiKey: boolean;
  icon: string; alternateBaseUrls: { label: string; url: string }[]; models: OpenMaicModel[];
};

// Synced from OpenMAIC lib/ai/providers.ts (MIT, THU-MAIC).
export const openMaicProviderCatalog: OpenMaicProviderPreset[] = [
  {
    "id": "openai",
    "name": "OpenAI",
    "type": "openai",
    "defaultBaseUrl": "https://api.openai.com/v1",
    "baseUrlPlaceholder": "",
    "supportsModelDiscovery": false,
    "requiresApiKey": true,
    "icon": "/logos/openai.svg",
    "alternateBaseUrls": [],
    "models": [
      {
        "id": "gpt-5.6",
        "name": "GPT-5.6 Sol"
      },
      {
        "id": "gpt-5.6-terra",
        "name": "GPT-5.6 Terra"
      },
      {
        "id": "gpt-5.6-luna",
        "name": "GPT-5.6 Luna"
      },
      {
        "id": "gpt-5.5",
        "name": "GPT-5.5"
      },
      {
        "id": "gpt-5.4-pro",
        "name": "GPT-5.4 Pro"
      },
      {
        "id": "gpt-5.4",
        "name": "GPT-5.4"
      },
      {
        "id": "gpt-5.4-mini",
        "name": "GPT-5.4 Mini"
      },
      {
        "id": "gpt-5.4-nano",
        "name": "GPT-5.4 Nano"
      }
    ]
  },
  {
    "id": "azure",
    "name": "Azure OpenAI",
    "type": "azure",
    "defaultBaseUrl": "",
    "baseUrlPlaceholder": "https://YOUR-RESOURCE.openai.azure.com/openai",
    "supportsModelDiscovery": false,
    "requiresApiKey": true,
    "icon": "/logos/azure.svg",
    "alternateBaseUrls": [],
    "models": []
  },
  {
    "id": "atlascloud",
    "name": "Atlas Cloud",
    "type": "openai",
    "defaultBaseUrl": "https://api.atlascloud.ai/v1",
    "baseUrlPlaceholder": "",
    "supportsModelDiscovery": true,
    "requiresApiKey": true,
    "icon": "",
    "alternateBaseUrls": [],
    "models": [
      {
        "id": "qwen/qwen3.5-flash",
        "name": "Qwen3.5 Flash"
      },
      {
        "id": "deepseek-ai/deepseek-v4-pro",
        "name": "DeepSeek V4 Pro"
      }
    ]
  },
  {
    "id": "anthropic",
    "name": "Claude",
    "type": "anthropic",
    "defaultBaseUrl": "https://api.anthropic.com/v1",
    "baseUrlPlaceholder": "",
    "supportsModelDiscovery": false,
    "requiresApiKey": true,
    "icon": "/logos/claude.svg",
    "alternateBaseUrls": [],
    "models": [
      {
        "id": "claude-opus-5",
        "name": "Claude Opus 5"
      },
      {
        "id": "claude-sonnet-5",
        "name": "Claude Sonnet 5"
      },
      {
        "id": "claude-fable-5",
        "name": "Claude Fable 5"
      },
      {
        "id": "claude-opus-4-8",
        "name": "Claude Opus 4.8"
      },
      {
        "id": "claude-opus-4-7",
        "name": "Claude Opus 4.7"
      },
      {
        "id": "claude-opus-4-6",
        "name": "Claude Opus 4.6"
      },
      {
        "id": "claude-sonnet-4-6",
        "name": "Claude Sonnet 4.6"
      },
      {
        "id": "claude-sonnet-4-5",
        "name": "Claude Sonnet 4.5"
      },
      {
        "id": "claude-haiku-4-5",
        "name": "Claude Haiku 4.5"
      }
    ]
  },
  {
    "id": "bedrock",
    "name": "Amazon Bedrock",
    "type": "bedrock",
    "defaultBaseUrl": "",
    "baseUrlPlaceholder": "",
    "supportsModelDiscovery": false,
    "requiresApiKey": false,
    "icon": "/logos/bedrock.svg",
    "alternateBaseUrls": [],
    "models": [
      {
        "id": "us.anthropic.claude-sonnet-5",
        "name": "Claude Sonnet 5 (Bedrock)"
      },
      {
        "id": "us.anthropic.claude-opus-4-8",
        "name": "Claude Opus 4.8 (Bedrock)"
      },
      {
        "id": "us.anthropic.claude-opus-4-7",
        "name": "Claude Opus 4.7 (Bedrock)"
      },
      {
        "id": "us.anthropic.claude-sonnet-4-6",
        "name": "Claude Sonnet 4.6 (Bedrock)"
      },
      {
        "id": "us.amazon.nova-pro-v1:0",
        "name": "Amazon Nova Pro"
      },
      {
        "id": "us.amazon.nova-lite-v1:0",
        "name": "Amazon Nova Lite"
      },
      {
        "id": "us.amazon.nova-micro-v1:0",
        "name": "Amazon Nova Micro"
      },
      {
        "id": "us.meta.llama3-3-70b-instruct-v1:0",
        "name": "Llama 3.3 70B Instruct (Bedrock)"
      }
    ]
  },
  {
    "id": "google",
    "name": "Gemini",
    "type": "google",
    "defaultBaseUrl": "https://generativelanguage.googleapis.com/v1beta",
    "baseUrlPlaceholder": "",
    "supportsModelDiscovery": false,
    "requiresApiKey": true,
    "icon": "/logos/gemini.svg",
    "alternateBaseUrls": [],
    "models": [
      {
        "id": "gemini-3.6-flash",
        "name": "Gemini 3.6 Flash"
      },
      {
        "id": "gemini-3.5-flash-lite",
        "name": "Gemini 3.5 Flash-Lite"
      },
      {
        "id": "gemini-3.5-flash",
        "name": "Gemini 3.5 Flash"
      },
      {
        "id": "gemini-3.1-pro-preview",
        "name": "Gemini 3.1 Pro Preview"
      },
      {
        "id": "gemini-3-flash-preview",
        "name": "Gemini 3 Flash Preview"
      },
      {
        "id": "gemini-2.5-flash",
        "name": "Gemini 2.5 Flash"
      },
      {
        "id": "gemini-2.5-flash-lite",
        "name": "Gemini 2.5 Flash Lite"
      },
      {
        "id": "gemini-2.5-pro",
        "name": "Gemini 2.5 Pro"
      }
    ]
  },
  {
    "id": "glm",
    "name": "GLM",
    "type": "openai",
    "defaultBaseUrl": "https://open.bigmodel.cn/api/paas/v4",
    "baseUrlPlaceholder": "",
    "supportsModelDiscovery": false,
    "requiresApiKey": true,
    "icon": "/logos/glm.svg",
    "alternateBaseUrls": [
      {
        "label": "中国",
        "url": "https://open.bigmodel.cn/api/paas/v4"
      },
      {
        "label": "国际",
        "url": "https://api.z.ai/api/paas/v4"
      }
    ],
    "models": [
      {
        "id": "glm-5.2",
        "name": "GLM-5.2"
      },
      {
        "id": "glm-5.1",
        "name": "GLM-5.1"
      },
      {
        "id": "glm-5v-turbo",
        "name": "GLM-5V-Turbo"
      },
      {
        "id": "glm-5",
        "name": "GLM-5"
      },
      {
        "id": "glm-4.7",
        "name": "GLM-4.7"
      },
      {
        "id": "glm-4.7-flashx",
        "name": "GLM-4.7-FlashX"
      },
      {
        "id": "glm-4.7-flash",
        "name": "GLM-4.7-Flash"
      },
      {
        "id": "glm-4.6",
        "name": "GLM-4.6"
      },
      {
        "id": "glm-4.6v",
        "name": "GLM-4.6V"
      },
      {
        "id": "glm-4.6v-flash",
        "name": "GLM-4.6V-Flash"
      }
    ]
  },
  {
    "id": "qwen",
    "name": "Qwen",
    "type": "openai",
    "defaultBaseUrl": "https://dashscope.aliyuncs.com/compatible-mode/v1",
    "baseUrlPlaceholder": "",
    "supportsModelDiscovery": false,
    "requiresApiKey": true,
    "icon": "/logos/qwen.svg",
    "alternateBaseUrls": [],
    "models": [
      {
        "id": "qwen3.7-plus",
        "name": "Qwen3.7 Plus"
      },
      {
        "id": "qwen3.7-max",
        "name": "Qwen3.7 Max"
      },
      {
        "id": "qwen3.6-max-preview",
        "name": "Qwen3.6 Max Preview"
      },
      {
        "id": "qwen3.6-plus",
        "name": "Qwen3.6 Plus"
      },
      {
        "id": "qwen3.6-plus-2026-04-02",
        "name": "Qwen3.6 Plus (2026-04-02)"
      },
      {
        "id": "qwen3.6-flash",
        "name": "Qwen3.6 Flash"
      },
      {
        "id": "qwen3.6-flash-2026-04-16",
        "name": "Qwen3.6 Flash (2026-04-16)"
      },
      {
        "id": "qwen3.6-35b-a3b",
        "name": "Qwen3.6 35B A3B"
      },
      {
        "id": "qwen3.5-flash",
        "name": "Qwen3.5 Flash"
      },
      {
        "id": "qwen3.5-plus",
        "name": "Qwen3.5 Plus"
      },
      {
        "id": "qwen3-max",
        "name": "Qwen3 Max"
      },
      {
        "id": "qwen3-vl-plus",
        "name": "Qwen3 VL Plus"
      }
    ]
  },
  {
    "id": "deepseek",
    "name": "DeepSeek",
    "type": "openai",
    "defaultBaseUrl": "https://api.deepseek.com/v1",
    "baseUrlPlaceholder": "",
    "supportsModelDiscovery": false,
    "requiresApiKey": true,
    "icon": "/logos/deepseek.svg",
    "alternateBaseUrls": [],
    "models": [
      {
        "id": "deepseek-v4-pro",
        "name": "DeepSeek V4 Pro"
      },
      {
        "id": "deepseek-v4-flash",
        "name": "DeepSeek V4 Flash"
      }
    ]
  },
  {
    "id": "kimi",
    "name": "Kimi",
    "type": "openai",
    "defaultBaseUrl": "https://api.moonshot.cn/v1",
    "baseUrlPlaceholder": "",
    "supportsModelDiscovery": false,
    "requiresApiKey": true,
    "icon": "/logos/kimi.svg",
    "alternateBaseUrls": [
      {
        "label": "中国",
        "url": "https://api.moonshot.cn/v1"
      },
      {
        "label": "国际",
        "url": "https://api.moonshot.ai/v1"
      }
    ],
    "models": [
      {
        "id": "kimi-k3",
        "name": "Kimi K3"
      },
      {
        "id": "kimi-k2.7-code",
        "name": "Kimi K2.7 Code"
      },
      {
        "id": "kimi-k2.7-code-highspeed",
        "name": "Kimi K2.7 Code HighSpeed"
      },
      {
        "id": "kimi-k2.6",
        "name": "Kimi K2.6"
      },
      {
        "id": "kimi-k2.5",
        "name": "Kimi K2.5"
      },
      {
        "id": "kimi-k2-thinking",
        "name": "Kimi K2 Thinking"
      }
    ]
  },
  {
    "id": "minimax",
    "name": "MiniMax",
    "type": "anthropic",
    "defaultBaseUrl": "https://api.minimaxi.com/anthropic/v1",
    "baseUrlPlaceholder": "",
    "supportsModelDiscovery": false,
    "requiresApiKey": true,
    "icon": "/logos/minimax.svg",
    "alternateBaseUrls": [
      {
        "label": "中国",
        "url": "https://api.minimaxi.com/anthropic/v1"
      },
      {
        "label": "国际",
        "url": "https://api.minimax.io/anthropic/v1"
      }
    ],
    "models": [
      {
        "id": "MiniMax-M3",
        "name": "MiniMax M3"
      },
      {
        "id": "MiniMax-M2.7",
        "name": "MiniMax M2.7"
      }
    ]
  },
  {
    "id": "siliconflow",
    "name": "硅基流动",
    "type": "openai",
    "defaultBaseUrl": "https://api.siliconflow.cn/v1",
    "baseUrlPlaceholder": "",
    "supportsModelDiscovery": false,
    "requiresApiKey": true,
    "icon": "/logos/siliconflow.svg",
    "alternateBaseUrls": [],
    "models": [
      {
        "id": "deepseek-ai/DeepSeek-V3.2",
        "name": "DeepSeek-V3.2"
      },
      {
        "id": "deepseek-ai/DeepSeek-R1",
        "name": "DeepSeek-R1"
      },
      {
        "id": "deepseek-ai/DeepSeek-R1-Distill-Qwen-7B",
        "name": "DeepSeek-R1-Distill-Qwen-7B"
      },
      {
        "id": "Qwen/Qwen3-VL-32B-Instruct",
        "name": "Qwen3-VL-32B-Instruct"
      },
      {
        "id": "Pro/moonshotai/Kimi-K2.5",
        "name": "Kimi-K2.5"
      },
      {
        "id": "THUDM/GLM-4.1V-9B-Thinking",
        "name": "GLM-4.1V-9B-Thinking"
      },
      {
        "id": "THUDM/GLM-Z1-Rumination-32B-0414",
        "name": "GLM-Z1-Rumination-32B"
      }
    ]
  },
  {
    "id": "doubao",
    "name": "豆包",
    "type": "openai",
    "defaultBaseUrl": "https://ark.cn-beijing.volces.com/api/v3",
    "baseUrlPlaceholder": "",
    "supportsModelDiscovery": false,
    "requiresApiKey": true,
    "icon": "/logos/doubao.svg",
    "alternateBaseUrls": [],
    "models": [
      {
        "id": "doubao-seed-2-1-pro-260628",
        "name": "Doubao Seed 2.1 Pro"
      },
      {
        "id": "doubao-seed-2-1-turbo-260628",
        "name": "Doubao Seed 2.1 Turbo"
      },
      {
        "id": "doubao-seed-evolving",
        "name": "Doubao Seed Evolving"
      },
      {
        "id": "doubao-seed-character-260628",
        "name": "Doubao Seed Character"
      },
      {
        "id": "doubao-seed-2-0-pro-260215",
        "name": "Doubao Seed 2.0 Pro"
      },
      {
        "id": "doubao-seed-2-0-lite-260215",
        "name": "Doubao Seed 2.0 Lite"
      },
      {
        "id": "doubao-seed-2-0-mini-260215",
        "name": "Doubao Seed 2.0 Mini"
      },
      {
        "id": "doubao-seed-1-8-251228",
        "name": "Doubao Seed 1.8"
      }
    ]
  },
  {
    "id": "openrouter",
    "name": "OpenRouter",
    "type": "openai",
    "defaultBaseUrl": "https://openrouter.ai/api/v1",
    "baseUrlPlaceholder": "",
    "supportsModelDiscovery": false,
    "requiresApiKey": true,
    "icon": "/logos/openrouter.svg",
    "alternateBaseUrls": [],
    "models": [
      {
        "id": "deepseek/deepseek-v4-pro",
        "name": "DeepSeek V4 Pro"
      },
      {
        "id": "deepseek/deepseek-v4-flash",
        "name": "DeepSeek V4 Flash"
      }
    ]
  },
  {
    "id": "grok",
    "name": "Grok",
    "type": "openai",
    "defaultBaseUrl": "https://api.x.ai/v1",
    "baseUrlPlaceholder": "",
    "supportsModelDiscovery": false,
    "requiresApiKey": true,
    "icon": "/logos/grok.svg",
    "alternateBaseUrls": [],
    "models": [
      {
        "id": "grok-4.6",
        "name": "Grok 4.6"
      },
      {
        "id": "grok-4.5",
        "name": "Grok 4.5"
      },
      {
        "id": "grok-4.3",
        "name": "Grok 4.3"
      },
      {
        "id": "grok-build-0.1",
        "name": "Grok Build 0.1"
      },
      {
        "id": "grok-4.20-reasoning",
        "name": "Grok 4.20 Reasoning"
      },
      {
        "id": "grok-4.20",
        "name": "Grok 4.20"
      },
      {
        "id": "grok-4.20-multi-agent",
        "name": "Grok 4.20 Multi-Agent"
      },
      {
        "id": "grok-4-1-fast-reasoning",
        "name": "Grok 4.1 Fast Reasoning"
      },
      {
        "id": "grok-4-1-fast-non-reasoning",
        "name": "Grok 4.1 Fast"
      },
      {
        "id": "grok-code-fast-1",
        "name": "Grok Code Fast"
      }
    ]
  },
  {
    "id": "tencent-hunyuan",
    "name": "Tencent Hunyuan",
    "type": "openai",
    "defaultBaseUrl": "https://tokenhub.tencentmaas.com/v1",
    "baseUrlPlaceholder": "",
    "supportsModelDiscovery": false,
    "requiresApiKey": true,
    "icon": "/logos/hunyuan.svg",
    "alternateBaseUrls": [
      {
        "label": "中国",
        "url": "https://tokenhub.tencentmaas.com/v1"
      },
      {
        "label": "国际",
        "url": "https://tokenhub-intl.tencentmaas.com/v1"
      }
    ],
    "models": [
      {
        "id": "hy3-preview",
        "name": "Tencent Hy3 Preview"
      }
    ]
  },
  {
    "id": "xiaomi",
    "name": "Xiaomi MiMo",
    "type": "openai",
    "defaultBaseUrl": "https://api.xiaomimimo.com/v1",
    "baseUrlPlaceholder": "",
    "supportsModelDiscovery": false,
    "requiresApiKey": true,
    "icon": "/logos/xiaomi.svg",
    "alternateBaseUrls": [
      {
        "label": "按量付费",
        "url": "https://api.xiaomimimo.com/v1"
      },
      {
        "label": "Token Plan 中国",
        "url": "https://token-plan-cn.xiaomimimo.com/v1"
      },
      {
        "label": "Token Plan 新加坡",
        "url": "https://token-plan-sgp.xiaomimimo.com/v1"
      },
      {
        "label": "Token Plan 欧洲",
        "url": "https://token-plan-ams.xiaomimimo.com/v1"
      }
    ],
    "models": [
      {
        "id": "mimo-v2.5-pro",
        "name": "MiMo V2.5 Pro"
      },
      {
        "id": "mimo-v2-pro",
        "name": "MiMo V2 Pro"
      },
      {
        "id": "mimo-v2.5",
        "name": "MiMo V2.5"
      },
      {
        "id": "mimo-v2-omni",
        "name": "MiMo V2 Omni"
      },
      {
        "id": "mimo-v2-flash",
        "name": "MiMo V2 Flash"
      }
    ]
  },
  {
    "id": "ollama",
    "name": "Ollama",
    "type": "openai",
    "defaultBaseUrl": "http://localhost:11434/v1",
    "baseUrlPlaceholder": "",
    "supportsModelDiscovery": false,
    "requiresApiKey": false,
    "icon": "/logos/ollama.svg",
    "alternateBaseUrls": [],
    "models": [
      {
        "id": "llama3.3",
        "name": "Llama 3.3 70B"
      },
      {
        "id": "gemma3",
        "name": "Gemma 3 12B"
      },
      {
        "id": "deepseek-r1",
        "name": "DeepSeek R1"
      }
    ]
  },
  {
    "id": "lemonade",
    "name": "Lemonade",
    "type": "openai",
    "defaultBaseUrl": "http://localhost:13305/v1",
    "baseUrlPlaceholder": "",
    "supportsModelDiscovery": false,
    "requiresApiKey": false,
    "icon": "/logos/lemonade.svg",
    "alternateBaseUrls": [],
    "models": [
      {
        "id": "Gemma-4-26B-A4B-it-GGUF",
        "name": "Gemma 4 26B A4B IT GGUF"
      }
    ]
  }
];

export const createOpenMaicProviders = (): Provider[] => openMaicProviderCatalog.map((preset, index) => ({
  id: preset.id,
  name: preset.name,
  prefix: preset.id,
  protocol: preset.type,
  baseUrl: preset.defaultBaseUrl,
  baseUrlPlaceholder: preset.baseUrlPlaceholder,
  model: preset.models[0]?.id || '',
  models: preset.models.map(model => ({ ...model })),
  key: '',
  enabled: index === 0,
  requiresApiKey: preset.requiresApiKey,
  supportsModelDiscovery: preset.supportsModelDiscovery,
  icon: preset.icon,
  alternateBaseUrls: preset.alternateBaseUrls.map(item => ({ ...item }))
}));

