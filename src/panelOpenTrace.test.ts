/**
 * Run the Entry panel's context-read path against a synthetic workspace and
 * print the timing breakdown, so we can SEE where panel-open time goes
 * instead of arguing about it. Cat 2026-07-25.
 *
 *   npx vitest run src/panelOpenTrace.bench.ts --environment node
 *
 * This is a measurement harness, not a pass/fail gate: it asserts only that
 * the trace produced a timeline. Read the printed table.
 */
import { describe, expect, it, vi } from 'vitest';

const PACKAGES = 12;
const MACROS_PER_PACKAGE = 60;
const ENTRIES = 400;
/** Simulated per-file latency. Real disk/FS-provider reads are not free. */
const READ_LATENCY_MS = 2;

let readCount = 0;
const traceLines: string[] = [];

vi.mock('vscode', () => {
  const FILE = 1;
  const encoder = new TextEncoder();

  const macroPackage = (bare: string): string =>
    JSON.stringify({
      name: bare,
      macros: Array.from({ length: MACROS_PER_PACKAGE }, (_, i) => ({
        name: `${bare}.m${i}`,
        kind: 'term',
        tags: ['algebra'],
        source: { entries: [], urls: [] },
        styles: [{ style_name: 'default', mode: 'formula_inline', template: '#0', tags: [] }]
      }))
    });

  const entriesJson = JSON.stringify(
    Array.from({ length: ENTRIES }, (_, i) => ({
      id: `entry-${i}`,
      title: `Entry ${i}`,
      kind: 'theorem',
      content: { snl: 'f(a,b)' }
    }))
  );

  const config = JSON.stringify({
    version: '0.0.4',
    active_macro_packages: Array.from({ length: PACKAGES }, (_, i) => `pkg${i}`),
    entry_kinds: [{ id: 'theorem', name: 'Theorem' }],
    macro_kinds: [{ id: 'term', name: 'Term' }]
  });

  return {
    Uri: {
      joinPath: (base: { path: string }, ...parts: string[]) => ({
        path: [base.path, ...parts].join('/'),
        fsPath: [base.path, ...parts].join('/')
      })
    },
    FileType: { File: FILE, Directory: 2 },
    window: {
      createOutputChannel: () => ({
        appendLine: (line: string) => { traceLines.push(line); },
        show: () => undefined
      })
    },
    workspace: {
      workspaceFolders: [{ uri: { path: '/ws', fsPath: '/ws' } }],
      getConfiguration: () => ({ get: () => true }),
      fs: {
        readDirectory: async () =>
          Array.from(
            { length: PACKAGES },
            (_, i) => [`pkg${i}.json`, FILE] as [string, number]
          ),
        stat: async () => ({ type: FILE }),
        readFile: async (uri: { path: string }) => {
          readCount += 1;
          await new Promise((resolve) => setTimeout(resolve, READ_LATENCY_MS));
          const name = uri.path.split('/').pop() ?? '';
          if (name === 'config.json') return encoder.encode(config);
          if (name === 'entries.json') return encoder.encode(entriesJson);
          return encoder.encode(macroPackage(name.replace(/\.json$/, '')));
        }
      }
    }
  };
});

describe('entry panel open cost', () => {
  it('prints where the time goes', async () => {
    const { startTrace, setTraceEnabled } = await import('./trace');
    const {
      listEntryKinds,
      readAllMacrosWithOrigin,
      readMacroKinds,
      readEntries
    } = await import('./snlDoc');
    setTraceEnabled(true);
    traceLines.length = 0;
    readCount = 0;

    const root = { path: '/ws', fsPath: '/ws' } as never;
    const trace = startTrace('entryPanel:open', 'mode=edit id=thm-1');

    const timed = <T>(name: string, work: Promise<T>): Promise<T> =>
      work.then((value) => {
        trace.mark(`read:${name}`);
        return value;
      });

    const [kinds, bundle, macroKinds, entries] = await Promise.all([
      timed('entryKinds', listEntryKinds(root)),
      timed('macros', readAllMacrosWithOrigin(root)),
      timed('macroKinds', readMacroKinds(root)),
      timed('entries', readEntries(root))
    ]);
    trace.mark(
      'read:done',
      `macros=${Object.keys(bundle.macros).length} entries=${entries.length} ` +
        `kinds=${kinds.length} macroKinds=${macroKinds.length}`
    );

    const payload = JSON.stringify({
      kinds,
      macros: bundle.macros,
      macroKinds,
      macroOrigin: bundle.origin,
      existingIds: entries.map((e) => ({ id: e.id, title: e.title }))
    });
    trace.mark('context-serialized', `payload=${(payload.length / 1024).toFixed(1)}KB`);

    // eslint-disable-next-line no-console
    console.log(
      `\n=== Entry panel context read: ${PACKAGES} packages × ` +
        `${MACROS_PER_PACKAGE} macros, ${ENTRIES} entries, ` +
        `${READ_LATENCY_MS}ms/read ===\n` +
        traceLines.join('\n') +
        `\n--- total file reads: ${readCount} ---\n`
    );

    expect(traceLines.length).toBeGreaterThan(3);
    setTraceEnabled(false);
  });
});
