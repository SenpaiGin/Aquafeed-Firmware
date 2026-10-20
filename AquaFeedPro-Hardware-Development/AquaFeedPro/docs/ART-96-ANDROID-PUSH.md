# ART-96 Android push setup and owner acceptance

This is an owner-run setup guide for the source delivery. The migration, Edge Function, and Android development build have not been applied to a hosted project or submitted from this checkout. Push remains disabled until the owner configures the invocation secret.

## Required owner configuration

- Supabase development project matching `supabase/config.toml` project ref `giilhohmrytpgyeyysir`.
- Edge Function secret `PUSH_WORKER_SECRET`: a high-entropy secret shared only with the owner's scheduler or manual operator. The handler rejects calls when this secret is absent and validates it even though JWT verification is disabled for this function.
- Optional Edge Function secret `EXPO_ACCESS_TOKEN` if push security is enabled for the Expo project. Expo/Firebase FCM credentials belong in the owner's Expo/EAS project credentials; they are not app secrets and do not belong in Supabase tables or this repository.
- A private scheduler or operator that can invoke `POST /functions/v1/push-sender` with `x-push-worker-secret`. Do not place the secret in a mobile build, source file, shell transcript, issue, or log. Do not enable `pg_cron`, `pg_net`, a webhook, or a scheduler as part of this source-only delivery.

## Apply to an authorized development project

From the repository root, after confirming the Supabase CLI is linked/authenticated to the development project:

```powershell
supabase db push --project-ref giilhohmrytpgyeyysir
supabase functions deploy push-sender --project-ref giilhohmrytpgyeyysir --no-verify-jwt
```

Configure `PUSH_WORKER_SECRET` with the Supabase CLI secrets facility and the owner's protected secret store. If using an owner-only environment file for that command, keep it outside the repository and remove it from the machine after use. Set `EXPO_ACCESS_TOKEN` only when required by the Expo project. A missing `PUSH_WORKER_SECRET` intentionally returns `503` with status `disabled`; a Supabase service key or an ordinary app JWT is not a substitute.

An owner-controlled scheduler may call the function every five minutes. Each invocation claims at most 100 sends from one EAS project and at most 100 due receipts. The database delays first receipt polling for 15 minutes, caps receipt attempts at three, expires transport work after one hour or five send attempts, and never resends a ticket merely because a receipt is missing. No scheduler is activated by this change.

## Build an internal Android development client

The existing profile is already `developmentClient: true`, `distribution: internal`, and `environment: development`. It uses Android package `com.aquafeedpro.app` and EAS project `1b3dc89f-3111-49d4-b91f-d5567e71d996`; this change adds no iOS setup.

From `mobile/`, after normal owner EAS authentication and project credential setup:

```powershell
npx eas-cli build --platform android --profile development
```

Install that internal build on a physical Android phone. Expo Go and web retain the server-backed history but do not receive remote Android push. Android creates the `feeder-alerts` channel before permission is requested. A denied permission leaves feeding and notification history available; granting it later in Android settings is rechecked on resume.

## Owner acceptance on a physical phone

Use only synthetic feeder events in an isolated development project. Confirm: two active feeders appear in the same installation history; the Android token is private and never appears in an API response or application log; event delivery begins only after the originating transaction commits; read/dismiss state remains installation-scoped; revoking one feeder blocks its future reads and cancels its unsent sends; revoking the last feeder clears the installation token; a stale push tap cannot select a revoked feeder; and foreground/realtime updates do not create duplicate local notifications.

Also exercise permission denial/regrant, token rotation, app resume, offline actions, sender timeout/429/5xx, `DeviceNotRegistered`, invalid credentials, missing receipts, and the one-hour/five-attempt bounds. Expo tickets and receipts show provider acceptance or rejection, not proof the phone displayed a notification. A send already accepted by Expo cannot be recalled after access is revoked; the subsequent detail read still denies navigation. Duplicate system delivery remains possible after an ambiguous transport result.

This owner setup and physical acceptance are separate from source checks, hosted migration/function application, production enablement, build submission, and hardware acceptance. None of those external actions was performed by this delivery.
