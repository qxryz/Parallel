import JSZip from 'jszip';
import type { SlideData } from './types';

// —— 把译文写回原件本体：PPTX 改写 XML 后重新渲染，HTML 改写 DOM，PDF 用画布擦除重绘 ——

function decodeXmlEntities(value: string): string {
  return value
    .replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&quot;/g, '"')
    .replace(/&apos;/g, "'").replace(/&#39;/g, "'").replace(/&amp;/g, '&');
}

function escapeXml(value: string): string {
  return value.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}

// 与导入时的段落提取完全同序：逐个 <p:sp> 形状、形状内逐个 <a:p>，跳过空段
function replacePptxParagraphTexts(xml: string, translations: string[]): string {
  let cursor = 0;
  const normalize = (text: string) => text.replace(/\s+/g, ' ').trim();
  const rewriteParagraph = (paragraph: string, translation: string) => {
    const runs = [...paragraph.matchAll(/<a:t(?:\s[^>]*)?>[\s\S]*?<\/a:t>/g)];
    if (!runs.length) return paragraph;
    let next = paragraph.slice(0, runs[0].index) + runs[0][0].replace(/(<a:t(?:\s[^>]*)?>)[\s\S]*?(<\/a:t>)/, (_, open, close) => open + escapeXml(translation) + close);
    for (let i = 1; i < runs.length; i++) {
      const run = runs[i];
      next += paragraph.slice(runs[i - 1].index + runs[i - 1][0].length, run.index) + run[0].replace(/(<a:t(?:\s[^>]*)?>)[\s\S]*?(<\/a:t>)/, (_, open, close) => open + close);
    }
    next += paragraph.slice(runs[runs.length - 1].index + runs[runs.length - 1][0].length);
    return next;
  };
  const shapes = [...xml.matchAll(/<p:sp\b[\s\S]*?<\/p:sp>/g)];
  let result = '';
  let offset = 0;
  if (shapes.length) {
    for (const shape of shapes) {
      result += xml.slice(offset, shape.index);
      const shapeXml = shape[0];
      let shapeNext = '';
      let shapeOffset = 0;
      for (const paragraph of [...shapeXml.matchAll(/<a:p(?:\s[^>]*)?>([\s\S]*?)<\/a:p>/g)]) {
        shapeNext += shapeXml.slice(shapeOffset, paragraph.index);
        const text = normalize([...paragraph[1].matchAll(/<a:t(?:\s[^>]*)?>([\s\S]*?)<\/a:t>/g)].map(run => decodeXmlEntities(run[1])).join(''));
        const translation = text ? translations[cursor++] : undefined;
        shapeNext += translation !== undefined && translation ? rewriteParagraph(paragraph[0], translation) : paragraph[0];
        shapeOffset = paragraph.index + paragraph[0].length;
      }
      shapeNext += shapeXml.slice(shapeOffset);
      result += shapeNext;
      offset = shape.index + shape[0].length;
    }
    result += xml.slice(offset);
    return result;
  }
  // 兜底路径：与导入兜底一致，直接扫描整个 XML 的段落
  let allOffset = 0;
  let allNext = '';
  for (const paragraph of [...xml.matchAll(/<a:p(?:\s[^>]*)?>([\s\S]*?)<\/a:p>/g)]) {
    allNext += xml.slice(allOffset, paragraph.index);
    const text = normalize([...paragraph[1].matchAll(/<a:t(?:\s[^>]*)?>([\s\S]*?)<\/a:t>/g)].map(run => decodeXmlEntities(run[1])).join(''));
    const translation = text ? translations[cursor++] : undefined;
    allNext += translation !== undefined && translation ? rewriteParagraph(paragraph[0], translation) : paragraph[0];
    allOffset = paragraph.index + paragraph[0].length;
  }
  allNext += xml.slice(allOffset);
  return allNext;
}

export async function renderPptxInPlace(file: File, slides: SlideData[]): Promise<string[]> {
  const zip = await JSZip.loadAsync(await file.arrayBuffer());
  const names = Object.keys(zip.files)
    .filter(name => /^ppt\/slides\/slide\d+\.xml$/.test(name))
    .sort((left, right) => Number(left.match(/slide(\d+)/)?.[1] || 0) - Number(right.match(/slide(\d+)/)?.[1] || 0));
  for (let i = 0; i < names.length; i++) {
    const slide = slides[i];
    if (!slide) continue;
    const entry = zip.file(names[i]);
    if (!entry) continue;
    const xml = await entry.async('text');
    zip.file(names[i], replacePptxParagraphTexts(xml, slide.sentences.map(line => line.target.trim())));
  }
  const blob = await zip.generateAsync({ type: 'blob' });
  const response = await fetch('/api/import/render', {
    method: 'POST',
    headers: { 'content-type': 'application/vnd.openxmlformats-officedocument.presentationml.presentation', 'x-file-ext': 'pptx' },
    body: blob
  });
  if (!response.ok) return [];
  const payload = await response.json() as { previews?: string[] };
  return payload.previews || [];
}

export function renderHtmlInPlace(slide: SlideData): string | null {
  if (!slide.sourceHtml) return null;
  const doc = new DOMParser().parseFromString(slide.sourceHtml, 'text/html');
  const sections = [...doc.querySelectorAll('section, article, .slide')];
  const nodes = sections.length ? sections : [doc.body];
  let cursor = 0;
  for (const node of nodes) {
    for (const block of [...node.querySelectorAll('h1,h2,h3,p,li,blockquote')]) {
      if (!block.textContent?.trim()) continue;
      const target = slide.sentences[cursor++]?.target.trim();
      if (target) block.textContent = target;
    }
  }
  const styles = [...doc.querySelectorAll('style')].map(style => style.outerHTML).join('');
  return '<!doctype html><html><head><meta charset="utf-8">' + styles + '</head><body style="margin:0">' + doc.body.innerHTML + '</body></html>';
}

