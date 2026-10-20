# Hardware integration acceptance and troubleshooting

Baseline: contract 2.7.0; source commit `2d208eca9ad68485f0295eda33b8a5c5adfbeed2`. Read the [main guide](../HARDWARE-DEVELOPER-HANDOFF.md) first. **Every physical, hosted and phone test below is NOT RUN by the author of this packet.** This is the execution plan for the hardware developer and owner.

## 1. How to record a result

For each test record: test ID; date/operator; device UUID; physical unit/board; firmware commit; local and server profile revisions; calibration revision; app build; backend deployment/migration baseline; setup; actual steps; expected versus observed behavior; evidence location; PASS/FAIL/NOT RUN; and remaining action.

For physical feeds also record target and independently weighed output per nozzle, before/after hopper readings, acquisition quality, actual start/stop/settling times, watchdog limit, stop feedback and sequence/event IDs. Define accuracy and repeat-count acceptance from the approved hardware profile before testing; this packet does not invent tolerances. Never call a synthetic number a measurement.

Use a controlled bench and an independent stop path for the authorized physical stages. Complete non-actuating tests first. Keep the simulator and real device on separate IDs, credentials and data directories. Only one process/operator controls the physical feeder.

## 2. Connection and authorization

| ID | Test | Expected result/evidence |
| --- | --- | --- |
| C01 | Compare app project URL and Pi project URL | Both use the owner-approved existing Supabase project |
| C02 | Verify deployed API/migration compatibility against packet baseline | 2.7.0 DTOs and current schedule `targets` understood; owner records actual deployed versions |
| C03 | Connect with the provisioned physical UUID/profile | Server identifies the correct device; `is_simulated=false`; no fixture identity reused |
| C04 | Send idle sync with no sensor samples and invalid clock | Valid JSON accepted; no actuator movement; unavailable values remain unavailable |
| C05 | Use missing, wrong and revoked machine credentials in isolated testing | 401/denial; no membership or command access; no secret in logs |
| C06 | Attempt cross-device identity substitution | Credential remains bound to its own device; returned command with wrong UUID rejected locally |
| C07 | Supply malformed/unsupported protocol, unknown nozzle or invalid dose | Rejected; no outputs; full payload not blindly replayed forever |
| C08 | Trigger pairing locally; redeem once on Android | Fresh challenge yields membership; reusable machine token never appears on phone |
| C09 | Replay, expire and exhaust a challenge | No duplicate or unauthorized membership; new window required |
| C10 | Scan permanent identity QR from an unpaired phone | Identity recognized, no access granted without fresh authorization |
| C11 | Reinstall phone; pair again; revoke prior installation | New identity works only after pairing; old membership denied after explicit revocation |
| C12 | Remove device from one of two paired installations | Other authorized installation remains; applied schedules do not disappear |
| C13 | Inspect device files, logs, crash messages and export bundle | No server key on Pi; no credentials/pairing secrets in shareable output |

## 3. Telemetry and Bluetooth DO

| ID | Test | Expected result/evidence |
| --- | --- | --- |
| T01 | Valid scale reading at empty, intermediate and approved full loads | Correct grams and percent within approved tolerance; calibration revision recorded |
| T02 | Missing/invalid load-cell calibration | Feed values and calibration revision null; quality uncalibrated; manual feed blocked |
| T03 | Disconnect/fault HX711, overload or inject non-finite read | Error/unavailable result; no fabricated zero/full inventory; no unsafe next leg |
| T04 | Reboot without changing actual hopper contents | No auto-full reset or automatic loaded-hopper tare; persistent sequence and calibration retained |
| T05 | Refill at idle; then reacquire valid settled stock | New stock reflects measurement; no artificial feed event or old-run resolution |
| T06 | Refill/contact/motion disturbs scale during a feed | Measurement invalidated or cycle handled under approved method; no false per-nozzle result |
| T07 | Valid Bluetooth reading from selected instrument | Known unit conversion to mg/L; correct sensor identity and acquisition time |
| T08 | Disconnect Bluetooth or move instrument out of range | DO unavailable/null after agreed acquisition-age limit; scale/sync/watchdog continue |
| T09 | Bluetooth stays connected but delivers no new measurements | Cached value is not freshly timestamped; eventually unavailable |
| T10 | Wrong unit, malformed packet, wrong nearby device | Invalid data rejected; no guessed conversion or sensor substitution |
| T11 | DO calibration required/expired or explicit sensor fault | Uncalibrated/error quality and null numeric reading |
| T12 | Reconnect Bluetooth repeatedly | Bounded retry; recovery on genuine new measurement; no busy loop or motor delay |
| T13 | Old, future, uncertain and invalid sample timestamps | No false fresh reading; invalid time uses null timestamp |
| T14 | Replay exact sample ID/content | Idempotent acknowledgment; history does not overwrite newer current sample |
| T15 | Replay sample ID with changed content | Conflict/rejection; firmware preserves forensic evidence and does not rename the record to evade it |
| T16 | More than 100 total samples or >262144-byte body | Explicit error; safely split batch, retain unsent records |
| T17 | Lose ACK after successful storage; reconnect | Same IDs replay safely; no data deletion until a validated ACK |
| T18 | Long outage exceeding telemetry storage budget | Bounded sample queue with locally recorded lost intervals; feeding evidence retained separately |
| T19 | Disconnect all sensors but keep authenticated sync running | Feeder contact can remain online; readings unavailable, not “healthy” |

