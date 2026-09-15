#!/usr/bin/env python3
"""Linux-only, Python 3.9+ pidfd cleanup for the synchronous Node harness API.

No numeric PID signaling. The token is read on stdin, never argv. Adapted from
SNL-Basics owned_process_emergency.py's retained-fd freeze/fixed-point design;
this port additionally requires the author's token, birth, PPID, PGID and SID
policy BEFORE signaling. Not a cross-OS supervisor or arbitrary daemon catcher.
"""
from __future__ import annotations
import json
import os
from pathlib import Path
import select
import signal
import sys
import time

TERMINAL = ('Z', 'X', 'x')


class CleanupIncomplete(RuntimeError):
    pass


def classify(record, rows):
    """Author AL01 classifier; input is scoped to root closure + recorded group."""
    live = [r for r in rows if r['state'] not in TERMINAL]
    by_pid = {r['pid']: r for r in live}
    root = by_pid.get(record['pid'])
    group = [r for r in live if not record.get('groupRoot') or r['pgid'] == record['groupRoot']]
    start = int(record['birth']['startTicks'])
    if root:
        if root['birth'] != record['birth']: raise CleanupIncomplete('owned PID birth identity changed')
        if root['tokenState'] != 'owned': raise CleanupIncomplete('registered root has unverifiable or mismatched owner token')
        seeds = [root]; pgid = root['pgid']; sid = root['sid']
    else:
        seeds = [r for r in group if r['tokenState'] == 'owned' and int(r['birth']['startTicks']) >= start]
        if not seeds:
            if group: raise CleanupIncomplete('registered root exited with unverifiable same-group members')
            return {}, []
        pgid = record.get('groupRoot') or seeds[0]['pgid']; sid = seeds[0]['sid']
        if any(r['pgid'] != pgid or r['sid'] != sid for r in seeds):
            raise CleanupIncomplete('independently owned markers disagree on group or session')
    if record.get('linuxSession') and record['linuxSession'] != dict(pgid=pgid, sid=sid):
        raise CleanupIncomplete('registered group or session changed')
    depths = {r['pid']: 0 for r in seeds}
    changed = True
    while changed:
        changed = False
        for r in live:
            if r['pid'] not in depths and r['ppid'] in depths:
                depths[r['pid']] = depths[r['ppid']] + 1; changed = True
    for pid in depths:
        r = by_pid[pid]
        if int(r['birth']['startTicks']) < start: raise CleanupIncomplete('descendant predates registered root')
        if r['pgid'] != pgid or r['sid'] != sid: raise CleanupIncomplete('descendant changed group or session')
        if r['tokenState'] == 'mismatched': raise CleanupIncomplete('readable mismatched owner token')
        if r['tokenState'] not in ('owned', 'scrubbed', 'inaccessible'): raise CleanupIncomplete('unknown owner-token state')
    if record.get('groupRoot') and any(r['pid'] not in depths for r in group):
        raise CleanupIncomplete('unrelated PIDs outside verified ancestry')
    return depths, seeds


class LinuxKernel:
    def require_capabilities(self):
        if sys.platform != 'linux' or not hasattr(os, 'pidfd_open') or not hasattr(signal, 'pidfd_send_signal'):
            raise CleanupIncomplete('Linux /proc and Python pidfd_open/pidfd_send_signal required')
    def stat(self, pid):
        try: text = Path(f'/proc/{pid}/stat').read_text()
        except OSError as e:
            if e.errno in (2, 3): return None
            raise
        end = text.rfind(')'); fields = text[end + 2:].split()
        if end < 0 or len(fields) < 20: raise CleanupIncomplete('malformed /proc stat')
        return dict(pid=pid, ppid=int(fields[1]), pgid=int(fields[2]), sid=int(fields[3]), state=fields[0], start=fields[19])
    def read(self, pid, token):
        before = self.stat(pid)
        if before is None: return None
        if before['state'] in TERMINAL: return None
        try:
            executable = os.readlink(f'/proc/{pid}/exe')
            try:
                env = Path(f'/proc/{pid}/environ').read_bytes().split(b'\0')
                markers = [x for x in env if x.startswith(b'SNL_PROCESS_OWNER_TOKEN=')]
                state = 'owned' if markers == [('SNL_PROCESS_OWNER_TOKEN=' + token).encode()] else ('mismatched' if markers else 'scrubbed')
            except PermissionError: state = 'inaccessible'
            after = self.stat(pid)
            if after is None: return None
            if any(before[k] != after[k] for k in ('pid', 'ppid', 'pgid', 'sid', 'start')):
                raise CleanupIncomplete('identity/ancestry changed during snapshot')
            return {k: before[k] for k in ('pid','ppid','pgid','sid','state')} | dict(tokenState=state, birth=dict(startTicks=before['start'], executable=executable))
        except OSError as e:
            if e.errno in (2, 3):
                now = self.stat(pid)
                if now is None or now['state'] in TERMINAL: return None
            raise
    def snapshot(self, record, token):
        table = {}
        for p in Path('/proc').iterdir():
            if p.name.isdigit():
                r = self.stat(int(p.name))
                if r: table[r['pid']] = r
        relevant = {record['pid']} if record['pid'] in table else set()
        if record.get('groupRoot'):
            relevant.update(r['pid'] for r in table.values() if r['pgid'] == record['groupRoot'])
        changed = True
        while changed:
            changed = False
            for r in table.values():
                if r['ppid'] in relevant and r['pid'] not in relevant:
                    relevant.add(r['pid']); changed = True
        rows = []
        for pid in sorted(relevant):
            r = self.read(pid, token)
            if r: rows.append(r)
        return rows
    def open(self, pid): return os.pidfd_open(pid, 0)
    def send(self, fd, sig): signal.pidfd_send_signal(fd, sig, None, 0)
    def ready(self, fd, timeout: float = 0):
        poll = select.poll(); poll.register(fd, select.POLLIN)
        return bool(poll.poll(max(0, int(timeout * 1000))))
    def close(self, fd): os.close(fd)
    def sleep(self, t): time.sleep(t)


