#!/usr/bin/env python3
"""Pure fake-kernel regression gates; never opens real PIDs or sends signals."""
import copy
import signal
import unittest
from library_depth_linux_pidfd import contain, classify, CleanupIncomplete


def row(pid, ppid, token='owned', start=None):
    return dict(pid=pid, ppid=ppid, pgid=100, sid=100, state='S', tokenState=token,
                birth=dict(startTicks=str(start or pid), executable='/node'))


ROOT = row(100, 1)
RECORD = dict(pid=100, groupRoot=100, birth=ROOT['birth'])


class FakeKernel:
    def __init__(self, rows):
        self.rows = {r['pid']: copy.deepcopy(r) for r in rows}
        self.fds = {}; self.signals = []; self.opened = []; self.closed = []
        self.reuse_on_open: int | None = None; self.reuse_on_send: int | None = None; self.mutate_on_open: int | None = None
    def require_capabilities(self): pass
    def snapshot(self, record, token): return copy.deepcopy(list(self.rows.values()))
    def read(self, pid, token): return copy.deepcopy(self.rows.get(pid))
    def open(self, pid):
        fd = 1000 + len(self.fds); self.fds[fd] = self.rows[pid]; self.opened.append(pid)
        if self.reuse_on_open == pid: self.rows[pid] = row(pid, 1, 'mismatched', 9999)
        if self.mutate_on_open == pid: self.rows[pid]['ppid'] = 777
        return fd
    def ready(self, fd, timeout=0): return self.fds[fd]['state'] in ('Z', 'X', 'x')
    def send(self, fd, sig):
        if self.reuse_on_send == self.fds[fd]['pid']:
            pid = self.fds[fd]['pid']; self.rows[pid] = row(pid, 1, 'mismatched', 9999)
            self.reuse_on_send = None
        self.signals.append((fd, sig, self.fds[fd]['birth']['startTicks']))
        self.fds[fd]['state'] = 'T' if sig == signal.SIGSTOP else 'Z'
    def close(self, fd): self.closed.append(fd)
    def sleep(self, t): pass


class Tests(unittest.TestCase):
    def zero(self, rows, mutate=None):
        k = FakeKernel(rows)
        if mutate: mutate(k)
        with self.assertRaises(CleanupIncomplete): contain(RECORD, 'token', kernel=k)
        self.assertEqual(k.signals, [])
        self.assertEqual(len(k.closed), len(k.fds))
    def test_capability_unavailable_zero_signals(self):
        def missing(k):
            def fail(): raise CleanupIncomplete('pidfds unavailable')
            k.require_capabilities = fail
        self.zero([ROOT], missing)
    def test_open_denied_zero_signals(self):
        def denied(k):
            def fail(pid): raise PermissionError('denied')
            k.open = fail
        self.zero([ROOT], denied)
    def test_owned_unrelated_same_group(self): self.zero([ROOT, row(101, 1)])
    def test_root_birth(self): self.zero([row(100, 1, start=999)])
    def test_root_token(self): self.zero([row(100, 1, 'scrubbed')])
    def test_mismatch(self): self.zero([ROOT, row(101, 100, 'mismatched')])
    def test_predates(self): self.zero([ROOT, row(101, 100, start=99)])
    def test_session(self): self.zero([ROOT, dict(row(101, 100), sid=101)])
    def test_group(self): self.zero([ROOT, dict(row(101, 100), pgid=101)])
    def test_unrelated(self): self.zero([ROOT, row(101, 1, 'scrubbed')])
    def test_dead_unowned(self): self.zero([row(101, 1, 'scrubbed')])
    def test_dead_unrelated(self): self.zero([row(101, 1), row(102, 1, 'scrubbed')])
    def test_dead_session(self): self.zero([row(101, 1), dict(row(102, 1), sid=101)])
    def test_reuse_before_validation(self): self.zero([ROOT], lambda k: setattr(k, 'reuse_on_open', 100))
    def test_child_reuse(self): self.zero([ROOT, row(101, 100)], lambda k: setattr(k, 'reuse_on_open', 101))
    def test_ancestry_race(self): self.zero([ROOT, row(101, 100)], lambda k: setattr(k, 'mutate_on_open', 101))
    def test_transitive(self):
        k = FakeKernel([ROOT, row(101, 100, 'scrubbed'), row(102, 101, 'inaccessible')])
        result = contain(RECORD, 'token', kernel=k)
        self.assertTrue(result['ok']); self.assertEqual(k.opened, [100, 101, 102])
        self.assertEqual([s[2] for s in k.signals if s[1] == signal.SIGKILL], ['102', '101', '100'])
    def test_dead_anchor(self):
        k = FakeKernel([row(101, 1), row(102, 101, 'scrubbed')])
        self.assertTrue(contain(RECORD, 'token', kernel=k)['ok'])
    def test_reuse_after_acquisition_targets_retained_fd_only(self):
        k = FakeKernel([ROOT]); k.reuse_on_send = 100
        with self.assertRaises(CleanupIncomplete): contain(RECORD, 'token', kernel=k)
        self.assertTrue(k.signals)
        self.assertTrue(all(s[2] == '100' for s in k.signals))
        self.assertEqual(k.rows[100]['state'], 'S')
    def test_failure_after_freeze_converges_owned_fds_but_raises(self):
        k = FakeKernel([ROOT])
        with self.assertRaises(CleanupIncomplete): contain(RECORD, 'token', kernel=k, max_iterations=1)
        self.assertTrue(k.ready(next(iter(k.fds))))
    def test_verify_zero_signals(self):
        k = FakeKernel([ROOT]); self.assertEqual(contain(RECORD, 'token', kernel=k, verify=True)['targets'], [100])
        self.assertEqual(k.signals, [])


if __name__ == '__main__': unittest.main(verbosity=2)
