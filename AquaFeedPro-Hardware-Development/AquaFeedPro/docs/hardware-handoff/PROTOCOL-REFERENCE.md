# Device protocol reference: contract 2.7.0

Source commit `2d208eca9ad68485f0295eda33b8a5c5adfbeed2`. Read the [main guide](../HARDWARE-DEVELOPER-HANDOFF.md) for implementation and safety semantics. The tables below are generated from the current JSON Schema, followed by runtime rules that a schema alone cannot prove.

Canonical sources: [JSON Schema](../../contracts/schemas/v2.schema.json), [OpenAPI](../../contracts/openapi.yaml), [device route/parser](../../supabase/functions/device-api/index.ts), [telemetry parser](../../supabase/functions/_shared/telemetry.ts), and the ordered [migrations](../../supabase/migrations).

## Request construction

Base: `<owner-approved Supabase project URL>/functions/v1`. Append `/device-api/v2/sync`, `/device-api/v2/wait` or `/device-api/v2/pairing-window`. These are POST routes. Do not append a device UUID to them: identity comes from the bearer credential.

```http
Authorization: Bearer <this feeder's private machine credential>
apikey: <project publishable key>
Content-Type: application/json
X-Protocol-Major: 2
X-Request-Id: <UUID matching body.request_id>
```

Use a real credential delivered securely at installation, never the placeholder. The source simulator sends these headers. Device parsers rely on the body protocol/request IDs; send both headers and body consistently. Installation routes instead require the phone's installation JWT and active membership. The Pi does not use `/app-api` to submit its own manual feed requests.

`device-api` has gateway `verify_jwt=false` because the device token is not a Supabase Auth JWT. The handler still authenticates it against a private verifier on every request. `app-api` has `verify_jwt=true` and checks installation access. A disabled gateway JWT check is not public unauthenticated device access.

## Example files and how to use them

All example UUIDs, timestamps, readings, doses and timing values are synthetic documentation fixtures. The dates are fixed and would be expired if sent later. Capability revision 1 and the example 20,000 g capacity relationship do not define your approved hardware profile. Validate the data shape; substitute measured/allocated values only in the implemented agent. Do not run these as live feed commands.

| File | DTO | Use |
| --- | --- | --- |
| [01-first-sync.json](examples/01-first-sync.json) | `DeviceSyncRequest` | First authenticated contact without valid time or sensors; outputs disabled. |
| [02-live-sync-do-unavailable.json](examples/02-live-sync-do-unavailable.json) | `DeviceSyncRequest` | Valid shared inventory with Bluetooth DO unavailable; no fabricated DO value. |
| [03-sync-response-with-command.json](examples/03-sync-response-with-command.json) | `DeviceSyncResponse` | A server response delivering an ordered manual command; validate before admission. |
| [04-configuration-both.json](examples/04-configuration-both.json) | `ConfigurationSnapshot` | A desired configuration containing one daily Both schedule; requires approved capability. |
| [05-wait-request.json](examples/05-wait-request.json) | `DeviceWaitRequest` | Initial wake request; token null. |
| [06-wait-response.json](examples/06-wait-response.json) | `DeviceWaitResponse` | Wake hint only, no command or trusted time. |
| [07-pairing-window-request.json](examples/07-pairing-window-request.json) | `PairingWindowRequest` | Request after authorized physical pairing action. |
| [08-pairing-window-response.json](examples/08-pairing-window-response.json) | `PairingWindowResponse` | Secret-bearing response, illustrative placeholder only; never log real content. |
| [09-manual-both-events.json](examples/09-manual-both-events.json) | `RunEvent[]` | Normal Both lifecycle as an array of six individual RunEvent objects. |
| [10-unknown-event.json](examples/10-unknown-event.json) | `RunEvent` | Alternative unknown first-step event after an uncertain restart. |
| [11-maintenance-event.json](examples/11-maintenance-event.json) | `RunEvent` | Alternative manual maintenance resolution; prior outcome stays unknown. |
| [12-scheduled-accepted-event.json](examples/12-scheduled-accepted-event.json) | `RunEvent` | First scheduled acceptance event; the rest of its sequence must still be implemented. |

