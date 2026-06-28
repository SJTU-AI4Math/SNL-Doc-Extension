import React from 'react';
import { createRoot } from 'react-dom/client';
import { InitApp } from './InitApp';

const container = document.getElementById('root');
if (container) {
  createRoot(container).render(
    <React.StrictMode>
      <InitApp />
    </React.StrictMode>
  );
}
