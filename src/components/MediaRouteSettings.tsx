import { useState } from 'react';
import type { Provider } from '../types';
import { loadMediaRoutes, mediaAdapters, resolveMediaRoute, type MediaKind, type MediaRoute } from '../agentMedia';
import { tokenPlanPresets } from '../tokenPlans';

export function MediaRouteSettings({ providers }: { providers: Provider[] }) {
  const [routes, setRoutes] = useState(loadMediaRoutes);
  function patch(kind: MediaKind, update: Partial<MediaRoute>) {
    const next = { ...routes, [kind]: { providerId: '', adapter: '', model: '', baseUrl: '', ...routes[kind], ...update } };
    setRoutes(next);
    localStorage.setItem('parallel.media-routes', JSON.stringify(next));
  }
  const plan = tokenPlanPresets.find(p => p.id === localStorage.getItem('parallel.active-token-plan'));
  return <>{(['image', 'video'] as const).map(kind => {
    const route = routes[kind];
    const provider = providers.find(p => p.id === route?.providerId);
    const planTarget = plan?.modalities.llm?.providerId === provider?.id ? plan?.modalities[kind] : undefined;
    const models = planTarget?.models || [...new Set([...(provider?.models?.map(m => m.id) || []), ...(mediaAdapters.find(a => a.id === route?.adapter)?.models || [])])];
    let status = '';
    try { const resolved = resolveMediaRoute(kind, providers); status = `${resolved.usesPlan ? 'Token Plan · ' : ''}${resolved.provider.name} · ${resolved.model}`; }
    catch (error) { status = error instanceof Error ? error.message : ''; }
    return <details className="agent-media-settings" key={kind} open>
      <summary>{kind === 'image' ? '图片生成' : '视频生成'}</summary>
      <label>供应商<select value={route?.providerId || ''} onChange={e => patch(kind, { providerId: e.target.value, model: '', baseUrl: '' })}>
        <option value="">选择已连接的供应商</option>
        {providers.filter(p => p.enabled && (p.requiresApiKey === false || p.key.trim())).map(p => <option key={p.id} value={p.id}>{p.name}</option>)}
      </select></label>
      <label>生成接口<select value={route?.adapter || ''} onChange={e => patch(kind, { adapter: e.target.value, model: '' })}>
        <option value="">选择接口类型</option>
        {mediaAdapters.filter(a => a.kind === kind).map(a => <option key={a.id} value={a.id}>{a.name}</option>)}
      </select></label>
      <label>模型<input list={`agent-${kind}-models`} value={route?.model || ''} onChange={e => patch(kind, { model: e.target.value })} placeholder="选择或填写模型 ID"/>
        <datalist id={`agent-${kind}-models`}>{models.map(m => <option key={m} value={m}/>)}</datalist>
      </label>
      <label>API Host<input disabled={!!planTarget} value={planTarget?.baseUrl || route?.baseUrl || ''} onChange={e => patch(kind, { baseUrl: e.target.value })} placeholder={provider?.baseUrl || '留空沿用供应商地址'}/></label>
      <small>{status}</small>
    </details>;
  })}</>;
}
