import initSqlJs from 'sql.js';
import { type Database } from 'sql.js';
import wasmUrl from 'sql.js/dist/sql-wasm.wasm?url';

const DB_STORE = 'parallel-store';
const DB_KEY = 'sqlite-snapshot';
const DB_NAME = 'parallel';
const REC_STORE = 'recordings';

export type SessionSummary = {
  id: number;
  sourceLanguage: string;
  targetLanguage: string;
  startedAt: string;
  endedAt: string | null;
  turnCount: number;
};

export type InterpretationTurn = {
  id: number;
  sessionId: number;
  role: 'source' | 'target';
  text: string;
  durationMs: number;
  createdAt: string;
};

export type DocumentRecord = {
  id: number;
  fileName: string;
  slideCount: number;
  translatedPageCount: number;
  translatedAt: string | null;
  updatedAt: string;
};

export type ActivityLogScope = 'document' | 'speech';
export type ActivityLogStatus = 'running' | 'success' | 'warning' | 'error' | 'cancelled';
export type ActivityLog = {
  id: number;
  traceId: string;
  scope: ActivityLogScope;
  context: string;
  stage: string;
  action: string;
  engineType: string;
  engineName: string;
  model: string;
  status: ActivityLogStatus;
  durationMs: number;
  detail: string;
  inputPreview: string;
  outputPreview: string;
  createdAt: string;
};

export type NewActivityLog = Omit<ActivityLog, 'id' | 'createdAt'> & { createdAt?: string };

let dbPromise: Promise<Database> | null = null;
let persistTimer: ReturnType<typeof setTimeout> | null = null;
let persistChain: Promise<void> = Promise.resolve();
let snapshotLoadedFromLegacy = false;

function idbOpen(): Promise<IDBDatabase> {
  return new Promise((resolve, reject) => {
    const request = indexedDB.open(DB_NAME, 1);
    request.onupgradeneeded = () => {
      if (!request.result.objectStoreNames.contains(DB_STORE)) request.result.createObjectStore(DB_STORE);
      if (!request.result.objectStoreNames.contains(REC_STORE)) request.result.createObjectStore(REC_STORE);
    };
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error);
  });
}

async function idbGet(key: string): Promise<Uint8Array | null> {
  const db = await idbOpen();
  return new Promise((resolve, reject) => {
    const tx = db.transaction(DB_STORE, 'readonly');
    const request = tx.objectStore(DB_STORE).get(key);
    request.onsuccess = () => resolve((request.result as Uint8Array | undefined) ?? null);
    request.onerror = () => reject(request.error);
    tx.oncomplete = () => db.close();
  });
}

async function idbPut(key: string, value: Uint8Array): Promise<void> {
  const db = await idbOpen();
  return new Promise((resolve, reject) => {
    const tx = db.transaction(DB_STORE, 'readwrite');
    tx.objectStore(DB_STORE).put(value, key);
    tx.oncomplete = () => { db.close(); resolve(); };
    tx.onerror = () => reject(tx.error);
  });
}

async function idbGetRecording(sessionId: number): Promise<Blob | null> {
  const db = await idbOpen();
  return new Promise((resolve, reject) => {
    const tx = db.transaction(REC_STORE, 'readonly');
    const request = tx.objectStore(REC_STORE).get(sessionId);
    request.onsuccess = () => resolve((request.result as Blob | undefined) ?? null);
    request.onerror = () => reject(request.error);
    tx.oncomplete = () => db.close();
  });
}

function isSqliteSnapshot(value: Uint8Array): boolean {
  if (value.byteLength < 100) return false;
  return new TextDecoder().decode(value.subarray(0, 16)) === 'SQLite format 3\0';
}

async function loadSnapshot(): Promise<Uint8Array | null> {
  let response: Response;
  try {
    response = await fetch('/api/local-db', { cache: 'no-store' });
  } catch {
    // 静态部署或旧安装没有本地数据库接口时，继续使用浏览器存储。
    const legacy = await idbGet(DB_KEY).catch(() => null);
    snapshotLoadedFromLegacy = Boolean(legacy);
    return legacy;
  }
  if (response.status === 204 || response.status === 404) {
    const legacy = await idbGet(DB_KEY).catch(() => null);
    snapshotLoadedFromLegacy = Boolean(legacy);
    return legacy;
  }
  if (!response.ok) throw new Error('无法读取本地数据库');
  const contentType = response.headers.get('content-type') || '';
  if (!contentType.includes('application/vnd.sqlite3')) {
    const legacy = await idbGet(DB_KEY).catch(() => null);
    snapshotLoadedFromLegacy = Boolean(legacy);
    return legacy;
  }
  const snapshot = new Uint8Array(await response.arrayBuffer());
  if (!isSqliteSnapshot(snapshot)) throw new Error('本地数据库文件格式无效');
  return snapshot;
}

