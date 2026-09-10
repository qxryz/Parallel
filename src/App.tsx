import { useEffect, useMemo, useRef, useState } from 'react';
import { PDFDocument } from 'pdf-lib';
import type { PointerEvent as ReactPointerEvent, WheelEvent as ReactWheelEvent } from 'react';
import {
  ArrowLeftRight, Check, ChevronDown, ChevronLeft, ChevronRight, CircleStop, Download, FileUp, History,
  Languages, MessageSquare, Mic, Radio, RefreshCw, Settings, Sparkles, Trash2, Volume2, VolumeX, X
} from 'lucide-react';
import { defaultProviders } from './data';
import { importTranslatedPdfDocument, normalizePresentation, PdfImportError, preparePdfDocument, ScanRecognitionRequiredError } from './importers';
import type { Provider, SlideData } from './types';
import { OpenMaicSettings } from './components/OpenMaicSettings';
import { HistoryPanel } from './components/HistoryPanel';
import { ScanRecognitionDialog } from './components/ScanRecognitionDialog';
import { InterpretationEngine, speechRecognitionAvailable } from './interpretation';
import type { CloudAsrConfig } from './interpretation';
import { getAsrProvider, type AsrProviderId } from './asrProviders';
import { resolveEngineForTask } from './modelRouting';
import { downloadPdf, mergePdfSession, Pdf2zhJobError, translatePdfWithLayout, type Pdf2zhPageResult, type Pdf2zhProgress } from './pdf2zhClient';
import {
  upsertDocument, findDocument, saveDocumentTranslation, loadDocumentSlides,
  loadDocumentFiles, saveDocumentPageFile, startDocumentFileSession, saveDocumentChat
} from './localDb';
import type { DocumentRecord } from './localDb';
import type { InterpretationLine } from './interpretation';
import { createTraceId, engineActivity, recordActivity } from './activityLog';
import { loadPdfTranslationSettings } from './pdfTranslationSettings';
import { DocumentAgent } from './components/DocumentAgent';
import { createHistorySession } from './historySession';
import './workspace-polish.css';

function hasValidChineseTranslation(source: SlideData[], target: SlideData[]): boolean {
  const sourceText = source.flatMap(page => page.sentences.map(line => line.source)).join(' ');
  const targetText = target.flatMap(page => page.sentences.map(line => line.source)).join(' ');
  const latinCount = (sourceText.match(/[A-Za-z]/g) || []).length;
  const chineseCount = (targetText.match(/[\u3400-\u9fff]/g) || []).length;
  if (latinCount < 20) return targetText.replace(/\s/g, '').length > 0;
  return chineseCount >= Math.max(8, Math.floor(latinCount * 0.05));
}

function slideTextPreview(slides: SlideData[]): string {
  return slides.flatMap(page => page.sentences.map(line => line.source)).join('\n').trim().slice(0, 1600);
}

