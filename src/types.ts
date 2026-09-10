export type TextRegion = { x: number; y: number; width: number; height: number };
export type Sentence = {
  id: string;
  source: string;
  target: string;
  role?: 'title' | 'body';
  region?: TextRegion;
};
export type SlideData = {
  title: string;
  subtitle?: string;
  sentences: Sentence[];
  preview?: string;
  translatedPreview?: string;
  translatedSentences?: Sentence[];
  pageAspect?: number;
  sourceHtml?: string;
};

export type Provider = {
  id: string;
  name: string;
  prefix: string;
  baseUrl: string;
  model: string;
  key: string;
  enabled: boolean;
  protocol?: 'openai' | 'anthropic' | 'google' | 'azure' | 'bedrock';
  requiresApiKey?: boolean;
  icon?: string;
  baseUrlPlaceholder?: string;
  supportsModelDiscovery?: boolean;
  alternateBaseUrls?: { label: string; url: string }[];
  models?: { id: string; name: string }[];
};
