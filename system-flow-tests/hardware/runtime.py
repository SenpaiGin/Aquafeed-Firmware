"""GPIO access is lazy and locked behind explicit commissioning opt-in."""

from __future__ import annotations
import json
import os
from pathlib import Path


def load_config(path: str | None = None) -> dict:
    config_path = Path(path or os.environ.get("AQUAFEED_HARDWARE_CONFIG", "hardware-config.json"))
    try:
        config = json.loads(config_path.read_text(encoding="utf-8"))
    except (OSError, json.JSONDecodeError) as exc:
        raise RuntimeError(f"Cannot read hardware config: {config_path}") from exc
    return config


def require_actuation_enabled(config: dict) -> None:
    if config.get("commissioned") is not True:
        raise RuntimeError("Hardware is not commissioned; no GPIO will be initialized")
    if os.environ.get("AQUAFEED_HARDWARE_ENABLE") != "YES_I_HAVE_VERIFIED_THE_WIRING":
        raise RuntimeError("Set AQUAFEED_HARDWARE_ENABLE only after reviewing the wiring and cutoff")
    required = ("independent_cutoff_verified", "stop_behavior_verified", "load_cell_calibrated")
    missing = [key for key in required if config.get(key) is not True]
    if missing:
        raise RuntimeError("Commissioning evidence missing: " + ", ".join(missing))


def gpio_module():
    try:
        import RPi.GPIO as GPIO
    except ImportError as exc:
        raise RuntimeError("RPi.GPIO is available only on the Raspberry Pi runtime") from exc
    GPIO.setmode(GPIO.BCM)
    GPIO.setwarnings(False)
    return GPIO

