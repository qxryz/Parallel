import type { Provider, SlideData } from './types';
import { localModelRequest, modelError, trimBaseUrl } from './modelClient';

type Segment = { id: number; text: string };

// —— 提示词（参考 kiss-translator 的批量翻译模板，按演示文稿场景精简） ——

const XML_SYSTEM_PROMPT = [
  'Act as a translation API. Output raw XML-like format only. No Markdown fences. No conversational filler.',
  '',
  'Input:',
  '{"targetLanguage":"<lang>","title":"<context>","segments":[{"id":0,"text":"..."}]}',
  '',
  'Output Format:',
  '<root>',
  '    <t id="0" sourceLanguage="<detected>">Translated text…</t>',
  '    <t id="1" sourceLanguage="<detected>">Translated text…</t>',
  '</root>',
  '',
  'Rules:',
  '1. Output ONLY the <root> element. No xml declaration, no markdown code blocks.',
  '2. Keep the exact "id" attribute of every segment, in order.',
  '3. Preserve Markdown, LaTeX formulas ($…$ / $$…$$), numbers, names, placeholders and HTML-like tags. Translate inner text only.',
  '4. Do not translate content in <code>, <pre>, backticks, or placeholders like {1}, {{1}}, [1].',
  '5. Use "title" for context only; never output it.',
  '',
  'Example:',
  'Input: {"targetLanguage":"zh-CN","title":"Quarterly Review","segments":[{"id":0,"text":"Hello <b>World</b>!"}]}',
  'Output: <root><t id="0" sourceLanguage="en">你好 <b>世界</b>！</t></root>'
].join('\n');

const SINGLE_SYSTEM_PROMPT = 'You are a professional, authentic machine translation engine.';

function singleUserPrompt(targetLanguage: string, title: string, text: string): string {
  return [
    '# Context',
    'Title: ' + title,
    '',
    '# Task',
    'Translate the Source Text below to ' + targetLanguage + '.',
    '1. Use the Context to ensure accuracy.',
    '2. Output ONLY the translated text. No markdown, no explanations.',
    '3. Preserve Markdown, LaTeX formulas, numbers, names and placeholders.',
    '',
    'Source Text: ' + text,
    '',
    'Translated Text:'
  ].join('\n');
}

// —— 入口 ——

export type TranslateOptions = {
  onSegment?: (position: number, text: string) => void;
};

export async function translateSlide(
  slide: SlideData,
  provider: Provider,
  targetLanguage = '简体中文',
  options: TranslateOptions = {}
): Promise<string[]> {
  if (!slide.sentences.length) return [];
  const onSegment = options.onSegment;
  const segments = slide.sentences.map((item, id) => ({ id, text: item.source }));
  const translated = new Array<string>(segments.length).fill('');

  const batches = splitBatches(segments, 10, 5000);
  for (const batch of batches) {
    try {
      const result = await translateBatch(batch, provider, targetLanguage, slide.title);
      result.forEach(item => {
        translated[item.id] = item.text;
        onSegment?.(item.id, item.text);
      });
    } catch (batchError) {
      // 该组失败时退回逐句请求，保住其余句子的结果。
      for (const item of batch) {
        try {
          const fallback = await translateSingleSegments([item], provider, targetLanguage, slide.title);
          translated[item.id] = fallback[0]?.text || '';
          if (translated[item.id]) onSegment?.(item.id, translated[item.id]);
        } catch { translated[item.id] = ''; }
      }
      if (batch.every(item => !translated[item.id])) throw batchError;
    }
  }
  return translated;
}

// —— 批量方法 ——

async function translateBatch(
  batch: Segment[],
  provider: Provider,
  targetLanguage: string,
  title: string
): Promise<Segment[]> {
  const userPrompt = JSON.stringify({ targetLanguage, title, segments: batch });

  let lastError: unknown;
  for (let attempt = 0; attempt < 2; attempt += 1) {
    try {
      const response = await sendChat(provider, { systemPrompt: XML_SYSTEM_PROMPT, userPrompt });
      if (!response.ok) throw await modelError(response, provider.name);
      return parseXmlTranslations(chatTextPayload(await response.text()), batch);
    } catch (error) {
      lastError = error;
      if (attempt === 0) await sleep(350);
    }
  }
  throw lastError instanceof Error ? lastError : new Error('翻译请求失败');
}

// —— 逐句（批量失败时的兜底） ——