The events file is an array to place under `DeviceSyncRequest.events`, not a new endpoint body. The unknown and maintenance files illustrate an alternative branch, not a continuation of the completed example. In a real Both unknown sequence also persist/report the later leg as not started; choose the next event number from the real journal. Scheduled acceptance requires the matching applied configuration and occurrence identity already persisted. Schema-valid examples alone do not prove that an API will admit them in an arbitrary server state.

## Important value and identity rules

- Required nullable fields must be present as JSON `null`; absence, an empty string and zero mean different things.
- Use finite JSON numbers. Never send NaN, infinity, a numeric string or a Python Boolean where an integer is required.
- UUIDs are stable identities; generate genuine UUIDs in firmware. Normalize casing consistently for deduplication.
- UTC timestamps use `YYYY-MM-DDTHH:MM:SS[.fraction]Z`; local date uses `YYYY-MM-DD`; schedule time uses 24-hour `HH:MM` and a supported IANA timezone.
- `request_id` correlates one exchange. It is not the durable duplicate-prevention key for a feed.
- Sample identity is `(device_id, boot_id, sequence)`; event identity is `(device_id, sequence_id, event_sequence)`; scheduled occurrence identity is `(device_id, schedule_id, occurrence_local_date)`.
- `live_sequence` is a per-device monotonically increasing counter that survives reboot. A new boot ID does not authorize resetting the live counter. The latest sample's sequence equals the enclosing live_sequence; historical entries carry their own boot ID.
- `step_index` is the position in the sequence. A single Nozzle 2 run is step 1, nozzle 2. Both is step 1/nozzle 1 followed by step 2/nozzle 2.
- Do not add diagnostic keys to network payloads. Several schema DTOs tolerate additive fields, but the actual route uses strict allowed-key checks. Target the exact current runtime fields; see the source-scan discrepancy.

## Exact field tables

“Yes” means required even when nullable. Constraints shown here are structural; conditional rules and stateful checks still apply. Each DTO name corresponds to a `$defs` entry in the canonical schema. Nested references name another table or a scalar definition below.

### DeviceSyncRequest

Authenticated device sync. Runtime validation also requires latest_sample.sequence to equal live_sequence and rejects duplicate identities within one body. Persist samples and contact atomically, and ACK only identities durably stored. Old, future, uncertain, or invalid device time cannot create a fresh trusted metric.

| Field | Required | Type / constraints | Meaning from schema |
| --- | --- | --- | --- |
| `protocol_major` | Yes | ProtocolMajor |  |
| `request_id` | Yes | Uuid |  |
| `boot_id` | Yes | Uuid |  |
| `live_sequence` | Yes | NonNegativeInteger | Per-device monotonic live counter that survives reboots; when latest_sample is present, its sequence must equal this value. |
| `firmware_version` | Yes | string; minLength=1; maxLength=100 |  |
| `capabilities_revision` | Yes | PositiveInteger |  |
| `clock` | Yes | ClockReport |  |
| `actuator` | Yes | ActuatorReport |  |
| `configuration` | Yes | ConfigurationReport |  |
| `latest_sample` | Yes | LiveTelemetrySample OR null | Current live sample for the enclosing boot_id; historical backlog is separate and cannot update the current sample pointer. |
| `backlog_samples` | Yes | array of HistoricalTelemetrySample; maxItems=100 | Bounded immutable history. At most 100 samples total are accepted; the live sample counts toward that limit. |
| `events` | Yes | array of RunEvent; maxItems=100 |  |

### DeviceSyncResponse

Sample ACKs mean those immutable identities are durably stored; they do not imply that historical replay replaced current state.

| Field | Required | Type / constraints | Meaning from schema |
| --- | --- | --- | --- |
| `protocol_major` | Yes | ProtocolMajor |  |
| `request_id` | Yes | Uuid |  |
| `server_time` | Yes | UtcDateTime |  |
| `acknowledged_samples` | Yes | array of SampleAcknowledgement; maxItems=100 | Only exact sample identities durably inserted or confirmed as immutable duplicates are acknowledged. |
| `acknowledged_events` | Yes | array of EventAcknowledgement; maxItems=100 |  |
| `desired_configuration` | Yes | ConfigurationSnapshot OR null |  |
| `command` | Yes | CommandDelivery OR null |  |
| `next_sync_after_ms` | Yes | PositiveInteger |  |

### ClockReport