def identity_equal(a, b):
    return a is not None and all(a[k] == b[k] for k in ('pid', 'ppid', 'pgid', 'sid', 'birth', 'tokenState'))


def contain(record, token, *, kernel=None, verify=False, max_iterations=32, timeout=3):
    k = kernel or LinuxKernel(); k.require_capabilities()
    caps = {}; authorized = False; signaled = False
    def send(fd, sig):
        try: k.send(fd, sig)
        except ProcessLookupError: pass
    try:
        for iteration in range(max_iterations):
            rows = k.snapshot(record, token); depths, seeds = classify(record, rows)
            observed = {r['pid']: r for r in rows}
            if verify: return dict(ok=True, targets=sorted(depths))
            new = []
            # Seed/root descriptors MUST be retained before descendants acquire authority.
            for pid in sorted(depths, key=lambda p: depths[p]):
                r = observed[pid]
                if pid in caps:
                    if not identity_equal(r, caps[pid]['row']): raise CleanupIncomplete('retained identity changed')
                    continue
                fd = k.open(pid)
                caps[pid] = dict(fd=fd, row=r, depth=depths[pid], validated=False)
                actual = k.read(pid, token)
                if k.ready(fd) or not identity_equal(actual, r):
                    raise CleanupIncomplete('pidfd birth/ancestry/token binding changed')
                if depths[pid] > 0:
                    parent = caps.get(r['ppid'])
                    if not parent or k.ready(parent['fd']) or not identity_equal(k.read(r['ppid'], token), parent['row']):
                        raise CleanupIncomplete('retained parent authority lost')
                new.append(pid)
            # A whole second snapshot must preserve classification, including negative
            # same-group/token assertions. No STOP (or error-path KILL) before this gate.
            check = k.snapshot(record, token); check_depths, _ = classify(record, check)
            if set(check_depths) != set(depths): raise CleanupIncomplete('snapshot changed before freeze')
            for r in check:
                if r['pid'] in depths and not identity_equal(r, caps[r['pid']]['row']):
                    raise CleanupIncomplete('snapshot identity changed before freeze')
            for pid in depths:
                if k.ready(caps[pid]['fd']): raise CleanupIncomplete('authority exited before freeze')
            for pid in new: caps[pid]['validated'] = True
            authorized = True
            if not new: break
            for pid in new:
                signaled = True; send(caps[pid]['fd'], signal.SIGSTOP)
                deadline = time.monotonic() + .5
                while True:
                    current = k.read(pid, token)
                    if k.ready(caps[pid]['fd']): raise CleanupIncomplete('authority exited during freeze')
                    if not identity_equal(current, caps[pid]['row']): raise CleanupIncomplete('identity changed during freeze')
                    if current is not None and current['state'] in ('T', 't'): break
                    if time.monotonic() >= deadline: raise CleanupIncomplete('owned process did not stop')
                    k.sleep(.005)
        else: raise CleanupIncomplete('freeze fixed point did not converge')
        ordered = sorted(caps.values(), key=lambda c: c['depth'], reverse=True)
        for cap in ordered: send(cap['fd'], signal.SIGKILL)
        deadline = time.monotonic() + timeout
        if not all(k.ready(c['fd'], max(0, deadline-time.monotonic())) for c in ordered):
            raise CleanupIncomplete('retained pidfds did not become ready')
        return dict(ok=True, targets=[], retainedCapabilities=len(caps), freezeIterations=iteration+1)
    except BaseException as error:
        # Converge only already-authorized handles after a partially executed freeze.
        # Never report success: unknown/unverifiable residue remains incomplete.
        if authorized and signaled:
            for cap in sorted(caps.values(), key=lambda c: c['depth'], reverse=True):
                if cap['validated']: send(cap['fd'], signal.SIGKILL)
            for cap in caps.values():
                if cap['validated']: k.ready(cap['fd'], .5)
        raise CleanupIncomplete(str(error)) from error
    finally:
        for cap in caps.values(): k.close(cap['fd'])


def main():
    try:
        request = json.load(sys.stdin)
        result = contain(request['record'], request['token'], verify=request.get('verify', False), timeout=request.get('timeout', 3))
        print(json.dumps(result)); return 0
    except BaseException as e:
        print(json.dumps(dict(ok=False, cleanupIncomplete=True, message=str(e)))); return 1


if __name__ == '__main__': sys.exit(main())
