// TODO(stage1): 接入 snl-script 的 SNL_render(SNL_SyntaxTree) -> ReactElement

import React from 'react';

export function App(): React.ReactElement {
  return (
    <main
      style={{
        fontFamily:
          'var(--vscode-font-family, system-ui, -apple-system, sans-serif)',
        color: 'var(--vscode-foreground, #ddd)',
        padding: '1.5rem',
        lineHeight: 1.5
      }}
    >
      <h1 style={{ margin: '0 0 0.5rem', fontSize: '1.25rem' }}>
        SNL Infoview
      </h1>
      <p style={{ margin: 0, opacity: 0.8 }}>
        脚手架就绪 — 等待接入 SNL_render
      </p>
    </main>
  );
}
