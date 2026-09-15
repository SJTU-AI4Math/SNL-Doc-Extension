#!/usr/bin/env node
// Pure fake runtime: a Linux numeric destructive-signal regression MUST fail.
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import vm from 'node:vm';
const source = readFileSync(new URL('./library-depth-harness-utils.mjs', import.meta.url), 'utf8');
const signalSource = source.slice(source.indexOf('function signalRecord('), source.indexOf('\nasync function waitForRecordExit'));
function signalGate(text) {
  const signals = [];
  const context = vm.createContext({ process: { platform: 'linux', kill: (...args) => signals.push(args) } });
  vm.runInContext(text + '\ntry { signalRecord({pid:100,groupRoot:100}, "SIGKILL"); } catch {}', context);
  assert.equal(signals.length, 0, 'Linux must never reach numeric PID/PGID signaling');
}
signalGate(signalSource);
const mutant = signalSource.replace("if (process.platform === 'linux') throw new Error('Linux requires retained pidfd signaling');", '');
assert.notEqual(mutant, signalSource, 'mutation must hit Linux guard');
assert.throws(() => signalGate(mutant), /Linux must never reach numeric/, 'pure mutant restores unsafe fallback and must go RED');
const cleanupSource = source.slice(source.indexOf('export async function cleanupOwnedProcessRegistry('), source.indexOf('\nexport async function verifyOwnedProcessRegistryClean(')).replace('export ', '');
const calls = [];
const context = vm.createContext({ process: { platform: 'linux', pid: 1 }, readOwnershipRecords: () => [{pid:100},{pid:101}], linuxPidfdRecord: record => calls.push(record.pid), signalRecord: () => assert.fail('numeric signal fallback'), liveRecordTargets: () => assert.fail('read/compare then kill path') });
await vm.runInContext(cleanupSource + '\ncleanupOwnedProcessRegistry({});', context);
assert.deepEqual(calls, [101,100], 'Linux cleanup uses only pidfd helper in reverse registry order');
const python = readFileSync(new URL('./library_depth_linux_pidfd.py', import.meta.url), 'utf8');
assert.doesNotMatch(python, /os\.kill\s*\(|killpg\s*\(|subprocess\./);
assert.match(python, /signal\.pidfd_send_signal\(fd, sig, None, 0\)/);
console.log(JSON.stringify({kind:'pass',gate:'linux-fake-runtime',numericSignals:0,mutationDetected:true}));
