#!/usr/bin/env node
// Rebuilds the SNL-Basics submodule's `dist-lib/` when it's missing or stale.
//
// Why this exists: `@sjtu-ai4math/snl-basics` is consumed as a `file:` dependency
// pointing at `external/SNL-Basics`. The artifact actually loaded is
// `external/SNL-Basics/dist-lib/index.js`, a BUILD ARTIFACT produced by the
// submodule's own `npm run build:lib` and `.gitignore`'d there. Pulling a new
// submodule pointer (`git submodule update`) does NOT rebuild it, and VS Code's
// F5 doesn't recurse into the submodule — so the webview can silently load a
// STALE library. This script closes that gap: it runs on `postinstall`, before
// `build:webview`, and before `compile`, and can be forced via `npm run
// snl:rebuild`.
//
// Cross-platform: uses child_process.spawnSync with shell:false and Node's
// `path`, and resolves the platform-specific npm binary. Works on Windows.

import { spawnSync } from 'node:child_process'
import { existsSync, statSync, readdirSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const submoduleDir = join(repoRoot, 'external', 'SNL-Basics')
const distLibIndex = join(submoduleDir, 'dist-lib', 'index.js')
const srcDir = join(submoduleDir, 'src')
const viteMarker = join(submoduleDir, 'node_modules', 'vite', 'package.json')

const npmBin = process.platform === 'win32' ? 'npm.cmd' : 'npm'
const force = process.argv.includes('--force')

/** Newest mtime (ms) among all files under `dir`, recursively. 0 if absent. */
function newestMtime(dir) {
  if (!existsSync(dir)) {
    return 0
  }
  let newest = 0
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const full = join(dir, entry.name)
    if (entry.isDirectory()) {
      newest = Math.max(newest, newestMtime(full))
    } else {
      newest = Math.max(newest, statSync(full).mtimeMs)
    }
  }
  return newest
}

function run(args) {
  console.log(`[snl-rebuild] > ${npmBin} ${args.join(' ')}  (in ${submoduleDir})`)
  // Windows note: Node ≥ 18.20.4 / 20.15.1 (CVE-2024-27980) refuses to spawn
  // `.bat`/`.cmd` files with `shell: false` and returns EINVAL. On Windows we
  // must use `shell: true` — safe here because `args` is a fixed compile-time
  // whitelist (`['ci']` / `['run', 'build:lib']`), no user input to inject.
  const res = spawnSync(npmBin, args, {
    cwd: submoduleDir,
    stdio: 'inherit',
    shell: process.platform === 'win32',
  })
  if (res.error) {
    console.error(`[snl-rebuild] failed to spawn npm: ${res.error.message}`)
    process.exit(1)
  }
  if (typeof res.status === 'number' && res.status !== 0) {
    console.error(`[snl-rebuild] "${npmBin} ${args.join(' ')}" exited with ${res.status}`)
    process.exit(res.status)
  }
}

function main() {
  if (!existsSync(join(submoduleDir, 'package.json'))) {
    console.error(
      `[snl-rebuild] submodule not found at ${submoduleDir}. Run "git submodule update --init --recursive" first.`,
    )
    process.exit(1)
  }

  if (!force) {
    // Every published entry point must be present, not just index.js: a tree
    // whose dist-lib predates the /core and /runtime subpaths would look
    // "up to date" by mtime and then fail vite resolution with ENOENT.
    const distExists = [distLibIndex, 'core.js', 'runtime.js'].every((file, index) =>
      existsSync(index === 0 ? file : join(submoduleDir, 'dist-lib', file)),
    )
    const distMtime = distExists ? statSync(distLibIndex).mtimeMs : 0
    const srcMtime = newestMtime(srcDir)
    if (distExists && distMtime >= srcMtime) {
      console.log('[snl-rebuild] SNL-Basics already up to date — skipping build.')
      return
    }
    console.log(
      distExists
        ? '[snl-rebuild] SNL-Basics dist-lib is stale (src newer) — rebuilding…'
        : '[snl-rebuild] SNL-Basics dist-lib missing — rebuilding…',
    )
  } else {
    console.log('[snl-rebuild] --force: rebuilding SNL-Basics regardless of freshness…')
  }

  if (!existsSync(viteMarker)) {
    console.log('[snl-rebuild] submodule deps missing (no vite) — running npm ci…')
    run(['ci'])
  }

  run(['run', 'build:lib'])
  console.log('[snl-rebuild] SNL-Basics rebuilt.')
}

main()
