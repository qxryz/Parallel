import type { ResolvedEngine } from './modelRouting';
import { pdfTranslationHeaders } from './pdfTranslationSettings';
import { PDFDocument } from 'pdf-lib';

export type Pdf2zhProgress = {
  stage: string;
  current: number;
  total: number;
  message: string;
  percent?: number;
  elapsedSeconds?: number;
  idleSeconds?: number;
  readyPages?: number[];
  events?: Pdf2zhTraceEvent[];
};

export type Pdf2zhTraceEvent = {
  id: number;
  stage: string;
  action: string;
  engineType: string;
  engineName: string;
  model?: string;
  status: 'success' | 'warning' | 'error';
  durationMs: number;
  detail?: string;
  inputPreview?: string;
  outputPreview?: string;
};

export type Pdf2zhResult = {
  jobId: string;
};

export type Pdf2zhPageResult = {
  mono: File;
  dual?: File;
};

export type Pdf2zhResume = { jobId: string; mode: 'current' | 'next' };

export class Pdf2zhJobError extends Error {
  constructor(message: string, readonly jobId: string) {
    super(message);
    this.name = 'Pdf2zhJobError';
  }
}

function encode(value: string | undefined): string {
  return encodeURIComponent(value || '');
}

function engineHeaders(engine: ResolvedEngine): Record<string, string> {
  if (engine.kind === 'service') {
    return {
      'x-translation-kind': 'service',
      'x-translation-service': engine.serviceId,
      'x-translation-engine-name': encode(engine.name),
      'x-translation-api-key': encode(engine.config.key),
      'x-translation-base-url': encode(engine.config.baseUrl)
    };
  }
  return {
    'x-translation-kind': 'model',
    'x-translation-engine-name': encode(engine.name),
    'x-translation-base-url': encode(engine.provider.baseUrl),
    'x-translation-api-key': encode(engine.provider.key),
    'x-translation-model': encode(engine.provider.model),
    'x-translation-protocol': engine.provider.protocol || 'openai'
  };
}

async function readError(response: Response, fallback: string): Promise<string> {
  const payload = await response.json().catch(() => null) as { error?: string | { message?: string } } | null;
  return typeof payload?.error === 'string' ? payload.error : payload?.error?.message || fallback;
}

export async function translatePdfWithLayout(
  source: File,
  engine: ResolvedEngine,
  onProgress: (progress: Pdf2zhProgress) => void,
  signal?: AbortSignal,
  onPageComplete?: (pageIndex: number, page: Pdf2zhPageResult) => void | Promise<void>,
  resume?: Pdf2zhResume,
  onJobReady?: (jobId: string) => void,
  onTrace?: (event: Pdf2zhTraceEvent) => void,
  startPage = 1,
  endPage?: number
): Promise<Pdf2zhResult> {
  const started = await fetch(resume ? `/api/pdf2zh/jobs/${resume.jobId}/resume` : '/api/pdf2zh/jobs', {
    method: 'POST',
    headers: {
      'content-type': resume ? 'application/json' : 'application/pdf',
      'x-source-language': 'en',
      'x-target-language': 'zh',
      'x-start-page': String(Math.max(1, Math.round(startPage))),
      ...(endPage ? { 'x-end-page': String(Math.max(startPage, Math.round(endPage))) } : {}),
      ...pdfTranslationHeaders(),
      ...engineHeaders(engine)
    },
    body: resume ? JSON.stringify({ mode: resume.mode }) : source,
    signal
  });
  if (!started.ok) throw new Error(await readError(started, resume ? '无法继续翻译' : '无法开始版面翻译'));
  const created = await started.json() as { id: string; eventCursor?: number };
  const jobId = created.id;
  onJobReady?.(jobId);
  const receivedPages = new Set<number>();
  let eventCursor = created.eventCursor || 0;

  try {
    for (;;) {
      if (signal?.aborted) throw new DOMException('Aborted', 'AbortError');
      const response = await fetch('/api/pdf2zh/jobs/' + jobId, { signal });
      if (!response.ok) throw new Error(await readError(response, '翻译任务已中断'));
      const status = await response.json() as Pdf2zhProgress & { state: 'queued' | 'running' | 'success' | 'error'; hasDual?: boolean };
      for (const event of status.events || []) {
        if (event.id <= eventCursor) continue;
        eventCursor = event.id;
        onTrace?.(event);
      }
      onProgress(status);
      for (const pageNumber of status.readyPages || []) {
        if (receivedPages.has(pageNumber)) continue;
        const pageResponse = await fetch(`/api/pdf2zh/jobs/${jobId}/pages/${pageNumber}/mono`, { signal });
        if (!pageResponse.ok) continue;
        receivedPages.add(pageNumber);
        const page = new File(
          [await pageResponse.arrayBuffer()],
          source.name.replace(/\.pdf$/i, '') + `-第${pageNumber}页-译文.pdf`,
          { type: 'application/pdf' }
        );
        const dualResponse = await fetch(`/api/pdf2zh/jobs/${jobId}/pages/${pageNumber}/dual`, { signal });
        const dual = dualResponse.ok
          ? new File(
            [await dualResponse.arrayBuffer()],
            source.name.replace(/\.pdf$/i, '') + `-第${pageNumber}页-双语.pdf`,
            { type: 'application/pdf' }
          )
          : undefined;
        await onPageComplete?.(pageNumber - 1, { mono: page, dual });
      }
      if (status.state === 'error') throw new Error(status.message || '版面翻译失败');
      if (status.state === 'success') {
        return { jobId };
      }
      await new Promise<void>((resolve, reject) => {
        const timer = window.setTimeout(resolve, 850);
        signal?.addEventListener('abort', () => {
          window.clearTimeout(timer);
          reject(new DOMException('Aborted', 'AbortError'));
        }, { once: true });
      });
    }
  } catch (error) {
    if (signal?.aborted) await fetch('/api/pdf2zh/jobs/' + jobId, { method: 'DELETE' }).catch(() => undefined);
    if (error instanceof DOMException && error.name === 'AbortError') throw error;
    throw new Pdf2zhJobError(error instanceof Error ? error.message : '翻译失败', jobId);
  }
}

export async function mergePdfSession(
  sourceFile: File,
  pages: Array<{ pageIndex: number; file: File }>,
  fileName: string
): Promise<File> {
  if (!pages.length) throw new Error('没有可导出的页面');
  const source = await PDFDocument.load(await sourceFile.arrayBuffer());
  const translated = new Map(pages.map(page => [page.pageIndex, page.file]));
  const merged = await PDFDocument.create();
  for (let pageIndex = 0; pageIndex < source.getPageCount(); pageIndex += 1) {
    const file = translated.get(pageIndex);
    if (file) {
      const pagePdf = await PDFDocument.load(await file.arrayBuffer());
      const copied = await merged.copyPages(pagePdf, pagePdf.getPageIndices());
      copied.forEach(page => merged.addPage(page));
    } else {
      const [page] = await merged.copyPages(source, [pageIndex]);
      merged.addPage(page);
    }
  }
  const bytes = await merged.save();
  return new File([bytes.slice().buffer], fileName, { type: 'application/pdf' });
}

export function downloadPdf(file: File): void {
  const url = URL.createObjectURL(file);
  const anchor = document.createElement('a');
  anchor.href = url;
  anchor.download = file.name;
  anchor.click();
  window.setTimeout(() => URL.revokeObjectURL(url), 1500);
}