| Field | Required | Type / constraints | Meaning from schema |
| --- | --- | --- | --- |
| `quality` | Yes | TimeQuality |  |
| `uncertainty_ms` | Yes | NullableNonNegativeInteger |  |

### ActuatorReport



| Field | Required | Type / constraints | Meaning from schema |
| --- | --- | --- | --- |
| `state` | Yes | "idle" / "feeding" / "fault" / "unknown" |  |
| `fault_code` | Yes | string/null; maxLength=128 |  |
| `active_sequence_id` | Yes | Uuid OR null |  |

### ConfigurationReport



| Field | Required | Type / constraints | Meaning from schema |
| --- | --- | --- | --- |
| `applied_revision` | Yes | NullableNonNegativeInteger |  |
| `last_attempt_revision` | Yes | NullablePositiveInteger |  |
| `last_attempt_status` | Yes | "pending" / "applied" / "rejected" / null |  |
| `error_code` | Yes | ErrorCode OR null |  |

### TelemetryValues

A measurement value is present only with quality valid. Invalid device time has measured_at null; uncertain device time is retained but cannot be promoted to a trusted current reading.

| Field | Required | Type / constraints | Meaning from schema |
| --- | --- | --- | --- |
| `measured_at` | Yes | UtcDateTime OR null |  |
| `time_quality` | Yes | TimeQuality |  |
| `do_mg_l` | Yes | NullableFiniteNonNegativeNumber |  |
| `do_quality` | Yes | SensorQuality |  |
| `feed_remaining_g` | Yes | NullableFiniteNonNegativeNumber |  |
| `feed_percent` | Yes | NullablePercentage |  |
| `feed_quality` | Yes | SensorQuality |  |
| `calibration_revision` | Yes | NullablePositiveInteger |  |

### LiveTelemetrySample

The current-boot sample whose sequence equals the enclosing per-device live_sequence.

| Field | Required | Type / constraints | Meaning from schema |
| --- | --- | --- | --- |
| `measured_at` | Yes | UtcDateTime OR null |  |
| `time_quality` | Yes | TimeQuality |  |
| `do_mg_l` | Yes | NullableFiniteNonNegativeNumber |  |
| `do_quality` | Yes | SensorQuality |  |
| `feed_remaining_g` | Yes | NullableFiniteNonNegativeNumber |  |
| `feed_percent` | Yes | NullablePercentage |  |
| `feed_quality` | Yes | SensorQuality |  |
| `calibration_revision` | Yes | NullablePositiveInteger |  |
| `sequence` | Yes | NonNegativeInteger |  |

### HistoricalTelemetrySample

An immutable backlog record keyed by boot_id and sequence. Backlog replay never replaces or refreshes the current live sample.

| Field | Required | Type / constraints | Meaning from schema |
| --- | --- | --- | --- |
| `measured_at` | Yes | UtcDateTime OR null |  |
| `time_quality` | Yes | TimeQuality |  |
| `do_mg_l` | Yes | NullableFiniteNonNegativeNumber |  |
| `do_quality` | Yes | SensorQuality |  |
| `feed_remaining_g` | Yes | NullableFiniteNonNegativeNumber |  |
| `feed_percent` | Yes | NullablePercentage |  |
| `feed_quality` | Yes | SensorQuality |  |
| `calibration_revision` | Yes | NullablePositiveInteger |  |
| `boot_id` | Yes | Uuid |  |
| `sequence` | Yes | NonNegativeInteger |  |

### SampleAcknowledgement



| Field | Required | Type / constraints | Meaning from schema |
| --- | --- | --- | --- |
| `boot_id` | Yes | Uuid |  |
| `sequence` | Yes | NonNegativeInteger |  |

### EventAcknowledgement



| Field | Required | Type / constraints | Meaning from schema |
| --- | --- | --- | --- |
| `event_sequence` | Yes | PositiveInteger |  |
| `sequence_id` | Yes | Uuid |  |

### CommandDelivery

One durable ordered sequence; later nozzles require prior stop and a valid settled shared-weight baseline.

