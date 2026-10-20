# AquaFeedPro hardware developer packet

Prepared October 16, 2026 (Asia/Manila).

**Start with [the hardware developer handoff](AquaFeedPro/docs/HARDWARE-DEVELOPER-HANDOFF.md).** It explains the full app/backend/Pi connection and what to implement.

Then read:

1. [Protocol reference and payload examples](AquaFeedPro/docs/hardware-handoff/PROTOCOL-REFERENCE.md).
2. [Acceptance tests and troubleshooting](AquaFeedPro/docs/hardware-handoff/ACCEPTANCE.md).
3. [Commissioning decisions to fill in together](AquaFeedPro/docs/hardware-handoff/DECISIONS.md).
4. [Source scan, gaps and verification record](AquaFeedPro/docs/hardware-handoff/SOURCE-SCAN.md).

The owner confirmed the component arrangement in the included wiring and a Bluetooth DO sensor connected to the Pi. Final wiring and the Bluetooth protocol must be established by the developer. This packet does not guess BLE details or physical calibration/safety limits.

Supabase is an existing project. Owner and hardware developer jointly confirm the physical feeder record, credentials, approved profile and deployed compatibility; this is not an instruction to rebuild the backend.

## What is included

- Five handoff documents and twelve schema-validated example payload files, plus an example manifest.
- Selected app, API, SQL, simulator, validator and contract source from commit `2d208eca9ad68485f0295eda33b8a5c5adfbeed2` (contract 2.7.0 / protocol major 2).
- The supplied wiring PDF, preview image, XML netlist and prior wiring draft.
- The existing local fishFeeder Python files as **legacy reference only**. They are not an app-connected controller; the old motor test uses a damaged pin shown in the drawing and must not be run unchanged.
- A manifest with SHA-256 hashes so the received files can be checked.

This is a curated reference packet, not a full Git checkout or installable physical firmware release. Clone the repository and use the pinned commit for reproducible source work. Some historical documentation included as reference predates the newer behavior; follow the new handoff and current canonical contract/migration chain.

## Verified and unverified

The local main pull was already up to date. Both existing contract validators passed; Python reported 85 schema and 22 behavior fixtures. All twelve new examples validated against the current schema; new documentation links/structure and ZIP integrity were checked.

No live Supabase verification/write, credential provisioning, phone test, Pi connection, Bluetooth integration, calibration or motor actuation was performed by this documentation task. Do not interpret a schema-valid example or simulator result as permission or proof to run hardware.

No real device credential, pairing secret, server key, phone session, private environment file, journal or calibration file is included. Example secrets are conspicuous nonfunctional placeholders.
