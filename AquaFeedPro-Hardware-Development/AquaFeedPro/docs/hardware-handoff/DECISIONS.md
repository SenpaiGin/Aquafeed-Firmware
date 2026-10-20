# Device commissioning and open decisions

Prepared October 16, 2026. Use with the [hardware developer guide](../HARDWARE-DEVELOPER-HANDOFF.md). This is a fill-in record, not an approved physical profile. **Do not put secrets in this file.** Record the secure delivery location/reference only.

## Confirmed by the owner for this handoff

- Use the component arrangement in the supplied AquaFeedPro Revision B wiring: Raspberry Pi, two dispensing motors, swing motor, three DRV8871 drivers, blower/relay and shared hopper HX711/load cell.
- Final wiring may differ: developer verifies and records the actual pin map.
- Dissolved oxygen comes from a Bluetooth sensor connected to the Pi; exact implementation is unknown, so the software boundary stays general.
- Owner and hardware developer handle device setup together. The existing Supabase project is used; developer access is mainly to inspect when needed.

## Connection record

| Field | Value to fill | Evidence required |
| --- | --- | --- |
| Owner / hardware developer / backend contact | TBD | Names and responsibility |
| Supabase environment/project URL | Owner supplies | Correct project confirmed on app and Pi |
| Deployed app-api/device-api revision | To verify | Deployment receipt and read-only inspection |
| Applied migration baseline | To verify | Includes current 2.7.0 dependent migrations, or reviewed compatible baseline |
| Physical device UUID / serial / model | To allocate or verify | Dedicated physical record, not simulator UUID |
| Credential installation/rotation reference | Secure reference only | Pi authenticates; verifier belongs to same UUID; no secret in document |
| Approved profile revision / local hash | TBD | Server and local copy match |
| Firmware release / Pi OS / Python | TBD | Tested on actual Pi and supported device libraries |
| App Android build used for acceptance | TBD | Exact build/version |
| Timezone | Confirm Asia/Manila or actual site zone | Applied configuration |
| Network and outage expectations | TBD | Site test; DNS/HTTPS reachability |

## As-built hardware and measurement decisions

| ID | Decision/input | Current status | Responsible role / blocks |
| --- | --- | --- | --- |
| HW01 | Exact Pi model, board damage and actual BCM/physical pin table | Reference drawing available; installed wiring not verified | Developer; all GPIO use |
| HW02 | Motor, driver, relay and blower model/ratings, power/protection design | Unverified purchased variants | Electrical/mechanical; energized tests |
| HW03 | Dispensing IN2 actually grounded or controlled; output direction and stop method | Drawing grounds IN2; final wiring to verify | Developer; driver implementation |
| HW04 | Required revolution/portion mechanism and position/index feedback | Drawing intent only; feedback not shown | Mechanical/firmware; dose accuracy |
| HW05 | Swing home, endpoint definition, speed and return; feedback method | Slow swing intended; actual implementation TBD | Mechanical/firmware; safe cycle |
| HW06 | Blower/swing start/stop timing relative to dispense and scale settle | TBD | Mechanical/firmware; measured cycle |
| HW07 | Independent actuator cutoff/watchdog and local emergency stop | Not established by drawing or Python tests | Electrical/firmware; all physical feeding |
| HW08 | Load-cell rating, HX711 board variant and electrical interface | Shared hopper confirmed; exact hardware/calibration TBD | Instrumentation; stock and dose measurement |
| HW09 | Hopper tare/capacity, stability window, uncertainty and repeatability | Must measure; 20 kg source value is simulator data | Calibration; valid inventory profile |
| HW10 | Per-nozzle dose mode, minimum/maximum/step or portion IDs | Must calibrate | Calibration/mechanical; feed controls |
| HW11 | Per-nozzle max actuation and cooldown, maximum settling | Must establish from bench evidence | Safety/firmware; bounded execution |
| HW12 | DO Bluetooth model/protocol and instrument identity selection | Bluetooth to Pi confirmed; implementation unknown | Instrumentation/firmware; valid DO |
| HW13 | DO units/conversion, calibration, acquisition age, reconnect policy | TBD; no BLE UUID/vendor packet guessed | Instrumentation; valid mg/L and freshness |
| HW14 | Clock source, RTC presence, drift/holdover and uncertainty bound | Unknown | Firmware/electrical; offline schedules |
| HW15 | Physical pairing trigger and temporary presentation method | Backend challenge exists; physical UI TBD | Owner/developer; secure pairing |
| HW16 | Fixed-portion inventory policy if that mode is selected | Backend cannot know portion mass | Owner/developer; safe portion admission |
| HW17 | Per-profile schedule count, grace and scheduled Both enablement | Must validate; simulator count is not a hardware guarantee | Firmware; local schedules |
| HW18 | Manual unknown inspection/clear procedure and scheduled unknown backend support | Manual wire event exists; scheduled counterpart not supported | Owner/backend/developer; unattended operation |
| HW19 | Lost-phone membership revocation and machine credential rotation | Joint operator procedure needed | Owner/backend; maintenance |
| HW20 | Failed-N1 continuation evidence and permission | Disabled until bench acceptance | Owner/developer; optional continuation |
| HW21 | Biological DO thresholds and any feed interlock | No biological interlock authorized | Owner/domain specialist; future behavior change only |

## Profile approval worksheet

Fill in the real values and attach measurements. Do not replace TBD with simulator numbers to make the UI enable controls.

| Profile field | Physical value / evidence reference |
| --- | --- |
| `is_simulated` | `false` for real unit; backend controlled |
| `capabilities_revision` | TBD, owner-approved revision |
| `do_monitoring` | TBD after Bluetooth measurement validation |
| `feed_remaining_monitoring` | TBD after scale validation |
| `feed_capacity_g` | TBD; positive capacity or null if unknown |
| `local_schedule_execution` / `max_schedules` | TBD; false/null until supported |
| `scheduled_both` | false until sequential scheduled Both accepted |
| `max_clock_uncertainty_ms` | TBD measured scheduling-safety bound |
| `scheduler_wake_grace_ms` | TBD; not permission for catch-up feeding |
| `maximum_settling_ms` | TBD validated upper bound |
| N1/N2 `enabled` | Independently approved |
| N1/N2 `dose_modes` | Approved modes only |
| N1/N2 `fixed_portion_ids` | Approved IDs or empty list |
| N1/N2 `min_dose_g`, `max_dose_g`, `dose_step_g` | Calibrated values for grams; null when unsupported |
| N1/N2 `measured_dispensed_g` | True only after independent catch-weight validation |
| N1/N2 `max_actuation_ms` | Independently enforced maximum |
| N1/N2 `minimum_cooldown_ms` | Validated value or unknown/null |

## Decision log template

```text
Decision ID:
Date and responsible person:
Observed hardware / measured evidence:
Chosen value or behavior:
Why it meets the requirement:
Affected local profile / calibration / firmware / contract revision:
Backend or app change required:
Acceptance tests and results:
Remaining limitations / disabled capabilities:
Owner approval reference:
```

## Ready-to-start boundary

The developer can begin protocol/journal implementation and Bluetooth documentation discovery now. A safe non-actuating first sync needs the owner-provided physical identity/credential and compatible deployed API. Hardware motion additionally needs the actual wiring, protection, calibration, bounds and cutoff evidence. Unattended scheduling additionally needs clock acceptance and a reviewed scheduled-unknown recovery path. These are separate milestones; access to the Supabase dashboard alone does not establish them.
