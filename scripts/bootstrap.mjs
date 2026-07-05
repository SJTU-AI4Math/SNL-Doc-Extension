#!/usr/bin/env node
// One-key bootstrap: turn a fresh clone into a runnable dev environment with
// zero extra commands. Wired to VS Code's F5 via the default build task (see
// .vscode/tasks.json → .vscode/launch.json's ${defaultBuildTask}).
//
// Each step is idempotent — it checks its own staleness and skips work when the
// tree is already up to date, so re-running on a clean checkout is fast.
//
// Sequence:
//   1. Submodule init (if external/SNL-Basics is empty).
//   2. npm install (if node_modules missing or package-lock.json is newer).
//   3. SNL-Basics rebuild (idempotent staleness check inside the script).
//   4. Compile (rebuild-snl + tsc).
//   5. Webview build (rebuild-snl + all vite entries).
//
// Cross-platform: spawnSync with the platform npm binary, shell:true only on
// Windows (matches scripts/rebuild-snl-basics.mjs).

import { spawnSync } from 'node:child_process'
import { existsSync, statSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const npmBin = process.platform === 'win32' ? 'npm.cmd' : 'npm'

if (Number(process.versions.node.split('.')[0]) < 20) {
  console.error(
    `[bootstrap] Node ${process.versions.node} is too old — this project needs Node >= 20.`,
  )
  process.exit(1)
}

/** Run a command, inheriting stdio for live logs. Exits 1 with `label` on failure. */
function run(cmd, args, cwd, label) {
  console.log(`[bootstrap] > ${cmd} ${args.join(' ')}  (in ${cwd})`)
  const res = spawnSync(cmd, args, {
    cwd,
    stdio: 'inherit',
    shell: process.platform === 'win32',
  })
  if (res.error) {
    console.error(`[bootstrap] failed to spawn ${cmd}: ${res.error.message}`)
    process.exit(1)
  }
  if (typeof res.status === 'number' && res.status !== 0) {
    console.error(`[bootstrap] ${label}`)
    process.exit(1)
  }
}

function mtimeOrZero(path) {
  return existsSync(path) ? statSync(path).mtimeMs : 0
}

function main() {
  // 1. Submodule check.
  const submodulePkg = join(repoRoot, 'external', 'SNL-Basics', 'package.json')
  if (!existsSync(submodulePkg)) {
    console.log('[bootstrap] SNL-Basics submodule empty — initializing…')
    run('git', ['submodule', 'update', '--init', '--recursive'], repoRoot,
      'git submodule init failed. See errors above.')
  } else {
    console.log('[bootstrap] SNL-Basics submodule present — skipping init.')
  }

  // 2. Top-level npm install (if node_modules missing or lockfile is newer).
  const nodeModules = join(repoRoot, 'node_modules')
  const installMarker = join(nodeModules, '.package-lock.json')
  const lockfile = join(repoRoot, 'package-lock.json')
  const needsInstall =
    !existsSync(nodeModules) || mtimeOrZero(installMarker) < mtimeOrZero(lockfile)
  if (needsInstall) {
    console.log('[bootstrap] Installing npm dependencies…')
    run(npmBin, ['install'], repoRoot,
      'npm install failed. See errors above.')
  } else {
    console.log('[bootstrap] npm dependencies up to date — skipping install.')
  }

  // 3. SNL-Basics freshness (script has its own staleness check → fast no-op).
  console.log('[bootstrap] Ensuring SNL-Basics dist-lib is fresh…')
  run('node', ['scripts/rebuild-snl-basics.mjs'], repoRoot,
    'SNL-Basics rebuild failed. See errors above.')

  // 4. Compile (rebuild-snl + tsc).
  console.log('[bootstrap] Compiling extension host (tsc)…')
  run(npmBin, ['run', 'compile'], repoRoot,
    'TypeScript compile failed. See errors above.')

  // 5. Webview build (rebuild-snl + all vite entries).
  console.log('[bootstrap] Building webview bundles…')
  run(npmBin, ['run', 'build:webview'], repoRoot,
    'Webview build failed. See errors above.')

  console.log('[bootstrap] ✓ Environment ready. Press F5 to launch the extension.')
}

main()
