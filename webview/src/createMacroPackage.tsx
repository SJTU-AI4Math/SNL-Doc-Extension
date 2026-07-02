import React from 'react';
import { createRoot } from 'react-dom/client';
import { CreateMacroPackageApp } from './CreateMacroPackageApp';

const container = document.getElementById('root');
if (container) {
  createRoot(container).render(
    <React.StrictMode>
      <CreateMacroPackageApp />
    </React.StrictMode>
  );
}