export default function App() {
  const [slides, setSlides] = useState<SlideData[]>([]);
  const [current, setCurrent] = useState(0);
  const [recording, setRecording] = useState(false);
  const [settingsOpen, setSettingsOpen] = useState(false);
  const [agentSettings, setAgentSettings] = useState(false);
  const [agentOpen, setAgentOpen] = useState(false);
  const historySessionRef = useRef<Awaited<ReturnType<typeof createHistorySession>> | null>(null);
  const [restoringPage, setRestoringPage] = useState(false);
  const [pageReadError, setPageReadError] = useState('');
  const [pageReadAttempt, setPageReadAttempt] = useState(0);
  const [retranslating, setRetranslating] = useState(false);
  const [railWidth, setRailWidth] = useState(150);
  const [split, setSplit] = useState(50);
  const [dockHeight, setDockHeight] = useState(252);
  const [dockOpen, setDockOpen] = useState(false);
  const [busy, setBusy] = useState(false);
  const [importing, setImporting] = useState(false);
  const [importError, setImportError] = useState('');
  const [toast, setToast] = useState('');
  const [title, setTitle] = useState('未打开文稿');
  const [documentId, setDocumentId] = useState<number | null>(null);
  const [historyOpen, setHistoryOpen] = useState(false);
  const [scanFile, setScanFile] = useState<File | null>(null);
  const inputRef = useRef<HTMLInputElement>(null);
  const sourceFileRef = useRef<File | null>(null);
  const monoFileRef = useRef<File | null>(null);
  const dualFileRef = useRef<File | null>(null);
  const translateAbortRef = useRef<AbortController | null>(null);
  const translationJobRef = useRef<string | null>(null);
  const translatedPagesRef = useRef<Map<number, SlideData>>(new Map());
  const translatedPageFilesRef = useRef<Map<number, Pdf2zhPageResult>>(new Map());
  const [translationProgress, setTranslationProgress] = useState<Pdf2zhProgress | null>(null);
  const [translationError, setTranslationError] = useState('');
  const [exportOpen, setExportOpen] = useState(false);
  const [providers, setProviders] = useState<Provider[]>(() => {
    try {
      const saved = JSON.parse(localStorage.getItem('parallel.providers') || '[]') as Provider[];
      const builtIns = defaultProviders.map(provider => ({ ...provider, ...(saved.find(item => item.id === provider.id) || {}) }));
      return [...builtIns, ...saved.filter(item => item.id.startsWith('custom-') && !builtIns.some(provider => provider.id === item.id))];
    }
    catch { return defaultProviders; }
  });

  useEffect(() => localStorage.setItem('parallel.providers', JSON.stringify(providers)), [providers]);
  useEffect(() => {
    function shortcuts(event: KeyboardEvent) {
      if ((event.metaKey || event.ctrlKey) && event.key === ',') { event.preventDefault(); setSettingsOpen(true); }
      if (event.key === 'Escape' && !settingsOpen && !historyOpen) { setAgentOpen(false); setExportOpen(false); }
    }
    window.addEventListener('keydown', shortcuts);
    return () => window.removeEventListener('keydown', shortcuts);
  }, [settingsOpen, historyOpen]);

  useEffect(() => {
    const session = historySessionRef.current;
    if (!session) return;
    let active = true;
    const index = current;
    const files = translatedPageFilesRef.current.get(index);
    setRestoringPage(true);
    setPageReadError('');
    void Promise.allSettled([session.sourcePage(index), session.targetPage(index, files)]).then(([source, target]) => {
      if (!active) return;
      const original = source.status === 'fulfilled' ? source.value : undefined;
      const translated = target.status === 'fulfilled' ? target.value : undefined;
      if (translated) translatedPagesRef.current.set(index, translated);
      setSlides(previous => previous.map((page, i) => i !== index ? page : {
        ...page, ...original, title: original?.title || page.title,
        translatedPreview: translated?.preview, translatedSentences: translated?.sentences,
        sentences: (original?.sentences || page.sentences).map((line, j) => ({ ...line, target: translated?.sentences[j]?.source || '' }))
      }));
      const failures = [source, target].filter(result => result.status === 'rejected');
      if (failures.length) setPageReadError(`第 ${index + 1} 页读取失败：` + failures.map(result => result.status === 'rejected' ? String(result.reason?.message || result.reason) : '').join('；'));
      setRestoringPage(false);
    });
    return () => { active = false; };
  }, [current, documentId, pageReadAttempt]);

  const notify = (text: string) => {
    setToast(text);
    window.setTimeout(() => setToast(''), 2200);
  };

  async function retranslatePage() {
    const source = sourceFileRef.current;
    const id = documentId;
    if (!source || id === null || busy || importing || restoringPage) return;
    const engine = resolveEngineForTask(providers, 'document-translation');
    if (!engine) { setSettingsOpen(true); return; }
    const index = current;
    const controller = new AbortController();
    translateAbortRef.current = controller;
    setBusy(true);
    setRetranslating(true);
    const traceId = createTraceId('page-retranslation');
    let replacement: { files: Pdf2zhPageResult; slide: SlideData } | undefined;
    try {
      await translatePdfWithLayout(source, engine, () => {}, controller.signal, async (pageIndex, files) => {
        if (pageIndex !== index) throw new Error('译文页码与所选页面不一致');
        const [slide] = await importTranslatedPdfDocument(files.mono);
        if (!slide?.preview) throw new Error('未能读取新译文，原译文已保留');
        replacement = { files, slide };
      }, undefined, undefined, event => recordActivity({ traceId, scope: 'document', context: title, ...event }), index + 1, index + 1);
      if (!replacement) throw new Error('没有收到单页译文，原译文已保留');
      const { files, slide } = replacement;
      // Upgrade old whole-file histories into a page session before replacing a page.
      if (monoFileRef.current) {
        const legacy = await PDFDocument.load(await monoFileRef.current.arrayBuffer());
        const legacyDual = dualFileRef.current ? await PDFDocument.load(await dualFileRef.current.arrayBuffer()) : null;
        if (legacy.getPageCount() !== slides.length) throw new Error('旧版译文页数不一致，暂不能替换单页');
        for (let i = 0; i < slides.length; i++) {
          if (translatedPageFilesRef.current.has(i)) continue;
          const single = await PDFDocument.create();
          single.addPage((await single.copyPages(legacy, [i]))[0]);
          const mono = new File([(await single.save()).slice().buffer], `page-${i + 1}.pdf`, { type: 'application/pdf' });
          let dual: File | undefined;
          if (legacyDual && [slides.length, slides.length * 2].includes(legacyDual.getPageCount())) {
            const pair = await PDFDocument.create();
            const indices = legacyDual.getPageCount() === slides.length ? [i] : [i * 2, i * 2 + 1];
            (await pair.copyPages(legacyDual, indices)).forEach(p => pair.addPage(p));
            dual = new File([(await pair.save()).slice().buffer], `dual-${i + 1}.pdf`, { type: 'application/pdf' });
          }
          await saveDocumentPageFile(id, i, mono, dual);
          translatedPageFilesRef.current.set(i, { mono, dual });
        }
      }
      await saveDocumentPageFile(id, index, files.mono, files.dual);
      translatedPageFilesRef.current.set(index, files);
      translatedPagesRef.current.set(index, slide);
      setSlides(previous => previous.map((page, i) => i !== index ? page : {
        ...page, translatedPreview: slide.preview, translatedSentences: slide.sentences,
        sentences: page.sentences.map((line, j) => ({ ...line, target: slide.sentences[j]?.source || '' }))
      }));
      notify(`第 ${index + 1} 页已重新翻译`);
    } catch (error) {
      notify(controller.signal.aborted ? '已停止，原译文已保留' : (error instanceof Error ? error.message : '重译失败，原译文已保留'));
    } finally {
      translateAbortRef.current = null;
      setBusy(false);
      setRetranslating(false);
    }
  }

  async function importFile(file?: File) {
    if (!file || busy || importing) return;
    const traceId = createTraceId('document-import');
    const startedAt = Date.now();
    const extension = file.name.split('.').pop()?.toLowerCase() || '';
    setImporting(true);
    setImportError('');
    setTranslationError('');
    setTranslationProgress(null);
    translationJobRef.current = null;
    translatedPagesRef.current.clear();
    translatedPageFilesRef.current.clear();
    monoFileRef.current = null;
    dualFileRef.current = null;
    try {
      const normalized = await normalizePresentation(file);
      recordActivity({
        traceId, scope: 'document', context: file.name, stage: '文件准备',
        action: extension === 'pdf' ? '读取 PDF 文件' : '转换为 PDF',
        engineType: extension === 'pdf' ? '本机组件' : '本机工具',
        engineName: extension === 'pdf' ? 'Parallel' : 'LibreOffice', status: 'success',
        durationMs: Date.now() - startedAt
      });
      const prepared = await preparePdfDocument(normalized, providers);
      for (const step of prepared.processingSteps) recordActivity({ traceId, scope: 'document', context: file.name, ...step });
      sourceFileRef.current = prepared.source;
      const next = prepared.slides;
      if (!next.length) throw new Error('没有从文件中读取到页面');
      const importedDocumentId = await upsertDocument(file.name, next.length);
      await startDocumentFileSession(importedDocumentId, prepared.source, true);
      await saveDocumentChat(importedDocumentId, '[]');
      historySessionRef.current = null;
      setRestoringPage(false);
      setPageReadError('');
      setPageReadAttempt(n => n + 1);
      setAgentOpen(false);
      setSlides(next);
      setCurrent(0);
      setTitle(file.name.replace(/\.(pptx?|pdf|html?)$/i, ''));
      setDocumentId(importedDocumentId);
      notify(prepared.recognition === 'ocr' ? `已识别并导入 ${next.length} 页` : `已导入 ${next.length} 页`);
    } catch (error) {
      if (error instanceof PdfImportError || error instanceof ScanRecognitionRequiredError) {
        for (const step of error.processingSteps) recordActivity({ traceId, scope: 'document', context: file.name, ...step });
      }
      if (error instanceof ScanRecognitionRequiredError) {
        setScanFile(file);
        setImportError('');
        return;
      }
      const message = error instanceof Error ? error.message : '导入失败';
      recordActivity({
        traceId, scope: 'document', context: file.name, stage: '文档导入', action: '导入文档',
        engineType: '工作流', engineName: 'Parallel', status: 'error', durationMs: Date.now() - startedAt,
        detail: message
      });
      setImportError(message);
      notify(message);
    } finally {
      setImporting(false);
      if (inputRef.current) inputRef.current.value = '';
    }
  }

  async function translateCurrent(resumeMode?: 'current' | 'next') {
    if (!slides.length) { notify('请先导入演示文稿'); return; }
    const sourcePdf = sourceFileRef.current;
    if (!sourcePdf) { notify('请重新导入原文件后再翻译'); return; }
    const engine = resolveEngineForTask(providers, 'document-translation');
    if (!engine) {
      setSettingsOpen(true);
      notify('先在设置中选择翻译引擎');
      return;
    }
    const resume = resumeMode && translationJobRef.current
      ? { jobId: translationJobRef.current, mode: resumeMode }
      : undefined;
    const storedSession = !resume && translatedPageFilesRef.current.size > 0;
    const firstMissingPage = storedSession
      ? slides.findIndex((_, pageIndex) => !translatedPageFilesRef.current.has(pageIndex))
      : 0;
    if (storedSession && firstMissingPage < 0) {
      notify('所有页面都已有译文');
      return;
    }
    const traceId = createTraceId(resume ? 'document-resume' : 'document-translation');
    const translationStartedAt = Date.now();
    const context = sourcePdf.name;
    const engineInfo = engineActivity(engine);
    const layoutSettings = loadPdfTranslationSettings();
    const clearFrom = resume
      ? Math.max(0, (translationProgress?.current || 1) - 1 + (resumeMode === 'next' ? 1 : 0))
      : storedSession ? firstMissingPage : 0;
    if (!resume && !storedSession) translatedPagesRef.current.clear();
    else {
      for (const pageIndex of translatedPagesRef.current.keys()) {
        if (pageIndex >= clearFrom) translatedPagesRef.current.delete(pageIndex);
      }
    }
    if (!resume && !storedSession) translatedPageFilesRef.current.clear();
    else {
      for (const pageIndex of translatedPageFilesRef.current.keys()) {
        if (pageIndex >= clearFrom) translatedPageFilesRef.current.delete(pageIndex);
      }
    }
    setSlides(currentSlides => currentSlides.map((slide, index) => index < clearFrom ? slide : ({
        ...slide,
        translatedPreview: undefined,
        translatedSentences: [],
        sentences: slide.sentences.map(sentence => ({ ...sentence, target: '' }))
      })));
    setBusy(true);
    setTranslationError('');
    setTranslationProgress({
      stage: 'queued',
      current: resume ? translationProgress?.current || 0 : storedSession ? clearFrom : 0,
      total: slides.length,
      message: resumeMode === 'next'
        ? '正在从下一页继续'
        : resume ? '正在重试当前页' : storedSession ? `正在从第 ${clearFrom + 1} 页继续` : '准备翻译'
    });
    const controller = new AbortController();
    translateAbortRef.current = controller;
    try {
      const existing = await findDocument(sourcePdf.name);
      const sessionDocumentId = documentId ?? existing?.id ?? await upsertDocument(sourcePdf.name, slides.length);
      setDocumentId(sessionDocumentId);
      await startDocumentFileSession(sessionDocumentId, sourcePdf, !resume && !storedSession);
      await translatePdfWithLayout(
        sourcePdf,
        engine,
        setTranslationProgress,
        controller.signal,
        async (pageIndex, pageFiles) => {
          translatedPageFilesRef.current.set(pageIndex, pageFiles);
          await saveDocumentPageFile(sessionDocumentId, pageIndex, pageFiles.mono, pageFiles.dual);
          const translatedPage = (await importTranslatedPdfDocument(pageFiles.mono))[0];
          if (!translatedPage) return;
          translatedPagesRef.current.set(pageIndex, translatedPage);
          setSlides(currentSlides => currentSlides.map((slide, index) => index !== pageIndex ? slide : {
            ...slide,
            translatedPreview: translatedPage.preview,
            translatedSentences: translatedPage.sentences || [],
            sentences: slide.sentences.map((line, lineIndex) => ({
              ...line,
              target: translatedPage.sentences?.[lineIndex]?.source || ''
            }))
          }));
          recordActivity({ traceId, scope: 'document', context, stage: '页面输出', action: '生成单页译文', engineType: '本机内核', engineName: layoutSettings.layoutMode === 'precise' ? 'BabelDOC' : 'PDFMathTranslate', status: 'success', durationMs: 0, detail: `第 ${pageIndex + 1} 页` });
        },
        resume,
        jobId => { translationJobRef.current = jobId; },
        event => recordActivity({ traceId, scope: 'document', context, ...event }),
        storedSession ? clearFrom + 1 : 1
      );
      const translated = [...translatedPagesRef.current.entries()]
        .sort(([left], [right]) => left - right)
        .map(([, page]) => page);
      const extractedTextLooksValid = translated.length > 0 && hasValidChineseTranslation(slides, translated);
      recordActivity({
        traceId, scope: 'document', context, stage: '右侧预览', action: '确认逐页译文', engineType: '本机组件', engineName: 'Parallel',
        status: extractedTextLooksValid ? 'success' : 'warning', durationMs: 0,
        detail: `${translatedPagesRef.current.size} / ${slides.length} 页已有译文`,
        inputPreview: slideTextPreview(slides),
        outputPreview: slideTextPreview(translated) || '译文页面已保存，文字层可能不可提取'
      });
      const updated = slides.map((slide, index) => {
        const translatedPage = translatedPagesRef.current.get(index);
        return {
          ...slide,
          translatedPreview: translatedPage?.preview,
          translatedSentences: translatedPage?.sentences || [],
          sentences: slide.sentences.map((line, lineIndex) => ({
            ...line,
            target: translatedPage?.sentences[lineIndex]?.source || ''
          }))
        };
      });
      setSlides(updated);
      monoFileRef.current = null;
      dualFileRef.current = null;
      translationJobRef.current = null;
      setTranslationProgress({ stage: 'complete', current: slides.length, total: slides.length, message: '翻译完成' });
      try {
        await saveDocumentTranslation(sessionDocumentId, updated);
        recordActivity({ traceId, scope: 'document', context, stage: '本地记录', action: '保存逐页译文与进度', engineType: '本机数据库', engineName: 'SQLite', status: 'success', durationMs: 0 });
      } catch { /* 本地记录失败不影响翻译结果 */ }
      recordActivity({
        traceId, scope: 'document', context, stage: '版面翻译', action: resume || storedSession ? '继续整页翻译' : '完成整页翻译',
        engineType: '本机内核', engineName: layoutSettings.layoutMode === 'precise' ? 'BabelDOC' : 'PDFMathTranslate',
        status: 'success', durationMs: Date.now() - translationStartedAt,
        detail: `${updated.length} 页 · ${engineInfo.engineName}${engineInfo.model ? ` · ${engineInfo.model}` : ''}`
      });
      notify('整份翻译完成');
    } catch (error) {
      if ((error as Error).name === 'AbortError') {
        recordActivity({ traceId, scope: 'document', context, stage: '版面翻译', action: '停止整页翻译', engineType: '本机内核', engineName: layoutSettings.layoutMode === 'precise' ? 'BabelDOC' : 'PDFMathTranslate', status: 'cancelled', durationMs: Date.now() - translationStartedAt });
        setTranslationError('翻译已停止，可以从当前页或下一页继续');
        notify('已停止翻译');
      }
      else {
        if (error instanceof Pdf2zhJobError) translationJobRef.current = error.jobId;
        const message = error instanceof Error ? error.message : '翻译失败';
        recordActivity({
          traceId, scope: 'document', context, stage: '版面翻译', action: resume ? '继续整页翻译' : '整页翻译',
          engineType: engineInfo.engineType, engineName: engineInfo.engineName, model: engineInfo.model,
          status: 'error', durationMs: Date.now() - translationStartedAt, detail: message
        });
        setTranslationError(message);
        notify(message);
      }
    } finally {
      translateAbortRef.current = null;
      setBusy(false);
    }
  }

  async function openDocument(record: DocumentRecord) {
    setImporting(true);
    try {
      const files = await loadDocumentFiles(record.id, record.fileName);
      if (files) {
        const session = await createHistorySession(files.source, files.mono);
        const savedSlides = await loadDocumentSlides(record.id);
        const sourcePages: SlideData[] = Array.from({ length: session.count }, (_, index) => ({
          title: savedSlides[index]?.title || `第 ${index + 1} 页`,
          sentences: (savedSlides[index]?.sentences || []).map((line, j) => ({ ...line, id: `p${index}-s${j}` }))
        }));
        const storedPageFiles = files.pages;
        historySessionRef.current = session;
        translatedPagesRef.current = new Map();
        translatedPageFilesRef.current = files.pages.length
          ? new Map(storedPageFiles.map(page => [page.pageIndex, { mono: page.mono, dual: page.dual }]))
          : new Map();
        setSlides(sourcePages);
        sourceFileRef.current = files.source;
        monoFileRef.current = files.mono || null;
        dualFileRef.current = files.dual || null;
      } else {
        historySessionRef.current = null;
        translatedPagesRef.current.clear();
        translatedPageFilesRef.current.clear();
        sourceFileRef.current = null;
        monoFileRef.current = null;
        dualFileRef.current = null;
        const pages = await loadDocumentSlides(record.id);
        if (!pages.length) throw new Error('这份记录没有保存可读取的文件或页面内容');
        setSlides(pages.map((page, index) => ({
          title: page.title || `第 ${index + 1} 页`,
          subtitle: page.subtitle || undefined,
          sentences: page.sentences.map((sentence, i) => ({ id: `p${index}-s${i}`, source: sentence.source, target: sentence.target }))
        })));
      }
      setCurrent(0);
      setTitle(record.fileName.replace(/\.(pptx?|pdf|html?)$/i, ''));
      setDocumentId(record.id);
      setPageReadAttempt(value => value + 1);
      setAgentOpen(false);
      translationJobRef.current = null;
      setTranslationProgress(null);
      setTranslationError('');
      setImportError('');
      setHistoryOpen(false);
    } catch (error) {
      throw new Error(error instanceof Error ? error.message : '无法读取历史文件');
    } finally { setImporting(false); }
  }

  const page = slides[current];
  const hasStoredPages = translatedPageFilesRef.current.size > 0;
  const allPagesTranslated = Boolean(monoFileRef.current)
    || (slides.length > 0 && slides.every((_, pageIndex) => translatedPageFilesRef.current.has(pageIndex)));
  const progressPercent = translationProgress?.percent != null
    ? Math.min(100, translationProgress.percent)
    : translationProgress?.total
    ? Math.min(94, 10 + Math.max(0, translationProgress.current - 1) / translationProgress.total * 84)
    : translationProgress?.stage === 'layout' ? 8 : 0;
  const progressElapsed = translationProgress?.elapsedSeconds
    ? `${Math.floor(translationProgress.elapsedSeconds / 60) ? `${Math.floor(translationProgress.elapsedSeconds / 60)} 分 ` : ''}${translationProgress.elapsedSeconds % 60} 秒`
    : '';
  const progressLabel = translationProgress?.stage === 'translation' && translationProgress.total
    ? `${translationProgress.current} / ${translationProgress.total} 页`
    : translationProgress?.stage === 'validation' ? '检查中'
      : translationProgress?.stage === 'layout' ? '分析中' : '';
  const move = (delta: number) => setCurrent(value => Math.max(0, Math.min(slides.length - 1, value + delta)));
  const lastWheelAt = useRef(0);

  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent) => {
      const target = event.target as HTMLElement | null;
      if (target?.closest('input, textarea, select, [contenteditable="true"]')) return;
      if (event.key === 'ArrowLeft' || event.key === 'ArrowUp' || event.key === 'PageUp') {
        event.preventDefault();
        move(-1);
      }
      if (event.key === 'ArrowRight' || event.key === 'ArrowDown' || event.key === 'PageDown' || event.key === ' ') {
        event.preventDefault();
        move(1);
      }
    };
    window.addEventListener('keydown', onKeyDown);
    return () => window.removeEventListener('keydown', onKeyDown);
  }, [slides.length]);

  const flipByWheel = (event: ReactWheelEvent) => {
    if (Math.abs(event.deltaY) < 18 || slides.length < 2) return;
    event.preventDefault();
    const now = Date.now();
    if (now - lastWheelAt.current < 320) return;
    lastWheelAt.current = now;
    move(event.deltaY > 0 ? 1 : -1);
  };
  const exportCurrentDocument = async (kind: 'mono' | 'dual') => {
    const source = sourceFileRef.current;
    if (!source) return;
    const pageFiles = [...translatedPageFilesRef.current.entries()]
      .map(([pageIndex, files]) => ({ pageIndex, file: kind === 'mono' ? files.mono : files.dual }))
      .filter((page): page is { pageIndex: number; file: File } => Boolean(page.file));
    try {
      if (pageFiles.length) {
        const suffix = kind === 'mono' ? '译文' : '双语';
        downloadPdf(await mergePdfSession(source, pageFiles, `${title}-${suffix}.pdf`));
      } else {
        const legacy = kind === 'mono' ? monoFileRef.current : dualFileRef.current;
        if (legacy) downloadPdf(legacy);
      }
    } catch (error) {
      notify(error instanceof Error ? error.message : '导出失败');
    } finally {
      setExportOpen(false);
    }
  };
  const startDrag = (kind: 'rail' | 'split' | 'dock', event: ReactPointerEvent) => {
    event.preventDefault();
    const startX = event.clientX;
    const startY = event.clientY;
    const initialRail = railWidth;
    const initialSplit = split;
    const initialDock = dockHeight;
    const stageWidth = document.querySelector('.lw-canvas-grid')?.clientWidth || 1000;
    const movePointer = (moveEvent: PointerEvent) => {
      if (kind === 'rail') setRailWidth(Math.max(96, Math.min(260, initialRail + moveEvent.clientX - startX)));
      if (kind === 'split') setSplit(Math.max(28, Math.min(72, initialSplit + ((moveEvent.clientX - startX) / stageWidth) * 100)));
      if (kind === 'dock') setDockHeight(Math.max(190, Math.min(420, initialDock + startY - moveEvent.clientY)));
    };
    const endPointer = () => {
      window.removeEventListener('pointermove', movePointer);
      window.removeEventListener('pointerup', endPointer);
      document.body.classList.remove('lw-resizing');
    };
    document.body.classList.add('lw-resizing');
    window.addEventListener('pointermove', movePointer);
    window.addEventListener('pointerup', endPointer);
  };

  return <div className={`lw-app${agentOpen ? ' with-agent' : ''}`} onDragOver={event => event.preventDefault()} onDrop={event => { event.preventDefault(); void importFile(event.dataTransfer.files[0]); }}>
    <input ref={inputRef} hidden type="file" accept=".pptx,.ppt,.pdf,.html,.htm" onChange={event => void importFile(event.target.files?.[0])} />

    <header className="lw-topbar">
      <div className="lw-brand"><span>P</span><strong>Parallel</strong></div>
      <div className="lw-document"><strong title={title}>{title}</strong>{slides.length > 0 && <span><Check size={14} /> 已保存</span>}</div>
      {slides.length > 0 && <div className="lw-reader-nav">
        <div className="lw-top-language"><span>英语</span><ArrowLeftRight size={13}/><span>简体中文</span></div>
        <div className="lw-pager">
          <button onClick={() => move(-1)} aria-label="上一页"><ChevronLeft size={18} /></button>
          <form className="lw-page-jump" onSubmit={event => { event.preventDefault(); const input = event.currentTarget.elements.namedItem('page') as HTMLInputElement; const value = Number(input.value); if (Number.isInteger(value) && value >= 1 && value <= slides.length) setCurrent(value - 1); else input.value = String(current + 1); }}>
            <input key={current} name="page" aria-label="跳转页码" title="输入页码后按回车" inputMode="numeric" defaultValue={current + 1}/><span>/ {slides.length}</span>
          </form>
          <button onClick={() => move(1)} aria-label="下一页"><ChevronRight size={18} /></button>
        </div>
      </div>}
      <div className="lw-actions">
        <button disabled={importing || busy} onClick={() => inputRef.current?.click()}><FileUp size={18} />{importing ? '正在导入' : '导入'}</button>
        {slides.length > 0 && <button disabled={busy || importing || restoringPage} onClick={() => void retranslatePage()} title={`重新翻译第 ${current + 1} 页`}><RefreshCw size={16}/>重译本页</button>}
        {retranslating && <button onClick={() => translateAbortRef.current?.abort()}><CircleStop size={16}/>停止重译</button>}
        <button disabled={!slides.length || busy || allPagesTranslated} className="lw-primary" onClick={() => void translateCurrent(translationJobRef.current ? 'current' : undefined)}><Sparkles size={17} />{busy ? '正在翻译' : allPagesTranslated ? '已翻译' : translationJobRef.current || hasStoredPages ? '继续翻译' : '翻译整份'}</button>
        <div className="lw-export-menu">
          <button disabled={!translatedPageFilesRef.current.size && !monoFileRef.current} onClick={() => setExportOpen(value => !value)}><Download size={17}/>导出<ChevronDown size={13}/></button>
          {exportOpen && <div>
            <button onClick={() => void exportCurrentDocument('mono')}>译文 PDF</button>
            <button disabled={![...translatedPageFilesRef.current.values()].some(file => file.dual) && !dualFileRef.current} onClick={() => void exportCurrentDocument('dual')}>双语 PDF</button>
          </div>}
        </div>
        <button disabled={busy || importing} onClick={() => setHistoryOpen(true)}><History size={18} />历史</button>
        <span className="lw-divider" />
        <button className="lw-icon" onClick={() => setSettingsOpen(true)} aria-label="设置" title="设置（⌘ / Ctrl + ,）"><Settings size={20} /></button>
        <button aria-label="文档对话" aria-expanded={agentOpen} onClick={() => setAgentOpen(value => !value)}><MessageSquare size={19}/>对话</button>
      </div>
    </header>

    {importError && slides.length > 0 && <div className="lw-import-banner" role="alert">
      <span>{importError}</span>
      <button onClick={() => setImportError('')} aria-label="关闭导入错误"><X size={14}/></button>
    </div>}
    {(restoringPage || pageReadError) && <div className="history-page-status" role={pageReadError ? 'alert' : 'status'}>{restoringPage ? `正在读取第 ${current + 1} 页…` : <>{pageReadError}<button onClick={() => setPageReadAttempt(n => n + 1)}>重新读取</button></>}</div>}

    {slides.length ? <main className="lw-workspace" style={{ gridTemplateColumns: `${railWidth}px 5px 1fr` }}>
      <SlideRail slides={slides} current={current} onSelect={setCurrent} />
      <div className="lw-resizer lw-resizer-rail" onPointerDown={event => startDrag('rail', event)} />
      <section className="lw-stage" style={{ gridTemplateRows: 'minmax(0, 1fr)' }}>
        <div className="lw-canvas-grid" onWheel={flipByWheel} style={{ gridTemplateColumns: `minmax(0, ${split}fr) 5px minmax(0, ${100 - split}fr)` }}>
          <SlidePage slide={page} translated={false} loading={restoringPage} />
          <div className="lw-resizer lw-resizer-split" onPointerDown={event => startDrag('split', event)} />
          <SlidePage
            slide={page}
            translated
            loading={restoringPage}
            readError={pageReadError}
            busy={busy && !retranslating}
            progress={progressPercent}
            progressMessage={translationProgress?.message}
            progressElapsed={progressElapsed}
            progressLabel={progressLabel}
            error={translationError}
            onCancel={() => translateAbortRef.current?.abort()}
            onRetry={mode => void translateCurrent(mode)}
            canSkip={(translationProgress?.current || 0) < (translationProgress?.total || slides.length)}
          />
        </div>
      </section>
    </main> : <EmptyWorkspace
      onImport={() => inputRef.current?.click()}
      importing={importing}
      importError={importError}
      recording={recording}
      onToggle={() => setRecording(value => !value)}
      providers={providers}
      notify={notify}
    />}

    {agentOpen && <DocumentAgent key={documentId ?? 'empty'} documentId={documentId} slides={slides} current={current} title={title} providers={providers} onPage={setCurrent} onClose={() => setAgentOpen(false)} onSettings={() => { setAgentSettings(true); setSettingsOpen(true); }}/>}
    {settingsOpen && <OpenMaicSettings providers={providers} setProviders={setProviders} initialRouteTab={agentSettings ? 'assistant' : 'translation'} onClose={() => { setSettingsOpen(false); setAgentSettings(false); }} />}
    <div className="iw-persistent"><InterpretationDock recording={recording} onToggle={() => setRecording(value => !value)} providers={providers} notify={notify} collapsed={!dockOpen} onCollapse={() => setDockOpen(value => !value)} /></div>
    <HistoryPanel open={historyOpen} onClose={() => setHistoryOpen(false)} onOpenDocument={openDocument} />
    {scanFile && <ScanRecognitionDialog
      fileName={scanFile.name}
      providers={providers}
      onClose={() => setScanFile(null)}
      onContinue={() => {
        const file = scanFile;
        setScanFile(null);
        void importFile(file);
      }}
    />}
    {toast && <div className="lw-toast">{toast}</div>}
  </div>;
}

