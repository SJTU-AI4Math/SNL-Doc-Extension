import React from 'react';
import { createRoot } from 'react-dom/client';
import { CreateEntryPackageApp } from './CreateEntryPackageApp';
import './components/ui.css';

createRoot(document.getElementById('root')!).render(
  <React.StrictMode><CreateEntryPackageApp /></React.StrictMode>
);
