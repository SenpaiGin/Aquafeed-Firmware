# ART-45 Android preview build receipt

The D6 internal Android preview built successfully on October 10, 2026.
This receipt verifies packaging and compilation. Physical installation,
accessibility, launcher presentation and hardware acceptance remain owner-deferred.

| Field | Verified value |
| --- | --- |
| Reviewed build source | `d730005eae4c106e34d77bb302f9f852e5873cc7` |
| EAS project | `1b3dc89f-3111-49d4-b91f-d5567e71d996` |
| Build ID | `ca00176e-6410-4fbb-aefa-bf5e5498f1ce` |
| Profile / distribution | `preview` / internal Android APK |
| EAS environment | `development` |
| Approved backend | `https://giilhohmrytpgyeyysir.supabase.co` |
| Package / version / build | `com.aquafeedpro.app` / `1.0.0` / `1` |
| Expo SDK / EAS CLI | SDK 57 / CLI 24.8.0 |
| Completed | `2026-10-10T00:10:40.540Z` |
| APK size | `139415363` bytes |
| APK SHA-256 | `d3705c1baa3a3cef3e1126f355bc22dc454145d8b5ab9ef70d32f0c8551f100a` |

[Build details and install page](https://expo.dev/accounts/artkincarreons-team/projects/aquafeed-pro/builds/ca00176e-6410-4fbb-aefa-bf5e5498f1ce)
and [APK download](https://expo.dev/artifacts/eas/rsuUF28YACXm-11ev4SqQCgPOuJ45iJWFr8CiAbbpY0.apk).
EAS currently records artifact expiration at `2026-10-23T23:52:02.692Z`;
retain the APK and verify its checksum for a later authorized install.

## Observed checks

- Actual source implementation used GPT-6 Luna Max through Orca; independent
  GPT-6.1 Sol High review accepted the four-file source candidate.
- Focused profile/environment assertions, mobile lint and types, targeted
  EAS JSON formatting, documentation consistency and whitespace checks passed.
- The actual EAS archive contained 266 files, all hash-matching the reviewed
  checkout. Required app, schema, imported database types, lockfile and branding
  inputs were retained; selected private/generated paths and private credential
  signatures were absent. Documentation and the private coordinator checkpoint
  were excluded from upload.
- The cloud log recorded `npm ci --include=dev` completing successfully and
  `gradlew :app:assembleRelease` reporting `BUILD SUCCESSFUL in 17m 38s`.
  Existing remote signing credentials were reused with `--freeze-credentials`.
- The downloaded APK passed ZIP integrity checks. Its native manifest contains
  the expected package marker; EAS records the package/version/build above.
  The Hermes bundle contains the approved development URL and the exact
  independently verified publishable key. No private file paths or full
  server-secret key/private PEM markers were found in the checked bundle strings.
  The SDK's bare `sb_secret_` key-type prefix is library code, not a credential.

Only public client values enter the app; they do not grant device membership
or server authorization. No EAS environment mutation, credential rotation,
backend migration/deployment or physical actuation was performed for D6.

The subsequent receipt documentation commit leaves the build's app source,
assets, lockfiles and EAS configuration unchanged. Required exact-head and
post-merge mobile/contracts CI evidence is recorded in the delivery PR and
Linear issue. Previously passed D2-D5 scenarios are historical evidence,
not tests rerun by this packaging delivery.

Use the [hardware handoff](ANDROID-HARDWARE-HANDOFF.md) for pinned clean setup,
offline simulator commands, controlled transport/recovery and per-nozzle
calibration unknowns. Android/Expo Go phone tests, GPIO/hardware/calibration,
production, emulator and iOS remain deferred. This APK is not physical feeding,
calibration, accuracy or hardware safety evidence.
