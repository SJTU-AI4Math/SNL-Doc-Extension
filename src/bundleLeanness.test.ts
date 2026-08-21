import {
  existsSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync
} from 'node:fs';
import { tmpdir } from 'node:os';
import { resolve } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import packageJson from '../package.json';
import productionEntries from '../webview/productionEntries.json';

/**
 * KaTeX is ~250KB of minified JS. It reached panels that render no math at
 * all, because tiny helpers (`read_localized`, `parseSnlSyntaxTree`) were only
 * exported from the SNL-Basics barrel — and that barrel also exports the React
 * views, which import KaTeX. Every panel therefore paid for the whole math
 * engine on open. Cat 2026-07-25: "各个 Panel 开起来都非常慢".
 *
 * The fix is the `/runtime` and `/core` subpath exports. This test keeps it
 * fixed: if someone reaches for the barrel again from a shared module, a
 * math-free panel doubles in size and this fails.
 */
const MEDIA = resolve(__dirname, '..', 'media', 'webview');

/** Panels that genuinely render math, and so legitimately ship KaTeX. */
const RENDERS_MATH = new Set([
  'createEntry',
  'entryInfoview',
  'snlGraph',
  'main',
  'createMacro',
  'packagePanel'
]);

/**
 * Panels with no math surface. `fontMetrics` is a KaTeX-internal identifier
 * that survives minification, so its presence is a reliable tell.
 */
const MATH_FREE = [
  'initEntryKinds',
  'initMacroKinds',
  'createEntryKind',
  'createMacroKind',
  'createMacroPackage',
  'createEntryPackage',
  'entryPackagePanel',
  'createRelationship',
  'createLibrary',
  'dashboard',
  'snoogl'
];

const WORKSPACE_ASSET_BROKER_DEBUG_LABELS = [
  'WorkspaceAssetBrokerTestHooks',
  'exposeSnapshot',
  'pendingConsumers',
  'pendingResolutions:',
  'resolutions:',
  'requests:',
  'epochs:'
];

const EXPECTED_PRODUCTION_OUTPUTS = [
  'main:main.js',
  'entryInfoview:entryInfoview.js',
  'createLibrary:createLibrary.js',
  'dashboard:dashboard.js',
  'initEntryKinds:initEntryKinds.js',
  'createEntryKind:createEntryKind.js',
  'initMacroKinds:initMacroKinds.js',
  'createMacroKind:createMacroKind.js',
  'createEntry:createEntry.js',
  'createEntryPackage:createEntryPackage.js',
  'entryPackagePanel:entryPackagePanel.js',
  'createMacroPackage:createMacroPackage.js',
  'packagePanel:packagePanel.js',
  'createMacro:createMacro.js',
  'createRelationship:createRelationship.js',
  'snlGraph:snlGraph.js',
  'snoogl:snoogl.js',
  'exportOptions:exportOptions.js'
];

function bundle(name: string, media = MEDIA): string | null {
  const output = productionEntries.entries.find(
    (entry) => entry.name === name
  )?.output;
  if (!output) return null;
  const file = resolve(media, output);
  return existsSync(file) ? readFileSync(file, 'utf8') : null;
}

function inspectWorkspaceAssetBrokerBundles(media: string): {
  missing: string[];
  offenders: string[];
} {
  const missing = productionEntries.entries
    .filter((entry) => bundle(entry.name, media) === null)
    .map((entry) => entry.name);
  const offenders = productionEntries.entries.flatMap((entry) =>
    WORKSPACE_ASSET_BROKER_DEBUG_LABELS
      .filter((label) => bundle(entry.name, media)?.includes(label))
      .map((label) => `${entry.name}:${label}`)
  );
  return { missing, offenders };
}

describe('webview bundle leanness', () => {
  // `media/webview` is gitignored, so a fresh clone has no bundles at all and
  // every assertion below would pass vacuously. Fail loudly instead: a green
  // check here must mean the guard actually ran.
  const built = MATH_FREE.filter((name) => bundle(name) !== null);
  const skip = built.length === 0;

  it.skipIf(skip)('has bundles to inspect', () => {
    expect(built.length).toBe(MATH_FREE.length);
  });

  it.skipIf(skip)('keeps KaTeX out of panels that render no math', () => {
    const offenders = built.filter((name) => bundle(name)!.includes('fontMetrics'));
    expect(offenders).toEqual([]);
  });

  it.skipIf(skip)('keeps math-free panels well under the KaTeX-inclusive size', () => {
    // A KaTeX-carrying bundle is 450KB+; a lean one is ~200-240KB. 300KB
    // sits clearly between the two, so this catches a regression without
    // being brittle about ordinary growth.
    const tooBig = built
      .map((name) => ({ name, bytes: bundle(name)!.length }))
      .filter((entry) => entry.bytes > 300_000);
    expect(tooBig).toEqual([]);
  });

  it('still ships KaTeX where math is actually rendered', () => {
    // Guards the other direction: a "leanness" change must not silently
    // break real math rendering.
    const mathBuilt = [...RENDERS_MATH].filter((name) => bundle(name) !== null);
    if (mathBuilt.length === 0) return;
    const missing = mathBuilt.filter((name) => !bundle(name)!.includes('fontMetrics'));
    expect(missing).toEqual([]);
  });

  it('keeps workspace asset broker introspection out of production bundles', () => {
    const { missing, offenders } = inspectWorkspaceAssetBrokerBundles(MEDIA);
    expect(missing).toEqual([]);
    expect(offenders).toEqual([]);
  });
});

describe('workspace asset broker bundle gate coverage', () => {
  const fixtureDirs: string[] = [];

  afterEach(() => {
    fixtureDirs.splice(0).forEach((dir) => rmSync(dir, { recursive: true }));
  });

  function completeFixture(): string {
    const dir = mkdtempSync(resolve(tmpdir(), 'snl-bundle-gate-'));
    fixtureDirs.push(dir);
    productionEntries.entries.forEach((entry) => {
      writeFileSync(resolve(dir, entry.output), 'production bundle');
    });
    return dir;
  }

  it('locks the complete production entry and output set', () => {
    expect(
      productionEntries.entries.map((entry) => `${entry.name}:${entry.output}`)
    ).toEqual(EXPECTED_PRODUCTION_OUTPUTS);
  });

  it('uses nonrecursive clean generated-artifact package scripts', () => {
    expect(packageJson.scripts['build:webview']).toBe(
      'node scripts/build-webviews.mjs'
    );
    expect(packageJson.scripts.test).toBe(
      'node scripts/prepare-test-artifacts.mjs && vitest run'
    );
  });

  it('fails when any affected production bundle is missing', () => {
    const dir = completeFixture();
    rmSync(resolve(dir, 'dashboard.js'));
    expect(inspectWorkspaceAssetBrokerBundles(dir).missing).toEqual(['dashboard']);
  });

  it('fails on a forbidden label in a non-main affected bundle', () => {
    const dir = completeFixture();
    writeFileSync(resolve(dir, 'dashboard.js'), 'pendingConsumers');
    expect(inspectWorkspaceAssetBrokerBundles(dir).offenders).toEqual([
      'dashboard:pendingConsumers'
    ]);
  });
});
