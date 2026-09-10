import { useCallback, useEffect, useMemo, useState } from 'react';
import { CheckCircle2, ChevronDown, ChevronRight, CircleAlert, Clock3, FileText, RefreshCw, Search, Trash2 } from 'lucide-react';
import { clearActivityLogs, recentActivityLogs, type ActivityLog } from '../localDb';

const statusLabel: Record<ActivityLog['status'], string> = {
  running: '进行中',
  success: '完成',
  warning: '需查看',
  error: '失败',
  cancelled: '已停止'
};

function formatTime(value: string): string {
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return value;
  return new Intl.DateTimeFormat('zh-CN', {
    month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', second: '2-digit', hour12: false
  }).format(date);
}

function formatDuration(value: number): string {
  if (!value) return '—';
  if (value < 1000) return `${value} ms`;
  if (value < 60000) return `${(value / 1000).toFixed(value < 10000 ? 1 : 0)} 秒`;
  return `${Math.floor(value / 60000)} 分 ${Math.round(value % 60000 / 1000)} 秒`;
}

export function ActivityLogPage() {
  const [logs, setLogs] = useState<ActivityLog[]>([]);
  const [loading, setLoading] = useState(true);
  const [query, setQuery] = useState('');
  const [expanded, setExpanded] = useState<Set<number>>(() => new Set());
  const [confirmClear, setConfirmClear] = useState(false);

  const refresh = useCallback(async () => {
    setLoading(true);
    try { setLogs(await recentActivityLogs()); }
    finally { setLoading(false); }
  }, []);

  useEffect(() => {
    void refresh();
    const handle = () => void refresh();
    window.addEventListener('parallel-activity-log', handle);
    return () => window.removeEventListener('parallel-activity-log', handle);
  }, [refresh]);

  const filtered = useMemo(() => {
    const needle = query.trim().toLocaleLowerCase();
    return logs.filter(log => {
      if (log.scope !== 'document') return false;
      if (!needle) return true;
      return [log.context, log.stage, log.action, log.engineType, log.engineName, log.model, log.detail]
        .some(value => value.toLocaleLowerCase().includes(needle));
    });
  }, [logs, query]);

  const clear = async () => {
    await clearActivityLogs();
    setConfirmClear(false);
    setExpanded(new Set());
  };

  const toggle = (id: number) => setExpanded(current => {
    const next = new Set(current);
    if (next.has(id)) next.delete(id); else next.add(id);
    return next;
  });

  return <main className="om-simple-page om-log-page">
    <div className="om-log-heading">
      <div><h2>文本翻译日志</h2><p>查看每份文档在导入、识别、翻译和排版中实际经过的步骤。</p></div>
      <div className="om-log-actions">
        <button onClick={() => void refresh()} disabled={loading}><RefreshCw size={14}/>刷新</button>
        {confirmClear
          ? <span className="om-log-clear-confirm"><em>清空全部？</em><button onClick={() => setConfirmClear(false)}>取消</button><button className="danger" onClick={() => void clear()}>清空</button></span>
          : <button onClick={() => setConfirmClear(true)} disabled={!logs.length}><Trash2 size={14}/>清空日志</button>}
      </div>
    </div>

    <div className="om-log-privacy">输入与输出只展示截断片段并保存在本机；API Key、令牌和完整请求不会写入日志。</div>

    <div className="om-log-toolbar">
      <span className="om-log-count">{filtered.length} 条记录</span>
      <label className="om-log-search"><Search size={14}/><input value={query} onChange={event => setQuery(event.target.value)} placeholder="搜索步骤、引擎或模型"/></label>
    </div>

    <section className="om-log-list" aria-live="polite">
      {loading && !logs.length && <div className="om-log-empty"><Clock3 size={23}/><strong>正在读取日志</strong></div>}
      {!loading && !filtered.length && <div className="om-log-empty"><FileText size={23}/><strong>{logs.length ? '没有符合条件的记录' : '还没有翻译记录'}</strong><span>{logs.length ? '换个关键词试试' : '导入或翻译文档后，处理步骤会显示在这里'}</span></div>}
      {filtered.map(log => {
        const isOpen = expanded.has(log.id);
        const StatusIcon = log.status === 'success' ? CheckCircle2 : log.status === 'running' ? Clock3 : CircleAlert;
        return <article className={'om-log-row ' + log.status} key={log.id}>
          <button className="om-log-row-main" onClick={() => toggle(log.id)} aria-expanded={isOpen}>
            <span className="om-log-chevron">{isOpen ? <ChevronDown size={14}/> : <ChevronRight size={14}/>}</span>
            <span className="om-log-kind"><FileText size={14}/></span>
            <span className="om-log-primary"><strong>{log.action}</strong><small>{log.context || '文档'}</small></span>
            <span className="om-log-engine"><strong>{log.engineName || '本机'}</strong><small>{log.model || log.engineType || log.stage}</small></span>
            <span className={'om-log-status ' + log.status}><StatusIcon size={13}/>{statusLabel[log.status]}</span>
            <time>{formatTime(log.createdAt)}</time>
          </button>
          {isOpen && <div className="om-log-detail">
            <dl>
              <div><dt>步骤</dt><dd>{log.stage}</dd></div>
              <div><dt>调用</dt><dd>{[log.engineType, log.engineName].filter(Boolean).join(' · ') || '本机处理'}</dd></div>
              {!!log.model && <div><dt>模型</dt><dd>{log.model}</dd></div>}
              <div><dt>耗时</dt><dd>{formatDuration(log.durationMs)}</dd></div>
              {!!log.detail && <div><dt>说明</dt><dd>{log.detail}</dd></div>}
            </dl>
            {(log.inputPreview || log.outputPreview) && <div className="om-log-io">
              <section><header>输入</header><pre>{log.inputPreview || '没有可展示的输入'}</pre></section>
              <section><header>输出</header><pre>{log.outputPreview || '没有可展示的输出'}</pre></section>
            </div>}
          </div>}
        </article>;
      })}
    </section>
  </main>;
}
