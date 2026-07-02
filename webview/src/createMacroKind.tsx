import React from 'react';
import { createRoot } from 'react-dom/client';
import { CreateMacroKindApp } from './CreateMacroKindApp';

const container = document.getElementById('root');
if (container) {
  createRoot(container).render(
    <React.StrictMode>
      <CreateMacroKindApp />
    </React.StrictMode>
  );
}
