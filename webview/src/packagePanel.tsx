import React from 'react';
import { createRoot } from 'react-dom/client';
import { PackagePanelApp } from './PackagePanelApp';

const container = document.getElementById('root');
if (container) {
  createRoot(container).render(
    <React.StrictMode>
      <PackagePanelApp />
    </React.StrictMode>
  );
}
