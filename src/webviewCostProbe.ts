import * as vscode from 'vscode';

/**
 * Measure what a bare `createWebviewPanel` costs, N times in a row.
 *
 * Why this exists (cat 2026-07-26): every panel in this extension takes
 * ~1.09s to open, and tracing showed the entire cost sits between
 * `html-set` and the first script mark inside the webview — i.e. before a
 * single line of our code runs. Bundle size (29ms), disk I/O (6ms), CSS and
 * ViewColumn were each measured and each exonerated.
 *
 * The original "the Infoview is fast, editor panels are slow" framing was
 * WRONG. Cat 2026-07-26, verbatim: '首次开 Infoview -> Libraries 列表页面不
 * 快, 从 Libraries 进 单个 Library 的 Infoview 面板快.' The Infoview's inner
 * navigation is fast because it is a `postMessage` inside an ALREADY-LIVE
 * webview; its first open pays the same ~1.09s as everything else. So the
 * dividing line is not panel identity, it is simply:
 *
 *     did this action call `createWebviewPanel`?
 *
 * That leaves exactly one open question, and it selects between two
 * completely different fixes:
 *
 *   A. the cost is ONCE PER WINDOW (VS Code booting its webview service /
 *      Electron renderer on first use) -> panel #1 is slow, #2..#N are cheap
 *      -> the fix is PREWARM: stand up a hidden webview during activation so
 *      the user's first real panel is never the one that pays.
 *
 *   B. the cost is PER PANEL (every `createWebviewPanel` builds a fresh
 *      renderer) -> all N are ~equally slow -> the fix is POOLING: never
 *      dispose, keep panels alive hidden and retarget them (which is already
 *      what the Entry editor singleton does, and why *switching* entries is
 *      instant while close-and-reopen is not).
 *
 * Arguing about this is a waste of time; the numbers decide. This command
 * opens `count` deliberately EMPTY webviews (no bundle, no CSS, no data
 * reads — nothing but an inline script that reports back) one at a time,
 * each waiting for the previous to report, and prints the per-panel cost
 * plus a verdict. An empty webview isolates the host stand-up cost from
 * everything our code does.
 *
 * The panels are disposed as soon as they report, so running the probe does
 * not leave a mess of tabs behind.
 */

/** How long to wait for one probe webview to phone home before giving up. */
const PROBE_TIMEOUT_MS = 15_000;

/** Result of standing up one probe webview. */
export interface ProbeSample {
  /** 1-based index of this panel within the probe run. */
  index: number;
  /**
   * Host-side wall time from just before `createWebviewPanel` until the
   * webview's inline script reported in. This is the number that matters —
   * it is the latency the user actually feels.
   */
  ms: number;
}

/**
 * Classify a probe run into the PREWARM / POOLING decision.
 *
 * Exported and pure so it can be unit-tested without a webview host.
 *
 * The rule: compare the first sample against the median of the rest. If the
 * later panels are dramatically cheaper, the cost was a one-time boot.
 *
 * `decayRatio` is `restMedian / first`. A run where panel #1 costs 1000ms
 * and the rest cost 60ms gives 0.06 -> clearly per-window. A run where every
 * panel costs ~1000ms gives ~1.0 -> clearly per-panel.
 */
export function classifyProbe(samples: readonly ProbeSample[]): {
  verdict: 'per-window' | 'per-panel' | 'inconclusive';
  first: number;
  restMedian: number;
  decayRatio: number;
  advice: string;
} {
  if (samples.length < 2) {
    return {
      verdict: 'inconclusive',
      first: samples[0]?.ms ?? 0,
      restMedian: 0,
      decayRatio: 1,
      advice: 'Need at least 2 samples; re-run with a higher count.'
    };
  }
  const first = samples[0].ms;
  const rest = samples.slice(1).map((s) => s.ms).sort((a, b) => a - b);
  const mid = Math.floor(rest.length / 2);
  const restMedian =
    rest.length % 2 === 1 ? rest[mid] : (rest[mid - 1] + rest[mid]) / 2;
  // Guard against a zero/absurd first sample making the ratio meaningless.
  const decayRatio = first > 0 ? restMedian / first : 1;

  if (decayRatio <= 0.4) {
    return {
      verdict: 'per-window',
      first,
      restMedian,
      decayRatio,
      advice:
        'Cost is a ONE-TIME per-window webview host boot. Fix = PREWARM: ' +
        'create a hidden throwaway webview during activation so the first ' +
        'panel the user opens is never the one that pays. Pooling would be ' +
        'wasted effort here.'
    };
  }
  if (decayRatio >= 0.7) {
    return {
      verdict: 'per-panel',
      first,
      restMedian,
      decayRatio,
      advice:
        'Cost is charged PER PANEL. Prewarming one hidden webview will not ' +
        'help. Fix = POOLING: keep panels alive (hide instead of dispose) ' +
        'and retarget them, the way the Entry editor singleton already does.'
    };
  }
  return {
    verdict: 'inconclusive',
    first,
    restMedian,
    decayRatio,
    advice:
      'Partial decay — neither a clean one-time boot nor a flat per-panel ' +
      'cost. Re-run with a higher count on an idle machine before choosing ' +
      'a fix.'
  };
}

