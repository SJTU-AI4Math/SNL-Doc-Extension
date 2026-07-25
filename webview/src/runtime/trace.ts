import { getVsCodeApi } from '../vscodeApi';

/**
 * Webview-side timing marks, reported to the host so the whole panel-open
 * path lands on ONE timeline in the "SNL Trace" output channel.
 *
 * Cat 2026-07-25: "给单 Entry Panel 里整个渲染工作流加 Output debugging，
 * 每一条附上时间（精确到毫秒）".
 *
 * The webview cannot see the host's clock, so it reports `performance.now()`
 * — milliseconds since this script started executing. That is exactly the
 * number we want for the webview's own stages: bundle parse → React mount →
 * first paint. The host stamps arrival time, so both views are available.
 *
 * Sending is unconditional and cheap (one postMessage per stage); the host
 * drops the marks unless tracing is enabled.
 */
export function traceMark(stage: string): void {
  try {
    getVsCodeApi()?.postMessage({
      type: 'trace',
      stage,
      ms: typeof performance !== 'undefined' ? performance.now() : 0
    });
  } catch {
    // Tracing must never break the panel.
  }
}

/**
 * Report `first-paint` after the browser has actually painted the frame that
 * this render produced.
 *
 * A `useEffect` fires after commit but BEFORE paint, so marking there would
 * flatter the number. Double-rAF is the standard way to land just after the
 * paint: the first callback runs before the frame, the second after it.
 */
export function traceFirstPaint(): void {
  if (typeof requestAnimationFrame !== 'function') {
    traceMark('first-paint');
    return;
  }
  requestAnimationFrame(() => {
    requestAnimationFrame(() => traceMark('first-paint'));
  });
}
