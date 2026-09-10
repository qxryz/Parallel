import { defineConfig, type Connect } from 'vite';
import react from '@vitejs/plugin-react';
import JSZip from 'jszip';
import fontkit from '@pdf-lib/fontkit';
import { PDFDocument } from 'pdf-lib';
import { execFile, spawn } from 'node:child_process';
import { createHash, createHmac, randomUUID } from 'node:crypto';
import { existsSync } from 'node:fs';
import { mkdir, mkdtemp, readFile, readdir, rename, rm, writeFile } from 'node:fs/promises';
import { basename, extname, join, resolve } from 'node:path';
import { tmpdir } from 'node:os';
import { promisify } from 'node:util';

const execFileAsync = promisify(execFile);
const firstExisting = (fallback: string, candidates: Array<string | undefined>) => (
  candidates.find((path): path is string => Boolean(path && existsSync(path))) || fallback
);
const SOFFICE = firstExisting('soffice', [
  process.env.PARALLEL_SOFFICE,
  '/Applications/LibreOffice.app/Contents/MacOS/soffice',
  '/opt/homebrew/bin/soffice',
  '/usr/local/bin/soffice'
]);
const PDFTOTEXT = firstExisting('pdftotext', [process.env.PARALLEL_PDFTOTEXT, '/opt/homebrew/bin/pdftotext', '/usr/local/bin/pdftotext']);
const PDFTOPPM = firstExisting('pdftoppm', [process.env.PARALLEL_PDFTOPPM, '/opt/homebrew/bin/pdftoppm', '/usr/local/bin/pdftoppm']);
const PDF2ZH_PYTHON = firstExisting('python3', [
  process.env.PARALLEL_PYTHON,
  join(process.cwd(), '.runtime', 'pdf2zh', 'bin/python')
]);
const PDF2ZH_BRIDGE = join(process.cwd(), 'scripts/pdf2zh_bridge.py');
const LOCAL_DATA_DIR = process.env.PARALLEL_DATA_DIR || join(process.cwd(), '.parallel-data');
const LOCAL_DB_PATH = join(LOCAL_DATA_DIR, 'parallel.sqlite');
const STANDARD_FONT_DATA = firstExisting('', [
  process.env.PARALLEL_STANDARD_FONTS,
  join(process.cwd(), 'node_modules', 'pdfjs-dist', 'standard_fonts'),
  process.env.HOME ? join(process.env.HOME, '.cache', 'codex-runtimes', 'codex-primary-runtime', 'dependencies', 'node', 'node_modules', 'pdfjs-dist', 'standard_fonts') : undefined
]);
const OCR_FONT_CANDIDATES = [
  '/Library/Fonts/Arial Unicode.ttf',
  '/System/Library/Fonts/Supplemental/Arial Unicode.ttf',
  process.env.WINDIR ? join(process.env.WINDIR, 'Fonts', 'arial.ttf') : '',
  process.env.WINDIR ? join(process.env.WINDIR, 'Fonts', 'msyh.ttc') : ''
].filter(Boolean);

type Pdf2zhRoute =
  | { kind: 'model'; displayName: string; baseUrl: string; apiKey: string; model: string; protocol: string }
  | { kind: 'service'; displayName: string; serviceId: string; baseUrl: string; apiKey: string };

type Pdf2zhTraceEvent = {
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

type ImportProcessingStep = Omit<Pdf2zhTraceEvent, 'id'>;

type Pdf2zhJob = {
  id: string;
  folder: string;
  state: 'queued' | 'running' | 'success' | 'error';
  stage: string;
  current: number;
  total: number;
  message: string;
  mono?: string;
  dual?: string;
  createdAt: number;
  lastActivityAt: number;
  sourceText?: string;
  route?: Pdf2zhRoute;
  validationPending?: boolean;
  readyPages?: Map<number, { mono: string; dual?: string }>;
  pageStartedAt?: number;
  pageProgress?: number;
  requestFailures?: number;
  lastRequestError?: string;
  layoutMode?: 'precise' | 'fast';
  layoutStartedAt?: number;
  layoutTracePending?: boolean;
  events?: Pdf2zhTraceEvent[];
  nextEventId?: number;
  child?: ReturnType<typeof spawn>;
};

const pdf2zhJobs = new Map<string, Pdf2zhJob>();

function readBody(req: Connect.IncomingMessage, maxBytes = 100 * 1024 * 1024): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    let size = 0;
    req.on('data', chunk => {
      const part = Buffer.from(chunk);
      size += part.length;
      if (size > maxBytes) {
        reject(new Error(`请求内容超过 ${Math.round(maxBytes / 1024 / 1024)}MB`));
        req.destroy();
        return;
      }
      chunks.push(part);
    });
    req.on('end', () => resolve(Buffer.concat(chunks)));
    req.on('error', reject);
  });
}

function sendJson(res: Connect.ServerResponse, status: number, value: unknown): void {
  res.statusCode = status;
  res.setHeader('content-type', 'application/json; charset=utf-8');
  res.end(JSON.stringify(value));
}

function hasReadableText(pages: string[]): boolean {
  return pages.some(page => page.replace(/\s/g, '').length >= 3);
}

/** 把 OCR 坐标写成不可见文字层，让预览、复制和 PDFMathTranslate 使用同一份 PDF。 */
async function addOcrTextLayer(buffer: Buffer, boxes: PdfBoxPage[]): Promise<Buffer> {
  const pdf = await PDFDocument.load(buffer);
  pdf.registerFontkit(fontkit);
  let fontBytes: Buffer | null = null;
  for (const path of OCR_FONT_CANDIDATES) {
    try {
      fontBytes = await readFile(path);
      break;
    } catch { /* 继续尝试系统字体 */ }
  }
  if (!fontBytes) throw new Error('系统缺少可用于扫描件文字层的 Unicode 字体');
  const font = await pdf.embedFont(fontBytes, { subset: true });
  const pdfPages = pdf.getPages();
  for (let index = 0; index < Math.min(pdfPages.length, boxes.length); index++) {
    const page = pdfPages[index];
    const pageBox = boxes[index];
    const { width, height } = page.getSize();
    for (const line of pageBox.blocks.length ? pageBox.blocks : pageBox.lines) {
      const text = line.text.replace(/\s+/g, ' ').trim();
      if (!text) continue;
      const x = line.x / pageBox.width * width;
      const top = line.y / pageBox.height * height;
      const targetWidth = Math.max(4, line.width / pageBox.width * width);
      const targetHeight = Math.max(3, line.height / pageBox.height * height);
      let size = Math.max(3, targetHeight * 0.76);
      const measured = font.widthOfTextAtSize(text, size);
      if (measured > targetWidth) size = Math.max(2.5, size * targetWidth / measured);
      page.drawText(text, { x, y: Math.max(0, height - top - size), size, font, opacity: 0 });
    }
  }
  return Buffer.from(await pdf.save());
}

function decodeEntities(value: string): string {
  return value.replace(/&amp;/g, '&').replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&quot;/g, '"').replace(/&#39;/g, "'");
}

const CJK = /[\u4e00-\u9fff\u3000-\u303f\uff00-\uffef]/;

// 段落内的多行合并：中文行直接相接，英文行用空格
function joinBlockLines(lines: string[]): string {
  let out = '';
  for (const line of lines) {
    if (!out) { out = line; continue; }
    const cjkBreak = CJK.test(out[out.length - 1]) || CJK.test(line[0]);
    out += (cjkBreak ? '' : ' ') + line;
  }
  return out;
}

type PdfBoxLine = { text: string; x: number; y: number; width: number; height: number };
type PdfBoxPage = { width: number; height: number; lines: PdfBoxLine[]; blocks: PdfBoxLine[] };

// 用 pdfjs（unpdf，OpenMaic 同款）按页提取文字与精确坐标，聚合成行和段落块。
async function parsePdfWithPdfjs(buffer: Buffer): Promise<{ pages: string[]; boxes: PdfBoxPage[] }> {
  const { getDocumentProxy, extractText } = await import('unpdf');
  const pdf = await getDocumentProxy(new Uint8Array(buffer), STANDARD_FONT_DATA
    ? { standardFontDataUrl: STANDARD_FONT_DATA + '/' }
    : undefined);
  const { text: mergedText } = await extractText(pdf, { mergePages: false });
  const pages = (Array.isArray(mergedText) ? mergedText : [mergedText]).map(page => page.replace(/\s+$/g, ''));
  const boxes: PdfBoxPage[] = [];
  for (let pageNumber = 1; pageNumber <= pdf.numPages; pageNumber++) {
    const page = await pdf.getPage(pageNumber);
    const viewport = page.getViewport({ scale: 1 });
    const content = await page.getTextContent();
    type RawItem = { str: string; width: number; transform: number[] };
    type Item = { text: string; left: number; right: number; baseline: number; size: number };
    const items: Item[] = [];
    for (const raw of content.items as RawItem[]) {
      if (!raw.str || !raw.str.trim()) continue;
      const t = raw.transform;
      const size = Math.hypot(t[2], t[3]) || 10;
      items.push({ text: raw.str, left: t[4], right: t[4] + (raw.width || 0), baseline: t[5], size });
    }
    if (!items.length) { boxes.push({ width: viewport.width, height: viewport.height, lines: [], blocks: [] }); continue; }
    // 聚合成行：基线相近的项为一行（阅读顺序：从上到下、行内从左到右）
    items.sort((a, b) => (b.baseline - a.baseline) || (a.left - b.left));
    type Line = { text: string; left: number; right: number; top: number; bottom: number; size: number };
    const lines: Line[] = [];
    let bucket: Item[] = [];
    const flushBucket = () => {
      if (!bucket.length) return;
      bucket.sort((a, b) => a.left - b.left);
      let text = '';
      let prev: Item | null = null;
      for (const item of bucket) {
        if (prev && item.left - prev.right > item.size * 0.26 && !/\s$/.test(text) && !/^\s/.test(item.text)) text += ' ';
        text += item.text;
        prev = item;
      }
      const size = Math.max(...bucket.map(item => item.size));
      const baseline = Math.max(...bucket.map(item => item.baseline));
      lines.push({
        text: text.trim(),
        left: Math.min(...bucket.map(item => item.left)),
        right: Math.max(...bucket.map(item => item.right)),
        top: viewport.height - baseline - size * 0.84,
        bottom: viewport.height - baseline + size * 0.24,
        size
      });
      bucket = [];
    };
    let anchorSize = items[0].size;
    for (const item of items) {
      if (bucket.length && (Math.abs(item.baseline - bucket[0].baseline) > Math.max(item.size, anchorSize) * 0.45 || bucket.length > 400)) flushBucket();
      bucket.push(item);
      anchorSize = item.size;
    }
    flushBucket();
    const validLines = lines.filter(line => line.text).map(line => ({
      text: line.text,
      x: line.left,
      y: Math.max(0, line.top),
      width: Math.max(1, line.right - line.left),
      height: Math.max(1, line.bottom - line.top)
    }));
    // 聚合成段落块：垂直间距小、水平范围有重叠、字号接近的行合并
    const blocks: PdfBoxLine[] = [];
    let blockLines: Line[] = [];
    const flushBlock = () => {
      if (!blockLines.length) return;
      const text = joinBlockLines(blockLines.map(line => line.text));
      blocks.push({
        text,
        x: Math.min(...blockLines.map(line => line.left)),
        y: Math.max(0, Math.min(...blockLines.map(line => line.top))),
        width: Math.max(1, Math.max(...blockLines.map(line => line.right)) - Math.min(...blockLines.map(line => line.left))),
        height: Math.max(1, Math.max(...blockLines.map(line => line.bottom)) - Math.min(...blockLines.map(line => line.top)))
      });
      blockLines = [];
    };
    for (const line of lines.filter(line => line.text)) {
      if (blockLines.length) {
        const last = blockLines[blockLines.length - 1];
        const gap = line.top - last.bottom;
        const overlap = Math.min(line.right, last.right) - Math.max(line.left, last.left);
        const sizeRatio = line.size / last.size;
        if (gap > line.size * 0.75 || overlap < Math.min(line.right - line.left, last.right - last.left) * 0.25 || sizeRatio > 1.7 || sizeRatio < 0.55) flushBlock();
      }
      blockLines.push(line);
    }
    flushBlock();
    boxes.push({ width: viewport.width, height: viewport.height, lines: validLines, blocks });
  }
  return { pages, boxes };
}

