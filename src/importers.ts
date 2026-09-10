import JSZip from 'jszip';
import { XMLParser } from 'fast-xml-parser';
import type { Sentence, SlideData, TextRegion } from './types';
import { pdfEngineHeaders } from './pdfProviders';

const sentence = (text: string, page: number, index: number, role: 'title' | 'body' = 'body', region?: TextRegion): Sentence => ({
  id: `import-${page}-${index}`,
  source: text,
  target: '',
  role,
  region
});

export async function importPresentation(file: File, providers: import('./types').Provider[] = []): Promise<SlideData[]> {
  const ext = file.name.split('.').pop()?.toLowerCase();
  if (!ext || !['pptx', 'ppt', 'pdf', 'html', 'htm'].includes(ext)) throw new Error('暂不支持该文件格式');
  const pdf = ext === 'pdf' ? file : await normalizePresentation(file);
  return importPdfDocument(pdf, providers);
}

/** PDFMathTranslate 只接收 PDF；其他演示格式先由 LibreOffice 统一转换。 */
export async function normalizePresentation(file: File): Promise<File> {
  const ext = file.name.split('.').pop()?.toLowerCase() || '';
  const response = await fetch('/api/document/normalize', {
    method: 'POST',
    headers: { 'content-type': file.type || 'application/octet-stream', 'x-file-ext': ext },
    body: file
  });
  if (!response.ok) {
    const payload = await response.json().catch(() => null) as { error?: string } | null;
    throw new Error(payload?.error || '无法把文件转换为 PDF');
  }
  const name = file.name.replace(/\.(pptx?|pdf|html?)$/i, '') + '.pdf';
  return new File([await response.arrayBuffer()], name, { type: 'application/pdf' });
}

async function importPptx(file: File): Promise<SlideData[]> {
  try {
    const [zip, previews] = await Promise.all([
      JSZip.loadAsync(await file.arrayBuffer()),
      renderPresentation(file).catch(() => [] as string[])
    ]);
    const names = Object.keys(zip.files)
      .filter(name => /^ppt\/slides\/slide\d+\.xml$/.test(name))
      .sort((left, right) => slideNumber(left) - slideNumber(right));
    if (!names.length) throw new Error('文件中没有找到幻灯片页面');
    const presentationXml = await zip.file('ppt/presentation.xml')?.async('text');
    const size = extractPptxSize(presentationXml || '');
    const parser = new XMLParser({ ignoreAttributes: false, preserveOrder: true });
    const slides: SlideData[] = [];
    for (let i = 0; i < names.length; i++) {
      const xml = await zip.file(names[i])!.async('text');
      parser.parse(xml);
      const blocks = extractPptxBlocks(xml, size.width, size.height);
      const title = blocks[0]?.text || `第 ${i + 1} 页`;
      slides.push({
        title,
        preview: previews[i],
        sentences: blocks.map((block, index) => sentence(block.text, i, index, index === 0 ? 'title' : 'body', block.region))
      });
    }
    return slides;
  } catch (error) {
    const detail = error instanceof Error ? error.message : '';
    if (/central directory|zip file|corrupt|encrypted/i.test(detail)) {
      throw new Error('PPTX 解析失败：文件不是有效的 PPTX，或文件已经损坏');
    }
    throw new Error('PPTX 解析失败：' + (detail || '文件可能已损坏'));
  }
}

export async function importPdfDocument(file: File, providers: import('./types').Provider[] = []): Promise<SlideData[]> {
  return (await preparePdfDocument(file, providers)).slides;
}

/** 译文 PDF 的视觉结果优先；即使特殊字体导致文字层不可提取，也保留页面预览。 */
export async function importTranslatedPdfDocument(file: File): Promise<SlideData[]> {
  try {
    return (await preparePdfDocument(file, [], { recognizeScans: false })).slides;
  } catch {
    const previews = await renderPresentation(file);
    if (!previews.length) throw new Error('译文 PDF 已生成，但页面预览读取失败');
    return previews.map((preview, index) => ({ title: `第 ${index + 1} 页`, preview, sentences: [] }));
  }
}

export type PreparedPdfDocument = {
  slides: SlideData[];
  source: File;
  recognition: 'text' | 'ocr';
  processingSteps: ImportProcessingStep[];
};

