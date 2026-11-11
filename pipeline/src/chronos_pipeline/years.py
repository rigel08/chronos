"""Year conventions (D-003). Internally CHRONOS uses astronomical years: 0 = 1 BCE, -1 = 2 BCE."""
from __future__ import annotations


def cliopatria_to_astronomical(y: int) -> int:
    """Map a Cliopatria year to an astronomical year (QA-001).

    Validation 0001 found negative years read as BCE (the Roman Empire begins at -31, the year of
    Actium, 31 BCE), so -n means n BCE, which is astronomical -(n-1). Cliopatria also uses 0 as an
    end bound immediately before a row starting at 1; it is read as 1 BCE (astronomical 0).
    The reading is an inference, so every BCE bound carries +/-1 year of convention uncertainty.
    """
    return y + 1 if y < 0 else y


def label(y: int) -> str:
    """Display label for an astronomical year."""
    return f"{1 - y} BCE" if y <= 0 else f"{y} CE"
