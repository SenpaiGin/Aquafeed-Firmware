# AquaFeedPro Raspberry Pi firmware

This is the physical-controller foundation for the Raspberry Pi feeder. It follows the supplied protocol 2.7.0 handoff and uses BCM GPIO numbering. The controller starts with all actuation disabled. Do not enable it until the as-built wiring, approved physical capability profile, calibration, watchdog/cutoff, and installation credentials have been supplied and reviewed.

The thesis describes feed-level sensing, time-based feeding, direct-drop/scatter distribution, logging and DO monitoring. The current hardware handoff supersedes thesis-era component assumptions where they conflict: shared HX711 hopper measurement is the inventory source, DO is a Bluetooth instrument, and the scatter nozzle uses a DC motor/DRV8871 arrangement rather than the older servo design. The handoff wiring map is still a reference and must be checked against the installed unit.

## Layout

- `aquafeed/` contains the controller, durable SQLite journal, v2 sync client, scheduler and hardware boundary.
- `config.example.json` documents non-secret commissioning fields. Copy and fill it only on the device; store credentials separately with restrictive permissions.
- `systemd/aquafeed.service` is a template; paths and service user must be adapted for the Pi installation.

The current hardware adapters deliberately fail closed. HX711 and Bluetooth sensor libraries/protocols depend on the actual purchased modules and instrument and are not guessed here. The actuator adapter never initializes GPIO until explicitly enabled and given a commissioned profile. This release provides no claim of physical acceptance or calibrated dispensing.

## Start

Use a supported Raspberry Pi OS/Python runtime and install only the hardware libraries selected for the actual device. Set `AQUAFEED_CONFIG` to the private configuration path and run `python -m aquafeed`. A missing credential, profile, calibration, trusted clock, sensor or hardware adapter keeps feeding unavailable. The first milestone is non-actuating authenticated telemetry; physical operations remain disabled until commissioning gates are completed.

Never use the sample credentials/device identifiers from the reference packet. The feeder authenticates only to `/device-api/v2/*`; it must not use a Supabase service-role key or write database tables directly.
