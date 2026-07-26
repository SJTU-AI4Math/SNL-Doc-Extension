import React from 'react';
import { createRoot } from 'react-dom/client';
import { App } from './App';
import { traceFirstPaint, traceMark } from './runtime/trace';

// Cat 2026-07-25: the Infoview is the one panel that feels fast on first
// open. Trace it exactly like the Entry panel so the two are comparable.
traceMark('script-start');

const container = document.getElementById('root');
if (container) {
  createRoot(container).render(
    <React.StrictMode>
      <App />
    </React.StrictMode>
  );
  traceMark('render-called');
  traceFirstPaint();
}