## 4. Durability and execution, initially with a fake actuator

| ID | Test | Expected result/evidence |
| --- | --- | --- |
| D01 | Deliver identical manual command repeatedly, including after reboot | One durable identity; at most one physical start attempt |
| D02 | Reuse idempotency key/sequence with changed dose/order/profile | Conflict; no movement |
| D03 | Race two manual requests and a local schedule | One device reservation; explicit refusal/skip of unrelated collision |
| D04 | Kill process before acceptance commit | No physical start; retried delivery can be evaluated safely |
| D05 | Kill after acceptance, before physical-start intent | Recovery proves no start; no automatic execution of saved request |
| D06 | Kill after physical-start intent, before/after output activation | Conservative unknown and lockout; no duplicate feed on restart |
| D07 | Kill after nozzle 1 result is durable, before nozzle 2 | Preserve nozzle 1; nozzle 2 not started; no resumed Both |
| D08 | Kill after terminal result, before server ACK | Replay terminal events only; no movement |
| D09 | Full/read-only/corrupt storage | New actuation disabled before intent cannot be saved; clear diagnostic |
| D10 | Unknown or stale ACK identity | Reject acknowledgment; no unrelated event/sample removed |
| D11 | First sync phase succeeds but later RPC/response fails | Immutable records retried; no assumption of whole-request rollback |
| D12 | Attempt second agent against same device/journal | Single-owner mechanism prevents concurrent execution |
| D13 | Firmware upgrade and compatible rollback | Identity, journal, occurrences, lockouts, applied config and calibration survive |

## 5. Physical motor, weighing and safety acceptance

Only execute after actual wiring, ratings, protection, calibration and independent cutoff have been reviewed. Use the smallest already-approved test dose for commissioning; do not copy a simulator dose.

| ID | Test | Expected result/evidence |
| --- | --- | --- |
| H01 | Cold boot with actuator power available | No unintended motor/blower pulse before service starts; safe defaults measured |
| H02 | Map each actuator to its intended output | Correct nozzle, direction, swing and relay; damaged pin remains unused |
| H03 | Stop each drive and measure residual/coasting motion | Safe stop established by observation/feedback, not merely PWM=0 |
| H04 | Exercise independent watchdog with stalled/frozen agent | Actuator energy removed within approved bound; no network dependency |
| H05 | Process termination, OS shutdown and power loss during feed | Safe physical stop; restart retains unknown where required |
| H06 | Jam/stall/no-flow/feedback fault | Bounded stop, truthful failed/unknown result, later leg withheld as appropriate |
| H07 | Swing home/endpoints or feedback unavailable | No guessed position; bounded failure and safe stop |
| H08 | Blower startup/stop and electrical noise at scale | Timing and weighing method remain valid under measured interference |
| H09 | Single Nozzle 1 through app | Correct one-time action, weighed catch, per-nozzle result and ACK/history |
| H10 | Single Nozzle 2 through app | Nozzle 1 stays off; `step_index=1`, `nozzle_number=2` |
| H11 | Both with different approved doses | Nozzle 1 then nozzle 2, no overlap; separate measured amounts |
| H12 | Attempt another feed during stop/settling | Reservation remains held; no interleaving |
| H13 | Invalid settled baseline after first leg | Later leg not started; amount unavailable when unproven |
| H14 | Stock smaller than requested total; stock changes before second leg | Admission/start refused locally and by backend where applicable |
| H15 | Expire start deadline while command waits locally | No late start; correct non-start evidence |
| H16 | Repeated dose trials across approved range and hopper levels | Accuracy/repeatability/thermal/cooldown criteria established, not just one successful cycle |
| H17 | Failed cycle with independently valid partial weighing | Failed status retains measured partial amount; not automatically zero |
| H18 | Completed cycle without valid final weighing | Completed with amount unavailable; feeding-unmeasured alert possible |
| H19 | Local emergency stop | All relevant motion stops; unresolved outcomes and lockout preserved |