export type ImportProcessingStep = {
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

export class ScanRecognitionRequiredError extends Error {
  constructor(message = '这是一份扫描文稿，需要先识别页面文字', readonly processingSteps: ImportProcessingStep[] = []) {
    super(message);
    this.name = 'ScanRecognitionRequiredError';
  }
}

export class PdfImportError extends Error {
  constructor(message: string, readonly processingSteps: ImportProcessingStep[] = []) {
    super(message);
    this.name = 'PdfImportError';
  }
}

export async function preparePdfDocument(
  file: File,
  providers: import('./types').Provider[] = [],
  options: { recognizeScans?: boolean } = {}
): Promise<PreparedPdfDocument> {
  const response = await fetch('/api/import/pdf', {
    method: 'POST',
    headers: {
      'content-type': 'application/pdf',
      ...(options.recognizeScans === false ? { 'x-pdf-provider': 'unpdf' } : pdfEngineHeaders(providers))
    },
    body: file
  });
    const payload = await response.json().catch(() => null) as {
    pages?: string[];
    previews?: string[];
    boxes?: Array<{ width: number; height: number; lines: Array<{ text: string; x: number; y: number; width: number; height: number }>; blocks: Array<{ text: string; x: number; y: number; width: number; height: number }> }>;
    recognition?: 'text' | 'ocr';
    processedPdf?: string;
    processingSteps?: ImportProcessingStep[];
    error?: string;
  } | null;
  if (!response.ok || !Array.isArray(payload?.pages)) {
    if (/扫描件|扫描文稿/.test(payload?.error || '')) throw new ScanRecognitionRequiredError(undefined, payload?.processingSteps || []);
    throw new PdfImportError(payload?.error || 'PDF 解析失败', payload?.processingSteps || []);
  }
  if (!payload.pages.length) throw new Error('PDF 中没有找到页面');
  const result = payload.pages.map((page, pageIndex) => {
    const textLines = page.split(/\r?\n/)
      .map(line => line.replace(/\s{2,}/g, ' ').trim())
      .filter(Boolean);
    const boxPage = payload.boxes?.[pageIndex];
    const lines = boxPage?.blocks?.length
      ? boxPage.blocks
      : boxPage?.lines?.length
        ? boxPage.lines
        : textLines.map((text, index) => ({
            text, x: 7, y: 10 + index * Math.min(8, 76 / Math.max(1, textLines.length)), width: 86, height: 5
          }));
    const title = lines[0]?.text || `第 ${pageIndex + 1} 页`;
    return {
      title,
      preview: payload.previews?.[pageIndex],
      pageAspect: boxPage?.width && boxPage?.height ? boxPage.width / boxPage.height : undefined,
      sentences: lines.map((line, index) => sentence(line.text, pageIndex, index, index === 0 ? 'title' : 'body', boxPage ? {
        x: line.x / boxPage.width * 100,
        y: line.y / boxPage.height * 100,
        width: line.width / boxPage.width * 100,
        height: line.height / boxPage.height * 100
      } : { x: line.x, y: line.y, width: line.width, height: line.height }))
    };
  });
  if (result.every(slide => !slide.sentences.length)) {
    throw new Error('这是扫描版 PDF（页面是图片），没有可以提取的文字，请换文字版 PDF');
  }
  const source = payload.processedPdf
    ? new File([Uint8Array.from(atob(payload.processedPdf), char => char.charCodeAt(0))], file.name, { type: 'application/pdf' })
    : file;
  return { slides: result, source, recognition: payload.recognition || 'text', processingSteps: payload.processingSteps || [] };
}

async function importLegacyPpt(file: File): Promise<SlideData[]> {
  const response = await fetch('/api/import/ppt', {
    method: 'POST',
    headers: {
      'content-type': 'application/vnd.ms-powerpoint',
      'x-file-name': encodeURIComponent(file.name)
    },
    body: file
  });
  if (!response.ok) {
    const payload = await response.json().catch(() => null) as { error?: string } | null;
    throw new Error(payload?.error || '旧版 PPT 转换失败');
  }
  const converted = new File(
    [await response.arrayBuffer()],
    file.name.replace(/\.ppt$/i, '.pptx'),
    { type: 'application/vnd.openxmlformats-officedocument.presentationml.presentation' }
  );
  return importPptx(converted);
}

async function importHtml(file: File): Promise<SlideData[]> {
  const raw = await file.text();
  const doc = new DOMParser().parseFromString(raw, 'text/html');
  const sections = [...doc.querySelectorAll('section, article, .slide')];
  const nodes = sections.length ? sections : [doc.body];
  return nodes.map((node, i) => {
    const title = node.querySelector('h1,h2,h3')?.textContent?.trim() || `第 ${i + 1} 页`;
    const blocks = [...node.querySelectorAll('h1,h2,h3,p,li,blockquote')].map(x => x.textContent?.trim() || '').filter(Boolean);
    const styles = [...doc.querySelectorAll('style')].map(style => style.outerHTML).join('');
    const sourceHtml = `<!doctype html><html><head><meta charset="utf-8">${styles}<style>html,body{margin:0;width:100%;height:100%;overflow:hidden}body{box-sizing:border-box}</style></head><body>${node.outerHTML}</body></html>`;
    const svg = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 1280 720"><foreignObject width="1280" height="720"><div xmlns="http://www.w3.org/1999/xhtml" style="width:1280px;height:720px;overflow:hidden;background:white">${styles}${node.outerHTML}</div></foreignObject></svg>`;
    return {
      title,
      sourceHtml,
      preview: 'data:image/svg+xml;charset=utf-8,' + encodeURIComponent(svg),
      sentences: blocks.map((text, j) => sentence(text, i, j, j === 0 ? 'title' : 'body', estimateRegion(j, blocks.length)))
    };
  });
}

export async function renderPresentation(file: File): Promise<string[]> {
  const response = await fetch('/api/import/render', {
    method: 'POST',
    headers: { 'content-type': file.type || 'application/octet-stream', 'x-file-ext': file.name.split('.').pop()?.toLowerCase() || 'pptx' },
    body: file
  });
  if (!response.ok) return [];
  const payload = await response.json() as { previews?: string[] };
  return payload.previews || [];
}

function decodeXml(value: string) {
  const el = document.createElement('textarea');
  el.innerHTML = value;
  return el.value;
}

function slideNumber(name: string): number {
  return Number(name.match(/slide(\d+)\.xml$/)?.[1] || 0);
}

function extractPptxParagraphs(xml: string): string[] {
  const paragraphs = [...xml.matchAll(/<a:p(?:\s[^>]*)?>([\s\S]*?)<\/a:p>/g)]
    .map(paragraph => [...paragraph[1].matchAll(/<a:t(?:\s[^>]*)?>([\s\S]*?)<\/a:t>/g)]
      .map(run => decodeXml(run[1]))
      .join('')
      .replace(/\s+/g, ' ')
      .trim())
    .filter(Boolean);
  if (paragraphs.length) return paragraphs;
  return [...xml.matchAll(/<a:t(?:\s[^>]*)?>([\s\S]*?)<\/a:t>/g)]
    .map(match => decodeXml(match[1]).replace(/\s+/g, ' ').trim())
    .filter(Boolean);
}

function extractPptxSize(xml: string): { width: number; height: number } {
  const match = xml.match(/<p:sldSz\b[^>]*\bcx="(\d+)"[^>]*\bcy="(\d+)"/);
  return { width: Number(match?.[1]) || 12192000, height: Number(match?.[2]) || 6858000 };
}

function extractPptxBlocks(xml: string, slideWidth: number, slideHeight: number): Array<{ text: string; region: TextRegion }> {
  const result: Array<{ text: string; region: TextRegion }> = [];
  const shapes = [...xml.matchAll(/<p:sp\b[\s\S]*?<\/p:sp>/g)];
  shapes.forEach(shapeMatch => {
    const shape = shapeMatch[0];
    const off = shape.match(/<a:off\b[^>]*\bx="(-?\d+)"[^>]*\by="(-?\d+)"/);
    const ext = shape.match(/<a:ext\b[^>]*\bcx="(\d+)"[^>]*\bcy="(\d+)"/);
    const paragraphs = extractPptxParagraphs(shape);
    if (!paragraphs.length) return;
    const x = Number(off?.[1]) || slideWidth * .08;
    const y = Number(off?.[2]) || slideHeight * .08;
    const width = Number(ext?.[1]) || slideWidth * .84;
    const height = Number(ext?.[2]) || Math.max(slideHeight * .06, paragraphs.length * slideHeight * .055);
    paragraphs.forEach((text, index) => result.push({
      text,
      region: {
        x: Math.max(0, x / slideWidth * 100),
        y: Math.max(0, (y + height * index / paragraphs.length) / slideHeight * 100),
        width: Math.min(100, width / slideWidth * 100),
        height: Math.max(3, height / paragraphs.length / slideHeight * 100)
      }
    }));
  });
  return result.length ? result : extractPptxParagraphs(xml).map((text, index, all) => ({ text, region: estimateRegion(index, all.length) }));
}

function estimateRegion(index: number, count: number): TextRegion {
  const step = Math.min(10, 76 / Math.max(1, count));
  return { x: 8, y: 9 + index * step, width: 84, height: Math.max(4, step * .72) };
}
