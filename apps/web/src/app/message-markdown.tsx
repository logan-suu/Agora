import * as React from 'react';
import Markdown, { type Components, defaultUrlTransform } from 'react-markdown';
import remarkGfm from 'remark-gfm';

type DisplayNode = { type: string; value?: string; lang?: string; children?: DisplayNode[] };

function taggedResult(text: string): boolean {
  const match = /^<agora-result>\s*([\s\S]*?)\s*<\/agora-result>$/.exec(text.trim());
  if (!match) return false;
  try {
    const value: unknown = JSON.parse(match[1] ?? '');
    return value !== null && typeof value === 'object';
  } catch {
    return false;
  }
}

/** Use parsed HTML nodes so result-tag examples inside code remain ordinary code. */
function remarkResultDetails() {
  return (tree: DisplayNode) => {
    const pending = [tree];
    while (pending.length > 0) {
      const node = pending.pop();
      if (!node) continue;
      if (node.type === 'html' && node.value && taggedResult(node.value)) {
        node.type = 'code';
        node.lang = 'agora-result';
      }
      if (node.children) pending.push(...node.children);
    }
  };
}

const plugins = [remarkGfm, remarkResultDetails];
const mentionPattern = /((?<![\w@])@[A-Z][A-Z0-9_]*\b)/g;

function mentions(children: React.ReactNode): React.ReactNode {
  return React.Children.map(children, (child) => {
    if (typeof child !== 'string') return child;
    return child.split(mentionPattern).map((part, index) =>
      /^@[A-Z][A-Z0-9_]*$/.test(part) ? (
        <span className="mention" key={index}>
          {part}
        </span>
      ) : (
        part
      ),
    );
  });
}

function textElement(tag: 'p' | 'h1' | 'h2' | 'h3' | 'h4' | 'h5' | 'h6' | 'strong' | 'em' | 'del') {
  return ({ children }: { children?: React.ReactNode }) =>
    React.createElement(tag, null, mentions(children));
}

function safeUrl(url: string): string {
  const safe = defaultUrlTransform(url.trim());
  const protocol = /^([a-z][a-z0-9+.-]*):/i.exec(safe)?.[1];
  return protocol && !['http', 'https', 'mailto'].includes(protocol.toLowerCase()) ? '' : safe;
}

const components: Components = {
  pre: ({ children }) => {
    const code = React.Children.toArray(children)[0];
    if (
      React.isValidElement<{ className?: string; children?: React.ReactNode }>(code) &&
      code.props.className === 'language-agora-result' &&
      typeof code.props.children === 'string' &&
      taggedResult(code.props.children)
    )
      return (
        <details className="message-original">
          <summary>View result details</summary>
          <pre>{children}</pre>
        </details>
      );
    if (
      React.isValidElement<{ className?: string; children?: React.ReactNode }>(code) &&
      code.props.className === 'language-json' &&
      typeof code.props.children === 'string'
    ) {
      try {
        JSON.parse(code.props.children);
        return (
          <details className="message-original">
            <summary>View JSON details</summary>
            <pre>{children}</pre>
          </details>
        );
      } catch {
        // Preserve malformed examples visibly instead of interpreting them as reports.
      }
    }
    return <pre>{children}</pre>;
  },
  p: textElement('p'),
  h1: textElement('h1'),
  h2: textElement('h2'),
  h3: textElement('h3'),
  h4: textElement('h4'),
  h5: textElement('h5'),
  h6: textElement('h6'),
  strong: textElement('strong'),
  em: textElement('em'),
  del: textElement('del'),
  li: ({ children, className }) => <li className={className}>{mentions(children)}</li>,
  td: ({ children, style }) => <td style={style}>{mentions(children)}</td>,
  th: ({ children, style }) => <th style={style}>{mentions(children)}</th>,
  a: ({ href, children, title }) =>
    href ? (
      <a href={href} title={title} target="_blank" rel="noopener noreferrer">
        {mentions(children)}
      </a>
    ) : (
      <span>{children}</span>
    ),
  img: ({ src, alt }) =>
    typeof src === 'string' && src ? (
      <a href={src} target="_blank" rel="noopener noreferrer">
        {alt || 'Image'}
      </a>
    ) : (
      <span>{alt || 'Image'}</span>
    ),
  table: ({ children }) => (
    // biome-ignore lint/a11y/noNoninteractiveTabindex: Keyboard users need to scroll wide message tables.
    <section className="markdown-table-scroll" aria-label="Message table" tabIndex={0}>
      <table>{children}</table>
    </section>
  ),
};

function rawJson(text: string): boolean {
  if (!/^[{[]/.test(text.trim())) return false;
  try {
    const parsed: unknown = JSON.parse(text);
    return parsed !== null && typeof parsed === 'object';
  } catch {
    return /^\s*(?:\{|\[\s*\{)/.test(text);
  }
}

/** Render display text only. No raw HTML plugin or executable content is admitted. */
export const MessageMarkdown = React.memo(function MessageMarkdown({ text }: { text: string }) {
  if (text.length > 100_000 || rawJson(text)) return <p className="message-plain">{text}</p>;
  return (
    <div className="message-markdown">
      <Markdown remarkPlugins={plugins} components={components} urlTransform={safeUrl}>
        {text}
      </Markdown>
    </div>
  );
});
