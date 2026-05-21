"""Project-local strict-close classifications for cafe-code.

This project currently inherits Selene's baseline executable classifier for
numeric distance-series checks. Engineering burst scope is predeclared in ADRs
and agreed plans, then audited against the repository quality gates. Add
project-specific executable classifiers here only through a new accepted ADR.
"""

from __future__ import annotations

from selene.discipline.classifications import (
    DEFAULT_TOLERANCE,
    Classification,
    classify_pair,
)

__all__ = ["Classification", "DEFAULT_TOLERANCE", "classify_pair"]
