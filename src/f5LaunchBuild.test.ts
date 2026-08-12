import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

describe('F5 Extension Development Host build contract', () => {
  it('synchronizes dependencies and runs the explicit full build before launching', () => {
    const launch = JSON.parse(readFileSync('.vscode/launch.json', 'utf8')) as {
      configurations?: Array<{ name?: string; preLaunchTask?: string }>;
    };
    const runExtension = launch.configurations?.find((item) => item.name === 'Run Extension');
    expect(runExtension?.preLaunchTask).toBe('build');

    const tasks = JSON.parse(readFileSync('.vscode/tasks.json', 'utf8')) as {
      tasks?: Array<{ label?: string; dependsOn?: string[]; dependsOrder?: string }>;
    };
    const build = tasks.tasks?.find((item) => item.label === 'build');
    expect(build?.dependsOrder).toBe('sequence');
    expect(build?.dependsOn).toEqual([
      'sync:dependencies',
      'compile',
      'build:export-runtime',
      'build:webview'
    ]);

    const packageJson = JSON.parse(readFileSync('package.json', 'utf8')) as {
      scripts?: Record<string, string>;
    };
    expect(packageJson.scripts?.['sync:dependencies']).toBe(
      'npm install --include=dev --no-audit --no-fund'
    );
    expect(packageJson.scripts?.bootstrap).toBe('node scripts/bootstrap.mjs');
  });
});