function EmptyWorkspace({ onImport, importing, importError, recording, onToggle, providers, notify }: {
  onImport: () => void;
  importing: boolean;
  importError: string;
  recording: boolean;
  onToggle: () => void;
  providers: Provider[];
  notify: (text: string) => void;
}) {
  const [interpreterOpen, setInterpreterOpen] = useState(false);
  return <main className="lw-empty-workspace">
    <section className="lw-empty-state">
      <div className="lw-empty-icon"><FileUp size={28}/></div>
      <h1>打开文稿，对照阅读</h1>
      <p>保留原有版式，逐页查看原文与译文。</p>
      <button disabled={importing} onClick={onImport}><FileUp size={17}/>{importing ? '正在读取页面…' : '选择文件'}</button>
      <span>{importing ? '正在分析文件，请稍候' : '或将文件拖到此处'}</span>
      <div className="lw-file-types" aria-label="支持的文件格式">{['PDF', 'PPTX', 'PPT', 'HTML'].map(format => <span key={format}>{format}</span>)}</div>
      {importError && <p className="lw-import-error">{importError}</p>}
    </section>
  </main>;
}

function SlideRail({ slides, current, onSelect }: { slides: SlideData[]; current: number; onSelect: (index: number) => void }) {
  return <aside className="lw-rail">
    {slides.map((slide, index) => <button key={`${slide.title}-${index}`} className={current === index ? 'lw-thumb active' : 'lw-thumb'} onClick={() => onSelect(index)}>
      <span>{index + 1}</span>
      <div>{slide.preview ? <img src={slide.preview} alt={`第 ${index + 1} 页缩略图`}/> : <><strong>{slide.title}</strong>{slide.sentences.slice(0, 4).map(sentence => <i key={sentence.id} style={{ width: `${Math.max(28, Math.min(82, sentence.source.length))}%` }} />)}</>}</div>
    </button>)}
  </aside>;
}