## 6. Configuration, scheduling and time

| ID | Test | Expected result/evidence |
| --- | --- | --- |
| S01 | Save a valid complete snapshot | Pending on app until durably applied; matching applied revision after ACK |
| S02 | Re-send same revision/snapshot | Idempotent; no duplicated occurrences |
| S03 | Same revision changed content, stale base, unsupported dose or duplicate nozzle slot | Whole snapshot rejected; prior applied snapshot intact |
| S04 | Update configuration during a feed | Staged until safe boundary; active sequence targets not retargeted |
| S05 | Rejected revision followed by a corrected revision | Revision chain reconciles using attempted/applied history; not stuck on wrong base |
| S06 | Run schedule with phone closed and internet disconnected | Pi uses applied snapshot and trusted clock; events uploaded later |
| S07 | Both schedule under one ID | One daily occurrence, two sequential steps with separate doses |
| S08 | Two separate same-time cross-nozzle schedules | One ordered group; nozzle 2 not skipped simply because nozzle 1 ran |
| S09 | Same-time Both plus overlapping single-nozzle schedule | Configuration rejected, no double use of a nozzle |
| S10 | Edit dose/nozzle/time after a schedule already ran that date | No second execution of that stable schedule/date |
| S11 | Remove/recreate a schedule | New identity for a new schedule; retired identity not reused |
| S12 | Reboot/forward clock jump past due time | Missed occurrence skipped; no catch-up feed |
| S13 | Backward jump/DST repeated hour | Occurrence ledger prevents duplicates |
| S14 | DST nonexistent hour/timezone change | Explicit deterministic handling; no inferred timezone changes |
| S15 | Clock invalid or uncertainty exceeds approved bound | Scheduled starts paused; correct quality/null report |
| S16 | Long offline holdover/power loss | Measured drift and RTC behavior support claimed scheduling period |
| S17 | Slow wait response | Never used to establish trusted clock |
| S18 | Schedule interrupted during movement | Unknown and lockout; reviewed scheduled-recovery path required before restoring feeding |

## 7. Optional conditional continuation and maintenance

| ID | Test | Expected result/evidence |
| --- | --- | --- |
| R01 | Nozzle 1 fails, no continuation proof | Nozzle 2 not started |
| R02 | Independently verified isolated N1 failure, safe stop, healthy device and settled valid baseline | If feature approved: N2 runs once; N1 never retried; aggregate partial |
| R03 | Missing/false/late continuation fields, bad clock or lockout | Continuation denied; physical controller also fails closed |
| R04 | Replay a previously acknowledged continuation event | No second N2 execution or replay conflict that loses evidence |
| R05 | Inspect manual unknown run and issue authorized maintenance acknowledgment | Lockout can clear; historical outcome remains unknown and amount null |
| R06 | Try to clear scheduled unknown through manual-only acknowledgment | Do not bypass API rejection; verify separately implemented scheduled recovery |
| R07 | Fresh inventory arrives while old operation is unknown | Inventory may recover; old run stays unknown and lockout is not silently cleared |

## 8. App and alert acceptance

| ID | Test | Expected result/evidence |
| --- | --- | --- |
| A01 | Observe queued/accepted/running/final phases | App never labels an admission response physical completion |
| A02 | Network timeout after manual submission | App recovers original key; no fresh feed automatically created |
| A03 | Completed, failed, partial, unknown and unmeasured histories | Correct requested/measured values and per-nozzle distinctions |
| A04 | Cross configured DO/feed thresholds with trustworthy samples | Backend alert facts appear once per crossing; no invented biological interlock |
| A05 | Finish a failed/partial/unknown/unmeasured sequence | Final feeding alert; no premature alert while later nozzle may still run |
| A06 | Android push in an owner-configured build | Actual phone display/tap verified separately; sender ticket alone is not a pass |
| A07 | Rename feeder on one authorized phone | Shared name/location refresh on another; metadata revision conflict handled |
| A08 | Fresh/stale readings and offline contact | Roughly 30 s metric / 45 s contact display policy observed; not used as motor watchdog |

