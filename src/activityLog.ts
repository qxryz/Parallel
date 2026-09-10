import type { ResolvedEngine } from './modelRouting';
import { addActivityLog, type ActivityLogScope, type ActivityLogStatus } from './localDb';

export type ActivityEvent = {
  traceId?: string;
  scope: ActivityLogScope;
  context?: string;
  stage: string;
  action: string;
  engineType?: string;
  engineName?: string;
  model?: string;
  status: ActivityLogStatus;
  durationMs?: number;
  detail?: string;
  inputPreview?: string;
  outputPreview?: string;
};

export function createTraceId(prefix: string): string {
  return `${prefix}-${Date.now()}-${Math.random().toString(36).slice(2, 9)}`;
}

export function engineActivity(engine: ResolvedEngine | null): Pick<ActivityEvent, 'engineType' | 'engineName' | 'model'> {
  if (!engine) return { engineType: '', engineName: '未配置', model: '' };
  if (engine.kind === 'service') return { engineType: '翻译服务', engineName: engine.name, model: '' };
  return { engineType: '模型', engineName: engine.name, model: engine.provider.model };
}

export function recordActivity(event: ActivityEvent): void {
  const safe = (value: string, limit: number) => value
    .replace(/Bearer\s+[^\s,;]+/gi, 'Bearer •••')
    .replace(/\bsk-[A-Za-z0-9_-]{8,}\b/g, '•••')
    .replace(/([?&](?:key|api_key|token|access_token)=)[^&\s]+/gi, '$1•••')
    .slice(0, limit);
  void addActivityLog({
    traceId: event.traceId || createTraceId(event.scope),
    scope: event.scope,
    context: event.context || '',
    stage: event.stage,
    action: event.action,
    engineType: event.engineType || '',
    engineName: event.engineName || '',
    model: event.model || '',
    status: event.status,
    durationMs: event.durationMs || 0,
    detail: safe(event.detail || '', 500),
    inputPreview: safe(event.inputPreview || '', 1600),
    outputPreview: safe(event.outputPreview || '', 1600)
  }).catch(() => undefined);
}
