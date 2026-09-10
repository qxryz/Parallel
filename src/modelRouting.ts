import type { Provider } from './types';
import { tokenPlanPresets } from './tokenPlans';
import {
  isServiceReady, loadServiceConfigs, translateServiceCatalog,
  type ServiceConfig, type TranslateServiceId
} from './translateServices';

/** Token Plan 启用时的供应商覆写：同 id 供应商改用 Plan 的接口地址与模型列表 */
export function planOverriddenProviders(providers: Provider[]): Provider[] {
  const planKey = localStorage.getItem('parallel.active-token-plan');
  const plan = planKey ? tokenPlanPresets.find(item => item.id === planKey) : null;
  if (!plan) return providers;
  const llm = plan.modalities.llm;
  if (!llm || !llm.models?.length) return providers;
  return providers.map(provider => provider.id === llm.providerId
    ? { ...provider, baseUrl: llm.baseUrl, protocol: llm.protocol || provider.protocol, models: llm.models!.map(id => ({ id, name: id })) }
    : provider);
}

/** 解析用户为当前任务明确选择的模型。 */
export function resolveProviderForTask(
  providers: Provider[],
  task: TaskKind
): Provider | null {
  const list = planOverriddenProviders(providers);
  const connected = (provider: Provider | undefined) =>
    !!provider && provider.protocol !== 'bedrock' && provider.enabled
      && (provider.requiresApiKey === false || !!provider.key.trim());
  let route = '';
  try { route = (JSON.parse(localStorage.getItem('parallel.model-routes') || '{}') as Record<string, string>)[task] || ''; }
  catch { route = ''; }
  const separator = route.indexOf(':');
  const routedProvider = separator > 0 ? list.find(item => item.id === route.slice(0, separator)) : undefined;
  if (connected(routedProvider)) {
    const model = route.slice(separator + 1);
    return { ...routedProvider!, model: model || routedProvider!.model };
  }
  return null;
}

// —— 引擎分配：每个任务可以用翻译服务，也可以用模型 ——

export type TaskKind = 'document-translation' | 'document-vision' | 'realtime-translation' | 'document-assistant';

export type ResolvedEngine =
  | { kind: 'model'; provider: Provider; name: string }
  | { kind: 'service'; serviceId: TranslateServiceId; config: ServiceConfig; name: string };

function readRoute(task: TaskKind): string {
  try {
    return (JSON.parse(localStorage.getItem('parallel.model-routes') || '{}') as Record<string, string>)[task] || '';
  } catch { return ''; }
}

export function usableServiceEngines(): Array<{ value: string; label: string }> {
  const configs = loadServiceConfigs();
  return translateServiceCatalog
    .filter(preset => isServiceReady(preset, configs[preset.id]))
    .map(preset => ({ value: 'service:' + preset.id, label: preset.name + ' · 翻译服务' }));
}

export function resolveEngineForTask(providers: Provider[], task: TaskKind): ResolvedEngine | null {
  const route = readRoute(task);
  if (route.startsWith('service:')) {
    const serviceId = route.slice('service:'.length) as TranslateServiceId;
    const preset = translateServiceCatalog.find(item => item.id === serviceId);
    const config = loadServiceConfigs()[serviceId];
    if (preset && isServiceReady(preset, config)) {
      return { kind: 'service', serviceId, config, name: preset.name };
    }
  }
  const provider = resolveProviderForTask(providers, task);
  if (provider) return { kind: 'model', provider, name: provider.name };
  return null;
}

/** VLM must be a user-selected multimodal model; plain translation services
 * only accept text and are intentionally excluded from this route. */
export function resolveVisionEngine(providers: Provider[]): Extract<ResolvedEngine, { kind: 'model' }> | null {
  const engine = resolveEngineForTask(providers, 'document-vision');
  return engine?.kind === 'model' ? engine : null;
}