| Field | Required | Type / constraints | Meaning from schema |
| --- | --- | --- | --- |
| `command_type` | Yes | exactly "feed" |  |
| `command_id` | Yes | Uuid |  |
| `sequence_id` | Yes | Uuid |  |
| `device_id` | Yes | Uuid |  |
| `request_id` | Yes | Uuid |  |
| `idempotency_key` | Yes | Uuid |  |
| `targets` | Yes | ManualFeedTargets |  |
| `capabilities_revision` | Yes | PositiveInteger |  |
| `created_at` | Yes | UtcDateTime |  |
| `start_before` | Yes | UtcDateTime |  |
| `scheduler_wake_grace_ms` | No | NullableNonNegativeInteger | For Both, nozzle 2 must start by the first valid settled completion time plus this device bound. |
| `status` | Yes | "queued" / "accepted" |  |

### ManualFeedTarget



| Field | Required | Type / constraints | Meaning from schema |
| --- | --- | --- | --- |
| `nozzle_number` | Yes | NozzleNumber |  |
| `dose` | Yes | Dose |  |

### GramsDose



| Field | Required | Type / constraints | Meaning from schema |
| --- | --- | --- | --- |
| `mode` | Yes | exactly "grams" |  |
| `amount_g` | Yes | number; exclusiveMinimum=0; maximum=1.7976931348623157e+308 | Requested feed weight in grams; bounds and increment come from the approved per-device profile. |

### FixedPortionDose



| Field | Required | Type / constraints | Meaning from schema |
| --- | --- | --- | --- |
| `mode` | Yes | exactly "fixed_portion" |  |
| `fixed_portion_id` | Yes | string; pattern="^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$" | Opaque ID selected from this device's advertised fixed_portion_ids; no gram amount is implied. |

### RunEvent

Each event is one nozzle step in a stable sequence_id/event_sequence stream; device reservation spans actuation and settling. Absent or null continuation_evidence never continues to nozzle 2 after a nozzle 1 failure.

| Field | Required | Type / constraints | Meaning from schema |
| --- | --- | --- | --- |
| `event_sequence` | Yes | PositiveInteger |  |
| `event_type` | Yes | "queued" / "accepted" / "running" / "completed" / "failed" / "rejected" / "expired" / "unknown" / "skipped" / "maintenance_acknowledged" / "not_started" |  |
| `outcome_status` | Yes | RunEventOutcome |  |
| `source` | Yes | "manual" / "scheduled" |  |
| `device_at` | Yes | UtcDateTime OR null |  |
| `time_quality` | Yes | TimeQuality |  |
| `command_id` | Yes | Uuid OR null |  |
| `schedule_id` | Yes | Uuid OR null |  |
| `configuration_revision` | Yes | NullablePositiveInteger |  |
| `occurrence_local_date` | Yes | LocalDate OR null |  |
| `requested_dose` | Yes | Dose |  |
| `estimated_dispensed_g` | Yes | NullableFiniteNonNegativeNumber |  |
| `measured_dispensed_g` | Yes | NullableFiniteNonNegativeNumber |  |
| `measurement_quality` | Yes | MeasurementQuality |  |
| `reason_code` | Yes | string/null; maxLength=128 |  |
| `maintenance_resolution` | Yes | MaintenanceResolution OR null |  |
| `lockout_cleared` | Yes | boolean |  |
| `continuation_evidence` | No | ContinuationEvidence OR null |  |
| `sequence_id` | Yes | Uuid |  |
| `nozzle_number` | Yes | NozzleNumber |  |
| `step_index` | Yes | 1 / 2 |  |

### ContinuationEvidence

Device-authored proof, bound to its sequence and step 1, that a failed nozzle 1 may continue to the already-authorized nozzle 2 once. Nozzle 1 is never retried.

| Field | Required | Type / constraints | Meaning from schema |
| --- | --- | --- | --- |
| `safe_stop` | Yes | exactly true | Nozzle 1 is definitively stopped. |
| `device_fault` | Yes | exactly false | No device-wide fault or lockout exists. |
| `baseline_ready_at` | Yes | UtcDateTime | Device time of the fresh valid settled shared-scale baseline. Nozzle 2 must start by this time plus scheduler_wake_grace_ms. |

### MaintenanceResolution



| Field | Required | Type / constraints | Meaning from schema |
| --- | --- | --- | --- |
| `resolution_at` | Yes | UtcDateTime OR null |  |
| `resolution_reason` | Yes | string; minLength=1; maxLength=256 |  |

### ConfigurationValues



