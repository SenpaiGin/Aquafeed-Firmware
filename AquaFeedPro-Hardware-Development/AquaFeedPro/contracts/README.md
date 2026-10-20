# AquaFeed Pro wire contract

**Version:** 2.7.0 (`protocol_major: 2`). 2.5.0 replaced the scalar schedule nozzle and dose with `targets`; 2.6.0 adds feeding-outcome alert events; 2.7.0 shares one feeder name and location across installations.

**Status:** D1 defines the v2 wire contract, shared examples, validators, and Supabase schema. D2-D5 now provide the app/API and durable simulator runtime; see the [Android and hardware handoff](../docs/ANDROID-HARDWARE-HANDOFF.md) for implementation provenance and evidence. Firmware and physical hardware remain unverified.

## Source of truth

- [openapi.yaml](openapi.yaml) describes the twenty-one v2 operations across nineteen paths relative to Supabase `/functions/v1`.
- [schemas/v2.schema.json](schemas/v2.schema.json) contains canonical Draft 2020-12 DTOs.
- [fixtures/manifest.json](fixtures/manifest.json) is shared by TypeScript and Python validators.
- [CHANGELOG.md](CHANGELOG.md) records contract versions.
- The v1 schema, OpenAPI file, and manifest remain historical records; they are not v2 inputs.

Major 2 requires explicit nozzle targets. Major 1 is rejected with `PROTOCOL_UNSUPPORTED`; there is no default nozzle or ignored optional target.

## Two-nozzle sequence rules

A device's two nozzles share one continuously weighed container. A request selects nozzle 1, nozzle 2, or both; Both carries a separate dose per nozzle and targets must be ordered 1 then 2. The device-wide reservation lasts through the final stop and valid weighing settle interval. A second nozzle starts only after the first stops and the shared weight has a valid settled baseline.

A schedule's `targets` select nozzle 1, nozzle 2, or Both under one `schedule_id`; Both needs the `scheduled_both` capability. Same-time due schedules admit as one ordered group under that reservation. The second leg's deadline begins at its settled baseline, so completion of nozzle 1 alone does not expire nozzle 2. Same-nozzle collisions, including Both against a single schedule on either nozzle, remain invalid. A fault, uncertain stop, or invalid weighing halts remaining legs. A failed nozzle 1 continues to nozzle 2 only with device-authored `continuation_evidence` (safe stop, no device fault, fresh settled baseline); nozzle 1 failed plus nozzle 2 completed is `partial`. A device adapter may send `continuation_evidence` only from measured stop, settled-scale and device-health signals; until hardware acceptance (ART-48) proves them, real adapters omit it and fail closed. The server also rejects proof that is malformed, outside the actuation-plus-settling window, under an untrusted clock, while the device is locked out, or when nozzle 2 is unsupported. Results preserve completed, failed, unknown, and not-started legs; interrupted work is never automatically resumed or replayed.

Manual-feed idempotency includes the ordered targets, each dose, and capability revision. `request_id` is correlation only. Reusing an idempotency key with changed targets or doses conflicts. Schedule occurrence identity is `(device_id, stable schedule_id, occurrence_local_date)`; editing dose, nozzle, or configuration does not create a second occurrence.

## Device connection loop

For the simulator and future firmware:

1. Keep one HTTPS connection open for `sync` and a second for `wait`; reconnect on any error.
2. Run `wait` continuously in its own task with the last `work_token`; when `changed: true`, call `sync` immediately.
3. Also sync on the server's `next_sync_after_ms`, and within 250 ms after recording a new local event.
4. Work comes only from `sync`; a wake-up never starts a feed. A `wait` round-trip is not a clock sample.
5. If `wait` returns `404`, the server is older; keep the timed sync only.

Requested dose, estimated amount, measured amount, and shared remaining inventory stay separate. Unknown readings remain unavailable. Desired and device-applied configuration revisions remain separate. Unknown nozzle results keep the safety lockout until a device-maintenance resolution; the result and any measurement remain unknown after the lockout is cleared.

## Alert history

