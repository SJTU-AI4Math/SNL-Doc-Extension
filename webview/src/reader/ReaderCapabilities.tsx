import React, { createContext, useContext } from 'react';

/** Platform capabilities. Shared components emit intents; adapters own I/O. */
export interface ReaderCapabilities {
  api?: { postMessage(message: unknown): void };
  edit: boolean;
  graph: boolean;
  export: boolean;
  /** Browser resolves availability from its reviewed manifest; host uses authored Pointer. */
  sourceAvailable?(entryId: string): boolean;
  sourceUnavailableReason?: string;
}
const defaults: ReaderCapabilities = {
  edit: true, graph: true, export: true
};
export const ReaderCapabilitiesContext = createContext<ReaderCapabilities>(defaults);
export const useReaderCapabilities = (): ReaderCapabilities => useContext(ReaderCapabilitiesContext);
export const READER_STYLE: React.CSSProperties = {
  fontFamily: 'var(--vscode-font-family, system-ui, -apple-system, sans-serif)',
  color: 'var(--vscode-foreground, var(--vscode-editor-foreground, #ddd))',
  padding: '1.5rem', lineHeight: 1.5, width: '100%', maxWidth: 'none', minWidth: 0,
  boxSizing: 'border-box'
};
