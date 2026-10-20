"""Safe startup and diagnostics entry point."""

from __future__ import annotations
import json
import os
import sys
from pathlib import Path
from .hardware import Actuators, Sensors
from .journal import Journal
from .safety import SafetyError, validate_commissioning


def main() -> int:
    config_path = Path(os.environ.get("AQUAFEED_CONFIG", "/etc/aquafeed/config.json"))
    try:
        config = json.loads(config_path.read_text(encoding="utf-8"))
    except (OSError, json.JSONDecodeError):
        print("AquaFeedPro: configuration unavailable; feeding disabled", file=sys.stderr)
        return 2
    data_dir = config.get("data_dir", "/var/lib/aquafeed")
    try:
        journal = Journal(str(Path(data_dir) / "journal.sqlite3"))
        actuators = Actuators(config)
        actuators.all_off()
        sensors = Sensors(config)
    except Exception as exc:
        print(f"AquaFeedPro: safe startup failed ({type(exc).__name__}); feeding disabled", file=sys.stderr)
        return 2
    try:
        validate_commissioning(config)
        status = "commissioned; network loop and approved adapters required"
    except SafetyError as exc:
        status = f"feeding disabled: {exc}"
    print(f"AquaFeedPro boot={journal.boot_id} sensors={sensors.__class__.__name__}: {status}")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