async function writeSnapshot(snapshot: Uint8Array): Promise<void> {
  let response: Response;
  try {
    response = await fetch('/api/local-db', {
      method: 'PUT',
      headers: { 'content-type': 'application/vnd.sqlite3', 'x-parallel-storage': '1' },
      body: snapshot.slice().buffer
    });
  } catch {
    // 静态部署没有本地 API 时保留浏览器模式。
    await idbPut(DB_KEY, snapshot);
    return;
  }
  if (response.status === 404 || response.status === 405) {
    await idbPut(DB_KEY, snapshot);
    return;
  }
  if (!response.ok) throw new Error('本地数据库写入失败');
}

async function idbDeleteRecording(sessionId: number): Promise<void> {
  const db = await idbOpen();
  return new Promise((resolve, reject) => {
    const tx = db.transaction(REC_STORE, 'readwrite');
    tx.objectStore(REC_STORE).delete(sessionId);
    tx.oncomplete = () => { db.close(); resolve(); };
    tx.onerror = () => { db.close(); reject(tx.error); };
  });
}

async function idbClearRecordings(): Promise<void> {
  const db = await idbOpen();
  return new Promise((resolve, reject) => {
    const tx = db.transaction(REC_STORE, 'readwrite');
    tx.objectStore(REC_STORE).clear();
    tx.oncomplete = () => { db.close(); resolve(); };
    tx.onerror = () => { db.close(); reject(tx.error); };
  });
}