async function renderPdf(pdf: string, folder: string) {
  const prefix = join(folder, 'page');
  let previews: string[] = [];
  await execFileAsync(PDFTOPPM, ['-png', '-r', '150', pdf, prefix], { timeout: 120000, maxBuffer: 10 * 1024 * 1024 });
  const files = (await readdir(folder)).filter(name => /^page-\d+\.png$/.test(name)).sort((a, b) => Number(a.match(/(\d+)/)?.[1]) - Number(b.match(/(\d+)/)?.[1]));
  previews = await Promise.all(files.map(async name => 'data:image/png;base64,' + (await readFile(join(folder, name))).toString('base64')));
  return { previews };
}

// —— PDF 识别引擎（OpenMaic 同款：unpdf / MinerU / MinerU Cloud / 阿里 DocMind）——

type PdfEngine = {
  id: string;
  baseUrl: string;
  apiKey: string;
  accessKeyId: string;
  accessKeySecret: string;
  visionBaseUrl: string;
  visionApiKey: string;
  visionModel: string;
  visionName: string;
  visionProtocol: string;
};

function pdfEngineOf(req: Connect.IncomingMessage): PdfEngine {
  const header = (name: string) => decodeURIComponent(String(req.headers[name] || ''));
  return {
    id: String(req.headers['x-pdf-provider'] || 'unpdf'),
    baseUrl: header('x-pdf-base-url'),
    apiKey: header('x-pdf-api-key'),
    accessKeyId: header('x-pdf-ak'),
    accessKeySecret: header('x-pdf-sk'),
    visionBaseUrl: header('x-vision-base-url').replace(/\/+$/, ''),
    visionApiKey: header('x-vision-api-key'),
    visionModel: header('x-vision-model'),
    visionName: header('x-vision-engine-name'),
    visionProtocol: header('x-vision-protocol') || 'openai'
  };
}

function parseVlmBlocks(text: string): PdfBoxLine[] {
  const cleaned = text.replace(/^```(?:json)?\s*/i, '').replace(/\s*```$/i, '').trim();
  const match = cleaned.match(/\{[\s\S]*\}/);
  if (!match) throw new Error('视觉模型没有返回可用的页面结构');
  const payload = JSON.parse(match[0]) as { blocks?: Array<{ text?: string; bbox?: number[] }> };
  return (payload.blocks || []).flatMap(block => {
    const value = block.text?.replace(/\s+/g, ' ').trim();
    const bbox = block.bbox;
    if (!value || !Array.isArray(bbox) || bbox.length !== 4 || bbox.some(number => !Number.isFinite(Number(number)))) return [];
    const [left, top, right, bottom] = bbox.map(number => Math.max(0, Math.min(1000, Number(number))));
    if (right <= left || bottom <= top) return [];
    return [{ text: value, x: left, y: top, width: right - left, height: bottom - top }];
  });
}

async function recognizePageWithVlm(imageUrl: string, engine: PdfEngine, pageNumber: number): Promise<PdfBoxLine[]> {
  if (!engine.visionBaseUrl || !engine.visionModel) throw new Error('视觉模型配置不完整，请在“翻译引擎”中指定扫描页视觉识别模型');
  const instruction = [
    'Transcribe every meaningful text block in this presentation or PDF page.',
    'Do not translate, summarize, explain, or add text that is not visible.',
    'Preserve formulas as readable plain text or LaTeX.',
    'Return strict JSON only: {"blocks":[{"text":"visible text","bbox":[left,top,right,bottom]}]}.',
    'bbox uses integer coordinates from 0 to 1000 relative to the image. Keep reading order.'
  ].join('\n');
  const base = engine.visionBaseUrl;
  let response: Response;
  if (engine.visionProtocol === 'anthropic') {
    const raw = imageUrl.replace(/^data:image\/png;base64,/, '');
    const auth = engine.visionApiKey.startsWith('sk-cp-')
      ? { authorization: 'Bearer ' + engine.visionApiKey }
      : { 'x-api-key': engine.visionApiKey };
    response = await fetch(base + '/messages', {
      method: 'POST',
      headers: { 'content-type': 'application/json', ...auth, 'anthropic-version': '2023-06-01' },
      body: JSON.stringify({ model: engine.visionModel, max_tokens: 4096, messages: [{ role: 'user', content: [
        { type: 'image', source: { type: 'base64', media_type: 'image/png', data: raw } },
        { type: 'text', text: instruction }
      ] }] }),
      signal: AbortSignal.timeout(120000)
    });
  } else if (engine.visionProtocol === 'google') {
    const raw = imageUrl.replace(/^data:image\/png;base64,/, '');
    response = await fetch(base + '/models/' + encodeURIComponent(engine.visionModel) + ':generateContent?key=' + encodeURIComponent(engine.visionApiKey), {
      method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ contents: [{ parts: [{ text: instruction }, { inlineData: { mimeType: 'image/png', data: raw } }] }], generationConfig: { temperature: 0, responseMimeType: 'application/json' } }),
      signal: AbortSignal.timeout(120000)
    });
  } else {
    const headers: Record<string, string> = { 'content-type': 'application/json' };
    if (engine.visionApiKey) {
      if (engine.visionProtocol === 'azure') headers['api-key'] = engine.visionApiKey;
      else headers.authorization = 'Bearer ' + engine.visionApiKey;
    }
    const url = engine.visionProtocol === 'azure'
      ? (base.includes('/deployments/')
        ? base + (base.includes('/chat/completions') ? '' : '/chat/completions') + (base.includes('?') ? '' : '?api-version=2024-10-21')
        : base + '/deployments/' + encodeURIComponent(engine.visionModel) + '/chat/completions?api-version=2024-10-21')
      : base + '/chat/completions';
    response = await fetch(url, {
      method: 'POST', headers,
      body: JSON.stringify({ model: engine.visionModel, temperature: 0, max_tokens: 4096, messages: [{ role: 'user', content: [
        { type: 'text', text: instruction }, { type: 'image_url', image_url: { url: imageUrl, detail: 'high' } }
      ] }] }),
      signal: AbortSignal.timeout(120000)
    });
  }
  const payload = await response.json().catch(() => null) as unknown;
  if (!response.ok) throw new Error(`第 ${pageNumber} 页视觉识别失败：${providerResponseText(payload) || response.status}`);
  const blocks = parseVlmBlocks(providerResponseText(payload));
  if (!blocks.length) throw new Error(`第 ${pageNumber} 页视觉模型没有识别到文字`);
  return blocks;
}

async function parsePdfWithVlm(previews: string[], engine: PdfEngine): Promise<{ pages: string[]; boxes: PdfBoxPage[] }> {
  if (!previews.length) throw new Error('无法生成页面图片，不能使用视觉模型识别');
  const boxes: PdfBoxPage[] = [];
  for (let index = 0; index < previews.length; index++) {
    const blocks = await recognizePageWithVlm(previews[index], engine, index + 1);
    boxes.push({ width: 1000, height: 1000, lines: blocks, blocks });
  }
  return { pages: boxes.map(page => page.blocks.map(block => block.text).join('\n')), boxes };
}

function sleepMs(ms: number): Promise<void> {
  return new Promise(resolve => setTimeout(resolve, ms));
}

type MineruItem = { type?: string; page_idx?: number; text?: string; table_body?: string; bbox?: number[] };

