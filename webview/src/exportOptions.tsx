import React from 'react';
import { createRoot } from 'react-dom/client';
import { ExportOptionsApp } from './ExportOptionsApp';

const container = document.getElementById('root');
if (container) {
  createRoot(container).render(
    <React.StrictMode>
      <ExportOptionsApp />
    </React.StrictMode>
  );
}
