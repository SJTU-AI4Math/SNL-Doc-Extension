// TODO(stage1): wire up snl-script's SNL_render(SNL_SyntaxTree) -> ReactElement

import React from 'react';
import { PANEL_STYLE } from './vscodeApi';

export function App(): React.ReactElement {
  return (
    <main style={PANEL_STYLE}>
      <h1 style={{ margin: '0 0 0.5rem', fontSize: '1.25rem' }}>
        SNL Infoview
      </h1>
      <p style={{ margin: 0, opacity: 0.8 }}>
        Scaffold ready — waiting for SNL_render integration.
      </p>
    </main>
  );
}