async function openDb(): Promise<Database> {
  const SQL = await initSqlJs({ locateFile: () => wasmUrl });
  const snapshot = await loadSnapshot();
  const db = snapshot ? new SQL.Database(snapshot) : new SQL.Database();
  db.run(
    'PRAGMA foreign_keys = ON;'
    + 'CREATE TABLE IF NOT EXISTS sessions ('
    + 'id INTEGER PRIMARY KEY AUTOINCREMENT,'
    + 'source_language TEXT NOT NULL,'
    + 'target_language TEXT NOT NULL,'
    + 'started_at TEXT NOT NULL,'
    + 'ended_at TEXT,'
    + 'turn_count INTEGER NOT NULL DEFAULT 0);'
    + 'CREATE TABLE IF NOT EXISTS turns ('
    + 'id INTEGER PRIMARY KEY AUTOINCREMENT,'
    + 'session_id INTEGER NOT NULL REFERENCES sessions(id) ON DELETE CASCADE,'
    + 'role TEXT NOT NULL,'
    + 'text TEXT NOT NULL,'
    + 'duration_ms INTEGER NOT NULL DEFAULT 0,'
    + 'created_at TEXT NOT NULL);'
    + 'CREATE INDEX IF NOT EXISTS turns_session ON turns(session_id);'
    + 'CREATE TABLE IF NOT EXISTS session_recordings ('
    + 'session_id INTEGER PRIMARY KEY REFERENCES sessions(id) ON DELETE CASCADE,'
    + 'mime_type TEXT NOT NULL DEFAULT \'audio/webm\','
    + 'audio_blob BLOB NOT NULL);'
    + 'CREATE TABLE IF NOT EXISTS documents ('
    + 'id INTEGER PRIMARY KEY AUTOINCREMENT,'
    + 'file_name TEXT NOT NULL,'
    + 'slide_count INTEGER NOT NULL DEFAULT 0,'
    + 'source_language TEXT NOT NULL DEFAULT \'英语\','
    + 'target_language TEXT NOT NULL DEFAULT \'简体中文\','
    + 'translated_at TEXT,'
    + 'updated_at TEXT NOT NULL);'
    + 'CREATE TABLE IF NOT EXISTS document_chats ('
    + 'document_id INTEGER PRIMARY KEY REFERENCES documents(id) ON DELETE CASCADE,'
    + 'messages_json TEXT NOT NULL DEFAULT \'[]\');'
    + 'CREATE TABLE IF NOT EXISTS document_slides ('
    + 'id INTEGER PRIMARY KEY AUTOINCREMENT,'
    + 'document_id INTEGER NOT NULL REFERENCES documents(id) ON DELETE CASCADE,'
    + 'page_index INTEGER NOT NULL,'
    + 'title_source TEXT NOT NULL DEFAULT \'\','
    + 'title_target TEXT NOT NULL DEFAULT \'\','
    + 'sentences_source TEXT NOT NULL DEFAULT \'[]\','
    + 'sentences_target TEXT NOT NULL DEFAULT \'[]\');'
    + 'CREATE INDEX IF NOT EXISTS document_slides_doc ON document_slides(document_id);'
    + 'CREATE TABLE IF NOT EXISTS document_files ('
    + 'document_id INTEGER PRIMARY KEY REFERENCES documents(id) ON DELETE CASCADE,'
    + 'source_pdf BLOB,'
    + 'mono_pdf BLOB,'
    + 'dual_pdf BLOB);'
    + 'CREATE TABLE IF NOT EXISTS document_page_files ('
    + 'document_id INTEGER NOT NULL REFERENCES documents(id) ON DELETE CASCADE,'
    + 'page_index INTEGER NOT NULL,'
    + 'mono_pdf BLOB NOT NULL,'
    + 'dual_pdf BLOB,'
    + 'PRIMARY KEY (document_id, page_index));'
    + 'CREATE INDEX IF NOT EXISTS document_page_files_doc ON document_page_files(document_id);'
    + 'CREATE TABLE IF NOT EXISTS activity_logs ('
    + 'id INTEGER PRIMARY KEY AUTOINCREMENT,'
    + 'trace_id TEXT NOT NULL DEFAULT \'\','
    + 'scope TEXT NOT NULL,'
    + 'context TEXT NOT NULL DEFAULT \'\','
    + 'stage TEXT NOT NULL,'
    + 'action TEXT NOT NULL,'
    + 'engine_type TEXT NOT NULL DEFAULT \'\','
    + 'engine_name TEXT NOT NULL DEFAULT \'\','
    + 'model TEXT NOT NULL DEFAULT \'\','
    + 'status TEXT NOT NULL,'
    + 'duration_ms INTEGER NOT NULL DEFAULT 0,'
    + 'detail TEXT NOT NULL DEFAULT \'\','
    + 'input_preview TEXT NOT NULL DEFAULT \'\','
    + 'output_preview TEXT NOT NULL DEFAULT \'\','
    + 'created_at TEXT NOT NULL);'
    + 'CREATE INDEX IF NOT EXISTS activity_logs_created ON activity_logs(id DESC);'
    + 'CREATE INDEX IF NOT EXISTS activity_logs_scope ON activity_logs(scope);'
  );
  const activityColumns = new Set((db.exec('PRAGMA table_info(activity_logs)')[0]?.values || []).map(row => String(row[1])));
  if (!activityColumns.has('input_preview')) db.run("ALTER TABLE activity_logs ADD COLUMN input_preview TEXT NOT NULL DEFAULT ''");
  if (!activityColumns.has('output_preview')) db.run("ALTER TABLE activity_logs ADD COLUMN output_preview TEXT NOT NULL DEFAULT ''");
  if (snapshotLoadedFromLegacy) window.setTimeout(schedulePersist, 0);
  return db;
}

export function getDb(): Promise<Database> {
  if (!dbPromise) dbPromise = openDb();
  return dbPromise;
}

function queueSnapshot(snapshot: Uint8Array): Promise<void> {
  persistChain = persistChain.catch(() => undefined).then(() => writeSnapshot(snapshot));
  return persistChain;
}

async function persistNow(): Promise<void> {
  if (persistTimer) {
    clearTimeout(persistTimer);
    persistTimer = null;
  }
  const db = await getDb();
  await queueSnapshot(db.export());
}

function schedulePersist(): void {
  if (persistTimer) clearTimeout(persistTimer);
  persistTimer = setTimeout(async () => {
    persistTimer = null;
    try {
      const db = await getDb();
      await queueSnapshot(db.export());
    } catch { /* 快照失败不影响当次使用 */ }
  }, 400);
}

