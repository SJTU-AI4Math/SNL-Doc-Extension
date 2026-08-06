import * as vscode from 'vscode';
import { createHostTranslator, defineHostMessages } from './hostI18n';
import { read_extension_preferences } from './preferences';

export const UI_MESSAGES = defineHostMessages(
  {
    pickCount: 'How many empty webviews to time?', probeTitle: 'SNL probe {index}', timing: 'Timing {count} empty webviews…',
    result: 'Webview cost: {verdict} — first {first}ms, rest ~{rest}ms. See "SNL Trace" output.',
    needSamples: 'Need at least 2 samples; re-run with a higher count.',
    perWindowAdvice: 'Cost is a ONE-TIME per-window webview host boot. Fix = PREWARM: create a hidden throwaway webview during activation so the first panel the user opens is never the one that pays. Pooling would be wasted effort here.',
    perPanelAdvice: 'Cost is charged PER PANEL. Prewarming one hidden webview will not help. Fix = POOLING: keep panels alive (hide instead of dispose) and retarget them, the way the Entry editor singleton already does.',
    inconclusiveAdvice: 'Partial decay — neither a clean one-time boot nor a flat per-panel cost. Re-run with a higher count on an idle machine before choosing a fix.',
    reportHeader: '─── Webview cost probe: {count} empty panels @ {timestamp}',
    reportScope: '    (no bundle, no CSS, no data reads — pure createWebviewPanel cost)',
    reportPanel: '    panel #{index}: {ms}ms',
    reportStats: '    first={first}ms restMedian={rest}ms ratio={ratio}',
    reportVerdict: '    VERDICT: {verdict}'
  },
  {
    pickCount: '要测量多少个空 Webview？', probeTitle: 'SNL 探针 {index}', timing: '正在测量 {count} 个空 Webview…',
    result: 'Webview 开销：{verdict}；首个 {first}ms，其余约 {rest}ms。详情见“SNL Trace”输出。',
    needSamples: '至少需要 2 个样本；请提高数量后重新运行。',
    perWindowAdvice: '开销来自每个窗口仅一次的 Webview Host 启动。修复方案 = 预热：在激活期间创建一个隐藏的临时 Webview，让用户打开的第一个面板无需承担启动开销；此时做面板池没有意义。',
    perPanelAdvice: '每个面板都会产生开销。预热一个隐藏 Webview 无法解决；修复方案 = 面板池：保持面板存活（隐藏而非销毁）并重新定向，类似条目编辑器单例。',
    inconclusiveAdvice: '开销只部分下降，既不是干净的一次性启动，也不是恒定的逐面板开销。请在机器空闲时提高数量后重跑，再选择修复方案。',
    reportHeader: '─── Webview 开销探针：{count} 个空面板 @ {timestamp}',
    reportScope: '    （无 bundle、无 CSS、无数据读取，仅测量 createWebviewPanel 开销）',
    reportPanel: '    面板 #{index}：{ms}ms',
    reportStats: '    首个={first}ms 其余中位数={rest}ms 比率={ratio}',
    reportVerdict: '    结论：{verdict}'
  }
);
const hostText = () => createHostTranslator(read_extension_preferences().language, UI_MESSAGES);
const englishText = createHostTranslator('en', UI_MESSAGES);

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
export function classifyProbe(
  samples: readonly ProbeSample[],
  t = englishText
): {
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
      advice: t('needSamples')
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
      advice: t('perWindowAdvice')
    };
  }
  if (decayRatio >= 0.7) {
    return {
      verdict: 'per-panel',
      first,
      restMedian,
      decayRatio,
      advice: t('perPanelAdvice')
    };
  }
  return {
    verdict: 'inconclusive',
    first,
    restMedian,
    decayRatio,
    advice: t('inconclusiveAdvice')
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
async function timeOneWebview(index: number, title: string): Promise<ProbeSample> {
  const started = Date.now();
  const panel = vscode.window.createWebviewPanel(
    'snlDoc.webviewCostProbe',
    title,
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
  out: vscode.OutputChannel,
  panelTitle: (index: number) => string
): Promise<ProbeSample[]> {
  const samples: ProbeSample[] = [];
  out.show(true);
  const t = hostText();
  out.appendLine(t('reportHeader', { count, timestamp: new Date().toISOString() }));
  out.appendLine(t('reportScope'));
  for (let i = 1; i <= count; i++) {
    const sample = await timeOneWebview(i, panelTitle(i));
    samples.push(sample);
    out.appendLine(t('reportPanel', { index: i, ms: sample.ms.toFixed(0) }));
  }
  const verdict = classifyProbe(samples, t);
  out.appendLine(t('reportStats', {
    first: verdict.first.toFixed(0),
    rest: verdict.restMedian.toFixed(0),
    ratio: verdict.decayRatio.toFixed(2)
  }));
  out.appendLine(t('reportVerdict', { verdict: verdict.verdict }));
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
      const t = createHostTranslator(read_extension_preferences().language, UI_MESSAGES);
      const picked = await vscode.window.showQuickPick(
        ['3', '5', '8'],
        { title: t('pickCount'), placeHolder: '5' }
      );
      if (!picked) return;
      const count = Number.parseInt(picked, 10);
      const samples = await vscode.window.withProgress(
        {
          location: vscode.ProgressLocation.Notification,
          title: t('timing', { count })
        },
        () => runWebviewCostProbe(count, out, (index) => t('probeTitle', { index }))
      );
      const verdict = classifyProbe(samples, t);
      void vscode.window.showInformationMessage(
        t('result', {
          verdict: verdict.verdict,
          first: verdict.first.toFixed(0),
          rest: verdict.restMedian.toFixed(0)
        })
      );
    }
  );
}
