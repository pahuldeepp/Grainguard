"""Resolve a repository-local I4 comparison report for disposable acceptance."""
from __future__ import annotations

import os
from pathlib import Path


DEFAULT_COMPARISON_REPORT = Path("evidence/intelligence/i4-transformer-comparison.json")
COMPARISON_REPORT_ENV = "ML_I4_COMPARISON_REPORT"


def resolve_i4_comparison_report(repo_root: Path) -> Path:
    """Return the selected I4 report, constrained to evidence/intelligence.

    Relative overrides are interpreted from ``repo_root``. Resolving symlinks
    before checking containment prevents an in-tree link from escaping the
    approved evidence directory.
    """
    root = Path(repo_root).resolve()
    configured = os.environ.get(COMPARISON_REPORT_ENV)
    selected = Path(configured) if configured else DEFAULT_COMPARISON_REPORT
    candidate = selected if selected.is_absolute() else root / selected
    try:
        allowed_dir = (root / "evidence" / "intelligence").resolve()
        allowed_dir.relative_to(root)
    except ValueError as exc:
        raise ValueError("I4 comparison evidence directory must remain inside the repository") from exc
    except (OSError, RuntimeError) as exc:
        raise ValueError("I4 comparison evidence directory cannot be resolved") from exc

    try:
        canonical_candidate = candidate.resolve(strict=False)
        canonical_candidate.relative_to(allowed_dir)
    except ValueError as exc:
        raise ValueError(
            f"I4 comparison report must be inside {allowed_dir}: {candidate.resolve(strict=False)}"
        ) from exc
    except (OSError, RuntimeError) as exc:
        raise ValueError(f"I4 comparison report path cannot be resolved: {candidate}") from exc

    try:
        resolved = canonical_candidate.resolve(strict=True)
    except (OSError, RuntimeError) as exc:
        raise ValueError(f"I4 comparison report does not exist: {canonical_candidate}") from exc
    if not resolved.is_file():
        raise ValueError(f"I4 comparison report is not a file: {resolved}")
    return resolved