| Field | Required | Type / constraints | Meaning from schema |
| --- | --- | --- | --- |
| `timezone` | Yes | IanaTimeZone |  |
| `monitoring_limits` | Yes | MonitoringLimits |  |
| `low_feed_threshold_pct` | Yes | NullablePercentage |  |
| `schedules` | Yes | array of Schedule |  |

### ConfigurationSnapshot



| Field | Required | Type / constraints | Meaning from schema |
| --- | --- | --- | --- |
| `timezone` | Yes | IanaTimeZone |  |
| `monitoring_limits` | Yes | MonitoringLimits |  |
| `low_feed_threshold_pct` | Yes | NullablePercentage |  |
| `schedules` | Yes | array of Schedule |  |
| `revision` | Yes | PositiveInteger |  |
| `based_on_revision` | Yes | NonNegativeInteger |  |

### Schedule

One logical schedule. Both shares one schedule_id and one occurrence per local date; it runs as one ordered sequence.

| Field | Required | Type / constraints | Meaning from schema |
| --- | --- | --- | --- |
| `schedule_id` | Yes | Uuid |  |
| `local_time` | Yes | LocalTime |  |
| `weekdays` | Yes | array of integer; minimum=1; maximum=7; minItems=1; maxItems=7; uniqueItems=true | ISO weekday numbers Monday=1 through Sunday=7. |
| `enabled` | Yes | boolean |  |
| `targets` | Yes | ManualFeedTargets | One nozzle, or Both as nozzle 1 then nozzle 2 with a separate dose each. Legacy scalar nozzle_number/dose schedules are no longer accepted. |

### MonitoringLimits

Dissolved oxygen is mg/L; thresholds are configuration only, not biological advice.

| Field | Required | Type / constraints | Meaning from schema |
| --- | --- | --- | --- |
| `do_low_mg_l` | Yes | NullableFiniteNonNegativeNumber |  |
| `do_high_mg_l` | Yes | NullableFiniteNonNegativeNumber |  |

### DeviceWaitRequest



| Field | Required | Type / constraints | Meaning from schema |
| --- | --- | --- | --- |
| `protocol_major` | Yes | ProtocolMajor |  |
| `request_id` | Yes | Uuid |  |
| `seen_work_token` | Yes | string/null; maxLength=128 | Opaque work watermark from the previous wait response; null requests an immediate current value. |

### DeviceWaitResponse



| Field | Required | Type / constraints | Meaning from schema |
| --- | --- | --- | --- |
| `protocol_major` | Yes | ProtocolMajor |  |
| `request_id` | Yes | Uuid |  |
| `work_token` | Yes | string; maxLength=128 | Opaque wake-up watermark only; it contains no work details and is not a clock sample. |
| `changed` | Yes | boolean | False only when the wait reached its 20 second timeout without a change. |

### PairingWindowRequest



| Field | Required | Type / constraints | Meaning from schema |
| --- | --- | --- | --- |
| `protocol_major` | Yes | ProtocolMajor |  |
| `request_id` | Yes | Uuid |  |

### PairingWindowResponse

Device-only secret response; never log or send the machine credential to the phone. Physical presentation is hardware-owned.

| Field | Required | Type / constraints | Meaning from schema |
| --- | --- | --- | --- |
| `request_id` | Yes | Uuid |  |
| `challenge_id` | Yes | Uuid |  |
| `pairing_secret` | Yes | string; minLength=1; maxLength=512 |  |
| `expires_at` | Yes | UtcDateTime |  |

### CapabilityProfile

Shared device monitoring, hopper capacity and schedule limits plus exactly two independent nozzle dose capabilities.

| Field | Required | Type / constraints | Meaning from schema |
| --- | --- | --- | --- |
| `do_monitoring` | Yes | boolean |  |
| `feed_remaining_monitoring` | Yes | boolean | One shared container/load-cell inventory, never per-nozzle stock. |
| `feed_capacity_g` | Yes | number; exclusiveMinimum=0; maximum=1.7976931348623157e+308 OR null | Capacity of the shared container. Null means unknown; it does not set any nozzle dose limit. |
| `nozzles` | Yes | object |  |
| `max_schedules` | Yes | NullablePositiveInteger |  |
| `scheduled_both` | Yes | boolean | True only when the device executes a two-target schedule as one ordered Both sequence. False rejects Both schedules. |
| `local_schedule_execution` | Yes | boolean |  |
| `max_clock_uncertainty_ms` | Yes | NullableNonNegativeInteger |  |
| `scheduler_wake_grace_ms` | Yes | NullableNonNegativeInteger |  |
| `maximum_settling_ms` | Yes | NullablePositiveInteger | Device-wide maximum settling interval; null means no verified bound. |