async function translateSingleSegments(
  batch: Segment[],
  provider: Provider,
  targetLanguage: string,
  title: string
): Promise<Segment[]> {
  let lastError: unknown;
  for (let attempt = 0; attempt < 2; attempt += 1) {
    try {
      const response = await sendChat(provider, {
        systemPrompt: SINGLE_SYSTEM_PROMPT,
        userPrompt: singleUserPrompt(targetLanguage, title, batch.map(item => item.text).join('\n'))
      });
      if (!response.ok) throw await modelError(response, provider.name);
      const raw = chatTextPayload(await response.text());
      if (raw.trim()) return [{ id: batch[0].id, text: raw.trim() }];
      throw new Error('模型没有返回译文');
    } catch (error) {
      lastError = error;
      if (attempt === 0) await sleep(350);
    }
  }
  throw lastError instanceof Error ? lastError : new Error('翻译请求失败');
}

// —— 请求 ——

type ChatSend = { systemPrompt: string; userPrompt: string; signal?: AbortSignal };

export async function sendChat(provider: Provider, options: ChatSend): Promise<Response> {
  const baseUrl = trimBaseUrl(provider.baseUrl);
  if (!baseUrl || !provider.model) throw new Error('当前供应商还没有填写 API Host 或模型');

  if (provider.protocol === 'anthropic') {
    const auth: Record<string, string> = provider.key.startsWith('sk-cp-')
      ? { authorization: 'Bearer ' + provider.key }
      : { 'x-api-key': provider.key };
    return localModelRequest(
      baseUrl + '/messages',
      { 'content-type': 'application/json', ...auth, 'anthropic-version': '2023-06-01' },
      {
        model: provider.model,
        max_tokens: 4096,
        system: options.systemPrompt,
        messages: [{ role: 'user', content: options.userPrompt }]
      }, options.signal
    );
  }

  if (provider.protocol === 'google') {
    return localModelRequest(
      baseUrl + '/models/' + encodeURIComponent(provider.model) + ':generateContent?key=' + encodeURIComponent(provider.key),
      { 'content-type': 'application/json' },
      {
        systemInstruction: { parts: [{ text: options.systemPrompt }] },
        contents: [{ parts: [{ text: options.userPrompt }] }],
        generationConfig: { temperature: 0.1 }
      }, options.signal
    );
  }

  if (provider.protocol === 'bedrock') {
    throw new Error(provider.name + ' 需要 AWS 签名配置，请换用已连接的翻译模型');
  }

  const azure = provider.protocol === 'azure';
  const url = azure
    ? (baseUrl.includes('/deployments/')
      ? baseUrl + (baseUrl.includes('/chat/completions') ? '' : '/chat/completions') + (baseUrl.includes('?') ? '' : '?api-version=2024-10-21')
      : baseUrl + '/deployments/' + encodeURIComponent(provider.model) + '/chat/completions?api-version=2024-10-21')
    : baseUrl + '/chat/completions';
  return localModelRequest(
    url,
    {
      'content-type': 'application/json',
      ...(provider.key ? (azure ? { 'api-key': provider.key } : { authorization: 'Bearer ' + provider.key }) : {})
    },
    {
      model: provider.model,
      messages: [
        { role: 'system', content: options.systemPrompt },
        { role: 'user', content: options.userPrompt }
      ],
      temperature: 0.1
    }, options.signal
  );
}

export function chatTextPayload(raw: string): string {
  try {
    const value = JSON.parse(raw) as {
      choices?: { message?: { content?: string } }[];
      content?: { type?: string; text?: string }[];
      candidates?: { content?: { parts?: { text?: string }[] } }[];
    };
    return value.choices?.[0]?.message?.content
      || (value.content || []).filter(block => !block.type || block.type === 'text').map(block => block.text || '').join('')
      || (value.candidates?.[0]?.content?.parts || []).map(part => part.text || '').join('')
      || '';
  } catch { return raw.trim(); }
}

// —— 解析 ——

function decodeEntities(value: string): string {
  return value
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/&amp;/g, '&');
}

export function parseXmlTranslations(raw: string, requested: Segment[]): Segment[] {
  const matches = [...raw.matchAll(/<t\b[^>]*\bid="(\d+)"[^>]*>([\s\S]*?)<\/t>/g)];
  const normalized = matches.map(match => ({
    id: Number(match[1]),
    text: decodeEntities(match[2]).replace(/<br\s*\/?>/gi, '\n').trim()
  })).filter(item => requested.some(source => source.id === item.id) && item.text);
  if (!normalized.length) throw new Error('模型没有返回可用的翻译内容');
  return normalized;
}

function splitBatches(segments: Segment[], maxItems: number, maxChars: number): Segment[][] {
  const batches: Segment[][] = [];
  let current: Segment[] = [];
  let chars = 0;
  segments.forEach(segment => {
    if (current.length && (current.length >= maxItems || chars + segment.text.length > maxChars)) {
      batches.push(current);
      current = [];
      chars = 0;
    }
    current.push(segment);
    chars += segment.text.length;
  });
  if (current.length) batches.push(current);
  return batches;
}

function sleep(ms: number): Promise<void> {
  return new Promise(resolve => window.setTimeout(resolve, ms));
}
