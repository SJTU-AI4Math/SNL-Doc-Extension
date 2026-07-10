import React from 'react';
import { createRoot } from 'react-dom/client';
import { CreateRelationshipApp } from './CreateRelationshipApp';

const container = document.getElementById('root');
if (container) {
  createRoot(container).render(
    <React.StrictMode>
      <CreateRelationshipApp />
    </React.StrictMode>
  );
}
