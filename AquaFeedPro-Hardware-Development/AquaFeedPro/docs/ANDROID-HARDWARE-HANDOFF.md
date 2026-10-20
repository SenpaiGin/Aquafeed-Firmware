# Android preview and hardware handoff

**Scope:** ART-45 D6 source handoff for the integrated D2-D5 app and
simulator. It records a reproducible Android preview configuration and
future hardware evidence needs. The [Android build receipt](ART-45-ANDROID-BUILD.md)
pins the verified preview APK; physical feeder testing and hardware calibration
remain unverified.

**Updated:** October 10, 2026

This is the current implementation status for the v2 contract. The D1-only
status in [contracts/README.md](../contracts/README.md) has been updated.
Older D1 and toolchain notes remain historical where they describe work
completed before D2-D5.

## Android preview

The app remains Expo SDK 57 (expo 57.0.26, React Native 0.86.3), package ID
com.aquafeedpro.app, EAS project
1b3dc89f-3111-49d4-b91f-d5567e71d996, with the existing Graphite Bento
identity. Locked versions are in [mobile/package-lock.json](../mobile/package-lock.json).

In [mobile/eas.json](../mobile/eas.json):

| Profile | Distribution | Android artifact | EAS environment |
| --- | --- | --- | --- |
| development | internal development client | development client | development |
| preview | internal | APK | development |
| production | store profile | default store artifact | production |

Build from mobile with EAS CLI 24.8.0:

    npx eas-cli@24.8.0 build --platform android --profile preview

The repository-root [.easignore](../.easignore) retains the root `.gitignore`
rules and excludes documentation, local simulator state, generated tool
output, credentials, and signing material from the upload archive.

The app's Supabase client reads `EXPO_PUBLIC_SUPABASE_URL` and
`EXPO_PUBLIC_SUPABASE_PUBLISHABLE_KEY`. Set those to the approved development
URL and publishable key in the EAS `development` environment; both are public
client values, not authorization. Values are not recorded here. Never place
service-role keys, device credentials, pairing payloads, or private tokens in
the app bundle. The production profile maps only to the production
environment; no production backend or release is authorized by D6.

The coordinator built and inspected the internal preview after independent
source review. The [committed build receipt](ART-45-ANDROID-BUILD.md) records
the reviewed source commit, EAS build ID, artifact URL and APK checksum.
For a later authorized reproduction, identify the exact checkout with:

    git rev-parse HEAD

Use the full build-source hash in the receipt for the recorded APK. Later
receipt-only documentation does not change its app source or build inputs.
Physical Android installation and launcher/accessibility checks remain deferred.

