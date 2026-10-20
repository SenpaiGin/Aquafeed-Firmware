"""Common validation, weighing and timing helpers for the mode entry points."""

from __future__ import annotations
import math
import time
from .load_cell import LoadCell
from .runtime import load_config, require_actuation_enabled


def positive(config: dict, key: str, maximum: float | None = None) -> float:
    value = config.get(key)
    if isinstance(value, bool) or not isinstance(value, (int, float)) or not math.isfinite(value) or value <= 0:
        raise ValueError(f"{key} must be a commissioned positive number")
    if maximum is not None and value > maximum:
        raise ValueError(f"{key} exceeds its configured safety limit")
    return float(value)


def start_sensors(config: dict) -> LoadCell:
    return LoadCell(config["load_cell_calibration_file"])


def settled_weight(scale: LoadCell, config: dict) -> float:
    """Require a configured run of stable samples before accepting a weight."""
    tolerance = positive(config, "settle_tolerance_g")
    window = config.get("settle_window_samples")
    timeout = positive(config, "maximum_settling_seconds")
    if type(window) is not int or window < 3:
        raise ValueError("settle_window_samples must be at least 3")
    deadline = time.monotonic() + timeout
    readings: list[float] = []
    while time.monotonic() < deadline:
        readings.append(scale.weight_g())
        readings = readings[-window:]
        if len(readings) == window and max(readings) - min(readings) <= tolerance:
            return sum(readings) / len(readings)
        time.sleep(0.2)
    raise RuntimeError("Load cell did not settle before the configured deadline")


def prepare(config_path: str | None) -> tuple[dict, LoadCell, float]:
    config = load_config(config_path)
    require_actuation_enabled(config)
    scale = start_sensors(config)
    try:
        before = settled_weight(scale, config)
    except Exception:
        scale.close()
        raise
    return config, scale, before


def report(before: float, after: float) -> None:
    delta = before - after
    print(f"settled_before_g={before:.1f}")
    print(f"settled_after_g={after:.1f}")
    print(f"hopper_mass_change_g={delta:.1f} (not proof of feed delivered to pond)")