function SlidePage({
  slide, translated, busy = false, progress = 0, progressMessage, progressElapsed, progressLabel, error, onCancel, onRetry, canSkip = false, loading = false, readError
}: {
  slide: SlideData;
  translated: boolean;
  busy?: boolean;
  progress?: number;
  progressMessage?: string;
  progressElapsed?: string;
  progressLabel?: string;
  error?: string;
  onCancel?: () => void;
  onRetry?: (mode: 'current' | 'next') => void;
  canSkip?: boolean;
  loading?: boolean;
  readError?: string;
}) {
  if (loading || readError) return <article className="lw-slide-wrap"><header><strong>{translated ? '译文' : '原文'}</strong></header><div className="history-page-placeholder">{loading ? <><span className="history-page-skeleton"/>正在读取页面</> : '页面暂时无法显示，请点击上方“重新读取”。'}</div></article>;
  const fallbackRegion = (index: number) => ({ x: 8, y: 9 + index * Math.min(10, 76 / Math.max(1, slide.sentences.length)), width: 84, height: 6 });
  const hasTranslation = !!slide.translatedPreview;
  return <article className="lw-slide-wrap">
    <header><strong>{translated ? '译文' : '原文'}</strong><span>{translated ? '简体中文' : '原始版式'}</span></header>
    <div className="lw-slide-viewport">
    <div
      className={translated ? 'lw-slide lw-slide-translated' : 'lw-slide lw-slide-source'}
      style={{ aspectRatio: String(slide.pageAspect || 16 / 9), width: `min(100cqw, calc(100cqh * ${slide.pageAspect || 16 / 9}))` }}
    >
      {!translated && slide.preview && <img className="lw-page-preview" src={slide.preview} alt={`原件：${slide.title}`}/>}
      {!translated && !slide.preview && slide.sourceHtml && <iframe className="lw-page-html" title={`${slide.title} 原始页面`} srcDoc={slide.sourceHtml} sandbox=""/>}
      {!translated && !slide.preview && !slide.sourceHtml && <div className="lw-source-fallback">{slide.sentences.map((sentence, index) => {
        const region = sentence.region || fallbackRegion(index);
        return <div key={sentence.id} className={sentence.role === 'title' ? 'title' : ''} style={{ left: `${region.x}%`, top: `${region.y}%`, width: `${region.width}%`, minHeight: `${region.height}%` }}>{sentence.source}</div>;
      })}</div>}
      {translated && hasTranslation && <img className="lw-page-preview" src={slide.translatedPreview} alt={'译文：' + slide.title}/>}
      {translated && !hasTranslation && <div className="lw-translation-empty">
        {busy ? <><span className="lw-page-spinner"/><strong>{progressMessage || '正在保留版式翻译'}</strong><span>完成后译文会显示在原位置</span></>
          : <><Languages size={22}/><strong>等待翻译</strong><span>译文将保持原页版式</span></>}
      </div>}
      {!slide.sentences.length && <div className="lw-no-text">此页没有可编辑文本</div>}
    </div>
    </div>
    {translated && busy && <div className="lw-translation-progress" role="status">
      <div><span>{progressMessage || '正在翻译'}{progressElapsed ? ` · ${progressElapsed}` : ''}</span>{progressLabel && <em>{progressLabel}</em>}<button onClick={onCancel}>停止</button></div>
      <i className="active"><b style={{ width: `${Math.max(4, progress)}%` }}/></i>
    </div>}
    {translated && !busy && error && <div className="lw-page-error"><span>{error}</span><button onClick={() => onRetry?.('current')}><RefreshCw size={12}/>从本页继续</button>{canSkip && <button onClick={() => onRetry?.('next')}>从下一页继续</button>}</div>}
  </article>;
}