## 9. Troubleshooting order

| Symptom | Check first | Action |
| --- | --- | --- |
| HTTPS request never reaches service | URL, DNS, network, TLS time/certificate and project match | Fix transport/time; keep local safety independent; do not disable certificate verification |
| 401 `AUTH_REQUIRED` | Actual machine token, revoked state, wrong project, gateway JWT configuration | Owner verifies device verifier and `device-api` deployment; do not substitute server key |
| 404 on wait | Older deployment or incorrect path | Keep timed sync; verify path/version with owner |
| 404 on sync | Wrong URL/path or missing function | Do not treat as normal wait fallback; owner inspects deployment |
| 422 `VALIDATION_FAILED` | Missing required nullable keys, timestamps, enum, sample totals, exact field names | Compare payload against reference and runtime parser; do not repeatedly send unchanged poison data |
| 413 `PAYLOAD_TOO_LARGE` | UTF-8 byte length, events and sample totals | Split batch while preserving identities/order |
| 409 `IDEMPOTENCY_CONFLICT` | Same identity was reused with altered content | Stop changing records; investigate journal/replay bug; preserve evidence |
| `CAPABILITY_MISMATCH`/unsupported dose | Server/local revision and bounds; `scheduled_both` | Jointly reconcile approved profile; never self-enable capabilities |
| `INVENTORY_UNAVAILABLE` | Feed quality, trusted sample time, calibration, capacity/percent and freshness | Repair/acquire a genuine valid stock measurement |
| `INSUFFICIENT_INVENTORY` | Combined gram doses and measured stock | Reduce request or refill and remeasure; no override by fabricated telemetry |
| Configuration remains pending | Pi fetching sync, validation rejection, active reservation, report revision | Inspect desired/applied/last attempt separately; preserve old applied config |
| Device online but DO missing | Bluetooth identity, packet unit, calibration and last acquisition age | Debug sensor adapter; not an app pairing failure |
| DO appears frozen but fresh | Cached values re-stamped on each sync | Fix acquisition-age policy; mark unavailable when no fresh sample |
| Current stock goes backwards after reconnect | Old backlog promoted to live; counter reset; identity collision | Preserve per-device live counter and separate backlog from current sample |
| N2 never starts after N1 | Safety/settling/stock/deadline/continuation reason | Verify actual stop and baseline; do not remove the safety check |
| Feeder stopped after reboot | Unknown intent or untrusted clock | Inspect/recover under maintenance procedure; never delete journal |
| 503/timeout after sending results | Partial server persistence possible | Retain and replay same events/samples; never repeat the feed |
| No phone push but alert exists | Android build/token/permission and owner sender configuration | Push troubleshooting belongs to backend/app; feeder still reports events |

## 10. Existing offline reference checks

These commands exercise contract/reference logic, not physical hardware. Run from the repository root with the documented dependencies already installed:

```text
npm run validate --prefix contracts
python contracts/scripts/validate.py
python supabase/scripts/art31_simulator.py --self-test
python supabase/scripts/art31_simulator.py --self-test-art33
python supabase/scripts/art31_simulator.py --self-test-telemetry
python supabase/scripts/art31_simulator.py --self-test-alerts
```

On Windows use `npm.cmd` if PowerShell's script policy requires it. The Python requirements are in `contracts/requirements.txt`. The simulator self-tests use temporary local SQLite databases; inspect the relevant entrypoint before running new commands. `--once`, `--backfill-hours` and normal simulator startup contact the backend and can execute simulated work; they are not read-only health checks and must not use a physical feeder's credentials.

Existing SQL tests under `supabase/tests` exercise backend behavior in an approved isolated database, not hardware. Their existence or historical results are not proof of this deployment's state. Run only with the owner's selected test resource and preserve credentials outside reports.

## 11. Sign-off

Connectivity is accepted only when the correct physical identity authenticates and Android shows honest readings. Physical feeding is accepted only after calibration, bounded stop, persistence, duplicate prevention and selected-nozzle behavior are measured. Scheduling additionally requires trustworthy offline time and a supported unknown-run recovery procedure. Conditional failure continuation and Android push each need their own explicit evidence.

Record any deferred feature as disabled/unavailable with an owner and follow-up. Do not label a partial bench pass as all hardware ready.
