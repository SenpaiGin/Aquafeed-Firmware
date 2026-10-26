"""Standalone scatter flow check without load-cell access."""

from __future__ import annotations

import argparse
import time

from hardware.blower import BlowerRelay
from hardware.config_values import positive
from hardware.dispensing_motor import DispensingMotor
from hardware.position_feedback import SwingLimits
from hardware.runtime import load_config, require_flow_test_enabled
from hardware.swing_motor import SwingMotor


def run(nozzle: int, run_seconds: float, config_path: str | None = None) -> None:
    config = load_config(config_path)
    require_flow_test_enabled(config)

    nozzle_config = config.get("nozzles", {}).get(str(nozzle), {})
    max_seconds = positive(nozzle_config, "maximum_run_seconds")
    if run_seconds <= 0 or run_seconds > max_seconds:
        raise ValueError(
            f"run_seconds must be positive and <= commissioned limit ({max_seconds:g})"
        )
    duty = positive(nozzle_config, "pwm_duty_percent", 100)

    swing_config = config.get("swing", {})
    travel_limit = positive(swing_config, "maximum_travel_seconds")
    swing_duty = positive(swing_config, "pwm_duty_percent", 100)
    if config.get("swing_position_feedback_verified") is not True:
        raise RuntimeError("scatter mode requires verified home/end feedback on BCM21/BCM26")

    limits = swing = motor = blower = None
    try:
        limits = SwingLimits(config.get("limit_switch_active_level"))
        swing = SwingMotor()
        motor = DispensingMotor(nozzle)
        blower = BlowerRelay(config.get("blower_relay_active_level"))
        if not limits.home_active():
            raise RuntimeError(
                "swing is not at the verified home switch; home it under the maintenance procedure"
            )

        started = time.monotonic()
        swing_started = started
        direction = "scatter"
        try:
            blower.on()
            swing.drive(direction, swing_duty)
            motor.run(duty)

            while time.monotonic() - started < run_seconds:
                if time.monotonic() - swing_started > travel_limit:
                    raise RuntimeError("swing endpoint not reached before travel timeout")

                reached = limits.end_active() if direction == "scatter" else limits.home_active()
                if reached:
                    swing.stop()
                    time.sleep(0.15)
                    direction = "home" if direction == "scatter" else "scatter"
                    swing_started = time.monotonic()
                    swing.drive(direction, swing_duty)
                time.sleep(0.02)

            motor.stop()
            blower.off()

            # Finish in the verified home position after dispensing.
            if not limits.home_active():
                swing_started = time.monotonic()
                swing.drive("home", swing_duty)
                while not limits.home_active():
                    if time.monotonic() - swing_started > travel_limit:
                        raise RuntimeError("swing could not return to the verified home switch")
                    time.sleep(0.02)
                swing.stop()
        finally:
            motor.stop()
            swing.stop()
            blower.off()

        print(f"mode=scatter nozzle={nozzle} elapsed_seconds={time.monotonic() - started:.2f}")
        print("load_cell=not_used")
    finally:
        # Ensure each constructed device receives a stop/off and releases its pins.
        for device in (motor, swing, blower, limits):
            if device is not None:
                device.close()


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--nozzle", type=int, choices=(1, 2), required=True)
    parser.add_argument("--run-seconds", type=float, required=True,
                        help="duration within the commissioned per-nozzle maximum")
    parser.add_argument("--config", help="hardware JSON (or AQUAFEED_HARDWARE_CONFIG)")
    args = parser.parse_args()
    run(args.nozzle, args.run_seconds, args.config)
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
