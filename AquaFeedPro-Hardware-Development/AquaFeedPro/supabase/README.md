# Supabase D1 data foundation

The migrations in `migrations/` define the protocol 2 relational foundation and an explicitly simulated device profile; both were applied to the AquaFeed development project and the full rollback verification passed. The follow-up migration revokes client execution of the existing `public.rls_auto_enable()` SECURITY DEFINER function while preserving owner access. The schema contains no real feeder credentials or hardware limits.

## Access matrix

| Data | `anon` | Authenticated installation | Trusted server (`service_role`) |
| --- | --- | --- | --- |
| Device and active membership metadata | None | Read own active memberships and their devices | Read/write |
| Telemetry, configuration, schedules, sequences, per-nozzle results, events, reservations | None | Read rows for actively paired devices | Read/write |
| Device credential verifiers, pairing challenges, security audit | None; private schema has no client usage grant | None; private schema has no client usage grant | Read/write |
| Membership creation/revocation and device writes | None | None | Trusted pairing/device flows only |

RLS checks `auth.uid()` against an active `device_access` row. Installation sessions receive `SELECT` grants only; they cannot add memberships or write telemetry/results. Server routes must still validate the active membership and machine identity on each operation. Device credential material remains in `private`; migration fails if that schema is included in a Realtime publication.

The follow-up migration removes `EXECUTE` on the existing `public.rls_auto_enable()` SECURITY DEFINER function from `PUBLIC`, `anon`, and `authenticated`, while retaining owner access. It safely does nothing on projects without that optional dashboard function. The rollback SQL asserts client denial and owner execution when the function is present.

`database.types.ts` is generated from the applied development project with the Supabase CLI's `--schema public` option. It contains public-schema database types only; private credentials, pairing challenges, and security audit tables are excluded.

Shared container readings are stored once per device telemetry sample. Requested dose and measured per-nozzle outcomes are separate rows. Desired and applied configuration revisions are separate references. Same-time cross-nozzle schedules may share a group sequence; per-device active/settling reservations prevent concurrent sequences. Stable occurrence keys exclude dose, nozzle, and revision edits.

## Rollback verification

After applying all reviewed migrations to the isolated development project, run from PowerShell using a privileged development connection:

```powershell
psql "$env:SUPABASE_DB_URL" -v ON_ERROR_STOP=1 -f supabase/tests/art7_two_installation_access.sql
```

The script covers two installations and two devices, active and revoked membership visibility, denied self-grant/client telemetry and result writes, private credential access, revoked public-function execution, cross-device references, ordered targets, duplicate manual and occurrence identities, same-time schedule slots, and the single device reservation. Synthetic installation UUIDs use deferred foreign keys inside one transaction; the final `ROLLBACK` leaves no test rows or Auth accounts. Run only on an isolated development database after review.

The coordinator applied both migrations and ran the rollback SQL successfully in the isolated development project; cleanup left one simulator device and no memberships, sequences, or samples. The SQL check cannot run locally because PostgreSQL/Docker tooling is unavailable in the worker environment.