export async function createSession(sourceLanguage: string, targetLanguage: string): Promise<number> {
  const db = await getDb();
  db.run('INSERT INTO sessions (source_language, target_language, started_at) VALUES (?, ?, ?)', [
    sourceLanguage, targetLanguage, new Date().toISOString()
  ]);
  const id = db.exec('SELECT last_insert_rowid()')[0].values[0][0] as number;
  await persistNow();
  return id;
}

export async function addTurn(sessionId: number, role: 'source' | 'target', text: string, durationMs: number): Promise<void> {
  const db = await getDb();
  db.run('INSERT INTO turns (session_id, role, text, duration_ms, created_at) VALUES (?, ?, ?, ?, ?)', [
    sessionId, role, text, Math.round(durationMs), new Date().toISOString()
  ]);
  if (role === 'source') db.run('UPDATE sessions SET turn_count = turn_count + 1 WHERE id = ?', [sessionId]);
  schedulePersist();
}

export async function endSession(sessionId: number): Promise<void> {
  const db = await getDb();
  db.run('UPDATE sessions SET ended_at = ? WHERE id = ?', [new Date().toISOString(), sessionId]);
  await persistNow();
}

export async function deleteSession(sessionId: number): Promise<void> {
  const db = await getDb();
  db.run('DELETE FROM session_recordings WHERE session_id = ?', [sessionId]);
  db.run('DELETE FROM turns WHERE session_id = ?', [sessionId]);
  db.run('DELETE FROM sessions WHERE id = ?', [sessionId]);
  await idbDeleteRecording(sessionId).catch(() => undefined);
  await persistNow();
}

export async function deleteAllSessions(): Promise<void> {
  const db = await getDb();
  db.run('DELETE FROM session_recordings');
  db.run('DELETE FROM turns');
  db.run('DELETE FROM sessions');
  await idbClearRecordings().catch(() => undefined);
  await persistNow();
}

export async function deleteDocument(documentId: number): Promise<void> {
  const db = await getDb();
  db.run('DELETE FROM document_chats WHERE document_id = ?', [documentId]);
  db.run('DELETE FROM document_slides WHERE document_id = ?', [documentId]);
  db.run('DELETE FROM document_page_files WHERE document_id = ?', [documentId]);
  db.run('DELETE FROM document_files WHERE document_id = ?', [documentId]);
  db.run('DELETE FROM documents WHERE id = ?', [documentId]);
  await persistNow();
}

export async function deleteAllDocuments(): Promise<void> {
  const db = await getDb();
  db.run('DELETE FROM document_chats');
  db.run('DELETE FROM document_slides');
  db.run('DELETE FROM document_page_files');
  db.run('DELETE FROM document_files');
  db.run('DELETE FROM documents');
  await persistNow();
}

export async function recentSessions(limit = 30): Promise<SessionSummary[]> {
  const db = await getDb();
  const result = db.exec(
    'SELECT id, source_language, target_language, started_at, ended_at, turn_count '
    + 'FROM sessions ORDER BY id DESC LIMIT ' + Math.max(1, Math.min(200, limit))
  );
  return result[0]?.values.map(row => ({
    id: row[0] as number,
    sourceLanguage: row[1] as string,
    targetLanguage: row[2] as string,
    startedAt: row[3] as string,
    endedAt: row[4] as string | null,
    turnCount: row[5] as number
  })) ?? [];
}

export async function sessionTurns(sessionId: number): Promise<InterpretationTurn[]> {
  const db = await getDb();
  const result = db.exec(
    'SELECT id, session_id, role, text, duration_ms, created_at FROM turns '
    + 'WHERE session_id = ' + Number(sessionId) + ' ORDER BY id ASC'
  );
  return result[0]?.values.map(row => ({
    id: row[0] as number,
    sessionId: row[1] as number,
    role: row[2] as 'source' | 'target',
    text: row[3] as string,
    durationMs: row[4] as number,
    createdAt: row[5] as string
  })) ?? [];
}

