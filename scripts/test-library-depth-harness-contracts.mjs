#!/usr/bin/env node
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { appendFileSync, existsSync, mkdtempSync, mkdirSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path, { resolve } from 'node:path';
import {
  cleanupOwnedProcessRegistry,
  createOwnedProcessRegistry,
  createDirectoryLink,
  destroyOwnedProcessRegistry,
  fileCensus,
  isPathInside,
  parseTerminalResults,
  parseMacProcessTable,
  processTreePolicy,
  requireExternalPath,
  restoreFiles,
  sameFileCensus,
  snapshotFiles,
  spawnProcessGroup,
  spawnTracked,
  terminateProcessTree,
  verifyOwnedProcessRegistryClean,
  validateProbeResult,
  windowsCommandLineHasExactArgument,
  windowsJobLauncherCommand,
  windowsTaskkillCommand
} from './library-depth-harness-utils.mjs';

const temp = mkdtempSync(resolve(tmpdir(), 'snl-depth-contracts-'));
const isProcessAlive = async pid => {
  if (process.platform === 'linux') return existsSync(`/proc/${pid}`);
  if (process.platform === 'win32') { try { process.kill(pid, 0); return true; } catch { return false; } }
  const probe = spawn('/bin/ps', ['-p', String(pid), '-o', 'stat='], { stdio: ['ignore', 'pipe', 'ignore'] });
  return await new Promise(resolveProbe => { let output = ''; probe.stdout.on('data', chunk => { output += chunk; }); probe.once('exit', code => resolveProbe(Boolean(code === 0 && output.trim() && !output.trim().startsWith('Z')))); });
};
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
  assert.equal(validateProbeResult('[ASSERT:A] expected\n{"kind":"assertion","ids":["A"]}\n', { kind: 'assertion', id: 'A' }).ok, true);
  assert.equal(validateProbeResult('[ASSERT:A]\n{"kind":"assertion","ids":["A"]}\n{"kind":"infra","id":"CLEANUP"}\n', { kind: 'assertion', id: 'A' }).ok, false);
  assert.equal(validateProbeResult('[ASSERT:A]\n[ASSERT:OTHER]\n{"kind":"assertion","ids":["A","OTHER"]}\n', { kind: 'assertion', id: 'A' }).ok, false, 'expected plus extra assertion must be rejected');
  const duplicateAssertion = validateProbeResult('[ASSERT:A] first occurrence\n[ASSERT:A] second occurrence\n{"kind":"assertion","ids":["A","A"]}\n', { kind: 'assertion', id: 'A' });
  assert.deepEqual(duplicateAssertion.assertionIds, ['A', 'A'], 'raw duplicate assertion occurrences must be preserved in order');
  assert.deepEqual(duplicateAssertion.result.ids, ['A', 'A'], 'terminal duplicate assertion occurrences must be preserved in order');
  assert.equal(duplicateAssertion.ok, false, 'duplicate expected assertion must be rejected');
  assert.equal(validateProbeResult('[ASSERT:OTHER]\n{"kind":"assertion","ids":["OTHER"]}\n', { kind: 'assertion', id: 'A' }).ok, false);
  assert.equal(validateProbeResult('{kind:bad}\n{"kind":"assertion","ids":["A"]}\n', { kind: 'assertion', id: 'A' }).ok, false);
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
  const geometrySourceText = readFileSync(new URL('./test-library-depth-row-geometry.mjs', import.meta.url), 'utf8');
  const mutationSourceText = readFileSync(new URL('./test-library-depth-row-mutations.mjs', import.meta.url), 'utf8');
  assert.match(helperSource, /symlinkSync\(absoluteTarget, link, 'junction'\)/);
  assert.match(helperSource, /const absoluteTarget = path\.resolve\(target\)/);
  assert.match(helperSource, /const detached = ownedDetached \?\? defaultDetached/);
  assert.doesNotMatch(geometrySourceText, /terminalFailures|failures\.filter/);
  assert.match(geometrySourceText, /terminalResult=\{kind:'assertion',ids:/);
  assert.match(mutationSourceText, /spawnProcessGroup\(process\.execPath, \[probe\]/);
  assert.deepEqual(processTreePolicy('linux'), { detachedGroupRoot: true, termination: 'process-group' });
  assert.deepEqual(processTreePolicy('darwin'), { detachedGroupRoot: true, termination: 'token-validated-process-group' });
  assert.deepEqual(processTreePolicy('win32'), { detachedGroupRoot: false, termination: 'job-object' });
  assert.match(helperSource, /SNL_PROCESS_OWNER_TOKEN/);
  assert.match(helperSource, /appendFileSync\(context\.registryPath/);
  const windowsHelperPath = resolve(new URL('./windows-job-launcher.ps1', import.meta.url).pathname);
  const windowsHelperSource = readFileSync(windowsHelperPath, 'utf8');
  assert.match(windowsHelperSource, /JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE/);
  assert.match(windowsHelperSource, /CREATE_SUSPENDED/);
  assert.match(windowsHelperSource, /AssignProcessToJobObject/);
  assert.match(windowsHelperSource, /ResumeThread/);
  assert.match(windowsHelperSource, /WaitForMultipleObjects/);
  assert.match(windowsHelperSource, /GetExitCodeProcess/);
  assert.match(windowsHelperSource, /DllImport\("kernel32\.dll", SetLastError=true\)\]\s*static extern bool TerminateProcess\(IntPtr process, uint exitCode\)/, 'pre-assignment cleanup must import TerminateProcess');
  assert.match(windowsHelperSource, /DllImport\("kernel32\.dll", SetLastError=true\)\]\s*static extern uint WaitForSingleObject\(IntPtr handle, uint ms\)/, 'pre-assignment cleanup must import bounded single-process waiting');
  const launcherRun = windowsHelperSource.slice(windowsHelperSource.indexOf('public static int Run('), windowsHelperSource.indexOf("\n}\n'@"));
  const createSucceeded = launcherRun.indexOf('created = true;');
  const assignAttempt = launcherRun.indexOf('AssignProcessToJobObject');
  const assignSucceeded = launcherRun.indexOf('assigned = true;');
  const resumeAttempt = launcherRun.indexOf('ResumeThread');
  const preAssignmentCleanup = launcherRun.indexOf('if (created && !assigned)');
  const closeThread = launcherRun.indexOf('CloseHandle(pi.hThread)', preAssignmentCleanup);
  assert.ok(createSucceeded > launcherRun.indexOf('CreateProcess('), 'creation state may only be set after CreateProcess succeeds');
  assert.ok(assignAttempt > createSucceeded && assignSucceeded > assignAttempt, 'assignment state may only be set after AssignProcessToJobObject succeeds');
  assert.ok(resumeAttempt > assignSucceeded, 'the child must never resume before successful Job assignment');
  assert.ok(preAssignmentCleanup > resumeAttempt, 'pre-assignment cleanup must live in the finalizer');
  assert.match(launcherRun.slice(preAssignmentCleanup, closeThread), /TerminateUnassignedProcess\(pi\.hProcess\)/, 'an unassigned suspended child must be terminated before handles close');
  const unassignedCleanup = windowsHelperSource.slice(windowsHelperSource.indexOf('static void TerminateUnassignedProcess('), windowsHelperSource.indexOf('public static int Run('));
  assert.match(unassignedCleanup, /TerminateProcess\(process,\s*PRE_ASSIGNMENT_EXIT_CODE\)/, 'pre-assignment cleanup must request a nonzero termination code');
  assert.match(unassignedCleanup, /WaitForSingleObject\(process,\s*PRE_ASSIGNMENT_WAIT_MS\)/, 'termination must be bounded and observed before handles close');
  assert.match(unassignedCleanup, /GetExitCodeProcess\(process/, 'termination must verify a process exit code before handles close');
  assert.match(windowsHelperSource, /const uint PRE_ASSIGNMENT_EXIT_CODE = (?!0;)\d+;/, 'pre-assignment termination code must be nonzero');
  assert.doesNotMatch(windowsHelperSource, /Invoke-Expression|Start-Process/);
  assert.match(helperSource, /for \(const record of \[\.\.\.records\]\.reverse\(\)\)/);
  assert.deepEqual(windowsTaskkillCommand(202, 'D:\\Windows'), { command: 'D:\\Windows\\System32\\taskkill.exe', args: ['/PID', '202', '/T', '/F'] }, 'nested Windows PID must have its own absolute taskkill invocation after a dead root');
  const jobOwnerId = 'c'.repeat(24);
  const job = windowsJobLauncherCommand('C:\\Program Files\\nodejs\\node.exe', ['a b', 'x"y'], { parentPid: 42, token: 'a'.repeat(64), ownerId: jobOwnerId }, 'D:\\Windows');
  assert.equal(job.command, 'D:\\Windows\\System32\\WindowsPowerShell\\v1.0\\powershell.exe');
  assert.deepEqual(job.args.slice(0, 4), ['-NoLogo', '-NoProfile', '-NonInteractive', '-File']);
  assert.deepEqual(job.args.slice(-4, -1), ['42', 'a'.repeat(64), jobOwnerId]);
  assert.deepEqual(JSON.parse(Buffer.from(job.args.at(-1), 'base64').toString('utf8')), { executable: 'C:\\Program Files\\nodejs\\node.exe', arguments: ['a b', 'x"y'] });
  const exactProfile = '--user-data-dir=C:\\Temp Dir\\profile';
  assert.equal(windowsCommandLineHasExactArgument('chrome.exe "--user-data-dir=C:\\Temp Dir\\profile" --type=renderer', exactProfile), true);
  assert.equal(windowsCommandLineHasExactArgument('chrome.exe --user-data-dir=C:\\Temp\\profile-other', '--user-data-dir=C:\\Temp\\profile'), false, 'prefix lookalike must not match');
  assert.equal(windowsCommandLineHasExactArgument('chrome.exe prefix--owner-token suffix', '--owner-token'), false, 'substring lookalikes must not match');
  assert.equal(windowsCommandLineHasExactArgument('chrome.exe --Owner-Token', '--owner-token'), false, 'non-path argument identity is case-sensitive');
  assert.equal(windowsCommandLineHasExactArgument('tool.exe "" tail', ''), true, 'empty quoted arguments must be preserved');
  assert.equal(windowsCommandLineHasExactArgument('tool.exe\t"two words"\tnext', 'two words'), true, 'tabs delimit unquoted arguments');
  assert.equal(windowsCommandLineHasExactArgument(String.raw`tool.exe "say \"hello\""`, 'say "hello"'), true, 'odd backslash runs before quotes produce literal quotes');
  assert.equal(windowsCommandLineHasExactArgument('tool.exe "one""two"', 'one"two'), true, 'paired quotes inside a quoted argument produce one literal quote');
  assert.equal(windowsCommandLineHasExactArgument(String.raw`tool.exe "C:\path with space\\"`, 'C:\\path with space\\'), true, 'even backslash runs before a closing quote preserve trailing backslashes');
  assert.equal(windowsCommandLineHasExactArgument(String.raw`tool.exe "one\\\"two"`, 'one\\"two'), true, 'three backslashes before a quote produce one backslash and one literal quote');
  assert.equal(windowsCommandLineHasExactArgument('tool.exe "unterminated argument', 'unterminated argument'), false, 'unmatched quotes must fail closed');
  assert.equal(windowsCommandLineHasExactArgument('tool.exe "valid" "unterminated', 'valid'), false, 'a malformed later argument invalidates the whole command line');
  assert.doesNotMatch(helperSource, /\.CommandLine\.Contains\(/, 'Windows launcher ownership must not use substring command-line matching');

  const macRows = parseMacProcessTable([
    '501\t501\tS\t/usr/local/bin/node\t/usr/local/bin/node child.js SNL_PROCESS_OWNER_TOKEN=' + 'b'.repeat(64) + ' OTHER=x',
    '502\t501\tS\t/Applications/Google Chrome\t/Applications/Google Chrome --type=renderer SNL_PROCESS_OWNER_TOKEN=' + 'b'.repeat(64),
    '503\t501\tS\t/bin/sleep\t/bin/sleep 9 SNL_PROCESS_OWNER_TOKEN=' + 'c'.repeat(64),
    '504\t501\tZ\t/bin/zombie\t/bin/zombie SNL_PROCESS_OWNER_TOKEN=' + 'b'.repeat(64)
  ].join('\n'), 'b'.repeat(64));
  assert.deepEqual(macRows.map(row => ({ pid: row.pid, tokenState: row.tokenState, executable: row.executable, zombie: row.zombie })), [
    { pid: 501, tokenState: 'owned', executable: '/usr/local/bin/node', zombie: false },
    { pid: 502, tokenState: 'owned', executable: '/Applications/Google Chrome', zombie: false },
    { pid: 503, tokenState: 'foreign', executable: '/bin/sleep', zombie: false },
    { pid: 504, tokenState: 'owned', executable: '/bin/zombie', zombie: true }
  ]);
  assert.equal(parseMacProcessTable(`505\t501\tS\t/bin/sleep\t/bin/sleep SNL_PROCESS_OWNER_TOKEN=${'b'.repeat(64)}0`, 'b'.repeat(64))[0].tokenState, 'foreign', 'macOS token matching must reject a longer value with the owned token as prefix');
  assert.throws(() => parseMacProcessTable(`506\t501\tS\tsleep\tsleep SNL_PROCESS_OWNER_TOKEN=${'b'.repeat(64)}`, 'b'.repeat(64)), /unverifiable macOS process identity/, 'macOS process identity must include an absolute executable');

  const malformedRegistry = createOwnedProcessRegistry();
  assert.equal(statSync(malformedRegistry.directory).mode & 0o777, 0o700, 'ownership registry directory must be private');
  assert.equal(statSync(malformedRegistry.registryPath).mode & 0o777, 0o600, 'ownership registry file must be private');
  appendFileSync(malformedRegistry.registryPath, '{"pid":');
  await assert.rejects(cleanupOwnedProcessRegistry(malformedRegistry), /malformed ownership registry record/);
  assert.throws(() => destroyOwnedProcessRegistry(malformedRegistry), /before zero-owned verification/);
  rmSync(malformedRegistry.directory, { recursive: true, force: true });

  const reDirtiedRegistry = createOwnedProcessRegistry();
  await verifyOwnedProcessRegistryClean(reDirtiedRegistry);
  const reDirtiedChild = spawnTracked(process.execPath, ['-e', 'setInterval(()=>{},1000)'], { stdio: 'ignore', env: reDirtiedRegistry.env });
  try {
    assert.throws(() => destroyOwnedProcessRegistry(reDirtiedRegistry), /before zero-owned verification/, 'a durable ownership append must invalidate prior zero-owned verification');
  } finally {
    if (existsSync(reDirtiedRegistry.registryPath)) {
      await cleanupOwnedProcessRegistry(reDirtiedRegistry);
      await verifyOwnedProcessRegistryClean(reDirtiedRegistry);
      destroyOwnedProcessRegistry(reDirtiedRegistry);
    } else {
      try { reDirtiedChild.kill('SIGKILL'); } catch (error) { if (error?.code !== 'ESRCH') throw error; }
    }
  }
  assert.equal(existsSync(reDirtiedRegistry.directory), false, 'registry deletion is allowed only after a fresh true zero-owned verification');

  const failedAppendRegistry = createOwnedProcessRegistry();
  await verifyOwnedProcessRegistryClean(failedAppendRegistry);
  const originalRegistryMode = statSync(failedAppendRegistry.registryPath).mode & 0o777;
  await import('node:fs').then(({ chmodSync }) => chmodSync(failedAppendRegistry.registryPath, 0o400));
  assert.throws(
    () => spawnTracked(process.execPath, ['-e', 'setInterval(()=>{},1000)'], { stdio: 'ignore', env: failedAppendRegistry.env }),
    /EACCES|permission denied/i,
    'forced ownership append failure must fail closed'
  );
  assert.throws(() => destroyOwnedProcessRegistry(failedAppendRegistry), /before zero-owned verification/, 'a failed ownership append must invalidate prior zero-owned verification');
  await import('node:fs').then(({ chmodSync }) => chmodSync(failedAppendRegistry.registryPath, originalRegistryMode));
  rmSync(failedAppendRegistry.directory, { recursive: true, force: true });
  void calls; void originalSymlink;

  if (process.platform !== 'win32') {
    const marker = resolve(temp, 'grandchild-alive');
    const pids = resolve(temp, 'nested-pids');
    const unrelatedMarker = resolve(temp, 'unrelated-alive');
    const unrelated = spawn(process.execPath, ['-e', `setTimeout(()=>require('fs').writeFileSync(${JSON.stringify(unrelatedMarker)},'alive'),600)`], { stdio: 'ignore' });
    const grandchildSource = `require('fs').appendFileSync(${JSON.stringify(pids)},process.pid+'\\n');setTimeout(()=>require('fs').writeFileSync(${JSON.stringify(marker)},'alive'),3000);setInterval(()=>{},1000)`;
    const browserSource = `const {spawn}=require('child_process');require('fs').appendFileSync(${JSON.stringify(pids)},process.pid+'\\n');spawn(process.execPath,['-e',${JSON.stringify(grandchildSource)}],{stdio:'ignore',detached:false});setInterval(()=>{},1000)`;
    const geometrySource = `import(${JSON.stringify(new URL('./library-depth-harness-utils.mjs', import.meta.url).href)}).then(({spawnTracked})=>{require('fs').appendFileSync(${JSON.stringify(pids)},process.pid+'\\n');spawnTracked(process.execPath,['-e',${JSON.stringify(browserSource)}],{stdio:'ignore'});setInterval(()=>{},1000)})`;
    const child = spawnProcessGroup(process.execPath, ['-e', geometrySource], { stdio: 'ignore' });
    await new Promise((resolveWait) => setTimeout(resolveWait, 150));
    await terminateProcessTree(child);
    await new Promise((resolveWait) => setTimeout(resolveWait, 700));
    assert.equal(existsSync(marker), false, 'nested descendant survived process-group timeout termination');
    assert.equal(existsSync(unrelatedMarker), true, 'unrelated process was killed');
    const nestedPids = readFileSync(pids, 'utf8').trim().split(/\s+/).map(Number);
    assert.equal(nestedPids.length, 3, 'geometry, browser, and grandchild all started');
    assert.equal((await Promise.all(nestedPids.map(isProcessAlive))).every(alive => !alive), true, `nested descendants remain: ${(await Promise.all(nestedPids.map(async pid => await isProcessAlive(pid) ? pid : null))).filter(Boolean).join(',')}`);
    if (unrelated.exitCode === null) unrelated.kill('SIGTERM');

    const standalonePids = resolve(temp, 'standalone-pids');
    const standaloneGrandchild = `require('fs').appendFileSync(${JSON.stringify(standalonePids)},process.pid+'\\n');setInterval(()=>{},1000)`;
    const standaloneChild = `const {spawn}=require('child_process');require('fs').appendFileSync(${JSON.stringify(standalonePids)},process.pid+'\\n');spawn(process.execPath,['-e',${JSON.stringify(standaloneGrandchild)}],{stdio:'ignore',detached:false});setInterval(()=>{},1000)`;
    const standalone = spawnTracked(process.execPath, ['-e', standaloneChild], { stdio: 'ignore' });
    await new Promise((resolveWait) => setTimeout(resolveWait, 150));
    await terminateProcessTree(standalone);
    await new Promise((resolveWait) => setTimeout(resolveWait, 150));
    const ownedPids = readFileSync(standalonePids, 'utf8').trim().split(/\s+/).map(Number);
    assert.equal((await Promise.all(ownedPids.map(isProcessAlive))).every(alive => !alive), true, `standalone cleanup left descendants: ${(await Promise.all(ownedPids.map(async pid => await isProcessAlive(pid) ? pid : null))).filter(Boolean).join(',')}`);

    for (const [label, launch] of [
      ['group root', spawnProcessGroup],
      ['tracked root', spawnTracked]
    ]) {
      const unrelatedExitedRoot = spawn(process.execPath, ['-e', 'setInterval(()=>{},1000)'], { stdio: 'ignore' });
      const exitedRootPids = resolve(temp, `${label.replaceAll(' ', '-')}-exited-root-pids`);
      const exitedRootChild = `require('fs').appendFileSync(${JSON.stringify(exitedRootPids)},process.pid+'\\n');setInterval(()=>{},1000)`;
      const exitedRootParent = `const {spawn}=require('child_process');const child=spawn(process.execPath,['-e',${JSON.stringify(exitedRootChild)}],{stdio:'ignore',detached:false});child.unref()`;
      const exitedRoot = launch(process.execPath, ['-e', exitedRootParent], { stdio: 'ignore' });
      await new Promise((resolveExit, rejectExit) => {
        exitedRoot.once('error', rejectExit);
        exitedRoot.once('exit', resolveExit);
      });
      for (let attempt = 0; attempt < 50 && !existsSync(exitedRootPids); attempt += 1) {
        await new Promise(resolveWait => setTimeout(resolveWait, 20));
      }
      const descendantPid = Number(readFileSync(exitedRootPids, 'utf8').trim());
      assert.equal(await isProcessAlive(descendantPid), true, `${label} descendant did not survive long enough to exercise exited-root cleanup`);
      try {
        await terminateProcessTree(exitedRoot);
        await new Promise(resolveWait => setTimeout(resolveWait, 150));
        assert.equal(await isProcessAlive(descendantPid), false, `${label} cleanup skipped a live descendant after its root exited`);
        assert.equal(await isProcessAlive(unrelatedExitedRoot.pid), true, `${label} cleanup killed an unrelated process`);
      } finally {
        try { process.kill(descendantPid, 'SIGKILL'); } catch (error) { if (error?.code !== 'ESRCH') throw error; }
        if (label === 'group root') {
          try { process.kill(-exitedRoot.pid, 'SIGKILL'); } catch (error) { if (error?.code !== 'ESRCH') throw error; }
        }
        if (unrelatedExitedRoot.exitCode === null) unrelatedExitedRoot.kill('SIGTERM');
      }
    }

    for (const nestedDetached of [false, true]) {
      const registry = createOwnedProcessRegistry();
      const nestedMarker = resolve(temp, `nested-detached-${nestedDetached}-alive`);
      const nestedPids = resolve(temp, `nested-detached-${nestedDetached}-pids`);
      const unrelatedMarker = resolve(temp, `nested-detached-${nestedDetached}-unrelated`);
      const unrelated = spawn(process.execPath, ['-e', `setTimeout(()=>require('fs').writeFileSync(${JSON.stringify(unrelatedMarker)},'alive'),500)`], { stdio: 'ignore' });
      const descendantSource = `require('fs').appendFileSync(${JSON.stringify(nestedPids)},process.pid+'\\n');setTimeout(()=>require('fs').writeFileSync(${JSON.stringify(nestedMarker)},'alive'),2500);setInterval(()=>{},1000)`;
      const nestedSource = `import(${JSON.stringify(new URL('./library-depth-harness-utils.mjs', import.meta.url).href)}).then(({spawnTracked})=>{const c=spawnTracked(process.execPath,['-e',${JSON.stringify(descendantSource)}],{stdio:'ignore',ownedDetached:${nestedDetached}});c.unref()})`;
      const root = spawnTracked(process.execPath, ['-e', nestedSource], { stdio: 'ignore', ownedDetached: false, env: registry.env });
      await new Promise((resolveExit, rejectExit) => { root.once('error', rejectExit); root.once('exit', resolveExit); });
      for (let attempt = 0; attempt < 50 && !existsSync(nestedPids); attempt += 1) await new Promise(resolveWait => setTimeout(resolveWait, 20));
      const descendantPid = Number(readFileSync(nestedPids, 'utf8').trim());
      assert.equal(await isProcessAlive(descendantPid), true, `nested ${nestedDetached ? 'detached' : 'inherited'} descendant was not alive before external cleanup`);
      try {
        await cleanupOwnedProcessRegistry(registry);
        await verifyOwnedProcessRegistryClean(registry);
        await new Promise(resolveWait => setTimeout(resolveWait, 600));
        assert.equal(existsSync(nestedMarker), false, `nested ${nestedDetached ? 'detached' : 'inherited'} descendant survived exited-root registry cleanup`);
        assert.equal(existsSync(unrelatedMarker), true, 'registry cleanup killed an unrelated process');
      } finally {
        try { process.kill(descendantPid, 'SIGKILL'); } catch (error) { if (error?.code !== 'ESRCH') throw error; }
        if (unrelated.exitCode === null) unrelated.kill('SIGTERM');
        destroyOwnedProcessRegistry(registry);
      }
    }
  } else {
    const registry = createOwnedProcessRegistry();
    const marker = resolve(temp, 'windows-job-grandchild-alive');
    const pids = resolve(temp, 'windows-job-pids');
    const grandchild = `require('fs').appendFileSync(${JSON.stringify(pids)},process.pid+'\\n');setTimeout(()=>require('fs').writeFileSync(${JSON.stringify(marker)},'alive'),3000);setInterval(()=>{},1000)`;
    const rootSource = `const fs=require('fs'),{spawn}=require('child_process');const c=spawn(process.execPath,['-e',${JSON.stringify(grandchild)}],{stdio:'ignore',detached:true});c.unref();const t=setInterval(()=>{if(fs.existsSync(${JSON.stringify(pids)}))clearInterval(t)},10)`;
    const root = spawnProcessGroup(process.execPath, ['-e', rootSource], { stdio: 'ignore', env: registry.env });
    await new Promise((resolveExit, rejectExit) => { root.once('error', rejectExit); root.once('exit', resolveExit); });
    for (let attempt = 0; attempt < 50 && !existsSync(pids); attempt += 1) await new Promise(resolveWait => setTimeout(resolveWait, 20));
    const childPid = Number(readFileSync(pids, 'utf8').trim());
    await new Promise(resolveWait => setTimeout(resolveWait, 250));
    assert.equal(await isProcessAlive(childPid), false, 'Windows kill-on-close Job left a detached descendant after root exit');
    assert.equal(existsSync(marker), false, 'Windows detached descendant survived long enough to write marker');
    await cleanupOwnedProcessRegistry(registry);
    await verifyOwnedProcessRegistryClean(registry);
    destroyOwnedProcessRegistry(registry);
  }

  console.log(JSON.stringify({ kind: 'pass' }));
} finally {
  rmSync(temp, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
}
