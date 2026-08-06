import * as vscode from 'vscode';
import { invariantHostText } from './hostI18n';

/**
 * Millisecond-resolution tracing for the Entry panel open path.
 *
 * Cat 2026-07-25 asked for this directly: "给单 Entry Panel 里整个渲染工作流
 * 加 Output debugging，每一条附上时间（精确到毫秒）". The point is to stop
 * guessing which stage is slow — bundle size, host I/O, webview mount, and
 * first paint each land in a different place, and only a timeline tells them
 * apart.
 *
 * Output goes to the "SNL Trace" output channel. Tracing is OFF by default
 * and enabled per-session via the `snlDoc.trace` setting or the
 * `snlDoc.toggleTrace` command, so it costs nothing in normal use.
 *
 * Lines look like:
 *
 *   [   0.0ms] (+  0.0) entryPanel:open              mode=edit id=thm-1
 *   [  12.4ms] (+ 12.4) entryPanel:webview-created
 *   [ 138.9ms] (+126.5) entryPanel:context-read      macros=412 entries=87
 *   [ 141.0ms] (+  2.1) entryPanel:context-posted
 *   [ 402.7ms] (+261.7) webview:first-paint
 *
 * The `(+n)` delta is what you read: the big jump is the culprit.
 */

let channel: vscode.OutputChannel | null = null;
let enabled = false;
/**
 * How many webview panels this window has stood up since activation.
 *
 * Cat 2026-07-25: the ~1s that precedes our HTML is charged on the webview's
 * OWN clock, i.e. before anything we control runs. If it is a one-time cost
 * per window (VS Code booting its webview service / Electron process) then
 * only the first panel of a session should be slow and the label below makes
 * that obvious immediately. If every panel shows `panelsThisSession=N` with
 * the same ~1s, it is genuinely per-panel.
 */
let panelsThisSession = 0;

export function countPanelOpen(): number {
  panelsThisSession += 1;
  return panelsThisSession;
}

/**
 * The shared "SNL Trace" channel, created on demand.
 *
 * Exported so diagnostics that are not themselves traces (the webview cost
 * probe) report into the same place instead of spawning a second channel the
 * author has to hunt for.
 */
export function traceChannel(): vscode.OutputChannel | null {
  return output();
}

/** Lazily create the channel; degrade to a no-op outside the extension host. */
function output(): vscode.OutputChannel | null {
  if (channel) return channel;
  try {
    const win = (vscode as { window?: typeof vscode.window }).window;
    if (win && typeof win.createOutputChannel === 'function') {
      channel = win.createOutputChannel(invariantHostText('SNL Trace', 'output-channel'));
      return channel;
    }
  } catch {
    // Fall through to no-op.
  }
  return null;
}

/** Read the `snlDoc.trace` setting; defaults to off. */
function configuredEnabled(): boolean {
  try {
    const ws = (vscode as { workspace?: typeof vscode.workspace }).workspace;
    if (ws && typeof ws.getConfiguration === 'function') {
      return ws.getConfiguration('snlDoc').get<boolean>('trace') === true;
    }
  } catch {
    // Fall through.
  }
  return false;
}

/** Re-read the setting. Called on activation and on config change. */
export function refreshTraceEnabled(): void {
  enabled = configuredEnabled();
}

/** Turn tracing on/off for this session and report the new state. */
export function setTraceEnabled(next: boolean): boolean {
  enabled = next;
  if (next) output()?.show(true);
  return enabled;
}

export function isTraceEnabled(): boolean {
  return enabled;
}

/**
 * A single timed run. Every `mark` is stamped with the time since `start`
 * AND the time since the previous mark, which is the number that actually
 * identifies a bottleneck.
 */
export interface Trace {
  /** Record a stage. `detail` is appended verbatim (keep it short). */
  mark(stage: string, detail?: string): void;
  /** Total elapsed milliseconds so far. */
  elapsed(): number;
}

/** A trace that does nothing, returned when tracing is off. */
const NOOP_TRACE: Trace = {
  mark: () => undefined,
  elapsed: () => 0
};

function format(ms: number, width: number): string {
  return ms.toFixed(1).padStart(width);
}

/**
 * Begin a trace named `label`. Returns a no-op when tracing is disabled, so
 * callers can instrument unconditionally without paying for it.
 */
export function startTrace(label: string, detail?: string): Trace {
  if (!enabled) return NOOP_TRACE;
  const out = output();
  if (!out) return NOOP_TRACE;

  const t0 = Date.now();
  let previous = t0;
  out.appendLine(invariantHostText(
    `─── ${label} ${detail ?? ''} @ ${new Date(t0).toISOString()}`,
    'output-channel'
  ));
  return {
    mark(stage: string, markDetail?: string): void {
      const now = Date.now();
      const total = now - t0;
      const delta = now - previous;
      previous = now;
      out.appendLine(invariantHostText(
        `[${format(total, 7)}ms] (+${format(delta, 6)}) ${stage.padEnd(30)}` +
          `${markDetail ?? ''}`,
        'output-channel'
      ));
    },
    elapsed(): number {
      return Date.now() - t0;
    }
  };
}

/**
 * Record a stage the WEBVIEW reported, folding it into the same timeline as
 * the host-side marks. The webview measures with `performance.now()` relative
 * to its own script start, so it sends deltas we can append verbatim.
 */
export function traceFromWebview(trace: Trace, stage: string, ms: number): void {
  trace.mark(stage, `webview-clock=${ms.toFixed(1)}ms`);
}
