"""Runtime integrity helpers for the Python tick path."""

from __future__ import annotations

import hashlib
import os
import shutil
import subprocess  # nosec B404
from pathlib import Path
from typing import Any


def _git_bin() -> str:
    """Find the git binary path, defaulting to 'git' if not found."""
    # nosec B607: We use shutil.which to resolve the full path
    return shutil.which("git") or "git"

CRITICAL_FILE_ENV_MAP = {
    "src/valuesteward/cli.py": "VS_EXPECTED_SHA_CLI_PY",
    "src/valuesteward/core/execution_engine.py": "VS_EXPECTED_SHA_EXECUTION_ENGINE_PY",
    "src/valuesteward/config.py": "VS_EXPECTED_SHA_CONFIG_PY",
    "src/valuesteward/policy.py": "VS_EXPECTED_SHA_POLICY_PY",
}


def _repo_root() -> Path:
    return Path(__file__).resolve().parents[2]


def _sha256_for_file(path: Path) -> str:
    return hashlib.sha256(path.read_bytes()).hexdigest()


def collect_runtime_integrity() -> dict[str, Any]:
    """Capture the current git identity and critical file hashes."""

    root = _repo_root()
    files: dict[str, str | None] = {}
    for relative_path in CRITICAL_FILE_ENV_MAP:
        absolute_path = root / relative_path
        files[relative_path] = (
            _sha256_for_file(absolute_path) if absolute_path.exists() else None
        )

    git_head = None
    git_dirty = None
    git_bin = _git_bin()
    try:
        git_head = subprocess.check_output(  # nosec B603
            [git_bin, "rev-parse", "HEAD"],
            cwd=root,
            text=True,
        ).strip()
        git_dirty = (
            subprocess.run(  # nosec B603
                [git_bin, "diff", "--quiet"],
                cwd=root,
                check=False,
            ).returncode
            != 0
        )
    except Exception:
        git_head = None
        git_dirty = None

    return {
        "repo_root": str(root),
        "git_head": git_head,
        "git_dirty": git_dirty,
        "files": files,
    }


def verify_runtime_expectations() -> dict[str, Any]:
    """Verify the Python process is executing the expected source tree."""

    actual = collect_runtime_integrity()
    mismatches: list[str] = []

    expected_head = os.getenv("VS_EXPECTED_GIT_HEAD")
    if expected_head and actual.get("git_head") != expected_head:
        mismatches.append(
            f"git_head expected {expected_head} got {actual.get('git_head')}"
        )

    expected_dirty = os.getenv("VS_EXPECTED_GIT_DIRTY")
    if expected_dirty in {"0", "1"}:
        actual_dirty = actual.get("git_dirty")
        normalized_actual = None if actual_dirty is None else ("1" if actual_dirty else "0")
        if normalized_actual != expected_dirty:
            mismatches.append(
                f"git_dirty expected {expected_dirty} got {normalized_actual}"
            )

    for relative_path, env_name in CRITICAL_FILE_ENV_MAP.items():
        expected_sha = os.getenv(env_name)
        if not expected_sha:
            continue
        actual_sha = actual["files"].get(relative_path)
        if actual_sha != expected_sha:
            mismatches.append(
                f"{relative_path} expected {expected_sha} got {actual_sha}"
            )

    if mismatches:
        joined = "; ".join(mismatches)
        raise RuntimeError(f"Runtime integrity check failed: {joined}")

    return actual
