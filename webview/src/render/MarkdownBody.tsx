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

export function MarkdownBody({ source }: MarkdownBodyProps): React.ReactElement {
  return (
    <div className="snl-markdown-body">
      <ReactMarkdown
        remarkPlugins={[remarkGfm, remarkMath]}
        rehypePlugins={[rehypeKatex]}
      >
        {source}
      </ReactMarkdown>
    </div>
  );
}
