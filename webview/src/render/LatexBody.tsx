// LaTeX-body renderer for Entry — cat 2026-07-11 spec: when only
// content.latex has value, render the entire body as bare KaTeX in
// display mode. NO markdown parsing, NO SNL semantics — just KaTeX.
//
// Errors: KaTeX's `throwOnError:false` gives us an in-place red error
// message rendered inside the output — we let that surface so authors
// see what's wrong without a separate error banner.

import React, { useMemo } from 'react';
import katex from 'katex';

export interface LatexBodyProps {
  source: string;
}

export function LatexBody({ source }: LatexBodyProps): React.ReactElement {
  const html = useMemo(
    () =>
      katex.renderToString(source, {
        displayMode: true,
        throwOnError: false,
        strict: 'ignore',
      }),
    [source]
  );
  return (
    <div
      className="snl-latex-body"
      // katex.renderToString returns HTML — same trust boundary the
      // rest of EntryRender uses.
      dangerouslySetInnerHTML={{ __html: html }}
    />
  );
}
