// Guards that the export runtime is actually BUILT by the flows a developer
// runs, not merely buildable.
//
// 猫猫 2026-07-30: "不行，所有交互全丢". The cause was not hover and not collapse;
// it was that `media/exportRuntime.js` did not exist. It is a gitignored build
// product, so a fresh clone has none, and `build:export-runtime` was wired only
// into `vscode:prepublish` — which F5 never runs. exportOptionsPanel then takes
// its catch branch and exports a strictly static document, losing hover AND
// collapse together.
//
// Every other test in this repo reads the generated file, so all of them pass
// on a machine where it happens to be lying around from an earlier manual run
// (which is exactly how this shipped). None of them can observe the file's
// ABSENCE. These assertions look at the build wiring itself instead.

import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

const root = resolve(__dirname, '..');
const read = (p: string) => readFileSync(resolve(root, p), 'utf8');

describe('the export runtime is wired into the dev build', () => {
  it('is a step in bootstrap.mjs, which backs the F5 default build task', () => {
    expect(read('scripts/bootstrap.mjs')).toContain("'build:export-runtime'");
  });

  it('is a dependency of the default build task, before the webview build', () => {
    const tasks = JSON.parse(read('.vscode/tasks.json')) as {
      tasks: { label: string; dependsOn?: string[]; group?: unknown }[];
    };

    const build = tasks.tasks.find((t) => t.label === 'build');
    expect(build?.dependsOn).toContain('build:export-runtime');

    // A `dependsOrder: sequence` task list runs in order; the runtime must be
    // present before anything that might read it.
    const order = build?.dependsOn ?? [];
    expect(order.indexOf('build:export-runtime')).toBeLessThan(
      order.indexOf('build:webview')
    );

    // dependsOn entries resolve by label, so the task itself has to exist.
    expect(tasks.tasks.some((t) => t.label === 'build:export-runtime')).toBe(true);
  });

  it('is still a step in vscode:prepublish, so a packaged .vsix carries it', () => {
    const pkg = JSON.parse(read('package.json')) as {
      scripts: Record<string, string>;
    };
    expect(pkg.scripts['vscode:prepublish']).toContain('build:export-runtime');
  });

  it('ships the generated file in the .vsix (it is gitignored, not packaged-ignored)', () => {
    // media/** must NOT be excluded, or a published extension repeats the bug
    // for every user instead of just for developers.
    const ignored = read('.vscodeignore')
      .split(/\r?\n/)
      .map((l) => l.trim())
      .filter(Boolean);
    expect(ignored.some((l) => l.startsWith('media'))).toBe(false);
  });
});