### NozzleCapability

Approved capability for one nozzle. Null limits are unknown, not zero.

| Field | Required | Type / constraints | Meaning from schema |
| --- | --- | --- | --- |
| `enabled` | Yes | boolean |  |
| `dose_modes` | Yes | array of DoseMode; uniqueItems=true |  |
| `fixed_portion_ids` | Yes | array of FixedPortionDose/properties/fixed_portion_id; uniqueItems=true |  |
| `min_dose_g` | Yes | NullableFiniteNonNegativeNumber |  |
| `max_dose_g` | Yes | NullableFiniteNonNegativeNumber |  |
| `dose_step_g` | Yes | NullableFiniteNonNegativeNumber |  |
| `measured_dispensed_g` | Yes | boolean |  |
| `max_actuation_ms` | Yes | NullablePositiveInteger |  |
| `minimum_cooldown_ms` | Yes | NullableNonNegativeInteger |  |

### DeviceDescriptor



| Field | Required | Type / constraints | Meaning from schema |
| --- | --- | --- | --- |
| `device_id` | Yes | Uuid |  |
| `model` | Yes | string; minLength=1; maxLength=100 |  |
| `firmware_version` | Yes | string; minLength=1; maxLength=100 |  |
| `protocol_major` | Yes | ProtocolMajor |  |
| `is_simulated` | Yes | boolean |  |
| `capabilities_revision` | Yes | PositiveInteger |  |
| `capabilities` | Yes | CapabilityProfile |  |

### ScheduledSequenceAdmission

Admit same-time due occurrences atomically under one device reservation. first_start_before gates target 1 only; target 2 starts only after nozzle 1 stops and a valid settled shared-weight baseline. Its deadline is baseline_ready_at + scheduler_wake_grace_ms. A null settling limit is unknown, never zero.

| Field | Required | Type / constraints | Meaning from schema |
| --- | --- | --- | --- |
| `protocol_major` | Yes | ProtocolMajor |  |
| `device_id` | Yes | Uuid |  |
| `sequence_id` | Yes | Uuid |  |
| `due_at` | Yes | UtcDateTime |  |
| `admitted_at` | Yes | UtcDateTime |  |
| `first_start_before` | Yes | UtcDateTime |  |
| `targets` | Yes | array of ScheduledOccurrenceTarget; minItems=1; maxItems=1 OR array (ordered tuple); minItems=2; maxItems=2 |  |

### ScheduledOccurrenceTarget

Occurrence identity is device_id + schedule_id + local date; nozzle, dose and revision are not identity.

| Field | Required | Type / constraints | Meaning from schema |
| --- | --- | --- | --- |
| `schedule_id` | Yes | Uuid |  |
| `nozzle_number` | Yes | NozzleNumber |  |
| `occurrence_local_date` | Yes | LocalDate |  |
| `configuration_revision` | Yes | PositiveInteger |  |
| `dose` | Yes | Dose |  |

### ErrorEnvelope



| Field | Required | Type / constraints | Meaning from schema |
| --- | --- | --- | --- |
| `error` | Yes | ApiError |  |

### ApiError



| Field | Required | Type / constraints | Meaning from schema |
| --- | --- | --- | --- |
| `code` | Yes | ErrorCode |  |
| `message` | Yes | string; minLength=1; maxLength=512 |  |
| `request_id` | Yes | Uuid |  |
| `retryable` | Yes | boolean |  |

## Scalar definitions and enumerations

