import { PDFDocument } from 'pdf-lib';
import { importTranslatedPdfDocument } from './importers';
import type { SlideData } from './types';
import type { Pdf2zhPageResult } from './pdf2zhClient';

/** Restoring a session never runs OCR and never renders an entire document. */
export async function createHistorySession(source: File, legacyMono?: File) {
  const pdf = await PDFDocument.load(await source.arrayBuffer());
  let legacy: Promise<PDFDocument> | undefined;
  const cache = new Map<number, Promise<SlideData>>();
  async function slice(document: PDFDocument, index: number) {
    const single = await PDFDocument.create();
    single.addPage((await single.copyPages(document, [index]))[0]);
    return new File([(await single.save()).slice().buffer], `page-${index + 1}.pdf`, { type: 'application/pdf' });
  }
  return {
    count: pdf.getPageCount(),
    sourcePage(index: number) {
      let pending = cache.get(index);
      if (!pending) {
        pending = slice(pdf, index).then(file => importTranslatedPdfDocument(file)).then(pages => {
          if (!pages[0]?.preview) throw new Error('原件页面预览不可用');
          return pages[0];
        }).catch(error => { cache.delete(index); throw error; });
        cache.set(index, pending);
      }
      return pending;
    },
    async targetPage(index: number, file?: Pdf2zhPageResult) {
      let target = file?.mono;
      if (!target && legacyMono) {
        legacy ||= PDFDocument.load(await legacyMono.arrayBuffer());
        target = await slice(await legacy, index);
      }
      if (!target) return undefined;
      const [page] = await importTranslatedPdfDocument(target);
      if (!page?.preview) throw new Error('译文页面预览不可用');
      return page;
    }
  };
}
