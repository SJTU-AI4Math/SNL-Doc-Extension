import React from 'react';
import { createRoot } from 'react-dom/client';
import { DashboardApp } from './DashboardApp';

const container = document.getElementById('root');
if (container) {
  createRoot(container).render(
    <React.StrictMode>
      <DashboardApp />
    </React.StrictMode>
  );
}
