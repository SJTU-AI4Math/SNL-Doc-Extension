import React from 'react';
import { createRoot } from 'react-dom/client';
import { InitMacroKindsApp } from './InitMacroKindsApp';

const container = document.getElementById('root');
if (container) {
  createRoot(container).render(
    <React.StrictMode>
      <InitMacroKindsApp />
    </React.StrictMode>
  );
}
