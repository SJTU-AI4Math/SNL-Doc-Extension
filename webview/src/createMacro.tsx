import React from 'react';
import { createRoot } from 'react-dom/client';
import { CreateMacroApp } from './CreateMacroApp';

const container = document.getElementById('root');
if (container) {
  createRoot(container).render(
    <React.StrictMode>
      <CreateMacroApp />
    </React.StrictMode>
  );
}
