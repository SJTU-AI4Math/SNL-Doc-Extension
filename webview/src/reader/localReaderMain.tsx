import { createRoot } from 'react-dom/client';
import { LocalWorkspaceReader } from './LocalWorkspaceReader';
import { initializeBrowserReaderDocument } from './BrowserReader';
import './localReader.css';

// BrowserReader retains the HTML export's existing bootstrap when its manifest is present.
if (!(window as Window & { __SNL_READER__?: unknown }).__SNL_READER__) {
  const root = document.getElementById('snl-reader-root');
  if (!root) throw new Error('Shared reader root missing');
  initializeBrowserReaderDocument();
  createRoot(root).render(<LocalWorkspaceReader />);
}