- **ProtocolMajor:** exactly 2.
- **Uuid:** string; format="uuid".
- **UtcDateTime:** string; format="date-time"; pattern="^\\d{4}-\\d{2}-\\d{2}T\\d{2}:\\d{2}:\\d{2}(?:\\.\\d+)?Z$".
- **LocalDate:** string; format="date".
- **LocalTime:** string; format="local-time"; pattern="^(?:[01]\\d|2[0-3]):[0-5]\\d$".
- **IanaTimeZone:** string; minLength=1; format="iana-time-zone".
- **PositiveInteger:** integer; minimum=1; maximum=9007199254740991.
- **NonNegativeInteger:** integer; minimum=0; maximum=9007199254740991.
- **NullablePositiveInteger:** PositiveInteger OR null.
- **NullableNonNegativeInteger:** NonNegativeInteger OR null.
- **FiniteNonNegativeNumber:** number; minimum=0; maximum=1.7976931348623157e+308.
- **NullableFiniteNonNegativeNumber:** FiniteNonNegativeNumber OR null.
- **NullablePercentage:** number; minimum=0; maximum=100 OR null.
- **DoseMode:** "grams" / "fixed_portion".
- **CommandState:** "queued" / "accepted" / "running" / "completed" / "partial" / "failed" / "rejected" / "expired" / "unknown".
- **RunEventOutcome:** "queued" / "accepted" / "running" / "completed" / "failed" / "rejected" / "expired" / "unknown" / "skipped" / "not_started".
- **NozzleResultStatus:** "not_started" / "queued" / "accepted" / "running" / "completed" / "failed" / "rejected" / "expired" / "unknown".
- **SensorQuality:** "valid" / "unavailable" / "uncalibrated" / "error".
- **TimeQuality:** "synced" / "rtc" / "uncertain" / "invalid".
- **MeasurementQuality:** "valid" / "unavailable" / "uncalibrated" / "error".
- **ErrorCode:** "INVALID_INPUT" / "AUTH_REQUIRED" / "ACCESS_DENIED" / "RESOURCE_NOT_FOUND" / "DEVICE_OFFLINE" / "DEVICE_BUSY" / "DOSE_UNSUPPORTED" / "DOSE_OUT_OF_RANGE" / "CONFIG_CONFLICT" / "CONFIG_PENDING" / "METADATA_CONFLICT" / "CLOCK_UNTRUSTED" / "PAIRING_EXPIRED" / "PAIRING_INVALID" / "ACCESS_REVOKED" / "COMMAND_EXPIRED" / "IDEMPOTENCY_CONFLICT" / "SAFETY_LOCKOUT" / "PROTOCOL_UNSUPPORTED" / "PAYLOAD_TOO_LARGE" / "RATE_LIMITED" / "SERVICE_UNAVAILABLE" / "CAPABILITY_MISMATCH" / "VALIDATION_FAILED" / "INVENTORY_UNAVAILABLE" / "INSUFFICIENT_INVENTORY".


## Runtime rules to implement in addition to the field tables

### Sync and acknowledgment

The route first validates the submitted shape, then calls telemetry, configuration, scheduled-event and manual-event RPCs in sequence. OpenAPI says the whole request is rejected on an invalid record, but these database phases are not one request-wide transaction. Assume earlier phases can commit when a later phase rejects. Retain all unacknowledged records on any failure and replay exact identities/content.

The response's sample ACK is `{boot_id, sequence}`. Its event ACK is `{sequence_id, event_sequence}`. Accept ACKs only for the actual sent batch. A successful response with an omitted ACK is not permission to delete that record. An old event arriving late may be acknowledged without replacing newer state; never manufacture a new identity to force it to win.

At most one live sample plus 99 backlog samples, or 100 backlog samples without a live sample; at most 100 events. Those are independent array limits within the same 262144-byte total body limit. Backlog samples include `boot_id`; the live sample uses the enclosing `boot_id` and therefore must not include an extra boot_id property. Firmware diagnostics and lost-interval records remain local because the current sync body has no such field.

### Clock, telemetry and actuator coupling

- `clock.quality=invalid` means `uncertainty_ms=null`; other clock qualities require a nonnegative integer uncertainty.
- A sample with `time_quality=invalid` requires `measured_at=null`. Other qualities require a valid UTC timestamp. A syntactically valid uncertain/future/old timestamp does not establish fresh trusted telemetry.
- DO quality `valid` requires a finite nonnegative mg/L value. Every other DO quality requires null DO.
- Feed quality `valid` requires finite nonnegative grams, percentage from 0 through 100, and a positive calibration revision. Every other feed quality requires all three null.
- `actuator.state=idle` requires null active_sequence_id; `feeding` requires a UUID. Keep the feeding reservation through physical settling; fault/unknown must be truthful and retain the affected identity when known.
- A null `latest_sample` is permitted. Contact and sensor quality are separate. Current metric freshness is about 30 seconds; contact freshness is about 45 seconds in the monitoring implementation. The manual admission code also checks contact state and a one-minute contact-age bound; do not collapse all these values into one safety timer.

