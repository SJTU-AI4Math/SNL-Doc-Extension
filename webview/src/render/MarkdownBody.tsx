// Markdown-body renderer for Entry — cat 2026-07-11 spec: when
// content.snl is empty but content.markdown has value, render the entry
// body as plain web-style Markdown with bare KaTeX for inline / display
// math ($…$ / $$…$$). Completely separate from the SNL pipeline (no
// term-macro lookup, no bvar-scope highlighting, no popovers).
//
// Rationale (cat verbatim): "如果 SNL 空着, Markdown 有内容, 就先渲染
// 一个 Markdown, SNL 有了再渲染 SNL. 这样我们就可以实现先写 Markdown
// Entry 或者 LaTeX Entry 搭框架, 再写 SNL."
//
// Dependencies (added 2026-07-11):
//   react-markdown, remark-gfm, remark-math, rehype-katex
//   (KaTeX CSS already imported by EntryRender.tsx)

import React from 'react';
import ReactMarkdown from 'react-markdown';
import remarkGfm from 'remark-gfm';
import remarkMath from 'remark-math';
import rehypeKatex from 'rehype-katex';

export interface MarkdownBodyProps {
  source: string;
}

const FENCED_CODE_COLOR = '#24292f';
const FENCED_CODE_BACKGROUND = '#f6f8fa';

/**
 * Keep fenced code readable on Entry cards from the very first paint.
 *
 * These styles deliberately live on the rendered nodes instead of relying
 * only on the stylesheet installed by useEffect: a VS Code webview can paint
 * the Markdown tree before that effect runs, briefly (or in a retained view,
 * persistently) exposing the host theme's light foreground on a light card.
 */
type MarkdownElementProps<Tag extends 'pre' | 'code'> =
  React.ComponentPropsWithoutRef<Tag> & { node?: unknown };

export const markdownComponents = {
  pre: ({ children, node: _node, ...props }: MarkdownElementProps<'pre'>) => (
    <pre
      {...props}
      style={{
        ...props.style,
        color: FENCED_CODE_COLOR,
        background: FENCED_CODE_BACKGROUND
      }}
    >
      {children}
    </pre>
  ),
  code: ({ children, node: _node, ...props }: MarkdownElementProps<'code'>) => (
    <code
      {...props}
      style={{ ...props.style, color: FENCED_CODE_COLOR }}
    >
      {children}
    </code>
  )
};

export function MarkdownBody({ source }: MarkdownBodyProps): React.ReactElement {
  React.useEffect(() => {
    if (document.getElementById('snl-markdown-body-style')) return;
    const style = document.createElement('style');
    style.id = 'snl-markdown-body-style';
    style.textContent = `
.snl-markdown-body > *:first-child { margin-top: 0; }
.snl-markdown-body > *:last-child { margin-bottom: 0; }
.snl-markdown-body p { margin: 0.4em 0; }
.snl-markdown-body h1, .snl-markdown-body h2, .snl-markdown-body h3,
.snl-markdown-body h4, .snl-markdown-body h5, .snl-markdown-body h6 {
  margin: 0.6em 0 0.3em; line-height: 1.25;
}
.snl-markdown-body ul, .snl-markdown-body ol { margin: 0.4em 0; padding-left: 1.5em; }
.snl-markdown-body li { margin: 0.15em 0; }
.snl-markdown-body pre { margin: 0.5em 0; padding: 0.5em 0.7em;
  background: rgba(127,127,127,0.1); border-radius: 3px; overflow-x: auto; }
/* Entry backgrounds are intentionally light, so fenced-code text must not
   inherit a light VS Code foreground (or the EntryKind stroke color). */
.snl-markdown-body pre, .snl-markdown-body pre code { color: #24292f; }
.snl-markdown-body code { font-family: var(--vscode-editor-font-family, monospace);
  font-size: 0.92em; }
.snl-markdown-body :not(pre) > code { padding: 0.1em 0.3em;
  background: rgba(127,127,127,0.15); border-radius: 3px; }
.snl-markdown-body blockquote { margin: 0.4em 0; padding-left: 0.8em;
  border-left: 3px solid rgba(127,127,127,0.4); color: inherit; opacity: 0.85; }
.snl-markdown-body table { border-collapse: collapse; margin: 0.5em 0; }
.snl-markdown-body th, .snl-markdown-body td {
  border: 1px solid rgba(127,127,127,0.3); padding: 0.25em 0.5em; }
`;
    document.head.appendChild(style);
  }, []);

  return (
    <div className="snl-markdown-body">
      <ReactMarkdown
        components={markdownComponents}
        remarkPlugins={[remarkGfm, remarkMath]}
        rehypePlugins={[rehypeKatex]}
      >
        {source}
      </ReactMarkdown>
    </div>
  );
}
