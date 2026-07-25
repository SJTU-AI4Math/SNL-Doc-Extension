import React from 'react';
import { createRoot } from 'react-dom/client';
import { CreateEntryApp } from './CreateEntryApp';
import { traceMark } from './runtime/trace';

// Cat 2026-07-25: time the whole open path. `script-start` is the first line
// the bundle executes, so the gap between the host's `html-set` and this mark
// IS the bundle fetch+parse cost.
traceMark('script-start');

const container = document.getElementById('root');
if (container) {
  createRoot(container).render(
    <React.StrictMode>
      <CreateEntryApp />
    </React.StrictMode>
  );
  traceMark('render-called');
}