// MinerU 的 content_list：按页组装文字块与归一化坐标（0-100 空间，和前端百分比定位一致）。
function pagesFromContentList(list: unknown[]): { pages: string[]; boxes: PdfBoxPage[] } {
  const byPage = new Map<number, MineruItem[]>();
  let maxX = 0;
  let maxY = 0;
  for (const raw of list) {
    const item = raw as MineruItem;
    const page = typeof item.page_idx === 'number' ? item.page_idx : 0;
    if (!byPage.has(page)) byPage.set(page, []);
    byPage.get(page)!.push(item);
    if (Array.isArray(item.bbox) && item.bbox.length >= 4) {
      maxX = Math.max(maxX, item.bbox[2]);
      maxY = Math.max(maxY, item.bbox[3]);
    }
  }
  if (!maxX) maxX = 100;
  if (!maxY) maxY = 100;
  const pageCount = byPage.size ? Math.max(...byPage.keys()) + 1 : 0;
  const clamp = (value: number, min: number, max: number) => Math.min(max, Math.max(min, value));
  const pages: string[] = [];
  const boxes: PdfBoxPage[] = [];
  for (let page = 0; page < pageCount; page++) {
    const items = byPage.get(page) || [];
    const blocks: PdfBoxLine[] = [];
    const texts: string[] = [];
    for (const item of items) {
      if (item.type === 'image') continue;
      const body = String(item.type === 'table' ? (item.table_body || item.text || '') : item.text || '').trim();
      if (!body) continue;
      let x = 7;
      let y = 10;
      let width = 86;
      let height = 5;
      if (Array.isArray(item.bbox) && item.bbox.length >= 4) {
        x = clamp(item.bbox[0] / maxX * 100, 0, 100);
        y = clamp(item.bbox[1] / maxY * 100, 0, 100);
        const right = clamp(item.bbox[2] / maxX * 100, x, 100);
        const bottom = clamp(item.bbox[3] / maxY * 100, y, 100);
        width = Math.max(2, right - x);
        height = Math.max(1.5, bottom - y);
      }
      blocks.push({ text: body, x, y, width, height });
      texts.push(body);
    }
    pages.push(texts.join('\n'));
    boxes.push({ width: 100, height: 100, lines: blocks, blocks });
  }
  return { pages, boxes };
}

async function parsePdfWithMineru(buffer: Buffer, engine: PdfEngine): Promise<{ pages: string[]; boxes: PdfBoxPage[] }> {
  const base = (engine.baseUrl || 'http://localhost:8888').replace(/\/+$/, '');
  const form = new FormData();
  form.append('files', new Blob([new Uint8Array(buffer)], { type: 'application/pdf' }), 'document.pdf');
  form.append('parse_method', 'auto');
  form.append('backend', 'pipeline');
  form.append('return_md', 'true');
  form.append('return_content_list', 'true');
  form.append('return_images', 'false');
  const headers: Record<string, string> = {};
  if (engine.apiKey) headers.authorization = 'Bearer ' + engine.apiKey;
  let response: Response;
  try {
    response = await fetch(base + '/file_parse', { method: 'POST', headers, body: form, signal: AbortSignal.timeout(600000) });
  } catch (error) {
    const detail = error instanceof Error ? error.message : '';
    throw new Error(/fetch failed|ECONNREFUSED|ETIMEDOUT|ENOTFOUND/i.test(detail)
      ? '连不上 MinerU 服务，请确认它已经启动、地址和端口无误'
      : 'MinerU 请求失败：' + (detail || '未知错误'));
  }
  if (!response.ok) {
    const detail = (await response.text().catch(() => '')).slice(0, 300);
    throw new Error('MinerU 解析失败（' + response.status + '）：' + (detail || response.statusText));
  }
  const json = await response.json().catch(() => null) as { results?: Record<string, { content_list?: unknown }> } | null;
  const first = json?.results ? Object.values(json.results)[0] : null;
  const list = Array.isArray(first?.content_list) ? first!.content_list as unknown[] : null;
  if (!list?.length) throw new Error('MinerU 没有返回页面内容');
  return pagesFromContentList(list);
}

async function mineruZipPages(zipUrl: string): Promise<{ pages: string[]; boxes: PdfBoxPage[] }> {
  const zipRes = await fetch(zipUrl, { signal: AbortSignal.timeout(180000) });
  if (!zipRes.ok) throw new Error('MinerU 结果下载失败（' + zipRes.status + '）');
  const zip = await JSZip.loadAsync(await zipRes.arrayBuffer());
  const paths = Object.keys(zip.files).filter(path => !zip.files[path].dir);
  const listPath = paths.find(path => path.endsWith('content_list.json')) || paths.find(path => /content_list/i.test(path));
  if (listPath) {
    const raw = await zip.file(listPath)!.async('string');
    try {
      const parsed = JSON.parse(raw);
      if (Array.isArray(parsed) && parsed.length) return pagesFromContentList(parsed);
    } catch {
      // 结果损坏时退回 markdown
    }
  }
  const mdPath = paths.find(path => /(^|\/)full\.md$/i.test(path));
  if (!mdPath) throw new Error('MinerU 结果里没有内容');
  const markdown = await zip.file(mdPath)!.async('string');
  const blocks = markdown.split(/\n{2,}/).map(part => part.trim()).filter(Boolean);
  const lines = blocks.map((text, index) => ({ text, x: 7, y: 10 + index * 5, width: 86, height: 4 }));
  return { pages: [blocks.join('\n')], boxes: [{ width: 100, height: 100, lines, blocks: lines }] };
}

async function parsePdfWithMineruCloud(buffer: Buffer, engine: PdfEngine): Promise<{ pages: string[]; boxes: PdfBoxPage[] }> {
  const token = engine.apiKey;
  if (!token) throw new Error('MinerU Cloud 需要先在设置里填写 API Key');
  const apiRoot = (engine.baseUrl || 'https://mineru.net/api/v4').replace(/\/+$/, '');
  const submit = await fetch(apiRoot + '/file-urls/batch', {
    method: 'POST',
    headers: { authorization: 'Bearer ' + token, 'content-type': 'application/json' },
    body: JSON.stringify({ files: [{ name: 'document.pdf' }], enable_formula: true, enable_table: true, language: 'ch' }),
    signal: AbortSignal.timeout(60000)
  });
  const payload = await submit.json().catch(() => null) as {
    code?: number; msg?: string; data?: { batch_id?: string; file_urls?: string[]; files?: string[] };
  } | null;
  if (!submit.ok || !payload?.data?.batch_id) {
    throw new Error('MinerU Cloud 提交失败：' + (payload?.msg || submit.statusText));
  }
  const uploadUrl = (payload.data.file_urls || payload.data.files || [])[0];
  if (!uploadUrl) throw new Error('MinerU Cloud 没有返回上传地址');
  const put = await fetch(uploadUrl, { method: 'PUT', body: new Blob([new Uint8Array(buffer)]), signal: AbortSignal.timeout(180000) });
  if (!put.ok) throw new Error('MinerU Cloud 上传失败（' + put.status + '）');
  await sleepMs(1500);
  const deadline = Date.now() + 15 * 60 * 1000;
  while (Date.now() < deadline) {
    await sleepMs(2500);
    const poll = await fetch(apiRoot + '/extract-results/batch/' + payload.data.batch_id, {
      headers: { authorization: 'Bearer ' + token, accept: 'application/json' },
      signal: AbortSignal.timeout(30000)
    });
    if (poll.status === 401 || poll.status === 403) throw new Error('MinerU Cloud API Key 无效');
    const pollJson = await poll.json().catch(() => null) as { data?: { extract_result?: unknown } } | null;
    const rows = pollJson?.data?.extract_result;
    const list: Array<{ state?: string; err_msg?: string; full_zip_url?: string }> = Array.isArray(rows) ? rows : rows ? [rows as { state?: string }] : [];
    const row = list[0];
    if (!row?.state) continue;
    if (row.state === 'failed') throw new Error('MinerU Cloud 解析失败：' + (row.err_msg || '未知错误'));
    if (row.state === 'done' && row.full_zip_url) return mineruZipPages(row.full_zip_url);
  }
  throw new Error('MinerU Cloud 解析超时，请稍后重试');
}

