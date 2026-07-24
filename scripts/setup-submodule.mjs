#!/usr/bin/env node
// Ensures the SNL-Basics submodule is initialized and built so
// `@sjtu-ai4math/snl-basics` resolves. Run after `git clone` on any new machine.

import { execSync } from 'node:child_process'
import { existsSync } from 'node:fs'
import { resolve, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const submodulePath = resolve(repoRoot, 'external/SNL-Basics')
const distLibPath = resolve(submodulePath, 'dist-lib/index.js')

function run(cmd, cwd = repoRoot) {
  console.log(`\n> ${cmd}  (in ${cwd})`)
  execSync(cmd, { cwd, stdio: 'inherit' })
}

// 1. Ensure submodule content is present (idempotent).
if (!existsSync(resolve(submodulePath, 'package.json'))) {
  console.log('SNL-Basics submodule empty — initializing…')
  run('git submodule update --init --recursive')
}

// 2. Ensure submodule deps installed.
if (!existsSync(resolve(submodulePath, 'node_modules'))) {
  console.log('SNL-Basics node_modules missing — installing…')
  run('npm install', submodulePath)
}

// 3. Ensure dist-lib built (this is what the file: dep consumes).
if (!existsSync(distLibPath)) {
  console.log('SNL-Basics dist-lib missing — building…')
  run('npm run build:lib', submodulePath)
} else {
  console.log('SNL-Basics dist-lib present — skipping build. Run `npm run rebuild-snl` to force rebuild.')
}

console.log('\n✓ SNL-Basics submodule ready.')
