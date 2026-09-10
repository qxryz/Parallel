import ReactMarkdown from 'react-markdown';
import remarkGfm from 'remark-gfm';
import remarkMath from 'remark-math';
import rehypeKatex from 'rehype-katex';
import 'katex/dist/katex.min.css';

// Preserve code verbatim; accept both common LaTeX delimiter conventions.
export function prepareAgentMarkdown(text: string) {
  return text.split(/(```[\s\S]*?```|`[^`\n]*`)/g).map((part, i) => i % 2 ? part : part
    .replace(/\\\[([\s\S]*?)\\\]/g, (_, math: string) => `\n$$\n${math}\n$$\n`)
    .replace(/\\\(([\s\S]*?)\\\)/g, (_, math: string) => `$${math}$`)
    .replace(/\[第\s*(\d+)\s*页\](?!\()/g, '[第 $1 页](#pdf-page-$1)')).join('');
}

export function AgentRichText({ text, pageCount, onPage }: { text: string; pageCount: number; onPage: (page: number) => void }) {
  return <ReactMarkdown remarkPlugins={[remarkGfm, remarkMath]} rehypePlugins={[[rehypeKatex, { strict: false, trust: false }]]}
    components={{
      a: ({ href, children }) => {
        const match = href?.match(/^#pdf-page-(\d+)$/);
        if (match) {
          const page = Number(match[1]);
          return page > 0 && page <= pageCount ? <button className="agent-citation" onClick={() => onPage(page - 1)}>{children}</button> : <span>{children}</span>;
        }
        return <a href={href} target="_blank" rel="noopener noreferrer">{children}</a>;
      },
      // Media is rendered by the confirmed generation card, not arbitrary model markdown.
      img: ({ alt }) => <span>{alt || '图片'}</span>,
    }}>{prepareAgentMarkdown(text)}</ReactMarkdown>;
}