function InterpretationDock({ recording, onToggle, providers, notify, collapsed, onCollapse }: {
  recording: boolean;
  onToggle: () => void;
  providers: Provider[];
  notify: (text: string) => void;
  collapsed: boolean;
  onCollapse: () => void;
}) {
  const [lines, setLines] = useState<InterpretationLine[]>([]);
  const [elapsed, setElapsed] = useState(0);
  const [level, setLevel] = useState(0);
  const [statusNote, setStatusNote] = useState('');
  const [asrMode, setAsrMode] = useState<CloudAsrConfig | null>(null);
  const [sourceLanguage, setSourceLanguage] = useState<'英语' | '简体中文'>('英语');
  const [draft, setDraft] = useState('');
  const [devices, setDevices] = useState<MediaDeviceInfo[]>([]);
  const [deviceId, setDeviceId] = useState(localStorage.getItem('parallel.microphone') || '');
  const [ttsEnabled, setTtsEnabled] = useState(localStorage.getItem('parallel.interpreter-tts') === 'true');
  const engineRef = useRef<InterpretationEngine | null>(null);
  const lastAsrNoteRef = useRef('');
  const [controlsOpen, setControlsOpen] = useState(false);
  const [toolbarOpen, setToolbarOpen] = useState(false);
  const [following, setFollowing] = useState(true);
  const followingRef = useRef(true);
  const transcriptRef = useRef<HTMLDivElement>(null);
  const scrollLatest = () => {
    followingRef.current = true;
    setFollowing(true);
    const node = transcriptRef.current;
    if (node) node.scrollTop = node.scrollHeight;
  };
  useEffect(() => {
    if (followingRef.current) scrollLatest();
  }, [lines, draft, collapsed, controlsOpen, toolbarOpen]);
  useEffect(() => {
    const node = transcriptRef.current;
    if (!node) return;
    const observer = new ResizeObserver(() => { if (followingRef.current) scrollLatest(); });
    observer.observe(node);
    return () => observer.disconnect();
  }, [collapsed]);
  const [position, setPosition] = useState(() => {
    try { return JSON.parse(localStorage.getItem('parallel.speech-position') || 'null') || { x: 24, y: 110 }; }
    catch { return { x: 24, y: 110 }; }
  });
  const [busy, setBusy] = useState(false);
  const targetLanguage = sourceLanguage === '英语' ? '简体中文' : '英语';

  useEffect(() => {
    const refreshAsr = () => {
    try {
      const saved = JSON.parse(localStorage.getItem('parallel.asr-config') || '{}') as {
        providerId?: AsrProviderId; model?: string; apiKey?: string; baseUrl?: string; language?: string;
      };
      const preset = getAsrProvider(saved.providerId || 'browser-native');
      if (preset && preset.id !== 'browser-native') {
        setAsrMode({
          providerId: preset.id,
          preset,
          modelId: saved.model || preset.defaultModelId,
          apiKey: saved.apiKey || '',
          baseUrl: saved.baseUrl || preset.defaultBaseUrl || '',
          language: saved.language || preset.languages[0] || 'auto'
        });
      } else {
        setAsrMode(null);
      }
    } catch { setAsrMode(null); }
    };
    refreshAsr();
    window.addEventListener('parallel-asr-config', refreshAsr);
    return () => window.removeEventListener('parallel-asr-config', refreshAsr);
  }, []);

  useEffect(() => {
    const refresh = () => void navigator.mediaDevices?.enumerateDevices().then(items => {
      setDevices(items.filter(item => item.kind === 'audioinput'));
    }).catch(() => undefined);
    refresh();
    navigator.mediaDevices?.addEventListener?.('devicechange', refresh);
    return () => navigator.mediaDevices?.removeEventListener?.('devicechange', refresh);
  }, []);

  useEffect(() => {
    if (!recording) return;
    const timer = window.setInterval(() => setElapsed(value => value + 1), 1000);
    return () => window.clearInterval(timer);
  }, [recording]);

  const activeEngine = useMemo(() => resolveEngineForTask(providers, 'realtime-translation'), [providers]);

  async function toggleRecording() {
    if (busy) return;
    if (recording) {
      setBusy(true);
      setStatusNote('正在保存录音与最后一段文字…');
      try {
      await engineRef.current?.stop();
      setStatusNote(value => value === '正在保存录音与最后一段文字…' ? '录音与文字已保存' : value);
      engineRef.current = null;
      window.speechSynthesis?.cancel();
      onToggle();
      } finally { setBusy(false); }
      return;
    }
    if (!asrMode && !speechRecognitionAvailable) { notify('当前浏览器不支持语音识别，请使用 Chrome 或 Edge'); return; }
    const cloud = asrMode ? { ...asrMode, language: asrMode.language === 'auto' ? 'auto' : sourceLanguage === '英语' ? 'en' : 'zh' } : null;
    const interpreter = new InterpretationEngine(cloud, activeEngine, targetLanguage);
    interpreter.onLevel = value => setLevel(value);
    interpreter.onDraft = setDraft;
    interpreter.onLine = line => {
      if (!line.pending && line.target && ttsEnabled && !line.target.startsWith('（')) {
        window.speechSynthesis?.cancel();
        const speech = new SpeechSynthesisUtterance(line.target);
        speech.lang = targetLanguage === '简体中文' ? 'zh-CN' : 'en-US';
        window.speechSynthesis?.speak(speech);
      }
      setLines(previous => {
        const found = previous.findIndex(item => item.key === line.key);
        const next = found === -1 ? [...previous, line] : previous.map(item => item.key === line.key ? line : item);
        return next.slice(-100);
      });
    };
    engineRef.current = interpreter;
    setBusy(true);
    setStatusNote('正在连接麦克风…');
    try {
      await interpreter.start(sourceLanguage, (status, message) => {
        const text = message || '';
        if (status === 'error') {
          setStatusNote(text || '识别暂时中断');
          if (text && text !== lastAsrNoteRef.current) { lastAsrNoteRef.current = text; notify(text); }
        } else setStatusNote('');
      }, deviceId || undefined);
      void navigator.mediaDevices?.enumerateDevices().then(items => setDevices(items.filter(item => item.kind === 'audioinput')));
      setElapsed(0);
      setDraft('');
      setStatusNote('');
      lastAsrNoteRef.current = '';
      onToggle();
    } catch (error) {
      await interpreter.stop().catch(() => undefined);
      engineRef.current = null;
      if ((error as Error).message === 'asr-not-ready') notify('先在设置的语音识别页填好密钥');
      else if ((error as Error).message !== 'microphone') notify('同传启动失败，请重试');
    } finally { setBusy(false); }
  }

  const clock = String(Math.floor(elapsed / 60)).padStart(2, '0') + ':' + String(elapsed % 60).padStart(2, '0');

  function swapLanguages() {
    if (recording) { notify('停止同传后再切换语言'); return; }
    setSourceLanguage(value => value === '英语' ? '简体中文' : '英语');
  }

  function toggleTts() {
    const next = !ttsEnabled;
    setTtsEnabled(next);
    localStorage.setItem('parallel.interpreter-tts', String(next));
    if (!next) window.speechSynthesis?.cancel();
  }

  function exportTranscript() {
    if (!lines.length) { notify('还没有可导出的同传内容'); return; }
    const body = lines.map(line => `**${line.time} 原声**  ${line.source}\n\n**译文**  ${line.target || '翻译中'}\n`).join('\n');
    const blob = new Blob([`# 同声传译记录\n\n${body}`], { type: 'text/markdown;charset=utf-8' });
    const anchor = document.createElement('a');
    anchor.href = URL.createObjectURL(blob);
    anchor.download = `同声传译-${new Date().toISOString().slice(0, 10)}.md`;
    anchor.click();
    window.setTimeout(() => URL.revokeObjectURL(anchor.href), 1000);
  }

  if (collapsed) {
    return <section key="collapsed" className="iw-collapsed">
      <button className="iw-collapsed-main" onClick={onCollapse}>
        <span className={recording ? 'iw-radio active' : 'iw-radio'}><Radio size={15}/></span>
        <strong>同声传译</strong>
        <small>{statusNote || (recording ? `正在同传 · ${clock}` : '准备就绪')}</small>
        <ChevronDown size={15}/>
      </button>
      <button disabled={busy} className={recording ? 'iw-quick-start recording' : 'iw-quick-start'} onClick={() => void toggleRecording()}>
        {recording ? <CircleStop size={15}/> : <Mic size={15}/>}
        {recording ? '停止' : '开始'}
      </button>
    </section>;
  }

  return <section key="expanded" className="lw-dock iw-dock iw-floating" style={{ left: Math.max(0, Math.min(position.x, window.innerWidth - 160)), top: Math.max(60, Math.min(position.y, window.innerHeight - 80)) }}>
    <div className="iw-drag-bar" onPointerDown={event => {
      if ((event.target as HTMLElement).closest('button')) return;
      const x = event.clientX, y = event.clientY;
      const initial = event.currentTarget.parentElement!.getBoundingClientRect();
      event.currentTarget.setPointerCapture(event.pointerId);
      const move = (e: PointerEvent) => {
        const next = { x: Math.max(0, Math.min(window.innerWidth - initial.width, initial.x + e.clientX - x)), y: Math.max(60, Math.min(window.innerHeight - 80, initial.y + e.clientY - y)) };
        setPosition(next); localStorage.setItem('parallel.speech-position', JSON.stringify(next));
      };
      const end = () => { window.removeEventListener('pointermove', move); window.removeEventListener('pointerup', end); window.removeEventListener('pointercancel', end); };
      window.addEventListener('pointermove', move); window.addEventListener('pointerup', end); window.addEventListener('pointercancel', end);
    }}><span>⠿ 同声传译 {recording ? clock : ''}</span><div className="iw-compact-actions">
      <button aria-expanded={controlsOpen} onClick={() => setControlsOpen(value => !value)} title="麦克风与语言设置"><Settings size={15}/>设置</button>
      <button aria-expanded={toolbarOpen} onClick={() => setToolbarOpen(value => !value)} title="展开或收起工具栏"><ChevronDown size={15}/>工具</button>
      <button disabled={busy} onClick={() => void toggleRecording()}>{recording ? <CircleStop size={15}/> : <Mic size={15}/>}{busy ? '处理中' : recording ? '停止' : '开始'}</button>
      <button type="button" onClick={onCollapse} aria-label="关闭同传面板" title={recording ? '收起面板，录音继续' : '关闭面板'}><X size={16}/></button>
    </div></div>
    {toolbarOpen && <header className="iw-header">
      <div className="iw-heading"><span className={recording ? 'iw-radio active' : 'iw-radio'}><Radio size={16}/></span><div><strong>同声传译</strong><small>{recording ? `正在同传 · ${clock}` : statusNote || '准备就绪'}</small></div></div>
      <div className="iw-services"><span>{asrMode ? asrMode.preset.name : '浏览器识别'}</span><i>→</i><span>{activeEngine?.name || '未选择翻译引擎'}</span></div>
      <div className="iw-actions">
        <button className={ttsEnabled ? 'active' : ''} onClick={toggleTts}>{ttsEnabled ? <Volume2 size={15}/> : <VolumeX size={15}/>}译文朗读</button>
        <button onClick={exportTranscript}><Download size={15}/>导出</button>
        <button onClick={() => { setLines([]); setDraft(''); }}><Trash2 size={15}/>清空</button>
        <button onClick={onCollapse} aria-label="收起同声传译"><ChevronDown size={15}/></button>
      </div>
    </header>}

    <div className={controlsOpen ? 'iw-body iw-reading' : 'iw-body iw-reading controls-hidden'}>
      {controlsOpen && <div className="iw-controls">
        <label className="iw-device"><span>麦克风</span><div><select disabled={recording} value={deviceId} onChange={event => { setDeviceId(event.target.value); localStorage.setItem('parallel.microphone', event.target.value); }}><option value="">系统默认麦克风</option>{devices.map((device, index) => <option key={device.deviceId} value={device.deviceId}>{device.label || `麦克风 ${index + 1}`}</option>)}</select><RefreshCw size={14}/></div></label>
        <div className="iw-language-pair">
          <label><span>原声</span><select disabled={recording} value={sourceLanguage} onChange={event => setSourceLanguage(event.target.value as '英语' | '简体中文')}><option>英语</option><option>简体中文</option></select></label>
          <button disabled={recording} onClick={swapLanguages} aria-label="交换语言"><ArrowLeftRight size={16}/></button>
          <label><span>译文</span><select disabled value={targetLanguage}><option>{targetLanguage}</option></select></label>
        </div>
        <div className="iw-recorder">
          <button className={recording ? 'iw-record active' : 'iw-record'} onClick={() => void toggleRecording()} aria-label={recording ? '停止同传' : '开始同传'}>{recording ? <CircleStop size={25}/> : <Mic size={25}/>}</button>
          <div><strong>{recording ? '停止同传' : '开始同传'}</strong><span>{recording ? statusNote || '正在识别并翻译' : '录音和文字仅保存在本机'}</span></div>
          <div className={recording ? 'iw-wave active' : 'iw-wave'}>{Array.from({ length: 24 }, (_, index) => <i key={index} style={{ height: `${5 + Math.round((recording ? level : .04) * (7 + (index * 11) % 28))}px` }}/>)}</div>
        </div>
      </div>}

      <div className="iw-transcript">
        <div className="iw-reading-heading"><span>{sourceLanguage} → {targetLanguage}</span><small>{statusNote}</small></div>
        <div className="iw-lines" ref={transcriptRef} tabIndex={0} aria-label="同传原文与译文" onScroll={event => {
          const node = event.currentTarget;
          const bottom = node.scrollHeight - node.clientHeight - node.scrollTop < 32;
          followingRef.current = bottom;
          setFollowing(bottom);
        }}>
          {!lines.length && !draft ? <div className="iw-empty"><Languages size={22}/><strong>{recording ? '正在听取原声' : '原声与译文会在这里逐句对照'}</strong><span>{recording ? '识别到完整句子后会立即翻译' : '选择麦克风和语言，然后开始同传'}</span></div> : lines.map(line => <div key={line.key} className={line.pending ? 'iw-line pending' : 'iw-line'}><p>{line.source}</p><p>{line.target || <span className="iw-thinking">正在翻译<span>•••</span></span>}</p><time>{line.time}</time></div>)}
          {draft && <div className="iw-line draft"><p>{draft}</p><p>正在听取…</p><time>{clock}</time></div>}
        </div>
        {!following && <button className="iw-back-latest" onClick={scrollLatest}>回到最新 ↓</button>}
      </div>
    </div>
  </section>;
}
