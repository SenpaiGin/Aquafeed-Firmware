"""Fail-closed commissioning gates shared by startup and command admission."""

from __future__ import annotations


class SafetyError(RuntimeError):
    pass


def validate_commissioning(config: dict) -> None:
    if config.get("protocol_major") != 2:
        raise SafetyError("only protocol major 2 is supported")
    if not config.get("device_id"):
        raise SafetyError("physical device UUID is not configured")
    if not config.get("commissioned"):
        raise SafetyError("physical commissioning is incomplete")
    profile = config.get("physical_profile")
    if not isinstance(profile, dict) or not profile.get("approved_by_owner"):
        raise SafetyError("owner-approved physical capability profile is missing")
    if not config.get("calibration_file"):
        raise SafetyError("load-cell calibration is not configured")
    required = ("independent_cutoff_verified", "position_feedback_verified", "stop_behavior_verified")
    missing = [key for key in required if profile.get(key) is not True]
    if missing:
        raise SafetyError("physical safety evidence is missing: " + ", ".join(missing))


def actuator_permission(config: dict) -> bool:
    try:
        validate_commissioning(config)
    except SafetyError:
        return False
    return config.get("gpio_enabled") is True
