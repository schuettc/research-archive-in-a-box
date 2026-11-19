"""The quality rules, importable without the command line.

Importing this module registers every rule in `REGISTRY`.
"""

from cruise.rules import fields, package, values
from cruise.rules.registry import (
    CHECK_FAILED,
    QUESTIONS,
    REGISTRY,
    Context,
    Outcome,
    Problem,
    Question,
    Registry,
    Rule,
    RuleResult,
    failed_id,
    required_fields,
)

__all__ = [
    "CHECK_FAILED",
    "QUESTIONS",
    "REGISTRY",
    "Context",
    "Outcome",
    "Problem",
    "Question",
    "Registry",
    "Rule",
    "RuleResult",
    "failed_id",
    "fields",
    "package",
    "required_fields",
    "values",
]