function loadImage(src: string): Promise<HTMLImageElement> {
  return new Promise((resolve, reject) => {
    const image = new Image();
    image.onload = () => resolve(image);
    image.onerror = () => reject(new Error('页面图片加载失败'));
    image.src = src;
  });
}

function drawWrappedText(ctx: CanvasRenderingContext2D, text: string, box: { x: number; y: number; width: number; height: number }) {
  let size = Math.max(9, Math.min(56, box.height * .8));
  const lineHeight = 1.3;
  const fit = (fontSize: number) => {
    ctx.font = `${fontSize}px "PingFang SC","Hiragino Sans GB","Microsoft YaHei",sans-serif`;
    const chars = [...text];
    const lines: string[] = [];
    let line = '';
    for (const char of chars) {
      if (ctx.measureText(line + char).width > box.width && line) { lines.push(line); line = char; }
      else line += char;
    }
    if (line) lines.push(line);
    return lines;
  };
  let lines = fit(size);
  while (lines.length * size * lineHeight > box.height * 1.12 && size > 9) {
    size = Math.max(9, size - 1);
    lines = fit(size);
  }
  ctx.textBaseline = 'top';
  const startY = box.y + Math.max(0, (box.height - lines.length * size * lineHeight) / 2);
  lines.forEach((line, index) => ctx.fillText(line, box.x, startY + index * size * lineHeight));
}

export async function renderPdfInPlace(slide: SlideData): Promise<string | null> {
  if (!slide.preview) return null;
  const image = await loadImage(slide.preview);
  const canvas = document.createElement('canvas');
  canvas.width = image.naturalWidth;
  canvas.height = image.naturalHeight;
  const ctx = canvas.getContext('2d');
  if (!ctx) return null;
  ctx.drawImage(image, 0, 0);
  const scaleX = canvas.width / 100;
  const scaleY = canvas.height / 100;
  for (const line of slide.sentences) {
    if (!line.target.trim() || !line.region) continue;
    const box = {
      x: line.region.x * scaleX,
      y: line.region.y * scaleY,
      width: Math.max(8, line.region.width * scaleX),
      height: Math.max(10, line.region.height * scaleY)
    };
    // 擦除范围要比文字框大一圈：原件里常有比文字更大的底色块/高亮，只按文字框擦会留边
    const padX = Math.max(2, box.width * 0.015);
    const padY = Math.max(3, box.height * 0.18);
    const erase = { x: box.x - padX, y: box.y - padY, width: box.width + padX * 2, height: box.height + padY * 2 };
    // 背景色：取擦除框上、下两条外侧带的平均色中更亮的一条（文字通常比背景深）
    const sampleBand = (x: number, y: number, w: number, h: number) => {
      const sx = Math.max(0, Math.min(canvas.width - 1, Math.round(x)));
      const sy = Math.max(0, Math.min(canvas.height - 1, Math.round(y)));
      const sw = Math.max(1, Math.min(canvas.width - sx, Math.round(w)));
      const sh = Math.max(1, Math.min(canvas.height - sy, Math.round(h)));
      const data = ctx.getImageData(sx, sy, sw, sh).data;
      let r = 0, g = 0, b = 0, n = 0;
      for (let i = 0; i < data.length; i += 4) { r += data[i]; g += data[i + 1]; b += data[i + 2]; n++; }
      return n ? { r: r / n, g: g / n, b: b / n } : { r: 255, g: 255, b: 255 };
    };
    const luminance = (c: { r: number; g: number; b: number }) => 0.299 * c.r + 0.587 * c.g + 0.114 * c.b;
    const band = 3;
    const above = sampleBand(erase.x, erase.y - band - 1, erase.width, band);
    const below = sampleBand(erase.x, erase.y + erase.height + 1, erase.width, band);
    const bg = luminance(above) >= luminance(below) ? above : below;
    // 文字颜色：框内与背景反差最大的像素（背景亮取最暗像素，背景暗取最亮像素）
    const frame = ctx.getImageData(Math.max(0, box.x), Math.max(0, box.y), Math.min(canvas.width - box.x, box.width), Math.min(canvas.height - box.y, box.height));
    const wantDark = luminance(bg) > 128;
    let ink = { r: 255, g: 255, b: 255, score: wantDark ? Infinity : -Infinity };
    let inkCount = 0;
    for (let i = 0; i < frame.data.length; i += 4) {
      const r = frame.data[i], g = frame.data[i + 1], b = frame.data[i + 2];
      const score = 0.299 * r + 0.587 * g + 0.114 * b;
      if (wantDark ? score < ink.score : score > ink.score) { ink = { r, g, b, score }; inkCount++; }
    }
    ctx.fillStyle = `rgb(${Math.round(bg.r)},${Math.round(bg.g)},${Math.round(bg.b)})`;
    ctx.fillRect(erase.x, erase.y, erase.width, erase.height);
    ctx.fillStyle = inkCount ? `rgb(${ink.r},${ink.g},${ink.b})` : '#1a2437';
    drawWrappedText(ctx, line.target.trim(), box);
  }
  return canvas.toDataURL('image/png');
}
