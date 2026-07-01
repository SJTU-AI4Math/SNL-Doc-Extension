import React from 'react';
import { createRoot } from 'react-dom/client';
import { CreateEntryApp } from './CreateEntryApp';

const container = document.getElementById('root');
if (container) {
  createRoot(container).render(
    <React.StrictMode>
      <CreateEntryApp />
    </React.StrictMode>
  );
}