// 阿里云 V3 签名：用 AccessKey 探测凭证是否有效。
function popEncode(value: string): string {
  return encodeURIComponent(value).replace(/[!'()*]/g, char => '%' + char.charCodeAt(0).toString(16).toUpperCase());
}

function acs3SignedQuery(action: string, extra: Record<string, string>, accessKeyId: string, accessKeySecret: string): string {
  const params: Record<string, string> = {
    Action: action,
    Version: '2022-07-11',
    AccessKeyId: accessKeyId,
    SignatureMethod: 'ACS3-HMAC-SHA256',
    SignatureVersion: '1.0',
    SignatureNonce: randomUUID(),
    Timestamp: new Date().toISOString().replace(/\.\d+Z$/, 'Z'),
    ...extra
  };
  const canonical = Object.keys(params).sort()
    .map(name => popEncode(name) + '=' + popEncode(params[name]))
    .join('&');
  const hashedPayload = createHash('sha256').update('').digest('hex');
  const canonicalRequest = ['GET', '/', canonical, '', '', hashedPayload].join('\n');
  const stringToSign = 'ACS3-HMAC-SHA256\n' + createHash('sha256').update(canonicalRequest).digest('hex');
  const signature = createHmac('sha256', accessKeySecret).update(stringToSign).digest('base64');
  return canonical + '&Signature=' + popEncode(signature);
}

async function extractPdfText(pdf: string): Promise<string> {
  try {
    return (await execFileAsync(PDFTOTEXT, ['-layout', '-enc', 'UTF-8', pdf, '-'], {
      encoding: 'utf8', maxBuffer: 30 * 1024 * 1024
    })).stdout;
  } catch {
    try {
      return (await execFileAsync(PDFTOTEXT, ['-raw', '-enc', 'UTF-8', pdf, '-'], {
        encoding: 'utf8', maxBuffer: 30 * 1024 * 1024
      })).stdout;
    } catch {
      throw new Error('无法读取这个 PDF 的文字内容，文件可能已损坏或使用了不兼容的字体');
    }
  }
}

function headerValue(req: Connect.IncomingMessage, name: string): string {
  const value = String(req.headers[name] || '');
  try { return decodeURIComponent(value); }
  catch { return value; }
}

function translationServiceConfig(req: Connect.IncomingMessage, jobId: string): {
  service: string;
  envs: Record<string, string>;
  route?: Pdf2zhJob['route'];
} {
  const kind = headerValue(req, 'x-translation-kind');
  const serviceId = headerValue(req, 'x-translation-service');
  const baseUrl = headerValue(req, 'x-translation-base-url').replace(/\/+$/, '');
  const apiKey = headerValue(req, 'x-translation-api-key');
  const model = headerValue(req, 'x-translation-model');
  const protocol = headerValue(req, 'x-translation-protocol') || 'openai';
  const displayName = headerValue(req, 'x-translation-engine-name');
  const localService = (id: string) => ({
    service: 'openailiked:parallel-' + id,
    envs: {
      OPENAILIKED_BASE_URL: 'http://' + String(req.headers.host || '127.0.0.1:5173') + '/api/pdf2zh/openai/' + jobId + '/v1',
      OPENAILIKED_API_KEY: 'parallel-local',
      OPENAILIKED_MODEL: 'parallel-' + id,
      OPENAILIKED_STREAM: 'false'
    },
    route: { kind: 'service' as const, displayName: displayName || id, serviceId: id, baseUrl, apiKey }
  });

  if (kind === 'service') {
    if (['microsoft', 'google', 'deepl', 'deeplx', 'tencent', 'volcengine', 'yandex'].includes(serviceId)) return localService(serviceId);
    throw new Error('当前翻译服务不支持版面翻译，请在“翻译引擎”中改选其他服务或模型');
  }

  if (!baseUrl || !model) throw new Error('翻译模型配置不完整，请先检查「引擎分配」');
  return {
    service: 'openailiked:' + model,
    envs: {
      OPENAILIKED_BASE_URL: 'http://' + String(req.headers.host || '127.0.0.1:5173') + '/api/pdf2zh/openai/' + jobId + '/v1',
      OPENAILIKED_API_KEY: 'parallel-local',
      OPENAILIKED_MODEL: model,
      OPENAILIKED_STREAM: 'false'
    },
    route: { kind: 'model', displayName: displayName || model, baseUrl, apiKey, model, protocol }
  };
}

function pushPdf2zhTrace(job: Pdf2zhJob, event: Omit<Pdf2zhTraceEvent, 'id'>): void {
  job.nextEventId = (job.nextEventId || 0) + 1;
  job.events ||= [];
  job.events.push({ id: job.nextEventId, ...event });
  if (job.events.length > 1000) job.events.splice(0, job.events.length - 1000);
}

function logPreview(value: string, limit = 1600): string {
  return value.replace(/\0/g, '').trim().slice(0, limit);
}

function finishLayoutTrace(job: Pdf2zhJob, status: 'success' | 'error', outputPreview: string): void {
  if (!job.layoutTracePending) return;
  job.layoutTracePending = false;
  pushPdf2zhTrace(job, {
    stage: '版面分析', action: '分析页面结构', engineType: '本机模型',
    engineName: job.layoutMode === 'fast' ? 'PDFMathTranslate · DocLayout-YOLO' : 'BabelDOC · DocLayout-YOLO',
    status, durationMs: Date.now() - (job.layoutStartedAt || Date.now()),
    inputPreview: 'PDF 页面、文字框、图片、表格与公式', outputPreview
  });
}

function promptSourceText(body: Record<string, unknown>): string {
  const messages = Array.isArray(body.messages) ? body.messages as Array<{ role?: string; content?: string }> : [];
  const content = [...messages].reverse().find(message => message.role === 'user')?.content || '';
  const match = content.match(/Source Text:\s*([\s\S]*?)\s*Translated Text:\s*$/i);
  return (match?.[1] || content).trim();
}

function pdfTranslationMessages(body: Record<string, unknown>): Array<{ role: string; content: string }> {
  const source = promptSourceText(body);
  return [{
    role: 'user',
    content: [
      'Translate the source text from English into Simplified Chinese.',
      'Return only the translated text. Do not explain, quote, summarize, or repeat the English source.',
      'Preserve Markdown and every formula placeholder such as {v0}, {{v0}}, <b0>, and </b0> exactly.',
      '',
      'Source Text:',
      source,
      '',
      'Simplified Chinese Translation:'
    ].join('\n')
  }];
}

function providerResponseText(payload: unknown): string {
  if (!payload || typeof payload !== 'object') return '';
  const value = payload as {
    content?: string | Array<{ type?: string; text?: string; content?: string }>;
    choices?: Array<{ message?: { content?: string | Array<{ type?: string; text?: string }> }; text?: string }>;
    output_text?: string;
    output?: Array<{ type?: string; content?: Array<{ type?: string; text?: string }> }>;
    candidates?: Array<{ content?: { parts?: Array<{ text?: string }> } }>;
  };
  const textFromBlocks = (blocks: Array<{ type?: string; text?: string; content?: string }> | undefined) => (blocks || [])
    .filter(block => !block.type || block.type === 'text' || block.type === 'output_text')
    .map(block => block.text || block.content || '')
    .join('')
    .trim();
  if (typeof value.content === 'string') return value.content.trim();
  if (Array.isArray(value.content)) {
    const text = textFromBlocks(value.content);
    if (text) return text;
  }
  const choiceContent = value.choices?.[0]?.message?.content;
  if (typeof choiceContent === 'string' && choiceContent.trim()) return choiceContent.trim();
  if (Array.isArray(choiceContent)) {
    const text = textFromBlocks(choiceContent);
    if (text) return text;
  }
  const output = (value.output || []).flatMap(item => item.content || []);
  return (
    value.choices?.[0]?.text
    || value.output_text
    || textFromBlocks(output)
    || value.candidates?.[0]?.content?.parts?.map(part => part.text || '').join('')
    || ''
  ).trim();
}

function ensureTranslatedResponse(_source: string, translated: string): string {
  if (!translated) throw new Error('模型没有返回译文');
  return translated;
}

function translationResponseStatus(source: string, translated: string): Pdf2zhTraceEvent['status'] {
  const normalize = (value: string) => value.replace(/\s+/g, '').replace(/[“”"'`]/g, '');
  const wordCount = (source.match(/[A-Za-z]{2,}/g) || []).length;
  if (wordCount >= 4 && (normalize(source) === normalize(translated) || !/[\u3400-\u9fff]/.test(translated))) {
    return 'warning';
  }
  return 'success';
}

async function forwardTranslationService(route: Extract<Pdf2zhRoute, { kind: 'service' }>, text: string): Promise<Response> {
  const ok = (translated: string) => Response.json({ choices: [{ message: { role: 'assistant', content: ensureTranslatedResponse(text, translated) } }] });
  const jsonFetch = async (url: string, init?: RequestInit) => {
    const response = await fetch(url, { ...init, signal: AbortSignal.timeout(45000) });
    const payload = await response.json().catch(() => null);
    if (!response.ok) throw new Error('翻译服务请求失败（' + response.status + '）');
    return payload;
  };
  if (route.serviceId === 'google') {
    const query = new URLSearchParams({ client: 'gtx', dt: 't', dj: '1', ie: 'UTF-8', sl: 'auto', tl: 'zh-CN', q: text });
    const payload = await jsonFetch('https://translate.googleapis.com/translate_a/single?' + query);
    const translated = (payload as { sentences?: Array<{ trans?: string }> })?.sentences?.map(item => item.trans || '').join('') || '';
    if (!translated) throw new Error('Google 翻译没有返回译文');
    return ok(translated);
  }
  if (route.serviceId === 'microsoft') {
    const payload = await jsonFetch('https://edge.microsoft.com/translate/translatetext?from=&to=zh-Hans&isEnterpriseClient=false', {
      method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify([text])
    }) as Array<{ translations?: Array<{ text?: string }> }>;
    const translated = payload?.[0]?.translations?.map(item => item.text || '').join('') || '';
    if (!translated) throw new Error('微软翻译没有返回译文');
    return ok(translated);
  }
  if (route.serviceId === 'deepl') {
    const host = route.apiKey.endsWith(':fx') ? 'https://api-free.deepl.com/v2' : 'https://api.deepl.com/v2';
    const payload = await jsonFetch(host + '/translate', {
      method: 'POST',
      headers: { 'content-type': 'application/json', authorization: 'DeepL-Auth-Key ' + route.apiKey },
      body: JSON.stringify({ text: [text], target_lang: 'ZH' })
    }) as { translations?: Array<{ text?: string }> };
    const translated = payload.translations?.[0]?.text || '';
    if (!translated) throw new Error('DeepL 没有返回译文');
    return ok(translated);
  }
  if (route.serviceId === 'deeplx') {
    const payload = await jsonFetch(route.baseUrl, {
      method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ text, source_lang: 'auto', target_lang: 'ZH' })
    }) as { data?: string };
    if (!payload.data) throw new Error('DeepLX 没有返回译文');
    return ok(payload.data);
  }
  if (route.serviceId === 'tencent') {
    const payload = await jsonFetch('https://transmart.qq.com/api/imt', {
      method: 'POST', headers: { 'content-type': 'application/json', referer: 'https://transmart.qq.com/zh-CN/index' },
      body: JSON.stringify({ header: { fn: 'auto_translation', client_key: 'browser-chrome-110.0.0-Mac OS-parallel' }, type: 'plain', model_category: 'normal', source: { text_list: [text], lang: 'auto' }, target: { lang: 'zh' } })
    }) as { auto_translation?: string[] };
    if (!payload.auto_translation?.[0]) throw new Error('腾讯翻译没有返回译文');
    return ok(payload.auto_translation[0]);
  }
  if (route.serviceId === 'volcengine') {
    const payload = await jsonFetch('https://translate.volcengine.com/crx/translate/v1', {
      method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ source_language: 'en', target_language: 'zh', text })
    }) as { translation?: string };
    if (!payload.translation) throw new Error('火山翻译没有返回译文');
    return ok(payload.translation);
  }
  const nonce = Array.from({ length: 32 }, () => Math.floor(Math.random() * 16).toString(16)).join('');
  const query = new URLSearchParams({ id: nonce + '-0-0', srv: 'android', source_lang: 'en', target_lang: 'zh', text });
  const payload = await jsonFetch('https://translate.yandex.net/api/v1/tr.json/translate?' + query, { method: 'POST' }) as { text?: string[] };
  if (!payload.text?.length) throw new Error('Yandex 翻译没有返回译文');
  return ok(payload.text.join(''));
}

