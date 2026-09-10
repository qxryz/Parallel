export type PdfLayoutMode = 'precise' | 'fast';

export type PdfTranslationSettings = {
  layoutMode: PdfLayoutMode;
  threads: number;
  useCache: boolean;
  compatible: boolean;
  subsetFonts: boolean;
  formulaFontRegex: string;
  onnxPath: string;
  prompt: string;
};

const STORAGE_KEY = 'parallel.pdf-translation-settings';

export const defaultPdfTranslationSettings: PdfTranslationSettings = {
  layoutMode: 'fast',
  threads: 4,
  useCache: true,
  compatible: false,
  subsetFonts: true,
  formulaFontRegex: '',
  onnxPath: '',
  prompt: ''
};

export function loadPdfTranslationSettings(): PdfTranslationSettings {
  try {
    const saved = JSON.parse(localStorage.getItem(STORAGE_KEY) || '{}') as Partial<PdfTranslationSettings>;
    const savedMode = String(saved.layoutMode || '');
    return {
      ...defaultPdfTranslationSettings,
      ...saved,
      // Migrate the two short-lived legacy values without keeping the broken
      // presentation-layout implementation around.
      layoutMode: savedMode === 'fast' || savedMode === 'strict' ? 'fast' : 'precise',
      threads: Math.max(1, Math.min(8, Number(saved.threads) || defaultPdfTranslationSettings.threads))
    };
  } catch {
    return { ...defaultPdfTranslationSettings };
  }
}

export function savePdfTranslationSettings(settings: PdfTranslationSettings): void {
  localStorage.setItem(STORAGE_KEY, JSON.stringify(settings));
}

export function pdfTranslationHeaders(): Record<string, string> {
  const settings = loadPdfTranslationSettings();
  return {
    'x-pdf-mode': settings.layoutMode,
    'x-pdf-threads': String(settings.threads),
    'x-pdf-use-cache': String(settings.useCache),
    'x-pdf-compatible': String(settings.compatible),
    'x-pdf-subset-fonts': String(settings.subsetFonts),
    'x-pdf-vfont': encodeURIComponent(settings.formulaFontRegex),
    'x-pdf-onnx-path': encodeURIComponent(settings.onnxPath),
    'x-pdf-prompt': encodeURIComponent(settings.prompt)
  };
}
