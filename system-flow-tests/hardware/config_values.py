"""Validation helpers for commissioned finite hardware settings."""

from __future__ import annotations
import math


def positive(config: dict, key: str, maximum: float | None = None) -> float:
    value = config.get(key)
    if isinstance(value, bool) or not isinstance(value, (int, float)) or not math.isfinite(value) or value <= 0:
        raise ValueError(f"{key} must be a commissioned positive number")
    if maximum is not None and value > maximum:
        raise ValueError(f"{key} exceeds its configured safety limit")
    return float(value)