async function validatePdf2zhResult(job: Pdf2zhJob): Promise<void> {
  const translatedCalls = (job.events || []).filter(event => event.stage === '文字翻译' && event.status !== 'error');
  const responseChineseCount = translatedCalls.reduce((total, event) => total + (event.outputPreview?.match(/[\u3400-\u9fff]/g) || []).length, 0);
  const completedPages = job.readyPages?.size || 0;
  const status: Pdf2zhTraceEvent['status'] = completedPages > 0 ? 'success' : 'warning';
  pushPdf2zhTrace(job, {
    stage: '结果校验', action: '检查页面译文', engineType: '本机组件', engineName: 'Parallel', status,
    durationMs: 0,
    detail: `${completedPages} / ${job.total || completedPages} 页已有译文 · 翻译调用 ${translatedCalls.length} 次`,
    inputPreview: logPreview(job.sourceText || ''),
    outputPreview: responseChineseCount
      ? `翻译接口输出中检测到 ${responseChineseCount} 个中文字`
      : '部分内容可能是公式、专有名词或无需翻译的短文本，请查看对应调用日志'
  });
  job.state = 'success';
  job.stage = 'complete';
  job.message = '翻译完成';
}

function startPdf2zhJob(job: Pdf2zhJob, configPath: string): void {
  job.state = 'running';
  job.stage = 'layout';
  job.message = '正在分析版面';
  job.lastActivityAt = Date.now();
  job.pageStartedAt = undefined;
  job.requestFailures = 0;
  job.lastRequestError = '';
  job.layoutStartedAt = Date.now();
  job.layoutTracePending = true;
  const child = spawn(PDF2ZH_PYTHON, [PDF2ZH_BRIDGE, configPath], {
    cwd: process.cwd(),
    stdio: ['ignore', 'pipe', 'pipe'],
    env: {
      ...process.env,
      PYTHONUNBUFFERED: '1',
      PYTHONUTF8: '1',
      PYTHONIOENCODING: 'utf-8',
      NO_PROXY: '127.0.0.1,localhost,::1',
      no_proxy: '127.0.0.1,localhost,::1'
    }
  });
  job.child = child;
  let pending = '';
  const consume = (text: string) => {
    pending += text;
    const lines = pending.split(/\r?\n/);
    pending = lines.pop() || '';
    for (const line of lines) {
      if (!line.trim().startsWith('{')) continue;
      try {
        const event = JSON.parse(line) as {
          type?: string; stage?: string; message?: string; current?: number; total?: number; progress?: number; mono?: string; dual?: string;
        };
        job.lastActivityAt = Date.now();
        if (event.type === 'page_start') {
          finishLayoutTrace(job, 'success', `版面分析完成，开始处理第 ${event.current || 1} 页`);
          job.stage = 'translation';
          job.current = event.current || 0;
          job.total = event.total || 0;
          job.pageStartedAt = Date.now();
          job.requestFailures = 0;
          job.lastRequestError = '';
          job.message = job.total ? `正在翻译第 ${job.current} 页` : '正在翻译';
          job.pageProgress = 0;
        } else if (event.type === 'page_progress') {
          job.stage = 'translation';
          job.current = event.current || job.current;
          job.total = event.total || job.total;
          job.pageProgress = Math.max(0, Math.min(100, Number(event.progress) || 0));
          job.message = event.message || `正在处理第 ${job.current} 页`;
        } else if (event.type === 'page_complete') {
          if (!event.current || !event.mono) throw new Error('单页译文信息不完整');
          job.readyPages ||= new Map();
          job.readyPages.set(event.current, { mono: event.mono, dual: event.dual });
          job.current = event.current;
          job.total = event.total || job.total;
          job.pageStartedAt = undefined;
          job.requestFailures = 0;
          job.message = `第 ${event.current} 页翻译完成`;
          job.pageProgress = 0;
        } else if (event.type === 'progress') {
          // 兼容旧桥接器的进度事件。
          job.stage = 'translation';
          job.current = event.current || 0;
          job.total = event.total || 0;
          job.message = job.total ? '正在翻译页面' : '正在翻译';
        } else if (event.type === 'stage') {
          job.stage = event.stage || job.stage;
          job.message = event.message || job.message;
        } else if (event.type === 'complete') {
          job.validationPending = true;
          job.stage = 'validation';
          job.message = '正在检查译文';
          void validatePdf2zhResult(job).catch(error => {
            job.state = 'error';
            job.message = error instanceof Error ? error.message : '译文检查失败';
          }).finally(() => { job.validationPending = false; });
        } else if (event.type === 'error') {
          finishLayoutTrace(job, 'error', event.message || '版面分析失败');
          job.state = 'error';
          job.message = event.message || 'PDF 翻译失败';
        }
      } catch {
        // 只消费桥接器发出的 JSON 行，其余依赖日志忽略。
      }
    }
  };
  child.stdout.on('data', chunk => consume(chunk.toString('utf8')));
  let stderr = '';
  child.stderr.on('data', chunk => { stderr = (stderr + chunk.toString('utf8')).slice(-6000); });
  child.on('error', error => {
    finishLayoutTrace(job, 'error', error.message);
    job.state = 'error';
    job.message = error.message.includes('ENOENT')
      ? 'PDFMathTranslate 尚未安装，请重新运行项目安装'
      : '无法启动 PDF 翻译：' + error.message;
  });
  child.on('close', code => {
    consume('\n');
    if (job.state === 'success' || job.state === 'error' || job.validationPending) return;
    finishLayoutTrace(job, 'error', 'PDF 翻译进程在版面分析阶段结束');
    job.state = 'error';
    const last = stderr.split(/\r?\n/).map(line => line.trim()).filter(Boolean).pop();
    job.message = last && !/warning/i.test(last) ? last : 'PDF 翻译进程异常结束（' + code + '）';
  });
}

async function forwardPdf2zhModel(job: Pdf2zhJob, body: Record<string, unknown>): Promise<Response> {
  const route = job.route;
  if (!route) throw new Error('翻译模型路由已失效');
  if (route.kind === 'service') return forwardTranslationService(route, promptSourceText(body));
  const base = route.baseUrl.replace(/\/+$/, '');
  const source = promptSourceText(body);
  const messages = pdfTranslationMessages(body);
  if (route.protocol === 'anthropic') {
    const authHeaders: Record<string, string> = route.apiKey.startsWith('sk-cp-')
      ? { authorization: 'Bearer ' + route.apiKey }
      : { 'x-api-key': route.apiKey };
    const upstream = await fetch(base + '/messages', {
      method: 'POST',
      headers: { 'content-type': 'application/json', ...authHeaders, 'anthropic-version': '2023-06-01' },
      body: JSON.stringify({
        model: route.model,
        max_tokens: Math.max(Number(body.max_tokens) || 0, 2048),
        system: 'You are a machine translation engine. Output only an accurate Simplified Chinese translation.',
        messages
      }),
      signal: AbortSignal.timeout(60000)
    });
    const payload = await upstream.json() as unknown;
    if (!upstream.ok) return new Response(JSON.stringify(payload), { status: upstream.status, headers: { 'content-type': 'application/json' } });
    const content = ensureTranslatedResponse(source, providerResponseText(payload));
    return Response.json({ choices: [{ message: { role: 'assistant', content } }] });
  }
  if (route.protocol === 'google') {
    const upstream = await fetch(base + '/models/' + encodeURIComponent(route.model) + ':generateContent?key=' + encodeURIComponent(route.apiKey), {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        systemInstruction: { parts: [{ text: 'You are a machine translation engine. Output only an accurate Simplified Chinese translation.' }] },
        contents: messages.map(message => ({
          role: message.role === 'assistant' ? 'model' : 'user',
          parts: [{ text: message.content || '' }]
        })),
        generationConfig: { temperature: 0 }
      }),
      signal: AbortSignal.timeout(60000)
    });
    const payload = await upstream.json() as { candidates?: Array<{ content?: { parts?: Array<{ text?: string }> } }> };
    if (!upstream.ok) return new Response(JSON.stringify(payload), { status: upstream.status, headers: { 'content-type': 'application/json' } });
    const content = ensureTranslatedResponse(source, payload.candidates?.[0]?.content?.parts?.map(part => part.text || '').join('') || '');
    return Response.json({ choices: [{ message: { role: 'assistant', content } }] });
  }
  const headers: Record<string, string> = { 'content-type': 'application/json' };
  if (route.apiKey) {
    if (route.protocol === 'azure') headers['api-key'] = route.apiKey;
    else headers.authorization = 'Bearer ' + route.apiKey;
  }
  if (route.protocol === 'bedrock') throw new Error('Amazon Bedrock 尚未配置 AWS 请求签名，不能用于文档翻译');
  const openAiUrl = route.protocol === 'azure'
    ? (base.includes('/deployments/')
      ? base + (base.includes('/chat/completions') ? '' : '/chat/completions') + (base.includes('?') ? '' : '?api-version=2024-10-21')
      : base + '/deployments/' + encodeURIComponent(route.model) + '/chat/completions?api-version=2024-10-21')
    : base + '/chat/completions';
  const upstream = await fetch(openAiUrl, {
    method: 'POST',
    headers,
    body: JSON.stringify({ ...body, model: route.model, messages, stream: false }),
    signal: AbortSignal.timeout(60000)
  });
  if (!upstream.ok) return upstream;
  const payload = await upstream.json() as unknown;
  const content = ensureTranslatedResponse(source, providerResponseText(payload));
  return Response.json({ choices: [{ message: { role: 'assistant', content } }] });
}

function recordPdf2zhRequestFailure(job: Pdf2zhJob, message: string): void {
  job.requestFailures = (job.requestFailures || 0) + 1;
  job.lastRequestError = message;
  if (job.requestFailures < 3 || job.state !== 'running') return;
  job.state = 'error';
  job.stage = 'error';
  job.message = `第 ${job.current || '?'} 页连续翻译失败：${message}`;
  job.child?.kill('SIGTERM');
}

