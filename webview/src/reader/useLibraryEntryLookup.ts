import type { EntryData } from '../render/EntrySurface';
import { useEffect, useRef, useState } from 'react';
import { useVsCodeApiRef } from '../vscodeApi';

let nextRequestId = 0;
export interface LibraryLookupEntry { id: string; title: EntryData['title']; kind?: string; content?: { snl?: string } }
export interface LibraryLookup {
  entryId: string;
  state: 'pending' | 'found' | 'missing' | 'error';
  entry?: LibraryLookupEntry;
  message?: string;
}
/** Lookup authority is the exact query AND request, not membership in the
 * current render pool. A remount cannot reuse an earlier request identity. */
export function useLibraryEntryLookup(entryId: string, target: string): LibraryLookup {
  const api = useVsCodeApiRef();
  const [result, setResult] = useState<LibraryLookup & { target?: string }>({ entryId, state: 'pending' });
  const active = useRef(0);
  useEffect(() => {
    const requestId = ++nextRequestId;
    active.current = requestId;
    setResult({ target, entryId, state: entryId ? 'pending' : 'missing' });
    const receive = ({ data: msg }: MessageEvent) => {
      if (!msg || active.current !== requestId || msg.requestId !== requestId || msg.entryId !== entryId) return;
      if (msg.type === 'entryLookupError') setResult({ target, entryId, state: 'error', message: typeof msg.message === 'string' ? msg.message : 'Entry lookup failed.' });
      if (msg.type !== 'entryLookup') return;
      if (msg.entry === null) setResult({ target, entryId, state: 'missing' });
      else if (msg.entry && msg.entry.id === entryId && typeof msg.entry.kind === 'string' && msg.entry.title !== undefined) {
        setResult({ target, entryId, state: 'found', entry: msg.entry });
      }
    };
    window.addEventListener('message', receive);
    api.current?.postMessage({ type: 'lookupEntry', requestId, entryId });
    return () => { active.current = 0; window.removeEventListener('message', receive); };
  }, [entryId, target, api]);
  return result.entryId === entryId && result.target === target ? result : { entryId, state: 'pending' };
}
