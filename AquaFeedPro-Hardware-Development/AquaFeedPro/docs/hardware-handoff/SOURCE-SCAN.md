# Source scan, integration gaps and verification record

Prepared October 16, 2026 (Asia/Manila). This is a hardware-integration review of the repository's major subsystems and their connected protocol paths, plus the local hardware mirror and supplied wiring. It is not a claim that every line is bug-free, a penetration test, deployed-system verification or physical acceptance.

## Checkout and pull

- Repository: `D:\thesis commision\Automated Fish Feeding System\AquaFeedPro`.
- Branch: `main`; remote: `https://github.com/kin2001/AquaFeedPro.git`.
- `git fetch origin main` and `git pull --ff-only origin main` completed; Git reported **Already up to date**.
- Reviewed source baseline: `2d208eca9ad68485f0295eda33b8a5c5adfbeed2`, merge of PR #61 / shared metadata.
- Contract/schema/fixture manifest: **2.7.0**; wire major **2**.
- Inventory: 323 tracked files; 176 under contracts, 70 under mobile, 43 under Supabase, 20 under docs, plus root/workflow/planning/configuration files. There are 18 SQL migrations. Current OpenAPI has 20 paths and 23 operations.

The working checkout was already dirty. Existing modifications in workflow/checkpoint documents, `mobile/app.json`, `mobile/src/lib/device-access.tsx` and `supabase/scripts/art31_simulator.py`, plus existing untracked branding, checkpoint and mobile configuration files, were preserved. No stash/reset/checkout replacement was used. The simulator's local change was a comment; the app local changes support a development web preview and local Google services configuration. These are not physical-feeder protocol changes. The portable reference source, when packaged, is taken from the pinned Git commit, not those local edits.

## Review coverage and where the developer should look

Paths below are relative to the repository root; source links are usable in the repository and in the reference bundle.

| Area reviewed | Source and important entry points | Integration conclusion |
| --- | --- | --- |
| Architecture and requirements | [AGENTS](../../AGENTS.md), [workflow](../../AI_DEVELOPMENT_WORKFLOW.md), [DESIGN](../../DESIGN.md), [requirements](../requirements.md), [delivery plan](../../planning/DELIVERY_PLAN.md) | Two nozzles, one shared scale, durable local scheduling and explicit evidence boundaries |
| Wire shape and fixtures | [OpenAPI](../../contracts/openapi.yaml), [v2 schema](../../contracts/schemas/v2.schema.json), [changelog](../../contracts/CHANGELOG.md), [fixture manifest](../../contracts/fixtures/manifest.json), both validators | Current schedule format and new events must be used; schema is not the whole runtime contract |
| Device authentication/routes | [device-api](../../supabase/functions/device-api/index.ts): `Deno.serve`, `syncManualFeed`, `validDeviceSync`, `validRunEvent`, `validContinuationEvidence` | Machine credential identity; only sync delivers commands; wait is wake-only |
| Shared boundary validation | [device-access helper](../../supabase/functions/_shared/device-access.ts), [telemetry helper](../../supabase/functions/_shared/telemetry.ts) | Runtime input checks, safe error envelopes, nullable quality/value coupling |
| App API orchestration | [app-api](../../supabase/functions/app-api/index.ts) | Installation authorization, feed/config/history/monitoring/alerts and shared metadata |
| Durable data and access | [foundation migration](../../supabase/migrations/20261002194139_art7_two_nozzle_v2_secure_data_foundation.sql), [pairing/access migration](../../supabase/migrations/20261002213633_art38_pairing_and_access.sql), [types](../../supabase/database.types.ts) | RLS-protected installation reads, private credentials and device-wide reservation |
| Feeding/scheduling SQL | [manual feed](../../supabase/migrations/20261007065452_art31_manual_feed_execution_history.sql), [scheduled feed](../../supabase/migrations/20261009120000_art33_independent_nozzle_schedules.sql), their later patches | Read migration chain in order; later definitions/patches supersede early functions |
| Inventory/recovery changes | [inventory profile](../../supabase/migrations/20261015060257_art97_inventory_profile_durability.sql), [stock admission/no-admission recovery](../../supabase/migrations/20261015113815_art97_stock_policy_manual_recovery.sql) | Fresh measured stock required for manual admission; durable synthetic inventory is not a scale driver |
| Both and continuation | [ART-98](../../supabase/migrations/20261016090000_art98_scheduled_both_continuation.sql), [continuation replay](../../supabase/migrations/20261016100000_art98_continuation_replay.sql) | Ordered schedule targets, profile revision 5 for simulators, device-authored continuation proof |
| Alerts and metadata | [feeding alerts](../../supabase/migrations/20261016120000_art100_feeding_alerts.sql), [shared metadata](../../supabase/migrations/20261016140000_art102_shared_device_metadata.sql), [push sender](../../supabase/functions/_shared/push-sender.ts) | Backend owns alerts/push; device reports facts; shared feeder labels |
| Simulator | [art31_simulator.py](../../supabase/scripts/art31_simulator.py): `Simulator`, `DeviceApi`, `accept_command`, `execute`, `run_due_schedules`, `recover_after_restart`, ACK helpers | Useful protocol/journal reference with synthetic execution, readings, clock and limits |
| Operator provisioning | [provision-d2-devices.mjs](../../supabase/scripts/provision-d2-devices.mjs) | Explicit simulator-only provisioning and private credential files; not real onboarding |
| Mobile consumers | [device access](../../mobile/src/lib/device-access.tsx), [QR/access state](../../mobile/src/lib/device-access-state.ts), [manual feed](../../mobile/src/lib/manual-feed.ts), [schedules](../../mobile/src/lib/schedules.ts), [monitoring](../../mobile/src/lib/monitoring.ts) | Actual app expectations for profile, inventory, stable request keys, revisions and freshness |
| Mobile updates/notifications | [Realtime hints](../../mobile/src/lib/device-changes.ts), [alerts](../../mobile/src/lib/alerts.ts), [notification controller](../../mobile/src/lib/notification-controller.tsx), connected app screens | Hints trigger authorized reads; device does not use these as a command channel |
| Checks and delivery | [CI](../../.github/workflows/ci.yml), [mobile package scripts](../../mobile/package.json), [SQL tests](../../supabase/tests), [Android/hardware guide](../ANDROID-HARDWARE-HANDOFF.md) | Existing local fixtures and test procedures; hosted/Android/physical results are separate |
| Local hardware mirror | Workspace sibling `fishFeeder/src/{main,loadcell,motor,servo,calibrateLoadcell}.py`, `src/test/hardwaretest.py` | Load-cell monitor and individual hardware helpers; no end-to-end physical device agent |
| Supplied drawing | Workspace sibling `hardware-wiring/kicad/AquaFeedPro-Wiring-preview.png` and `AquaFeedPro-Wiring.xml`; wiring draft | Reference net map confirmed; actual installation differs or remains to verify |