function responseErrorMessage(buffer: Buffer, status: number): string {
  try {
    const payload = JSON.parse(buffer.toString('utf8')) as { error?: string | { message?: string }; message?: string };
    const detail = typeof payload.error === 'string' ? payload.error : payload.error?.message || payload.message;
    if (detail) return detail;
  } catch { /* 非 JSON 错误响应 */ }
  return `翻译接口返回 ${status}`;
}

function localApi() {
  const middleware: Connect.NextHandleFunction = async (req, res, next) => {
    if (req.url === '/api/parallel/health' && req.method === 'GET') {
      sendJson(res, 200, { app: 'parallel', root: resolve(process.cwd()), dataDir: resolve(LOCAL_DATA_DIR) });
      return;
    }
    if (req.url === '/api/local-db' && req.method === 'GET') {
      try {
        const snapshot = await readFile(LOCAL_DB_PATH);
        res.statusCode = 200;
        res.setHeader('content-type', 'application/vnd.sqlite3');
        res.setHeader('cache-control', 'no-store');
        res.end(snapshot);
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
          res.statusCode = 204;
          res.setHeader('cache-control', 'no-store');
          res.end();
        } else {
          sendJson(res, 500, { error: error instanceof Error ? error.message : '无法读取本地数据库' });
        }
      }
      return;
    }

    if (req.url === '/api/local-db' && req.method === 'PUT') {
      let temporary = '';
      try {
        if (req.headers['x-parallel-storage'] !== '1') {
          sendJson(res, 403, { error: '无效的本地存储请求' });
          return;
        }
        const snapshot = await readBody(req, 1024 * 1024 * 1024);
        if (snapshot.length < 100 || snapshot.subarray(0, 16).toString('utf8') !== 'SQLite format 3\u0000') {
          throw new Error('数据库快照格式无效');
        }
        await mkdir(LOCAL_DATA_DIR, { recursive: true });
        temporary = LOCAL_DB_PATH + '.' + randomUUID() + '.tmp';
        await writeFile(temporary, snapshot, { mode: 0o600 });
        await rename(temporary, LOCAL_DB_PATH);
        temporary = '';
        sendJson(res, 200, { ok: true });
      } catch (error) {
        sendJson(res, 500, { error: error instanceof Error ? error.message : '无法保存本地数据库' });
      } finally {
        if (temporary) void rm(temporary, { force: true });
      }
      return;
    }

    if (req.method === 'POST' && req.url === '/api/document/normalize') {
      let folder = '';
      try {
        const body = await readBody(req);
        const requested = headerValue(req, 'x-file-ext').toLowerCase();
        const extension = ['pptx', 'ppt', 'pdf', 'html', 'htm'].includes(requested) ? requested : '';
        if (!extension) throw new Error('暂不支持这个文件格式');
        if (extension === 'pdf') {
          res.statusCode = 200;
          res.setHeader('content-type', 'application/pdf');
          res.end(body);
          return;
        }
        folder = await mkdtemp(join(tmpdir(), 'parallel-normalize-'));
        const input = join(folder, 'document.' + extension);
        await writeFile(input, body);
        await execFileAsync(SOFFICE, ['--headless', '--convert-to', 'pdf', '--outdir', folder, input], {
          timeout: 120000,
          maxBuffer: 10 * 1024 * 1024
        });
        const output = join(folder, 'document.pdf');
        const pdf = await readFile(output);
        res.statusCode = 200;
        res.setHeader('content-type', 'application/pdf');
        res.end(pdf);
      } catch (error) {
        sendJson(res, 422, { error: error instanceof Error ? error.message : '文件转换失败' });
      } finally {
        if (folder) void rm(folder, { recursive: true, force: true });
      }
      return;
    }

    if (req.method === 'POST' && req.url === '/api/pdf2zh/jobs') {
      let folder = '';
      try {
        const body = await readBody(req);
        if (!body.length) throw new Error('PDF 内容为空');
        const id = randomUUID();
        folder = await mkdtemp(join(tmpdir(), 'parallel-pdf2zh-'));
        const input = join(folder, 'source.pdf');
        const output = join(folder, 'output');
        const configPath = join(folder, 'job.json');
        await mkdir(output);
        await writeFile(input, body);
        const service = translationServiceConfig(req, id);
        const sourceText = await parsePdfWithPdfjs(body)
          .then(parsed => parsed.pages.join('\n'))
          .catch(() => '');
        const layoutMode = headerValue(req, 'x-pdf-mode') === 'fast' ? 'fast' : 'precise';
        const job: Pdf2zhJob = {
          id,
          folder,
          state: 'queued',
          stage: 'queued',
          current: 0,
          total: 0,
          message: '准备翻译',
          createdAt: Date.now(),
          lastActivityAt: Date.now(),
          sourceText,
          route: service.route,
          readyPages: new Map(),
          requestFailures: 0,
          layoutMode,
          events: [],
          nextEventId: 0
        };
        await writeFile(configPath, JSON.stringify({
          id,
          input,
          output,
          langIn: headerValue(req, 'x-source-language') || 'en',
          langOut: headerValue(req, 'x-target-language') || 'zh',
          service: service.service,
          envs: service.envs,
          thread: Math.max(1, Math.min(8, Number(headerValue(req, 'x-pdf-threads')) || 4)),
          mode: layoutMode,
          useCache: headerValue(req, 'x-pdf-use-cache') !== 'false',
          compatible: headerValue(req, 'x-pdf-compatible') === 'true',
          subsetFonts: headerValue(req, 'x-pdf-subset-fonts') !== 'false',
          vfont: headerValue(req, 'x-pdf-vfont'),
          onnxPath: headerValue(req, 'x-pdf-onnx-path'),
          prompt: headerValue(req, 'x-pdf-prompt'),
          startPage: Math.max(1, Number(headerValue(req, 'x-start-page')) || 1),
          endPage: Math.max(0, Number(headerValue(req, 'x-end-page')) || 0)
        }), { mode: 0o600 });
        pdf2zhJobs.set(id, job);
        for (const [oldId, oldJob] of pdf2zhJobs) {
          if (Date.now() - oldJob.createdAt > 2 * 60 * 60 * 1000) {
            pdf2zhJobs.delete(oldId);
            void rm(oldJob.folder, { recursive: true, force: true });
          }
        }
        startPdf2zhJob(job, configPath);
        sendJson(res, 202, { id, eventCursor: 0 });
        folder = '';
      } catch (error) {
        sendJson(res, 422, { error: error instanceof Error ? error.message : '无法创建翻译任务' });
      } finally {
        if (folder) void rm(folder, { recursive: true, force: true });
      }
      return;
    }

    const resumeMatch = req.url?.match(/^\/api\/pdf2zh\/jobs\/([a-f0-9-]+)\/resume$/i);
    if (resumeMatch && req.method === 'POST') {
      const job = pdf2zhJobs.get(resumeMatch[1]);
      try {
        if (!job) throw new Error('续译任务已过期，请重新导入文稿');
        if (job.state === 'running') throw new Error('翻译仍在进行中');
        const payload = JSON.parse((await readBody(req)).toString('utf8') || '{}') as { mode?: string };
        const service = translationServiceConfig(req, job.id);
        const currentPage = Math.max(1, job.current || (job.readyPages?.size || 0) + 1);
        const startPage = payload.mode === 'next' ? currentPage + 1 : currentPage;
        const configPath = join(job.folder, 'job.json');
        const config = JSON.parse(await readFile(configPath, 'utf8')) as Record<string, unknown>;
        config.startPage = startPage;
        config.service = service.service;
        config.envs = service.envs;
        await writeFile(configPath, JSON.stringify(config), { mode: 0o600 });
        job.route = service.route;
        job.state = 'queued';
        job.stage = 'queued';
        job.message = payload.mode === 'next' ? `将从第 ${startPage} 页继续` : `将重试第 ${startPage} 页`;
        job.validationPending = false;
        job.mono = undefined;
        job.dual = undefined;
        const eventCursor = job.nextEventId || 0;
        startPdf2zhJob(job, configPath);
        sendJson(res, 202, { id: job.id, startPage, eventCursor });
      } catch (error) {
        sendJson(res, 409, { error: error instanceof Error ? error.message : '无法继续翻译' });
      }
      return;
    }

    const pageResultMatch = req.url?.match(/^\/api\/pdf2zh\/jobs\/([a-f0-9-]+)\/pages\/(\d+)\/(mono|dual)$/i);
    if (pageResultMatch && req.method === 'GET') {
      const job = pdf2zhJobs.get(pageResultMatch[1]);
      const pageNumber = Number(pageResultMatch[2]);
      const kind = pageResultMatch[3] as 'mono' | 'dual';
      const result = job?.readyPages?.get(pageNumber);
      const path = kind === 'mono' ? result?.mono : result?.dual;
      if (!job || !path) {
        sendJson(res, 404, { error: '这一页的译文尚未生成' });
        return;
      }
      try {
        const pdf = await readFile(path);
        res.statusCode = 200;
        res.setHeader('content-type', 'application/pdf');
        res.setHeader('content-disposition', `inline; filename="page-${pageNumber}-${kind}.pdf"`);
        res.end(pdf);
      } catch {
        sendJson(res, 404, { error: '单页译文文件不存在' });
      }
      return;
    }

    const jobMatch = req.url?.match(/^\/api\/pdf2zh\/jobs\/([a-f0-9-]+)(?:\/(mono|dual))?$/i);
    if (jobMatch && req.method === 'GET') {
      const job = pdf2zhJobs.get(jobMatch[1]);
      if (!job) {
        sendJson(res, 404, { error: '翻译任务已过期' });
        return;
      }
      const outputKind = jobMatch[2] as 'mono' | 'dual' | undefined;
      if (!outputKind) {
        const now = Date.now();
        const idleSeconds = Math.max(0, Math.floor((now - job.lastActivityAt) / 1000));
        const elapsedSeconds = Math.max(0, Math.floor((now - job.createdAt) / 1000));
        const pageSeconds = job.pageStartedAt ? Math.max(0, Math.floor((now - job.pageStartedAt) / 1000)) : 0;
        if (job.state === 'running' && pageSeconds > 600 && idleSeconds > 120) {
          job.child?.kill('SIGTERM');
          job.state = 'error';
          job.message = `第 ${job.current || '?'} 页长时间没有进展，已停止。请从本页重试`;
        } else if (job.state === 'running' && idleSeconds > 300) {
          job.child?.kill('SIGTERM');
          job.state = 'error';
          job.message = '这个页面处理超时。可重试，或先将复杂页面拆分后再翻译';
        }
        const completedPages = job.readyPages?.size || 0;
        const percent = job.state === 'success' ? 100
          : job.stage === 'validation' ? 96
            : job.total > 0 ? Math.min(94, 10 + (completedPages + (job.pageProgress || 0) / 100) / job.total * 84)
              : job.stage === 'layout' ? 8 : 2;
        const message = job.state === 'running' && idleSeconds > 40 && job.total
          ? '本页内容较复杂，仍在处理'
          : job.message;
        sendJson(res, 200, {
          id: job.id,
          state: job.state,
          stage: job.stage,
          current: job.current,
          total: job.total,
          message,
          percent,
          elapsedSeconds,
          idleSeconds,
          readyPages: [...(job.readyPages?.keys() || [])].sort((a, b) => a - b),
          events: job.events || [],
          hasMono: !!job.mono,
          hasDual: !!job.dual
        });
        return;
      }
      const path = outputKind === 'mono' ? job.mono : job.dual;
      if (job.state !== 'success' || !path) {
        sendJson(res, 409, { error: '翻译结果尚未生成' });
        return;
      }
      try {
        const pdf = await readFile(path);
        res.statusCode = 200;
        res.setHeader('content-type', 'application/pdf');
        res.setHeader('content-disposition', 'inline; filename="' + outputKind + '.pdf"');
        res.end(pdf);
      } catch {
        sendJson(res, 404, { error: '翻译结果文件不存在' });
      }
      return;
    }

    if (jobMatch && req.method === 'DELETE') {
      const job = pdf2zhJobs.get(jobMatch[1]);
      if (job) {
        job.child?.kill('SIGTERM');
        job.state = 'error';
        job.stage = 'cancelled';
        job.message = '已停止翻译';
      }
      sendJson(res, 200, { ok: true });
      return;
    }

    const modelProxyMatch = req.url?.match(/^\/api\/pdf2zh\/openai\/([a-f0-9-]+)\/v1\/chat\/completions$/i);
    if (modelProxyMatch && req.method === 'POST') {
      const job = pdf2zhJobs.get(modelProxyMatch[1]);
      const startedAt = Date.now();
      let inputPreview = '';
      try {
        if (!job) throw new Error('翻译任务已过期');
        job.lastActivityAt = Date.now();
        const body = JSON.parse((await readBody(req)).toString('utf8')) as Record<string, unknown>;
        inputPreview = logPreview(promptSourceText(body));
        const upstream = await forwardPdf2zhModel(job, body);
        job.lastActivityAt = Date.now();
        const responseBody = Buffer.from(await upstream.arrayBuffer());
        if (upstream.ok) {
          job.requestFailures = 0;
          job.lastRequestError = '';
        } else {
          recordPdf2zhRequestFailure(job, responseErrorMessage(responseBody, upstream.status));
        }
        let outputPreview = '';
        if (upstream.ok) {
          try { outputPreview = logPreview(providerResponseText(JSON.parse(responseBody.toString('utf8')))); }
          catch { outputPreview = logPreview(responseBody.toString('utf8')); }
        } else outputPreview = logPreview(responseErrorMessage(responseBody, upstream.status));
        const route = job.route;
        const responseStatus = upstream.ok ? translationResponseStatus(inputPreview, outputPreview) : 'error';
        pushPdf2zhTrace(job, {
          stage: '文字翻译',
          action: route?.kind === 'service' ? '调用翻译服务' : '调用翻译模型',
          engineType: route?.kind === 'service' ? '翻译服务' : '模型',
          engineName: route?.displayName || '未配置',
          model: route?.kind === 'model' ? route.model : undefined,
          status: responseStatus,
          durationMs: Date.now() - startedAt,
          detail: responseStatus === 'warning'
            ? `第 ${job.current || 1} 页 · 本段未检测到中文，已继续处理`
            : `第 ${job.current || 1} 页`, inputPreview, outputPreview
        });
        res.statusCode = upstream.status;
        res.setHeader('content-type', upstream.headers.get('content-type') || 'application/json; charset=utf-8');
        res.end(responseBody);
      } catch (error) {
        const message = error instanceof Error ? error.message : '模型请求失败';
        if (job) recordPdf2zhRequestFailure(job, message);
        if (job) {
          const route = job.route;
          pushPdf2zhTrace(job, {
            stage: '文字翻译',
            action: route?.kind === 'service' ? '调用翻译服务' : '调用翻译模型',
            engineType: route?.kind === 'service' ? '翻译服务' : '模型',
            engineName: route?.displayName || '未配置',
            model: route?.kind === 'model' ? route.model : undefined,
            status: 'error',
            durationMs: Date.now() - startedAt,
            detail: `第 ${job.current || 1} 页 · 请求失败`, inputPreview,
            outputPreview: logPreview(message)
          });
        }
        sendJson(res, 502, { error: { message } });
      }
      return;
    }

    if (req.method === 'POST' && req.url === '/api/import/pdf') {
      let folder = '';
      const processingSteps: ImportProcessingStep[] = [];
      try {
        const body = await readBody(req);
        folder = await mkdtemp(join(tmpdir(), 'parallel-pdf-'));
        const input = join(folder, 'input.pdf');
        await writeFile(input, body);
        const engine = pdfEngineOf(req);
        let pages: string[] = [];
        let boxes: PdfBoxPage[] = [];
        let parsedVia = 'pdfjs';
        let processedPdf: Buffer | null = null;
        let previews: string[] = [];
        let stepStartedAt = Date.now();
        try {
          const rendered = await renderPdf(input, folder);
          previews = rendered.previews;
          processingSteps.push({ stage: '页面预览', action: '生成页面预览', engineType: '本机工具', engineName: 'Poppler', status: 'success', durationMs: Date.now() - stepStartedAt });
        } catch {
          processingSteps.push({ stage: '页面预览', action: '生成页面预览', engineType: '本机工具', engineName: 'Poppler', status: 'error', durationMs: Date.now() - stepStartedAt, detail: '预览生成失败，继续读取文字' });
          // 页面图片失败时仍可导入带文字层的文档。
        }
        stepStartedAt = Date.now();
        try {
          const parsed = await parsePdfWithPdfjs(body);
          pages = parsed.pages;
          boxes = parsed.boxes;
          processingSteps.push({
            stage: '文字读取', action: '读取 PDF 文字层', engineType: '本机组件', engineName: 'PDF.js', status: 'success',
            durationMs: Date.now() - stepStartedAt, detail: `${pages.length} 页`, inputPreview: 'PDF 页面与内嵌文字层',
            outputPreview: logPreview(pages.filter(Boolean).slice(0, 3).join('\n\n')) || '没有读取到文字'
          });
        } catch {
          processingSteps.push({ stage: '文字读取', action: '读取 PDF 文字层', engineType: '本机组件', engineName: 'PDF.js', status: 'error', durationMs: Date.now() - stepStartedAt, detail: '已改用兼容读取器' });
          // pdfjs 打不开的文件退回 Poppler 文本提取。
          stepStartedAt = Date.now();
          const stdout = await extractPdfText(input);
          pages = stdout.split('\f').map(page => page.trim());
          if (pages.length > 1 && pages[pages.length - 1] === '') pages.pop();
          parsedVia = 'poppler';
          processingSteps.push({
            stage: '文字读取', action: '兼容读取 PDF 文字', engineType: '本机工具', engineName: 'Poppler', status: 'success',
            durationMs: Date.now() - stepStartedAt, detail: `${pages.length} 页`, inputPreview: 'PDF 页面与内嵌文字层',
            outputPreview: logPreview(pages.filter(Boolean).slice(0, 3).join('\n\n')) || '没有读取到文字'
          });
        }

        // 普通文字 PDF 到这里即完成；只在没有文字层时调用用户配置的 OCR。
        if (!hasReadableText(pages)) {
          if (engine.id === 'unpdf') {
            throw new Error('检测到扫描件。请选择视觉模型或 OCR 服务后继续');
          }
          if (engine.id === 'vlm') {
            stepStartedAt = Date.now();
            try {
              const parsed = await parsePdfWithVlm(previews, engine);
              pages = parsed.pages;
              boxes = parsed.boxes;
              parsedVia = 'vlm';
              processingSteps.push({
                stage: '视觉识别', action: '调用 VLM 识别扫描页', engineType: '模型', engineName: engine.visionName || engine.visionModel,
                model: engine.visionModel, status: 'success', durationMs: Date.now() - stepStartedAt, detail: `${pages.length} 页 · VLM 已调用`,
                inputPreview: `${previews.length} 页页面图像`, outputPreview: logPreview(pages.slice(0, 3).join('\n\n')) || '模型没有识别出文字'
              });
            } catch (error) {
              processingSteps.push({
                stage: '视觉识别', action: '调用 VLM 识别扫描页', engineType: '模型', engineName: engine.visionName || engine.visionModel || '视觉模型',
                model: engine.visionModel, status: 'error', durationMs: Date.now() - stepStartedAt, detail: 'VLM 调用失败',
                inputPreview: `${previews.length} 页页面图像`, outputPreview: error instanceof Error ? logPreview(error.message) : '视觉识别失败'
              });
              throw error;
            }
          } else {
            if (engine.id === 'alidocmind') {
              throw new Error('阿里 DocMind 暂不支持从本机导入文件，请改用视觉模型、MinerU 或 MinerU Cloud');
            }
            stepStartedAt = Date.now();
            const engineName = engine.id === 'mineru' ? 'MinerU' : 'MinerU Cloud';
            let parsed: { pages: string[]; boxes: PdfBoxPage[] };
            try {
              parsed = engine.id === 'mineru'
                ? await parsePdfWithMineru(body, engine)
                : await parsePdfWithMineruCloud(body, engine);
              processingSteps.push({
                stage: '结构识别', action: '调用 OCR 识别扫描页', engineType: '识别服务', engineName, status: 'success',
                durationMs: Date.now() - stepStartedAt, detail: `${parsed.pages.length} 页 · OCR 已调用`,
                inputPreview: '扫描版 PDF 页面', outputPreview: logPreview(parsed.pages.slice(0, 3).join('\n\n')) || '服务没有识别出文字'
              });
            } catch (error) {
              processingSteps.push({
                stage: '结构识别', action: '调用 OCR 识别扫描页', engineType: '识别服务', engineName, status: 'error',
                durationMs: Date.now() - stepStartedAt, detail: 'OCR 调用失败', inputPreview: '扫描版 PDF 页面',
                outputPreview: error instanceof Error ? logPreview(error.message) : '扫描页识别失败'
              });
              throw error;
            }
            if (!hasReadableText(parsed.pages)) throw new Error('OCR 没有识别到可翻译的文字');
            pages = parsed.pages;
            boxes = parsed.boxes;
            parsedVia = engine.id;
          }
          stepStartedAt = Date.now();
          processedPdf = await addOcrTextLayer(body, boxes);
          processingSteps.push({
            stage: '文字层', action: '写入可复制文字层', engineType: '本机组件', engineName: 'pdf-lib', status: 'success',
            durationMs: Date.now() - stepStartedAt, inputPreview: logPreview(pages.slice(0, 3).join('\n\n')),
            outputPreview: '已生成带可搜索文字层的 PDF'
          });
        }
        else {
          processingSteps.push({
            stage: '视觉识别', action: '跳过 VLM', engineType: '工作流', engineName: '未调用', status: 'success', durationMs: 0,
            detail: 'PDF 已有可用文字层，不需要视觉识别', inputPreview: 'PDF 文字层检测结果', outputPreview: '检测到可翻译文字，继续进入版面翻译'
          });
        }
        if (!parsedVia.startsWith('poppler') && boxes.length !== pages.length) {
          // 页数对不上时按文本兜底，避免错位
          boxes = [];
        }
        sendJson(res, 200, {
          pages,
          previews,
          boxes,
          recognition: parsedVia === 'pdfjs' || parsedVia === 'poppler' ? 'text' : 'ocr',
          processedPdf: processedPdf?.toString('base64'),
          processingSteps
        });
      } catch (error) {
        sendJson(res, 422, { error: error instanceof Error ? error.message : 'PDF 解析失败', processingSteps });
      } finally {
        if (folder) void rm(folder, { recursive: true, force: true });
      }
      return;
    }

    if (req.method === 'POST' && req.url === '/api/pdf/test') {
      try {
        const request = JSON.parse((await readBody(req)).toString('utf8')) as {
          providerId?: string; baseUrl?: string; apiKey?: string; accessKeyId?: string; accessKeySecret?: string;
        };
        const providerId = request.providerId || 'unpdf';
        if (providerId === 'mineru') {
          const base = (request.baseUrl || 'http://localhost:8888').replace(/\/+$/, '');
          try {
            await fetch(base, { signal: AbortSignal.timeout(8000) });
            // 任何 HTTP 响应都算在线（FastAPI 服务根路由常见 404）
            sendJson(res, 200, { ok: true, message: '服务已连接，可以导入 PDF' });
          } catch (error) {
            const detail = error instanceof Error ? error.message : '';
            sendJson(res, 200, { ok: false, message: /fetch failed|ECONNREFUSED|ETIMEDOUT|ENOTFOUND/i.test(detail)
              ? '连不上服务，请确认它已经启动、地址和端口无误'
              : '连接失败：' + (detail || '未知错误') });
          }
        } else if (providerId === 'mineru-cloud') {
          const base = (request.baseUrl || 'https://mineru.net/api/v4').replace(/\/+$/, '');
          const probe = await fetch(base + '/extract-results/batch/test-connection', {
            headers: { authorization: 'Bearer ' + (request.apiKey || '') },
            signal: AbortSignal.timeout(10000)
          });
          if (probe.status === 401 || probe.status === 403) {
            sendJson(res, 200, { ok: false, message: 'API Key 无效，请检查后重试' });
          } else {
            sendJson(res, 200, { ok: true, message: '连接成功，可以导入 PDF' });
          }
        } else if (providerId === 'alidocmind') {
          if (!request.accessKeyId?.trim() || !request.accessKeySecret?.trim()) {
            sendJson(res, 200, { ok: false, message: '请先填写 AccessKey ID 和 Secret' });
          } else {
            const query = acs3SignedQuery('QueryDocParserStatus', { Id: 'connection-check' }, request.accessKeyId.trim(), request.accessKeySecret.trim());
            const probe = await fetch('https://docmind-api.cn-hangzhou.aliyuncs.com/?' + query, { signal: AbortSignal.timeout(10000) });
            const text = await probe.text();
            if (/SignatureDoesNotMatch|InvalidAccessKeyId/i.test(text)) {
              sendJson(res, 200, { ok: false, message: 'AccessKey 校验失败，请检查 ID 和 Secret' });
            } else {
              sendJson(res, 200, { ok: true, message: '密钥有效，可以导入 PDF' });
            }
          }
        } else {
          sendJson(res, 200, { ok: true, message: '内置引擎开箱即用，无需测试' });
        }
      } catch (error) {
        const detail = error instanceof Error ? error.message : '';
        sendJson(res, 200, { ok: false, message: /fetch failed|ETIMEDOUT|ENOTFOUND/i.test(detail)
          ? '网络连接失败，请稍后重试'
          : (detail || '连接失败') });
      }
      return;
    }

    if (req.method === 'POST' && req.url === '/api/import/render') {
      let folder = '';
      try {
        const body = await readBody(req);
        const requestedExt = String(req.headers['x-file-ext'] || 'pptx').toLowerCase();
        const extension = ['pptx', 'ppt', 'pdf'].includes(requestedExt) ? requestedExt : 'pptx';
        folder = await mkdtemp(join(tmpdir(), 'parallel-render-'));
        const input = join(folder, 'presentation.' + extension);
        await writeFile(input, body);
        let pdf = input;
        if (extension !== 'pdf') {
          await execFileAsync(SOFFICE, ['--headless', '--convert-to', 'pdf', '--outdir', folder, input], { timeout: 120000, maxBuffer: 10 * 1024 * 1024 });
          pdf = join(folder, basename(input, extname(input)) + '.pdf');
        }
        const rendered = await renderPdf(pdf, folder);
        sendJson(res, 200, { previews: rendered.previews });
      } catch (error) {
        sendJson(res, 422, { error: error instanceof Error ? error.message : '页面预览生成失败' });
      } finally {
        if (folder) void rm(folder, { recursive: true, force: true });
      }
      return;
    }

    if (req.method === 'POST' && req.url === '/api/import/ppt') {
      let folder = '';
      try {
        const body = await readBody(req);
        const rawName = decodeURIComponent(String(req.headers['x-file-name'] || 'presentation.ppt'));
        const safeName = basename(rawName).replace(/[^a-zA-Z0-9._-]/g, '_') || 'presentation.ppt';
        folder = await mkdtemp(join(tmpdir(), 'parallel-ppt-'));
        const input = join(folder, safeName.endsWith('.ppt') ? safeName : safeName + '.ppt');
        await writeFile(input, body);
        await execFileAsync(SOFFICE, ['--headless', '--convert-to', 'pptx', '--outdir', folder, input], {
          timeout: 120000,
          maxBuffer: 10 * 1024 * 1024
        });
        const output = join(folder, basename(input, '.ppt') + '.pptx');
        const pptx = await readFile(output);
        res.statusCode = 200;
        res.setHeader('content-type', 'application/vnd.openxmlformats-officedocument.presentationml.presentation');
        res.end(pptx);
      } catch (error) {
        sendJson(res, 422, { error: error instanceof Error ? error.message : 'PPT 转换失败' });
      } finally {
        if (folder) void rm(folder, { recursive: true, force: true });
      }
      return;
    }

    if (req.method === 'POST' && req.url === '/api/model') {
      try {
        const request = JSON.parse((await readBody(req)).toString('utf8')) as {
          url?: string;
          headers?: Record<string, string>;
          body?: unknown;
          method?: 'GET' | 'POST';
          bodyBase64?: string;
        };
        const url = new URL(request.url || '');
        if (!['http:', 'https:'].includes(url.protocol)) throw new Error('模型地址无效');
        const upstream = await fetch(url, {
          method: request.method === 'GET' ? 'GET' : 'POST',
          headers: request.headers || {},
          body: request.bodyBase64 !== undefined ? Buffer.from(request.bodyBase64, 'base64') : request.method === 'GET' || !Object.prototype.hasOwnProperty.call(request, 'body')
            ? undefined
            : JSON.stringify(request.body),
          signal: AbortSignal.timeout(60000)
        });
        res.statusCode = upstream.status;
        res.setHeader('content-type', upstream.headers.get('content-type') || 'application/json; charset=utf-8');
        if (upstream.body) {
          const reader = upstream.body.getReader();
          try {
            for (;;) {
              const { done, value } = await reader.read();
              if (done) break;
              res.write(Buffer.from(value));
              if (typeof (res as unknown as { flush?: () => void }).flush === 'function') {
                (res as unknown as { flush?: () => void }).flush();
              }
            }
          } finally {
            void reader.cancel().catch(() => undefined);
          }
        }
        res.end();
      } catch (error) {
        sendJson(res, 502, { error: { message: error instanceof Error ? error.message : '模型请求失败' } });
      }
      return;
    }

    next();
  };
  return {
    name: 'parallel-local-api',
    configureServer(server: { middlewares: { use: (handler: Connect.NextHandleFunction) => void } }) {
      server.middlewares.use(middleware);
    },
    configurePreviewServer(server: { middlewares: { use: (handler: Connect.NextHandleFunction) => void } }) {
      server.middlewares.use(middleware);
    }
  };
}

export default defineConfig({
  plugins: [react(), localApi()]
});