The three installation routes added in 2.2.0 are `GET /app-api/v2/devices/{id}/notifications`, `PATCH /app-api/v2/devices/{id}/notifications/{eventId}`, and `POST /app-api/v2/devices/{id}/notifications/actions`. Each requires the authenticated installation JWT, `X-Protocol-Major: 2`, `X-Request-Id`, and active membership for the path device; action bodies repeat the same request ID and cannot provide an installation ID. Version 2.3.0 adds a verified event read on the existing event path and `POST`/`DELETE /app-api/v2/push-token`. Registration accepts only Android tokens for the configured EAS project and never returns the token.

The list returns at most 50 immutable shared alert facts in descending `(raised_at,event_id)` order. Its optional opaque cursor is device-bound and continues strictly below that tuple. `do_low`, `do_high`, and `feed_low` events include the applied revision, finite value and limit, trusted sample identity and measured time, raised time, and the trusted simulator marker. Their `sequence_id` is null.

Feeding outcomes are alert events too. `feeding_failed`, `feeding_partial` and `feeding_unknown` are raised once when a feed sequence first reaches that final status; `feeding_unmeasured` is raised when a sequence completes but a completed step has no valid final weighing. They carry the `sequence_id` of the run to open and null `value`, `limit`, `measured_at`, `applied_revision`, `boot_id` and `sample_sequence`; nothing is raised while a later nozzle may still run, and expired or rejected sequences, which never moved feed, raise nothing. A later status with new evidence (for example `unknown` then `failed`) is a second event for the same sequence; an existing event is never changed.

### Alert presentation

The phone notification and the in-app list use the same title and first line (push sender `TITLES`, app `alertTitle`/`alertLine`); the feeder name and a Simulator marker follow the line.

| kind | Title | Line |
| --- | --- | --- |
| `do_low` | Oxygen below limit | `<value> mg/L · limit <limit>` |
| `do_high` | Oxygen above limit | `<value> mg/L · limit <limit>` |
| `feed_low` | Feed is low | `<value>% · alert below <limit>%` |
| `feeding_failed` | Feeding failed | No nozzle completed |
| `feeding_partial` | Feeding partly completed | Only one nozzle completed |
| `feeding_unknown` | Feeding result unknown | Not confirmed · check before feeding again |
| `feeding_unmeasured` | Feeding not measured | Final weight unavailable |

Tapping a feeding outcome opens its history run, which shows each nozzle's requested and measured amounts; tapping a reading crossing opens the notification list.

Read and dismiss state belongs to one paired installation. `read` and `dismiss` update one event; dismissal also marks it read. The bulk action accepts `mark_read` or `dismiss` through a caller-captured event cutoff. Events raised after that tuple remain unchanged, and a reinstall has a new installation identity that must pair again.

Push is a best-effort wake-up for Android development builds. New alert facts enqueue one delivery per active token installation inside the same database transaction; transport runs later through bounded private leases and retries. Tokens, tickets, receipts, and sender state remain outside public tables and Realtime. The Edge sender is disabled until the owner configures `PUSH_WORKER_SECRET`; an Expo access token is optional, and Firebase credentials remain in the owner's Expo/EAS project. An accepted ticket or receipt is not proof that Android displayed a notification. See [the ART-96 owner setup and acceptance guide](../docs/ART-96-ANDROID-PUSH.md) before configuring a development environment.

## Check the contract

From the repository root:

```powershell
npm.cmd run validate --prefix contracts
py -3.14 contracts/scripts/validate.py
```

Both implementations consume the same manifest. Fixtures verify DTO shape and selected command, idempotency, schedule, and sequence rules. A passing fixture does not prove an API or physical feed exists.

## Data foundation

The migrations are under [supabase/migrations](../supabase/migrations/). They separate per-nozzle feed steps from shared device telemetry and feed inventory, scope installation reads to active device membership, keep device credentials in a private schema, and grant installation clients read access only. See [the access matrix and rollback SQL check](../supabase/README.md). The coordinator applied both migrations to the isolated AquaFeed development project; no production or hardware resources were changed.
