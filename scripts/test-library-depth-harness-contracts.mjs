#!/usr/bin/env node
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { existsSync, mkdtempSync, mkdirSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path, { resolve } from 'node:path';
import {
  createDirectoryLink,
  fileCensus,
  isPathInside,
  parseTerminalResults,
  requireExternalPath,
  restoreFiles,
  sameFileCensus,
  snapshotFiles,
  spawnTracked,
  terminateProcessTree,
  validateProbeResult
} from './library-depth-harness-utils.mjs';

const temp = mkdtempSync(resolve(tmpdir(), 'snl-depth-contracts-'));
try {
  assert.equal(isPathInside('/repo', '/repo'), true);
  assert.equal(isPathInside('/repo', '/repo/evidence/result.json'), true);
  assert.equal(isPathInside('/repo', '/repo-other/result.json'), false);
  assert.equal(isPathInside('C:\\Repo', 'c:/repo/evidence/result.json', path.win32), true);
  assert.equal(isPathInside('C:\\Repo', 'D:\\Repo\\evidence.json', path.win32), false);
  assert.equal(isPathInside('C:\\Repo', 'C:\\Repository\\evidence.json', path.win32), false);
  assert.equal(isPathInside('C:/Repo', 'c:\\repo\\child\\evidence.json', path.win32), true);

  assert.deepEqual(parseTerminalResults('{"kind":"pass"}\n'), [{ kind: 'pass' }]);
  assert.equal(validateProbeResult('{"kind":"pass"}\n', { kind: 'pass' }).ok, true);
  assert.equal(validateProbeResult('{"kind":"pass","extra":true}\n', { kind: 'pass' }).ok, false);
  assert.equal(validateProbeResult('[ASSERT:A] expected\n{"kind":"assertion","id":"A"}\n', { kind: 'assertion', id: 'A' }).ok, true);
  assert.equal(validateProbeResult('[ASSERT:A]\n{"kind":"assertion","id":"A"}\n{"kind":"infra","id":"CLEANUP"}\n', { kind: 'assertion', id: 'A' }).ok, false);
  assert.equal(validateProbeResult('[ASSERT:A]\n[ASSERT:OTHER]\n{"kind":"assertion","id":"A"}\n', { kind: 'assertion', id: 'A' }).ok, false);
  assert.equal(validateProbeResult('[ASSERT:OTHER]\n{"kind":"assertion","id":"OTHER"}\n', { kind: 'assertion', id: 'A' }).ok, false);
  assert.equal(validateProbeResult('{kind:bad}\n{"kind":"assertion","id":"A"}\n', { kind: 'assertion', id: 'A' }).ok, false);
  assert.equal(validateProbeResult('', { kind: 'pass' }).ok, false);

  const repository = resolve(temp, 'repository');
  const external = resolve(temp, 'external');
  mkdirSync(resolve(repository, 'evidence'), { recursive: true });
  mkdirSync(external);
  const repositoryAlias = resolve(temp, 'repository-alias');
  createDirectoryLink(repository, repositoryAlias, process.platform);
  assert.throws(() => requireExternalPath(repository, resolve(repositoryAlias, 'evidence/result.json'), 'CONTAINMENT'), /ASSERT:CONTAINMENT/);
  assert.equal(requireExternalPath(repository, resolve(external, 'result.json'), 'CONTAINMENT'), resolve(external, 'result.json'));

  const artifacts = [resolve(temp, 'media/createLibrary.js'), resolve(temp, 'media/createLibrary.css')];
  mkdirSync(resolve(temp, 'media'), { recursive: true });
  writeFileSync(artifacts[0], 'original-js');
  const fixed = new Date('2020-01-02T03:04:05.000Z');
  await import('node:fs').then(({ utimesSync }) => utimesSync(artifacts[0], fixed, fixed));
  const before = fileCensus(artifacts);
  for (const shouldThrow of [false, true]) {
    const snapshot = snapshotFiles(artifacts);
    try {
      writeFileSync(artifacts[0], 'mutated-js');
      writeFileSync(artifacts[1], 'new-css');
      if (shouldThrow) throw new Error('forced failure');
    } catch (error) {
      if (!shouldThrow) throw error;
    } finally {
      restoreFiles(snapshot);
    }
    assert.equal(sameFileCensus(before, fileCensus(artifacts)), true, `artifacts restored after shouldThrow=${shouldThrow}`);
    assert.equal(readFileSync(artifacts[0], 'utf8'), 'original-js');
    assert.equal(existsSync(artifacts[1]), false);
    assert.equal(statSync(artifacts[0]).mtimeMs, fixed.getTime());
  }

  const target = resolve(temp, 'target');
  mkdirSync(target);
  const posixLink = resolve(temp, 'posix-link');
  const posix = createDirectoryLink(target, posixLink, 'linux');
  assert.deepEqual(posix, { type: 'dir-symlink', target });
  rmSync(posixLink);
  const calls = [];
  const originalSymlink = await import('node:fs');
  // The helper source is also checked statically so Windows never requests an
  // unprivileged directory symlink and always supplies an absolute target.
  const helperSource = readFileSync(new URL('./library-depth-harness-utils.mjs', import.meta.url), 'utf8');
  assert.match(helperSource, /symlinkSync\(absoluteTarget, link, 'junction'\)/);
  assert.match(helperSource, /const absoluteTarget = path\.resolve\(target\)/);
  void calls; void originalSymlink;

  if (process.platform !== 'win32') {
    const marker = resolve(temp, 'grandchild-alive');
    const child = spawnTracked(process.execPath, ['-e', `const {spawn}=require('child_process');spawn(process.execPath,['-e',${JSON.stringify(`setTimeout(()=>require('fs').writeFileSync(${JSON.stringify(marker)},'alive'),3000)`)}],{stdio:'ignore'});setInterval(()=>{},1000)`], { stdio: 'ignore' });
    await new Promise((resolveWait) => setTimeout(resolveWait, 150));
    await terminateProcessTree(child);
    await new Promise((resolveWait) => setTimeout(resolveWait, 3200));
    assert.equal(existsSync(marker), false, 'descendant process was killed with its detached group');
  }

  console.log(JSON.stringify({ kind: 'pass' }));
} finally {
  rmSync(temp, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
}