The Notion master plan was retrieved for orientation. Its returned status content was dated October 3 and predates current code, so it was not treated as current delivery/deployment status. The owner supplied the October 16 clarification that DO is Bluetooth-to-Pi and the component set follows the drawing while actual wiring may differ. That clarification takes precedence over older unknown-sensor notes.

## Findings that affect the handoff

### 1. Physical controller and approved provisioning remain integration work

The local mirror has no device HTTP loop, durable sequence/occurrence journal, two-nozzle executor, Bluetooth DO adapter or service wrapper. The simulator explicitly limits IDs and synthesizes actuation outcomes. The only repository provisioning RPC is `art38_provision_simulated_device`; its script is restricted to the development project and fixture IDs.

**Consequence:** the developer needs a real agent and a verified owner-provided physical record/profile/credential. Supabase access does not mean rebuilding the backend, but it also does not prove that the physical unit is already provisioned. The guide separates owner checks from firmware work.

### 2. The old actuator test does not match the supplied wiring

`hardwaretest.py` uses BCM18/13 for one motor and BCM19 for an MG996R. The drawing/XML grounds dispensing IN2, uses BCM18 and BCM17 for the two nozzles, BCM22/23 for swing, and marks physical pin 33/BCM13 damaged. The `Motor` helper requires two GPIO inputs and supports reversing.

**Consequence:** do not run the old test or wire from it. Verify actual terminals and write the correct adapter. With the drawing's grounded IN2, zero PWM is coast, not proof of stopped motion. The owner has not asked this documentation task to alter wiring or actuate anything.

### 3. Request-wide sync atomicity is overstated in OpenAPI prose

OpenAPI's sync description says no partial acceptance. In `syncManualFeed`, telemetry, configuration report, scheduled events and manual events are separate awaited RPC calls. A later failure returns an error after earlier RPC calls may already have committed.

