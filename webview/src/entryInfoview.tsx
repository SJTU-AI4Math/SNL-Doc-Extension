import React from 'react';
import { createRoot } from 'react-dom/client';
import { EntryInfoviewApp } from './EntryInfoviewApp';

const container = document.getElementById('root');
if (container) {
  createRoot(container).render(
    <React.StrictMode>
      <EntryInfoviewApp />
    </React.StrictMode>
  );
}
