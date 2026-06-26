"""Adversarial tests for the state-lock PID-ownership race fix.

A plain "evict any lock older than STALE" check has a TOCTOU race: a slow-but-
alive process holding the lock can have it stolen, letting two processes write
state concurrently. The fix records the owner PID and only evicts when the owner
is actually gone. These tests try to break that.
"""

import os
import subprocess
import sys
import time
from pathlib import Path

import pytest

import valuesteward.steward_state as ss


@pytest.fixture
def lockenv(tmp_path, monkeypatch):
    lock = tmp_path / "state.json.lock"
    monkeypatch.setattr(ss, "STATE_LOCK_PATH", lock)
    monkeypatch.setattr(ss, "STATE_PATH", tmp_path / "state.json")
    monkeypatch.setattr(ss, "LOCK_STALE_SEC", 0.0)  # any age counts as stale
    monkeypatch.setattr(ss, "LOCK_TIMEOUT_SEC", 0.3)  # fail fast in tests
    monkeypatch.setattr(ss, "LOCK_RETRY_SEC", 0.01)
    return lock


def _dead_pid() -> int:
    """A definitively-dead (reaped) PID — won't be reused within the test."""
    proc = subprocess.Popen([sys.executable, "-c", "pass"])
    proc.wait()
    return proc.pid


def _make_stale_lock(lock: Path, pid_text) -> None:
    lock.mkdir()
    if pid_text is not None:
        (lock / "owner.pid").write_text(str(pid_text), encoding="utf-8")
    old = time.time() - 1000
    os.utime(lock, (old, old))  # set AFTER writing the pid file


def test_is_pid_alive_guards_and_basics():
    assert ss._is_pid_alive(os.getpid()) is True
    assert ss._is_pid_alive(0) is False  # os.kill(0,…) would hit a process group
    assert ss._is_pid_alive(-1) is False
    assert ss._is_pid_alive(_dead_pid()) is False


def test_live_owner_lock_is_not_stolen(lockenv):
    # Stale-aged lock owned by THIS (alive) process must NOT be evicted —
    # acquiring must time out instead of stealing it.
    _make_stale_lock(lockenv, os.getpid())
    with pytest.raises(TimeoutError):
        with ss._state_lock():
            pass
    assert lockenv.exists()
    assert (lockenv / "owner.pid").exists()


def test_dead_owner_lock_is_evicted(lockenv):
    _make_stale_lock(lockenv, _dead_pid())
    with ss._state_lock():
        assert (lockenv / "owner.pid").read_text().strip() == str(os.getpid())
    assert not lockenv.exists()  # released cleanly


def test_corrupt_pid_lock_is_evicted(lockenv):
    # Garbage PID file (e.g. partial write) must not wedge the lock forever.
    _make_stale_lock(lockenv, "not-a-pid")
    with ss._state_lock():
        pass
    assert not lockenv.exists()


def test_missing_pid_lock_is_evicted(lockenv):
    _make_stale_lock(lockenv, None)
    with ss._state_lock():
        pass
    assert not lockenv.exists()


def test_happy_path_acquire_and_release(lockenv):
    with ss._state_lock():
        assert lockenv.exists()
        assert (lockenv / "owner.pid").read_text().strip() == str(os.getpid())
    assert not lockenv.exists()