/** Minimal webview document: no bundle, no CSS, just a report-back. */
function probeHtml(nonce: string): string {
  return `<!DOCTYPE html>
<html><head>
<meta http-equiv="Content-Security-Policy" content="default-src 'none'; script-src 'nonce-${nonce}'" />
<script nonce="${nonce}">
  try { acquireVsCodeApi().postMessage({ type: 'probe-ready' }); } catch (e) {}
</script>
</head><body></body></html>`;
}

function nonce(): string {
  let text = '';
  const chars = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789';
  for (let i = 0; i < 32; i++) {
    text += chars.charAt(Math.floor(Math.random() * chars.length));
  }
  return text;
}

/**
 * Stand up one empty webview and resolve with the wall time until it reports.
 * The panel is always disposed, including on timeout, so a hung probe cannot
 * leak a tab.
 */
async function timeOneWebview(index: number): Promise<ProbeSample> {
  const started = Date.now();
  const panel = vscode.window.createWebviewPanel(
    'snlDoc.webviewCostProbe',
    `SNL probe ${index}`,
    // Beside, so the probe never steals the editor the author is looking at.
    { viewColumn: vscode.ViewColumn.Beside, preserveFocus: true },
    { enableScripts: true, retainContextWhenHidden: false }
  );

  const ms = await new Promise<number>((resolve) => {
    let settled = false;
    const finish = (value: number): void => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      subscription.dispose();
      resolve(value);
    };
    const timer = setTimeout(() => finish(Date.now() - started), PROBE_TIMEOUT_MS);
    const subscription = panel.webview.onDidReceiveMessage(() => {
      finish(Date.now() - started);
    });
    panel.webview.html = probeHtml(nonce());
  });

  panel.dispose();
  return { index, ms };
}

/**
 * Run the probe `count` times and write a report to the "SNL Trace" channel.
 *
 * Sequential on purpose: opening them concurrently would let VS Code overlap
 * the very boot cost we are trying to isolate.
 */
export async function runWebviewCostProbe(
  count: number,
  out: vscode.OutputChannel
): Promise<ProbeSample[]> {
  const samples: ProbeSample[] = [];
  out.show(true);
  out.appendLine(
    `─── webview cost probe: ${count} empty panels @ ${new Date().toISOString()}`
  );
  out.appendLine(
    '    (no bundle, no CSS, no data reads — pure createWebviewPanel cost)'
  );
  for (let i = 1; i <= count; i++) {
    const sample = await timeOneWebview(i);
    samples.push(sample);
    out.appendLine(`    panel #${i}: ${sample.ms.toFixed(0)}ms`);
  }
  const verdict = classifyProbe(samples);
  out.appendLine(
    `    first=${verdict.first.toFixed(0)}ms restMedian=${verdict.restMedian.toFixed(0)}ms ` +
      `ratio=${verdict.decayRatio.toFixed(2)}`
  );
  out.appendLine(`    VERDICT: ${verdict.verdict}`);
  out.appendLine(`    ${verdict.advice}`);
  return samples;
}

/** Register `snlDoc.probeWebviewCost`. */
export function registerWebviewCostProbe(
  out: vscode.OutputChannel
): vscode.Disposable {
  return vscode.commands.registerCommand(
    'snlDoc.probeWebviewCost',
    async () => {
      const picked = await vscode.window.showQuickPick(
        ['3', '5', '8'],
        { title: 'How many empty webviews to time?', placeHolder: '5' }
      );
      if (!picked) return;
      const count = Number.parseInt(picked, 10);
      const samples = await vscode.window.withProgress(
        {
          location: vscode.ProgressLocation.Notification,
          title: `Timing ${count} empty webviews…`
        },
        () => runWebviewCostProbe(count, out)
      );
      const verdict = classifyProbe(samples);
      void vscode.window.showInformationMessage(
        `Webview cost: ${verdict.verdict} — first ${verdict.first.toFixed(0)}ms, ` +
          `rest ~${verdict.restMedian.toFixed(0)}ms. See "SNL Trace" output.`
      );
    }
  );
}
