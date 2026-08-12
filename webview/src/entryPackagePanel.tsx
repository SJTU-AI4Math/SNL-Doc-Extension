import React from 'react';
import { createRoot } from 'react-dom/client';
import { EntryPackagePanelApp } from './EntryPackagePanelApp';
import './components/ui.css';

createRoot(document.getElementById('root')!).render(<React.StrictMode><EntryPackagePanelApp /></React.StrictMode>);
