"""QA findings are data (schema table qa_flag): kept, reported and shown, never silently fixed."""
from __future__ import annotations

from collections import Counter
from dataclasses import asdict, dataclass, field
from typing import Any

SEVERITIES = ("info", "warning", "error")


@dataclass(frozen=True)
class Finding:
    rule: str            # QA-001 .. QA-012
    severity: str        # info | warning | error
    subject_type: str    # polity | territory | external_id | source_release | dataset | point
    subject_id: str
    message: str         # the sentence a UI shows
    detail: dict[str, Any] = field(default_factory=dict)

    def __post_init__(self) -> None:
        if self.severity not in SEVERITIES:
            raise ValueError(f"bad severity {self.severity!r}")

    def as_dict(self) -> dict[str, Any]:
        return asdict(self)


def sort_key(f: Finding) -> tuple:
    return (f.rule, -SEVERITIES.index(f.severity), f.subject_type, f.subject_id, f.message)


def summarize(findings: list[Finding]) -> dict[str, dict[str, int]]:
    out: dict[str, dict[str, int]] = {}
    for (rule, sev), n in sorted(Counter((f.rule, f.severity) for f in findings).items()):
        out.setdefault(rule, {})[sev] = n
    return out
