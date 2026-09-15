import React from 'react';
import { createRoot } from 'react-dom/client';
import { PackagePanelApp } from './PackagePanelApp';
import '@sjtu-ai4math/snl-basics/style.css';

const container = document.getElementById('root');
if (container) {
  createRoot(container).render(
    <React.StrictMode>
      <PackagePanelApp />
    </React.StrictMode>
  );
}
