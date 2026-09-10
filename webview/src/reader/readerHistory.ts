import { useEffect, useState } from 'react';
import { flushSync } from 'react-dom';
import { decodeReaderRoute } from './readerRoute';

const READER_NAVIGATION = 'snl-reader-navigation';
export function notifyReaderLocation(): void {
  window.dispatchEvent(new Event(READER_NAVIGATION));
}

/** pushState does not emit hashchange: both workspace and reader observe this same port. */
export function navigateReaderHash(hash: string, replace = false): void {
  if (location.hash !== hash) (replace ? history.replaceState : history.pushState).call(history, { ...history.state }, '', hash);
  flushSync(notifyReaderLocation);
}

/** A navigation session resets search controls; keystroke URL replacement does not. */
export function useReaderLocation() {
  const [locationState, setLocationState] = useState(() => ({ route: decodeReaderRoute(location.hash), session: 0 }));
  useEffect(() => {
    const changed = () => setLocationState(value => ({ route: decodeReaderRoute(location.hash), session: value.session + 1 }));
    window.addEventListener('hashchange', changed);
    window.addEventListener('popstate', changed);
    window.addEventListener(READER_NAVIGATION, changed);
    return () => {
      window.removeEventListener('hashchange', changed);
      window.removeEventListener('popstate', changed);
      window.removeEventListener(READER_NAVIGATION, changed);
    };
  }, []);
  return locationState;
}
