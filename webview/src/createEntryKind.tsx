import React from 'react';
import { createRoot } from 'react-dom/client';
import { CreateEntryKindApp } from './CreateEntryKindApp';

const container = document.getElementById('root');
if (container) {
  createRoot(container).render(
    <React.StrictMode>
      <CreateEntryKindApp />
    </React.StrictMode>
  );
}