### Configuration reports

With no attempt: last_attempt_revision, last_attempt_status and error_code are all null. With a pending/applied/rejected attempt: last_attempt_revision is present. Applied requires last_attempt_revision to equal applied_revision and a null error_code. Rejected requires a recognized error_code while retaining the actual prior applied_revision. Pending has no rejection error. Do not report applied merely because JSON arrived.

`ConfigurationSnapshot` combines all `ConfigurationValues` fields with `revision` and `based_on_revision`. Schedule targets contain either one nozzle or both ordered 1 then 2. Weekdays are unique integers 1 through 7. The schema's 100-schedule ceiling is not a promise that a physical profile supports 100; validate against the profile's actual max_schedules. Same-time overlap of the same nozzle is rejected, including Both against another schedule.

### Events and sequence state

Each event contains every required nullable field. For manual events, command_id is present and schedule_id/configuration_revision/occurrence_local_date are null. For scheduled events the inverse applies: command_id is null, and all three schedule identity fields are required. Both legs of one Both schedule share schedule_id/date but retain separate step_index/nozzle_number values.

Ordinary event_type equals outcome_status. The exception is maintenance_acknowledged, whose outcome stays unknown. `partial` is an aggregate sequence state and is not a RunEvent outcome. Terminal states must not regress to running/accepted. Events must match the original target, dose, source and sequence; their durable event sequence advances in order. A duplicate identity is immutable.

A valid measurement quality requires a numeric measured_dispensed_g; all other qualities require null. Queued, accepted, rejected, expired, unknown, not_started and skipped cannot claim valid measured dispensing. A known failed cycle may carry a valid measured partial amount. Not_started and skipped need a nonempty reason. Use meaningful device reasons within the string length limit rather than copying SIMULATOR_* reasons into real hardware reports.

A normal event has maintenance_resolution=null and lockout_cleared=false. An authorized manual maintenance acknowledgment requires a resolution object, lockout_cleared=true, outcome_status=unknown and no invented measurement. The current device handler rejects a scheduled maintenance acknowledgment even though broad schema validation alone is not enough to demonstrate that restriction. Treat scheduled unknown recovery as a backend integration requirement, not a supported hidden endpoint.

Continuation evidence is optional; absence or null means no continuation after N1 failure. It is valid only on the failed first N1 event with a valid weighing and trusted event time. The server further verifies an existing running/failed first step, two-target sequence, supported N2, no lockout, clock uncertainty and the start/actuation/settling window. Physical firmware must prove safe stop and a healthy device; these Booleans cannot be guessed from successful function calls.

### Capabilities and compatibility

Nozzle keys are string keys `"1"` and `"2"`. Disabled nozzles have empty dose_modes and measured_dispensed_g=false. Grams support requires positive min/max/step and the backend checks `(amount-min) mod step = 0`. A supported fixed portion must use an approved ID; it has no implied mass. Unsupported gram bounds are null, not zero. Local scheduling requires real positive count and non-null timing bounds accepted by the backend, not only a true Boolean.

The physical device uses the approved profile supplied at provisioning; it cannot enable its own controls by changing capabilities_revision. `scheduled_both` is a separate capability. Some changes within major 2 have strict-parser compatibility implications (notably schedule targets in 2.5 and app metadata in 2.7), so pin the actual contract release and deployment baseline in addition to protocol_major.

### Error response handling

Errors use ErrorEnvelope/ApiError above. Preserve the server error code and a sanitized correlation ID. Use retryable as a hint, not as permission to repeat physical execution. Retry transport/server failures with the same event records; pause and diagnose authorization, version, malformed payload, profile or identity conflicts. Split oversized batches. On 429, respect any server retry guidance and use bounded backoff. On 401, ask the owner to verify/reprovision the proper machine credential; never rotate credentials autonomously or bypass authentication.

A bad event at the front of the outbox may block later evidence. Preserve it, stop any unsafe dependent work, and correct the firmware/contract mismatch through a reviewed process. Do not silently drop a run event or assign it a different identity. Telemetry may be bounded with explicit local loss evidence; feeding events and occurrence identities require a separate retention policy that preserves recovery safety.