export async function findDocument(fileName: string): Promise<DocumentRecord | null> {
  const db = await getDb();
  const result = db.exec(
    'SELECT d.id, d.file_name, d.slide_count, d.translated_at, d.updated_at, '
    + '(SELECT COUNT(*) FROM document_page_files p WHERE p.document_id = d.id) '
    + 'FROM documents d WHERE d.file_name = \'' + fileName.replace(/'/g, "''") + "' LIMIT 1"
  );
  const row = result[0]?.values[0];
  if (!row) return null;
  return {
    id: row[0] as number,
    fileName: row[1] as string,
    slideCount: row[2] as number,
    translatedPageCount: Number(row[5]) || 0,
    translatedAt: row[3] as string | null,
    updatedAt: row[4] as string
  };
}

/** 新建或更新文稿记录；slideCount 为 0 表示刚导入还没翻译 */
export async function upsertDocument(fileName: string, slideCount: number): Promise<number> {
  const db = await getDb();
  const now = new Date().toISOString();
  const existing = await findDocument(fileName);
  if (existing) {
    db.run('UPDATE documents SET slide_count = ?, updated_at = ? WHERE id = ?', [slideCount, now, existing.id]);
    schedulePersist();
    return existing.id;
  }
  db.run('INSERT INTO documents (file_name, slide_count, updated_at) VALUES (?, ?, ?)', [fileName, slideCount, now]);
  const id = db.exec('SELECT last_insert_rowid()')[0].values[0][0] as number;
  schedulePersist();
  return id;
}

/** 翻译完成后逐页写入/覆盖原句与译文，并打上翻译时间 */
export async function saveDocumentTranslation(
  documentId: number,
  slides: { title: string; subtitle?: string; sentences: { source: string; target: string }[] }[]
): Promise<void> {
  const db = await getDb();
  db.run('DELETE FROM document_slides WHERE document_id = ?', [documentId]);
  slides.forEach((slide, index) => {
    const titlesSource = JSON.stringify([slide.title, slide.subtitle || '']);
    const titlesTarget = JSON.stringify([slide.title, slide.subtitle || '']);
    db.run(
      'INSERT INTO document_slides (document_id, page_index, title_source, title_target, sentences_source, sentences_target) VALUES (?, ?, ?, ?, ?, ?)',
      [
        documentId,
        index,
        titlesSource,
        titlesTarget,
        JSON.stringify(slide.sentences.map(line => line.source)),
        JSON.stringify(slide.sentences.map(line => line.target))
      ]
    );
  });
  db.run('UPDATE documents SET translated_at = ?, updated_at = ? WHERE id = ?', [
    new Date().toISOString(), new Date().toISOString(), documentId
  ]);
  await persistNow();
}

/** 保存 PDFMathTranslate 生成的真实文件，历史记录重新打开后仍能保持原版式。 */
export async function saveDocumentFiles(
  documentId: number,
  sourcePdf: File,
  monoPdf: File,
  dualPdf?: File
): Promise<void> {
  const db = await getDb();
  const source = new Uint8Array(await sourcePdf.arrayBuffer());
  const mono = new Uint8Array(await monoPdf.arrayBuffer());
  const dual = dualPdf ? new Uint8Array(await dualPdf.arrayBuffer()) : null;
  db.run(
    'INSERT OR REPLACE INTO document_files (document_id, source_pdf, mono_pdf, dual_pdf) VALUES (?, ?, ?, ?)',
    [documentId, source, mono, dual]
  );
  await persistNow();
}

/** 新任务只保存原文件；译文页随后逐页写入，便于中断后保留进度。 */
export async function startDocumentFileSession(documentId: number, sourcePdf: File, resetPages: boolean): Promise<void> {
  const db = await getDb();
  const source = new Uint8Array(await sourcePdf.arrayBuffer());
  db.run(
    'INSERT INTO document_files (document_id, source_pdf, mono_pdf, dual_pdf) VALUES (?, ?, NULL, NULL) '
      + 'ON CONFLICT(document_id) DO UPDATE SET source_pdf = excluded.source_pdf, mono_pdf = NULL, dual_pdf = NULL',
    [documentId, source]
  );
  if (resetPages) {
    db.run('DELETE FROM document_page_files WHERE document_id = ?', [documentId]);
    db.run('UPDATE documents SET translated_at = NULL, updated_at = ? WHERE id = ?', [new Date().toISOString(), documentId]);
  }
  await persistNow();
}

export async function saveDocumentPageFile(
  documentId: number,
  pageIndex: number,
  monoPdf: File,
  dualPdf?: File
): Promise<void> {
  const db = await getDb();
  const mono = new Uint8Array(await monoPdf.arrayBuffer());
  const dual = dualPdf ? new Uint8Array(await dualPdf.arrayBuffer()) : null;
  const previous = db.exec('SELECT mono_pdf, dual_pdf FROM document_page_files WHERE document_id = ? AND page_index = ?', [documentId, pageIndex])[0]?.values[0];
  db.run(
    'INSERT OR REPLACE INTO document_page_files (document_id, page_index, mono_pdf, dual_pdf) VALUES (?, ?, ?, ?)',
    [documentId, pageIndex, mono, dual]
  );
  db.run('UPDATE documents SET updated_at = ? WHERE id = ?', [new Date().toISOString(), documentId]);
  try { await persistNow(); }
  catch (error) {
    if (previous) db.run('INSERT OR REPLACE INTO document_page_files (document_id, page_index, mono_pdf, dual_pdf) VALUES (?, ?, ?, ?)', [documentId, pageIndex, previous[0], previous[1]]);
    else db.run('DELETE FROM document_page_files WHERE document_id = ? AND page_index = ?', [documentId, pageIndex]);
    throw error;
  }
}

export async function loadDocumentFiles(documentId: number, fileName: string): Promise<{
  source: File;
  mono?: File;
  dual?: File;
  pages: Array<{ pageIndex: number; mono: File; dual?: File }>;
} | null> {
  const db = await getDb();
  const statement = db.prepare('SELECT source_pdf, mono_pdf, dual_pdf FROM document_files WHERE document_id = ?');
  try {
    statement.bind([documentId]);
    if (!statement.step()) return null;
    const row = statement.get();
    const source = row[0] as Uint8Array | null;
    const mono = row[1] as Uint8Array | null;
    const dual = row[2] as Uint8Array | null;
    if (!source) return null;
    const base = fileName.replace(/\.(pptx?|pdf|html?)$/i, '');
    const pageStatement = db.prepare(
      'SELECT page_index, mono_pdf, dual_pdf FROM document_page_files WHERE document_id = ? ORDER BY page_index ASC'
    );
    const pages: Array<{ pageIndex: number; mono: File; dual?: File }> = [];
    try {
      pageStatement.bind([documentId]);
      while (pageStatement.step()) {
        const page = pageStatement.get();
        const pageIndex = page[0] as number;
        const pageMono = page[1] as Uint8Array;
        const pageDual = page[2] as Uint8Array | null;
        pages.push({
          pageIndex,
          mono: new File([pageMono.slice().buffer], `${base}-第${pageIndex + 1}页-译文.pdf`, { type: 'application/pdf' }),
          dual: pageDual
            ? new File([pageDual.slice().buffer], `${base}-第${pageIndex + 1}页-双语.pdf`, { type: 'application/pdf' })
            : undefined
        });
      }
    } finally {
      pageStatement.free();
    }
    return {
      source: new File([source.slice().buffer], base + '.pdf', { type: 'application/pdf' }),
      mono: mono ? new File([mono.slice().buffer], base + '-译文.pdf', { type: 'application/pdf' }) : undefined,
      dual: dual ? new File([dual.slice().buffer], base + '-双语.pdf', { type: 'application/pdf' }) : undefined,
      pages
    };
  } finally {
    statement.free();
  }
}

export async function recentDocuments(limit = 30): Promise<DocumentRecord[]> {
  const db = await getDb();
  const result = db.exec(
    'SELECT d.id, d.file_name, d.slide_count, d.translated_at, d.updated_at, '
    + '(SELECT COUNT(*) FROM document_page_files p WHERE p.document_id = d.id) '
    + 'FROM documents d ORDER BY d.updated_at DESC LIMIT ' + Math.max(1, Math.min(200, limit))
  );
  return result[0]?.values.map(row => ({
    id: row[0] as number,
    fileName: row[1] as string,
    slideCount: row[2] as number,
    translatedPageCount: Number(row[5]) || 0,
    translatedAt: row[3] as string | null,
    updatedAt: row[4] as string
  })) ?? [];
}

export async function loadDocumentSlides(documentId: number): Promise<{
  pageIndex: number;
  title: string;
  subtitle: string;
  sentences: { source: string; target: string }[];
}[]> {
  const db = await getDb();
  const result = db.exec(
    'SELECT page_index, title_source, title_target, sentences_source, sentences_target '
    + 'FROM document_slides WHERE document_id = ' + Number(documentId) + ' ORDER BY page_index ASC'
  );
  return result[0]?.values.map(row => {
    const titlesSource = JSON.parse(String(row[1] || '[]')) as string[];
    const sentencesSource = JSON.parse(String(row[3] || '[]')) as string[];
    const sentencesTarget = JSON.parse(String(row[4] || '[]')) as string[];
    return {
      pageIndex: row[0] as number,
      title: titlesSource[0] || '',
      subtitle: titlesSource[1] || '',
      sentences: sentencesSource.map((source, index) => ({ source, target: sentencesTarget[index] || '' }))
    };
  }) ?? [];
}

export async function saveRecording(sessionId: number, blob: Blob): Promise<void> {
  const db = await getDb();
  const bytes = new Uint8Array(await blob.arrayBuffer());
  db.run(
    'INSERT OR REPLACE INTO session_recordings (session_id, mime_type, audio_blob) VALUES (?, ?, ?)',
    [sessionId, blob.type || 'audio/webm', bytes]
  );
  await persistNow();
}

export async function loadRecording(sessionId: number): Promise<Blob | null> {
  const db = await getDb();
  const statement = db.prepare('SELECT mime_type, audio_blob FROM session_recordings WHERE session_id = ?');
  try {
    statement.bind([sessionId]);
    if (statement.step()) {
      const row = statement.get();
      const bytes = row[1] as Uint8Array;
      return new Blob([bytes.slice().buffer], { type: String(row[0] || 'audio/webm') });
    }
  } finally {
    statement.free();
  }
  const legacy = await idbGetRecording(sessionId).catch(() => null);
  if (legacy) await saveRecording(sessionId, legacy);
  return legacy;
}

export async function addActivityLog(log: NewActivityLog): Promise<number> {
  const db = await getDb();
  db.run(
    'INSERT INTO activity_logs (trace_id, scope, context, stage, action, engine_type, engine_name, model, status, duration_ms, detail, input_preview, output_preview, created_at) '
      + 'VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)',
    [
      log.traceId, log.scope, log.context, log.stage, log.action, log.engineType,
      log.engineName, log.model, log.status, Math.max(0, Math.round(log.durationMs)),
      log.detail, log.inputPreview, log.outputPreview, log.createdAt || new Date().toISOString()
    ]
  );
  const id = db.exec('SELECT last_insert_rowid()')[0].values[0][0] as number;
  schedulePersist();
  window.dispatchEvent(new CustomEvent('parallel-activity-log'));
  return id;
}

export async function recentActivityLogs(limit = 300): Promise<ActivityLog[]> {
  const db = await getDb();
  const result = db.exec(
    'SELECT id, trace_id, scope, context, stage, action, engine_type, engine_name, model, status, duration_ms, detail, input_preview, output_preview, created_at '
      + 'FROM activity_logs ORDER BY id DESC LIMIT ' + Math.max(1, Math.min(2000, limit))
  );
  return result[0]?.values.map(row => ({
    id: row[0] as number,
    traceId: String(row[1] || ''),
    scope: row[2] as ActivityLogScope,
    context: String(row[3] || ''),
    stage: String(row[4] || ''),
    action: String(row[5] || ''),
    engineType: String(row[6] || ''),
    engineName: String(row[7] || ''),
    model: String(row[8] || ''),
    status: row[9] as ActivityLogStatus,
    durationMs: Number(row[10]) || 0,
    detail: String(row[11] || ''),
    inputPreview: String(row[12] || ''),
    outputPreview: String(row[13] || ''),
    createdAt: String(row[14] || '')
  })) ?? [];
}

export async function loadDocumentChat(documentId: number): Promise<string> {
  const db = await getDb();
  return String(db.exec('SELECT messages_json FROM document_chats WHERE document_id = ?', [documentId])[0]?.values[0]?.[0] || '[]');
}

export async function saveDocumentChat(documentId: number, messages: string): Promise<void> {
  const db = await getDb();
  db.run('INSERT OR REPLACE INTO document_chats (document_id, messages_json) VALUES (?, ?)', [documentId, messages]);
  await persistNow();
}

export async function clearActivityLogs(): Promise<void> {
  const db = await getDb();
  db.run('DELETE FROM activity_logs');
  await persistNow();
  window.dispatchEvent(new CustomEvent('parallel-activity-log'));
}