**Consequence:** implement replay-safe immutable identities and retain all records until explicit ACK. The packet calls out this behavior rather than promising HTTP failure means no writes. Whether the server should become request-atomic or its prose should change is a backend follow-up; neither was changed here. This is a static source finding, not a live fault-injection result.

### 4. Scheduled unknown maintenance recovery has no equivalent supported event path

The schema describes maintenance acknowledgments broadly, but `validRunEvent` explicitly rejects `source=scheduled` with `event_type=maintenance_acknowledged`. The simulator persists scheduled unknown/lockout state. Manual recovery events and the app's no-admission receipt solve different problems.

**Consequence:** owner/backend/developer must agree and implement a supported scheduled-recovery procedure before unattended physical scheduling. Do not clear this by deleting journal entries, changing identities or manually bypassing safety fields.

### 5. Contract fixture acceptance is not exact route acceptance

The shared `additive-field-valid` fixture passes schema validation for an extra field in PairingWindowRequest, while the actual pairing-window handler uses `onlyKeys` for only protocol_major/request_id. The event handler also adds checks not fully represented by basic schema shape (such as the scheduled maintenance restriction).

**Consequence:** send exact documented runtime fields and test against a reviewed backend instance. The generated examples use exact allowed fields. Passing JSON Schema alone is not an end-to-end admission result.

### 6. Current documentation and illustrative fixture details have drift

- `contracts/README.md` describes 21 operations/19 paths; current OpenAPI contains 23 operations/20 paths.
- Older requirements/Android handoff descriptions predate scheduled Both, inventory changes, public identity QR and shared metadata. In particular, the old “one nozzle per schedule” description is superseded by current `targets` and `scheduled_both`.
- `simulator-capabilities-valid.json` uses revision 5 but leaves max_clock_uncertainty_ms and maximum_settling_ms null. Current effective simulator provisioning and Python constants use 1,000 ms for both. That fixture is structurally valid and is not a physical or deployment-ready profile.
- A validator fixture description still mentions 5–100 g, while current simulator profile bounds are 5–20,000 g. None is a real dose recommendation.

**Consequence:** this packet pins source/contract version and explains effective behavior. Read the full migration chain, not just the earliest function definition, and do not copy a fixture as a commissioning profile.

### 7. Physical sensor timestamps and continuation proof need adapter discipline

Telemetry has one measured_at for the combined sample; no Bluetooth-specific status, device timestamp or separate DO calibration revision is transmitted. Continuation accepts device-authored proof but cannot itself measure physical stop/settling.

**Consequence:** keep sensor acquisition ages and detailed diagnostics locally; never relabel a cached DO value fresh. Enable failure continuation only after real feedback-based acceptance. Additional wire fields require coordinated changes.

### 8. No remote emergency stop exists in the feed command contract

`CommandDelivery.command_type` is `feed`. No stop/cancel command or GPIO control endpoint is present in the reviewed device surface.

**Consequence:** local independent stop/watchdog and maintenance are mandatory parts of the physical controller design. Do not promise that removing the app device or closing the phone stops local schedules or an active motor.

## Verification performed for this documentation

- Git root/branch/status/HEAD and remote-main pull checked.
- Major integration paths and current migration replacements inspected; pre-existing local product diffs inspected and preserved.
- Supplied wiring image inspected and XML nets parsed: 23 named connected nets plus the explicitly unconnected relay NC node. This is a source connection map, not a fresh ERC or electrical bench test.
- TypeScript contract validator completed successfully against the current manifest/OpenAPI.
- Python contract validator passed **85 schema fixtures and 22 behavior fixtures**.
- **12 new documentation example files** validated against the current Draft 2020-12 schema; the normal events file contains six individually validated RunEvents.
- Documentation link/structure/example consistency review performed; package verification is recorded in the portable bundle manifest when delivered.

No application logic, migration, GPIO helper or deployed service was changed. No package installation, Supabase write, provisioning, credential rotation, app build, phone operation, Pi connection or actuator run was performed. Existing simulator self-tests, mobile tests and SQL database tests are listed as future checks in the acceptance plan; they were not rerun for this documentation-only change. CI at the remote HEAD was not inspected. Bluetooth integration, real hardware safety/calibration and hosted deployment readiness remain unverified.

## Interpretation

The repository supplies a substantial app/backend/protocol/simulator baseline. The missing bridge is a physically validated Pi agent and the owner-approved real-device setup/recovery details. The packet is sufficient to implement against the reviewed wire behavior while explicitly reserving unknown physical values for measurement and joint decisions; it does not certify the existing feeder ready to run.
