"""Direct-drop dispersion flow: one selected nozzle, bounded by commissioned time."""

from __future__ import annotations
import argparse
import time
from hardware.dispensing_motor import DispensingMotor
from hardware.flow_support import positive, prepare, report, settled_weight


def run(nozzle: int, run_seconds: float, config_path: str | None = None) -> None:
    config, scale, before = prepare(config_path)
    motor = None
    try:
        nozzle_config = config.get("nozzles", {}).get(str(nozzle), {})
        max_seconds = positive(nozzle_config, "maximum_run_seconds")
        if run_seconds <= 0 or run_seconds > max_seconds:
            raise ValueError(f"run_seconds must be positive and <= commissioned limit ({max_seconds:g})")
        duty = positive(nozzle_config, "pwm_duty_percent", 100)
        motor = DispensingMotor(nozzle)
        started = time.monotonic()
        try:
            motor.run(duty)
            while time.monotonic() - started < run_seconds:
                time.sleep(min(0.05, run_seconds))
        finally:
            motor.stop()
        time.sleep(positive(config, "post_feed_settle_delay_seconds"))
        after = settled_weight(scale, config)
        print(f"mode=direct_drop nozzle={nozzle}")
        report(before, after)
    finally:
        if motor is not None:
            motor.close()
        scale.close()


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--nozzle", type=int, choices=(1, 2), required=True)
    parser.add_argument("--run-seconds", type=float, required=True,
                        help="duration within the commissioned per-nozzle maximum")
    parser.add_argument("--config", help="commissioned hardware JSON (or AQUAFEED_HARDWARE_CONFIG)")
    args = parser.parse_args()
    run(args.nozzle, args.run_seconds, args.config)
    return 0


if __name__ == "__main__":
    raise SystemExit(main())

