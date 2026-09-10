import { useEffect, useMemo, useState, useRef } from 'react';
import {
  ArrowLeft, Download, FileText, FolderOpen, History, Mic, Search, Trash2, X
} from 'lucide-react';
import {
  recentSessions, recentDocuments, deleteSession, deleteDocument,
  deleteAllSessions, deleteAllDocuments, sessionTurns, loadRecording, loadDocumentFiles,
  type DocumentRecord, type InterpretationTurn, type SessionSummary
} from '../localDb';
import { mergePdfSession } from '../pdf2zhClient';
import { exportSpeechSession, recordingExtension, transcriptMarkdown } from '../speechExport';

type HistoryKind = 'documents' | 'sessions';

function formatDate(value: string | null): string {
  if (!value) return '尚未完成';
  return new Date(value).toLocaleString('zh-CN', {
    year: 'numeric', month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit'
  });
}

function downloadFile(file: File): void {
  const url = URL.createObjectURL(file);
  const anchor = document.createElement('a');
  anchor.href = url;
  anchor.download = file.name;
  document.body.appendChild(anchor);
  anchor.click();
  anchor.remove();
  window.setTimeout(() => URL.revokeObjectURL(url), 60000);
}

export function HistoryPanel({
  open,
  onClose,
  onOpenDocument
}: {
  open: boolean;
  onClose: () => void;
  onOpenDocument: (record: DocumentRecord) => Promise<void>;
}) {
  const [kind, setKind] = useState<HistoryKind>('documents');
  const [query, setQuery] = useState('');
  const [loading, setLoading] = useState(false);
  const [sessions, setSessions] = useState<SessionSummary[]>([]);
  const [documents, setDocuments] = useState<DocumentRecord[]>([]);
  const [detail, setDetail] = useState<SessionSummary | null>(null);
  const [turns, setTurns] = useState<InterpretationTurn[]>([]);
  const [recordingUrl, setRecordingUrl] = useState<string | null>(null);
  const [recordingBlob, setRecordingBlob] = useState<Blob | null>(null);
  const [sessionLoading, setSessionLoading] = useState(false);
  const [exportingSession, setExportingSession] = useState<number | null>(null);
  const sessionRequest = useRef(0);
  const audioRef = useRef<HTMLAudioElement>(null);
  const [pendingDelete, setPendingDelete] = useState<string | null>(null);
  const [exportingId, setExportingId] = useState<number | null>(null);
  const [loadError, setLoadError] = useState('');
  const [openingId, setOpeningId] = useState<number | null>(null);
  async function openDocument(item: DocumentRecord) {
    if (openingId !== null) return;
    setOpeningId(item.id);
    setLoadError('');
    try { await onOpenDocument(item); }
    catch (error) { setLoadError('打开失败：' + (error instanceof Error ? error.message : String(error))); }
    finally { setOpeningId(null); }
  }

  useEffect(() => {
    if (!open) return;
    setLoading(true);
    setDetail(null);
    setQuery('');
    setPendingDelete(null);
    setLoadError('');
    void Promise.all([recentSessions(100), recentDocuments(100)])
      .then(([nextSessions, nextDocuments]) => {
        setSessions(nextSessions);
        setDocuments(nextDocuments);
      })
      .catch(() => {
        setSessions([]);
        setDocuments([]);
        setLoadError('无法读取本地历史，请检查数据目录中的 parallel.sqlite');
      })
      .finally(() => setLoading(false));
  }, [open]);

  useEffect(() => () => {
    if (recordingUrl) URL.revokeObjectURL(recordingUrl);
  }, [recordingUrl]);

  useEffect(() => {
    if (!open) return;
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key !== 'Escape') return;
      if (detail) setDetail(null);
      else onClose();
    };
    window.addEventListener('keydown', onKeyDown);
    return () => window.removeEventListener('keydown', onKeyDown);
  }, [detail, onClose, open]);

  const filteredDocuments = useMemo(() => {
    const term = query.trim().toLocaleLowerCase();
    if (!term) return documents;
    return documents.filter(item => item.fileName.toLocaleLowerCase().includes(term));
  }, [documents, query]);

  const filteredSessions = useMemo(() => {
    const term = query.trim().toLocaleLowerCase();
    if (!term) return sessions;
    return sessions.filter(item => (
      `${item.sourceLanguage} ${item.targetLanguage} ${formatDate(item.startedAt)}`
        .toLocaleLowerCase().includes(term)
    ));
  }, [sessions, query]);

  if (!open) return null;

  const removeDocument = async (item: DocumentRecord) => {
    const key = `document-${item.id}`;
    if (pendingDelete !== key) {
      setPendingDelete(key);
      return;
    }
    try {
      await deleteDocument(item.id);
      setDocuments(list => list.filter(record => record.id !== item.id));
      setPendingDelete(null);
    } catch {
      setLoadError('删除失败，本地数据库没有完成写入');
    }
  };

  const removeSession = async (item: SessionSummary) => {
    const key = `session-${item.id}`;
    if (pendingDelete !== key) {
      setPendingDelete(key);
      return;
    }
    try {
      await deleteSession(item.id);
      setSessions(list => list.filter(record => record.id !== item.id));
      if (detail?.id === item.id) setDetail(null);
      setPendingDelete(null);
    } catch {
      setLoadError('删除失败，本地数据库没有完成写入');
    }
  };

  const clearCurrent = async () => {
    const key = `clear-${kind}`;
    if (pendingDelete !== key) {
      setPendingDelete(key);
      return;
    }
    if (kind === 'documents') {
      try {
        await deleteAllDocuments();
        setDocuments([]);
      } catch {
        setLoadError('清空失败，本地数据库没有完成写入');
        return;
      }
    } else {
      try {
        await deleteAllSessions();
        setSessions([]);
      } catch {
        setLoadError('清空失败，本地数据库没有完成写入');
        return;
      }
    }
    setPendingDelete(null);
  };

  const openSession = async (item: SessionSummary) => {
    const requestId = ++sessionRequest.current;
    setLoadError('');
    setSessionLoading(true);
    setDetail(item);
    setTurns([]);
    setRecordingBlob(null);
    if (recordingUrl) URL.revokeObjectURL(recordingUrl);
    setRecordingUrl(null);
    try {
      const [nextTurns, recording] = await Promise.all([sessionTurns(item.id), loadRecording(item.id)]);
      if (requestId !== sessionRequest.current) return;
      setTurns(nextTurns);
      setRecordingBlob(recording);
      if (recording) setRecordingUrl(URL.createObjectURL(recording));
    } catch (error) {
      if (requestId === sessionRequest.current) setLoadError('读取同传失败：' + (error instanceof Error ? error.message : String(error)));
    } finally { if (requestId === sessionRequest.current) setSessionLoading(false); }
  };

  const exportSession = async (item: SessionSummary) => {
    if (exportingSession !== null) return;
    setExportingSession(item.id);
    setLoadError('');
    try {
      const [savedTurns, audio] = await Promise.all([sessionTurns(item.id), loadRecording(item.id)]);
      downloadFile(await exportSpeechSession(item, savedTurns, audio));
    } catch (error) { setLoadError('导出失败：' + (error instanceof Error ? error.message : String(error))); }
    finally { setExportingSession(null); }
  };

  const exportDocument = async (item: DocumentRecord) => {
    setExportingId(item.id);
    const files = await loadDocumentFiles(item.id, item.fileName).catch(() => null);
    if (files?.pages.length) {
      const base = item.fileName.replace(/\.pdf$/i, '');
      const merged = await mergePdfSession(
        files.source,
        files.pages.map(page => ({ pageIndex: page.pageIndex, file: page.mono })),
        `${base}-译文.pdf`
      ).catch(() => null);
      if (merged) downloadFile(merged);
    } else if (files?.mono) downloadFile(files.mono);
    setExportingId(null);
  };

  const totalPages = documents.reduce((sum, item) => sum + item.slideCount, 0);
  const listCount = kind === 'documents' ? documents.length : sessions.length;

  return <div className="lwh-backdrop" onMouseDown={event => event.target === event.currentTarget && onClose()}>
    <aside className="lwh-panel" role="dialog" aria-modal="true" aria-label="历史">
      {detail ? <>
        <header className="lwh-detail-header">
          <button onClick={() => setDetail(null)} aria-label="返回历史列表"><ArrowLeft size={17}/></button>
          <div>
            <strong>{detail.sourceLanguage} → {detail.targetLanguage}</strong>
            <span>{formatDate(detail.startedAt)} · {detail.turnCount} 段</span>
          </div>
          <button onClick={onClose} aria-label="关闭"><X size={17}/></button>
        </header>
        <div className="lwh-detail-content">
          {loadError && <div className="lwh-storage-error" role="alert">{loadError}</div>}
          <div className="lwh-item-actions">
            <button disabled={sessionLoading || exportingSession !== null} onClick={() => void exportSession(detail)}><Download size={14}/>{exportingSession === detail.id ? '正在导出…' : '导出全部 ZIP'}</button>
            <button disabled={sessionLoading || !turns.length} onClick={() => downloadFile(new File(['\ufeff' + transcriptMarkdown(detail, turns)], `同传-${detail.id}.md`, { type: 'text/markdown;charset=utf-8' }))}>下载文字</button>
            <button disabled={!recordingBlob?.size} onClick={() => recordingBlob && downloadFile(new File([recordingBlob], `录音-${detail.id}.${recordingExtension(recordingBlob.type)}`, { type: recordingBlob.type }))}>下载录音</button>
          </div>
          {sessionLoading && <p role="status">正在读取同传记录…</p>}
          {recordingUrl && <section className="lwh-player">
            <div><Mic size={15}/><strong>录音</strong></div>
            <audio ref={audioRef} src={recordingUrl} controls preload="metadata"/>
            <small>点击文字时间可播放对应片段；浏览器识别时间为近似值。</small>
          </section>}
          <section className="lwh-transcript" aria-label="同传文本">
            {turns.length === 0
              ? <div className="lwh-empty"><Mic size={24}/><strong>没有可显示的文本</strong><span>这次同传没有保存识别内容</span></div>
              : turns.map(turn => <article className={`lwh-turn ${turn.role}`} key={turn.id}>
                <span>{turn.role === 'source' ? '原文' : '译文'}</span>
                <p>{turn.text}</p>
                <button disabled={!recordingUrl} onClick={() => {
                  if (!audioRef.current) return;
                  audioRef.current.currentTime = Math.max(0, turn.durationMs / 1000);
                  void audioRef.current.play().catch(() => { audioRef.current?.focus(); });
                }}>{Math.floor(turn.durationMs / 60000).toString().padStart(2, '0')}:{Math.floor(turn.durationMs / 1000 % 60).toString().padStart(2, '0')}</button>
              </article>)}
          </section>
        </div>
      </> : <>
        <header className="lwh-header">
          <div className="lwh-mark"><History size={18}/></div>
          <div className="lwh-heading"><strong>历史</strong><span>文稿与同传记录仅保存在这台设备</span></div>
          <button onClick={onClose} aria-label="关闭"><X size={17}/></button>
        </header>

        <section className="lwh-overview" aria-label="历史概览">
          <div><strong>{documents.length}</strong><span>份文稿</span></div>
          <div><strong>{totalPages}</strong><span>页内容</span></div>
          <div><strong>{sessions.length}</strong><span>次同传</span></div>
        </section>

        <nav className="lwh-tabs" aria-label="历史类型">
          <button className={kind === 'documents' ? 'active' : ''} onClick={() => { setKind('documents'); setPendingDelete(null); }}>
            <FileText size={15}/>文稿 <span>{documents.length}</span>
          </button>
          <button className={kind === 'sessions' ? 'active' : ''} onClick={() => { setKind('sessions'); setPendingDelete(null); }}>
            <Mic size={15}/>同传 <span>{sessions.length}</span>
          </button>
        </nav>

        <div className="lwh-toolbar">
          <label><Search size={15}/><input value={query} onChange={event => setQuery(event.target.value)} placeholder={kind === 'documents' ? '搜索文稿' : '搜索语言或日期'}/>{query && <button onClick={() => setQuery('')} aria-label="清除搜索"><X size={13}/></button>}</label>
          {listCount > 0 && <button className={pendingDelete === `clear-${kind}` ? 'confirm' : ''} onClick={() => void clearCurrent()}>
            <Trash2 size={13}/>{pendingDelete === `clear-${kind}` ? '再次点击确认' : '清空'}
          </button>}
        </div>

        {loadError && <div className="lwh-storage-error" role="alert">{loadError}</div>}

        <div className="lwh-content">
          {loading ? <div className="lwh-skeleton" aria-label="正在载入历史"><i/><i/><i/></div>
            : kind === 'documents' ? (
              filteredDocuments.length === 0
                ? <div className="lwh-empty"><FileText size={25}/><strong>{query ? '没有找到文稿' : '还没有文稿记录'}</strong><span>{query ? '换个关键词试试' : '导入的文稿和翻译进度会自动保存在这里'}</span></div>
                : <div className="lwh-list">{filteredDocuments.map(item => {
                  const deleteKey = `document-${item.id}`;
                  return <article className="lwh-item" key={item.id}>
                    <button className="lwh-item-main" disabled={openingId !== null} onClick={() => void openDocument(item)}>
                      <span className="lwh-file-icon"><FileText size={17}/></span>
                      <span className="lwh-item-copy">
                        <strong title={item.fileName}>{item.fileName}</strong>
                        <small>{formatDate(item.translatedAt || item.updatedAt)} · {item.slideCount} 页</small>
                      </span>
                      <span className={`lwh-status ${item.translatedAt ? 'done' : ''}`}>
                        {item.translatedAt ? '已完成' : item.translatedPageCount ? `${item.translatedPageCount}/${item.slideCount} 页` : '未开始'}
                      </span>
                    </button>
                    <div className="lwh-item-actions">
                      <button disabled={openingId !== null} onClick={() => void openDocument(item)}><FolderOpen size={14}/>{openingId === item.id ? '正在打开…' : '打开'}</button>
                      {(item.translatedAt || item.translatedPageCount > 0) && <button disabled={exportingId === item.id} onClick={() => void exportDocument(item)}><Download size={14}/>{exportingId === item.id ? '正在导出' : '导出'}</button>}
                      <button disabled={openingId !== null} className={pendingDelete === deleteKey ? 'danger confirm' : 'danger'} onClick={() => void removeDocument(item)}><Trash2 size={14}/>{pendingDelete === deleteKey ? '确认删除' : '删除'}</button>
                    </div>
                  </article>;
                })}</div>
            ) : (
              filteredSessions.length === 0
                ? <div className="lwh-empty"><Mic size={25}/><strong>{query ? '没有找到同传记录' : '还没有同传记录'}</strong><span>{query ? '换个关键词试试' : '结束同传后，文本与录音会保存在这里'}</span></div>
                : <div className="lwh-list">{filteredSessions.map(item => {
                  const deleteKey = `session-${item.id}`;
                  return <article className="lwh-item" key={item.id}>
                    <button className="lwh-item-main" onClick={() => void openSession(item)}>
                      <span className="lwh-file-icon session"><Mic size={17}/></span>
                      <span className="lwh-item-copy">
                        <strong>{item.sourceLanguage} → {item.targetLanguage}</strong>
                        <small>{formatDate(item.startedAt)} · {item.turnCount} 段</small>
                      </span>
                      <span className="lwh-status done">已结束</span>
                    </button>
                    <div className="lwh-item-actions">
                      <button onClick={() => void openSession(item)}><FolderOpen size={14}/>查看</button>
                      <button disabled={exportingSession !== null} onClick={() => void exportSession(item)}><Download size={14}/>{exportingSession === item.id ? '正在导出…' : '导出'}</button>
                      <button className={pendingDelete === deleteKey ? 'danger confirm' : 'danger'} onClick={() => void removeSession(item)}><Trash2 size={14}/>{pendingDelete === deleteKey ? '确认删除' : '删除'}</button>
                    </div>
                  </article>;
                })}</div>
            )}
        </div>
      </>}
    </aside>
  </div>;
}
