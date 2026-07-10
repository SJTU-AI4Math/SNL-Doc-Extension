import React from 'react';
import { createRoot } from 'react-dom/client';
import { SnlGraphApp } from './SnlGraphApp';

const container = document.getElementById('root');
if (container) {
  createRoot(container).render(
    <React.StrictMode>
      <SnlGraphApp />
    </React.StrictMode>
  );
}
