import React from 'react';
import { createRoot } from 'react-dom/client';
import { InitEntryKindsApp } from './InitEntryKindsApp';

const container = document.getElementById('root');
if (container) {
  createRoot(container).render(
    <React.StrictMode>
      <InitEntryKindsApp />
    </React.StrictMode>
  );
}
