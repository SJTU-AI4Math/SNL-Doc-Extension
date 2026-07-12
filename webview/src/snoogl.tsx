import React from 'react';
import { createRoot } from 'react-dom/client';
import { SnooglApp } from './SnooglApp';

const container = document.getElementById('root');
if (container) {
  createRoot(container).render(
    <React.StrictMode>
      <SnooglApp />
    </React.StrictMode>
  );
}