See the official [SDK 57 reference](https://docs.expo.dev/versions/v57.0.0/),
[APK configuration guide](https://docs.expo.dev/build-reference/apk/),
[EAS environment usage](https://docs.expo.dev/eas/environment-variables/usage/),
[monorepo guide](https://docs.expo.dev/build-reference/build-with-monorepos/),
and [.easignore guide](https://docs.expo.dev/build-reference/easignore/).

## Clean checkout and local checks

Use Node 24 and Python 3.14. Start from the exact reviewed ART-45 commit:

    git clone https://github.com/kin2001/AquaFeedPro.git
    cd AquaFeedPro
    git checkout <reviewed-full-commit>
    git rev-parse HEAD
    cd mobile
    npm ci
    npm run lint
    npm run typecheck
    npm run format:check

From the repository root, install the pinned contract validator dependencies
in a local Python environment before running the contract checks:

    npm.cmd ci --prefix contracts
    npm.cmd run validate --prefix contracts
    py -3.14 -m venv "$env:TEMP\aquafeed-contracts-venv"
    & "$env:TEMP\aquafeed-contracts-venv\Scripts\python.exe" -m pip install -r contracts/requirements.txt
    & "$env:TEMP\aquafeed-contracts-venv\Scripts\python.exe" contracts/scripts/validate.py

The approved visual and interaction reference is [DESIGN.md](../DESIGN.md);
capability and evidence boundaries are in [requirements.md](requirements.md).
Existing focused mobile runners are listed by
[mobile/package.json](../mobile/package.json): device access, manual-feed
recovery, monitoring, and button-state checks. Schedule and API parser
self-checks remain under [mobile/scripts](../mobile/scripts).

These checks use the [v2 schema](../contracts/schemas/v2.schema.json),
[OpenAPI contract](../contracts/openapi.yaml), and
[shared fixture manifest](../contracts/fixtures/manifest.json). Protocol
major 2 requires explicit nozzle targets; major 1 is rejected as
unsupported. Contract validation and simulator checks do not prove hardware
behavior.

## Offline simulator and durable journal

[supabase/scripts/art31_simulator.py](../supabase/scripts/art31_simulator.py)
contains the existing local SQLite simulator and assert-based self-checks.
They use temporary local databases, do not call the cloud, and do not
actuate hardware. From the repository root:

    & "$env:TEMP\aquafeed-contracts-venv\Scripts\python.exe" supabase/scripts/art31_simulator.py --self-test
    & "$env:TEMP\aquafeed-contracts-venv\Scripts\python.exe" supabase/scripts/art31_simulator.py --self-test-art33
    & "$env:TEMP\aquafeed-contracts-venv\Scripts\python.exe" supabase/scripts/art31_simulator.py --self-test-telemetry

Expected successful output, copied from the simulator source (these D6
checks were not rerun):

    ART-31 simulator ordering, idempotency, atomic competing starts, deadline stops, durable event sequence, late acknowledgment, and restart lockout checks passed.
    ART-33 simulator checks passed: atomic configuration apply/reject, independent offline nozzles and doses, stable daily occurrence/outbox, invalid schedule/profile inputs, explicit manual collisions, DST gap/fold, clock jumps, and restart lockout.
    ART-27 simulator telemetry checks passed: deterministic valid/faulty readings, untrusted time, stable replay ACKs, durable backlog cap 100 including live, and persisted lost-sequence interval evidence, synthetic history backfill, and a non-flat fixture curve.

These are the current source summaries, not checks rerun for this D6 change.
D5 feature scenarios and API probe are recorded below.

The simulator persists its live journal in SQLite with WAL and full
synchronous writes. Keep its database and WAL files in a private
development directory; choose a location with the simulator's --db option.
The default is inside the current user's private data directory. At process
start, interrupted work is recovered as unknown, later nozzle legs remain
not-started, and the safety lockout remains. Never automatically repeat or
resume an uncertain action. Local journal recovery is simulator evidence,
not a firmware persistence test.

Use one simulator process per device ID, credential file, and journal. For a
restart, reuse the exact device ID, private credential file, and `--db` path;
do not start a new journal for an identity that has already used a live
cursor. Stop the process before making a consistent SQLite backup or moving
the journal, including its WAL state. The simulator reads public
`SUPABASE_URL` and `SUPABASE_PUBLISHABLE_KEY` values from its environment;
provide them separately through the authorized local environment. Set
PowerShell variables to the approved fixture ID and private local paths, then
run one sync cycle:

**Warning:** `--once` changes development cloud and local journal state, and
may apply configuration or run due schedules and accepted manual commands
with simulated actuation. Use only an authorized controlled fixture; it does
not operate GPIO and is not a read-only diagnostic.

    & "$env:TEMP\aquafeed-contracts-venv\Scripts\python.exe" supabase/scripts/art31_simulator.py --once --device-id "$DeviceId" --credential-file "$CredentialFile" --db "$JournalFile"

For a feeder with history and a populated app, see [DEMO-DATA.md](DEMO-DATA.md).

Never put the device credential itself in a command, shell history, log, app,
or build archive. The `--credential-file` path must remain private and match
the selected device ID.

## Development transport and access recovery

Use only the approved development Supabase project and controlled simulator
fixtures. The preview APK gets the development URL and publishable key from
EAS; it never gets a device credential. The simulator's --credential-file
input is a private device credential and must stay outside Git, build
archives, app storage, logs, and chat. Do not place a credential in a
command line or shell history.

Provisioning and live API calls are authorized-operator operations, not part
of the offline setup. The existing [D2 provisioning tool](../supabase/scripts/provision-d2-devices.mjs)
supports `node supabase/scripts/provision-d2-devices.mjs provision`,
`node supabase/scripts/provision-d2-devices.mjs resume`, and
`node supabase/scripts/provision-d2-devices.mjs pair`; it requires the
approved development `SUPABASE_URL`, and
`provision`/`resume` also require a server-side `SUPABASE_SECRET_KEY` (or the
legacy `SUPABASE_SERVICE_ROLE_KEY`) supplied privately by the coordinator.
The tool stores device credentials and pairing payloads in its private
directory. Do not record the values or path here, add a second provisioner,
or run these remote operations during local setup. Pairing uses a short-lived,
one-use challenge and grants only the current phone installation's device
membership. The phone stores its protected anonymous installation session,
not the feeder's reusable machine credential.

For a lost phone, revoke that installation's membership, or all memberships
if its identity is unknown, then recover through approved maintenance and
re-pair. This revokes phone access only; it does not rotate the feeder's
machine credential. The provisioner sets `p_allow_rotation=false` and refuses
to replace a missing saved credential, so machine credential rotation needs
the service-only maintenance path and explicit review; no public rotation UI
is implemented. The physical trigger, pairing presentation, device
credential storage, and prototype recovery process remain unverified.

### Permanent feeder identity QR

Each feeder has one permanent, printable, public QR. Its text is
`{"protocol_major":2,"purpose":"device_identity","device_id":"<uuid>"}` and
nothing else; the app rejects any other key, version, purpose or link. It is
derived from `device_id` alone, so restarts, `resume`, phone replacement and
machine-credential rotation never change it. A new identity exists only when
the feeder itself is replaced or factory-reset and re-provisioned under a new
`device_id`; routine startup never creates one. Anyone who holds the printed QR
learns the feeder id and nothing more: it cannot read, configure or feed.

`node supabase/scripts/provision-d2-devices.mjs identity` writes the public
`identity-<device_id>.json` (id, short label and `qr_payload`) and the
printable `identity-<device_id>.svg` for the provisioned simulator feeders;
print the SVG with the label. Run `npm ci` once at the repo root before
`identity` or `node supabase/scripts/check-d2-provisioning-recovery.mjs`, which
checks that the SVG is byte-identical per feeder (only the `qrcode` dev
dependency; the app does not use it). The other provisioning commands need no
root install.

Scanning it in the app:

- This phone is already authorized: the app opens that feeder.
- A new or additional phone, or one whose access was revoked: the app fills in
  the device id and asks for a challenge ID and pairing secret from a fresh
  pairing window. The identity QR never pairs by itself. A phone cannot fetch a
  window from the id; the operator opens one (`pair`) and hands over the
  temporary QR or code, which expires in five minutes and works once.
- Expired, used or wrong challenge: open a new window and try again.

Lost phone, simulator procedure (service key supplied privately by the
operator, never in chat or Git):

1. `node supabase/scripts/provision-d2-devices.mjs revoke <device_id> <installation_id>`
   ends only that installation's access. Other phones, schedules and history
   stay. Find the installation id in `device_access` for that feeder.
2. `node supabase/scripts/provision-d2-devices.mjs pair` opens a fresh window;
   the new phone installs, scans the identity QR and enters or scans the
   temporary details. App-storage loss or reinstall is the same: a new
   installation must pair, an old phone session is never restored.
3. If every phone is lost, only this operator path works; the printed QR alone
   is not enough. The real feeder's physical or admin path for opening a
   window is not built or approved; ART-48 must demonstrate it before field use.

The v2 schema is in [supabase/migrations](../supabase/migrations/) and its
access model is summarized in [supabase/README.md](../supabase/README.md):
installation membership scopes reads through RLS, installation clients have
read grants only, server routes validate installation access and device
identity, and device credentials and pairing state stay in the private
schema. The D2-D5 app/API and simulator work does not update firmware,
establish physical pairing, or authorize production.

## Contract changes and evidence owners

The product owner approves contract semantics and every breaking major
version. Change the versioned schema, OpenAPI document, shared fixtures and
manifest, and changelog together; run both existing validators and the
affected API, simulator, and mobile safety checks, then record the commit and
observed results. Apply migrations only when the reviewed data model requires
them and under separate authorization.

## Integrated evidence and truthful status

| Delivery | Integrated source | Recorded integration evidence |
| --- | --- | --- |
| D2, PRs [#8](https://github.com/kin2001/AquaFeedPro/pull/8) and [#9](https://github.com/kin2001/AquaFeedPro/pull/9) | 2777b214e46b899d376b663e31205f8d5de25cbc | Device access, secure installation session, pairing APIs, simulator provisioning |
| D3, PR [#10](https://github.com/kin2001/AquaFeedPro/pull/10) | a72e67346f8e5373ed4be06ad39775ddbf0c51e7 | Manual feed, durable command and simulator paths |
| D4, PR [#11](https://github.com/kin2001/AquaFeedPro/pull/11) | 7932d093255cddda66b59f0f3cf0a8f58e3fc5ab | Per-nozzle schedules and device configuration |
| D5, PR [#12](https://github.com/kin2001/AquaFeedPro/pull/12) | b80d35a9eac4850e7f7da946b7d737a120070c84 | Live monitoring, retention diagnostics, applied monitoring settings |

D5 exact-head candidate CI [run 37982897702](https://github.com/kin2001/AquaFeedPro/actions/runs/37982897702)
and merged-main CI [run 37983237037](https://github.com/kin2001/AquaFeedPro/actions/runs/37983237037)
both passed the mobile and contracts jobs.
At the D5 development checkpoint, the coordinator recorded a passing
simulator/API probe, restored the prior configuration, revoked temporary
test membership, and observed both functions active at version 5 and nine
migration versions through 20261009193033. These are historical results;
this handoff did not repeat live checks.

No destructive automatic retention job is enabled. Feeding evidence remains
durable until acknowledgement; telemetry is separately bounded and records
lost sequence intervals when data is dropped. Proposed retention periods
are not enabled policies. API success or simulator completion is not proof
of physical feeding, measured dispensing, calibration, accuracy, safety,
or production readiness. See the [contract changelog](../contracts/CHANGELOG.md)
and [requirements](requirements.md) for protocol and evidence owners.

## Hardware unknowns and per-nozzle calibration record

Both nozzles share one continuously suspended, weighed container. Each
sequence reserves the whole device; nozzle 1 must stop and have a valid
settled weighing baseline before nozzle 2 can start. A fault, uncertain
stop, invalid weight, or other partial result halts later work. Preserve
completed, failed/unknown, and not-started outcomes separately. Never
silently catch up after a clock change, restart, reconnect, or uncertainty.

Record a separate calibration for each nozzle; leave values blank until
measured:

| Field | Record |
| --- | --- |
| Device and hardware revision | |
| Nozzle number and calibration revision | |
| Dose mode and approved range/step | |
| Independent catch method and scale ID | |
| Reference masses, trials, and measured results | |
| Repeatability and uncertainty | |
| Feed type, refill state, and test conditions | |
| Stop behavior, settle criterion, and valid baseline evidence | |
| Watchdog/runtime limits and fault observations | |
| Operator, date, review, and evidence location | |

Still unknown: hopper capacity and tare/refill effects; mechanical and cable
forces; real settling interval; actuator runtime and watchdog limits; clock
source, uncertainty, and reboot behavior; DO sensor model, calibration,
fault behavior, and physical output units (the contract uses mg/L); and
safe-stop behavior under jams, power loss, sensor faults, and network loss.
Do not reuse simulator limits as hardware limits. Required hardware review
roles are not assigned by this handoff: mechanical/device and
calibration/metrology for weighed catches and safe stops; firmware/electrical
for watchdog and clock; sensor/instrumentation for DO; and device
security/firmware with backend/security review for pairing and recovery.
Biological DO thresholds or feed interlocks also need a product/domain
decision.

## Deferred acceptance checklist

All items below are deferred; none passed as part of this source handoff.

- **Physical Android smoke:** install the coordinator's reviewed APK on an
  owner-controlled Android phone; verify package/version and source/build
  provenance, launch, all four tabs, development fixture pairing/removal,
  camera-denial fallback, offline/error states, Android Back, and safe areas.
- **Accessibility and branding:** check screen-reader names/status, text
  scaling, focus order, contrast, app icon, splash, and permission prompts
  against [DESIGN.md](../DESIGN.md).
- **Hardware bench:** explicitly authorized work only; verify exclusive
  nozzle operation, independent catches/calibration, settling, safe stop,
  watchdog, clock, sensor faults, persistence, and recovery.
- **Deferred platforms/environments:** iOS, emulator acceptance, production
  provisioning/build/release, physical feeder actuation, and hardware claims.

The preview APK is an Android app artifact, not hardware acceptance. H1/H2
hardware work and iOS acceptance require their own owner authorization and
recorded evidence.
