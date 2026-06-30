import React from 'react';
import { createRoot } from 'react-dom/client';
import { CreateLibraryApp } from './CreateLibraryApp';

const container = document.getElementById('root');
if (container) {
  createRoot(container).render(
    <React.StrictMode>
      <CreateLibraryApp />
    </React.StrictMode>
  );
}
