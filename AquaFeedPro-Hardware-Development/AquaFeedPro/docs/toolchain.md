# AquaFeed Pro — Toolchain and environments

Baseline inspected October 2, 2026. This records the existing app setup; product features and physical feeder readiness remain separate tasks.

## Repository and runtime

- App repository: [kin2001/AquaFeedPro](https://github.com/kin2001/AquaFeedPro), private; integration branch `main`.
- Repository root: `AquaFeedPro/`; mobile package: `mobile/`. The surrounding thesis/CAD folder is not this application's Git root.
- Package manager: npm 11.12.1 and Node 24.15.0 observed on October 2, 2026. `npm ls --depth=0` in `mobile/` verified the installed package versions below. Use `npm ci` with the committed `mobile/package-lock.json`; do not add another lockfile/package manager.
- The approved UI uses React Native `StyleSheet` and shared design tokens. NativeWind is not selected.

## Selected package versions

These are the installed versions observed with `npm ls --depth=0` on October 2, 2026; the committed lockfile records the complete dependency graph.

| Area | Selected package/version | Decision |
| --- | --- | --- |
| Mobile framework | Expo 57.0.26; React Native 0.86.3; React 19.2.3 | Keep the SDK 57 compatible set. |
| Web preview | React DOM 19.2.3; React Native Web 0.21.3 | Secondary browser preview, not native acceptance evidence. |
| Navigation | Expo Router 57.0.24; screens 4.26.2; safe-area-context 5.7.0; gesture-handler 2.32.0 | Four tabs with scoped detail/confirmation routes. |
| Language | TypeScript 6.0.3; @types/react 19.2.18 | Type checking plus runtime validation at network boundaries. |
| Formatting/lint | Prettier 3.9.9; ESLint 9.39.5; eslint-config-expo 57.0.2 | Existing configs. The starter web hydration override is scoped to its one file. |
| Font | @expo-google-fonts/inter 0.4.2; expo-font 57.0.4 | Bundle and load Inter 400/500/600/700 before rendering. Apply the approved typography during UI tasks. |
| Icons | @react-native-vector-icons/lucide 13.1.4 | Existing maintained outlined family; no duplicate icon library. Verify exact icon names against its glyph map. |
| Motion | react-native-reanimated 4.5.1; react-native-worklets 0.10.1 | Expo-compatible pair; respect reduced motion. |
| Backend client | @supabase/supabase-js 2.117.2; react-native-url-polyfill 4.0.0 | Existing public client. The installed client is not proof of implemented authentication/RLS/APIs. |
| Local storage | expo-sqlite 57.0.3 | Existing starter client uses localStorage. Protected session bootstrap/storage belongs to ART-16. |
| Development runtime | expo-dev-client 57.0.19; @expo/ngrok 4.1.3 | Development client configured; tunnel available. No completed development APK claimed. |

Remaining direct dependencies are pinned by the lockfile and remain unchanged. Add feature-specific native modules only in the owning task, using `npx expo install` and the SDK 57 documentation: secure storage for ART-16, QR camera for ART-38, SVG chart for ART-27. Do not install them merely to complete a technology checklist.

## Compatibility evidence

Independently run on October 2, 2026 from `mobile/`:

- `npx expo install --check`: dependencies are up to date.
- `npx expo-doctor` (1.20.4): 21/21 checks passed.
- Node `--version`: 24.15.0.

The [SDK 57 reference](https://docs.expo.dev/versions/v57.0.0/) targets React Native 0.86 / React 19.2.3, minimum Node 22.13.x. Native support in that reference is Android 7+ and iOS 16.4+; local iOS simulator/build requires compatible macOS/Xcode. Native runtime testing is separate from dependency compatibility.

## Environments and credential boundaries

| Environment | Current state | Backend/build policy |
| --- | --- | --- |
| Development | Supabase development project and EAS project configured in the existing setup. Local public variables exist and are ignored. | Use the development backend. Sanitized fixtures and simulators are labeled. |
| Preview | EAS internal-distribution profile exists; no preview build or separate backend verified. | Test against development or an explicitly isolated test backend. Do not assume the EAS profile alone selects its backend. |
| Production | Profile skeleton exists; production backend, credentials and release are not created/verified. | Create explicit isolated production resources at release preparation; never infer production readiness from a named build profile. |

Only `EXPO_PUBLIC_SUPABASE_URL` and `EXPO_PUBLIC_SUPABASE_PUBLISHABLE_KEY` belong in the phone bundle. They are public identifiers, not authorization. Keep `mobile/.env.local` ignored; `mobile/.env.example` contains blank placeholders. EAS public development variables were reported configured during setup; this baseline does not independently claim current remote variable values.

Installation identity uses a protected anonymous Supabase session with current device membership checks. Machine credentials are device-specific and server-verified. Never distribute project secret/service-role credentials or pairing secrets as public app environment variables. Implement grants/RLS/API handlers in their assigned tasks.

## App identifiers and build access

- Existing Android package: `com.aquafeedpro.app`; app link scheme: `aquafeedpro`.
- Existing EAS project ID: `1b3dc89f-3111-49d4-b91f-d5567e71d996`.
- iOS bundle identifier is absent and remains owned by the project owner for ART-13 before an iOS build.
- Android Expo Go on a physical phone and tunnel operation were confirmed by the user during setup. They are not evidence of a standalone native development build.
- The development APK queue was canceled; no APK or iOS build is verified. EAS build access/signing remain account-owned steps. The [development build guide](https://docs.expo.dev/develop/development-builds/introduction/) defines when a rebuilt native client is required.
- No EAS cloud build, release, production provisioning or physical actuation is performed by this baseline.

## Provisional operational targets

From the [master plan](https://app.notion.com/p/3ec224a56ef381019c30d3da4e54251e); these are simulator/load-test starting points, not validated hardware limits or measured latency:

| Setting | Proposal |
| --- | --- |
| Device sync | 10 seconds; one outstanding request. |
| App foreground fallback refresh | 15 seconds when Realtime is unavailable. |
| Device offline | 45 seconds without authenticated contact. |
| Per-metric outdated | 30 seconds without a new valid measurement. |
| Manual start deadline | 60 seconds after server acceptance; device must recheck before movement. |
| Configuration pending notice | 30 seconds without applied acknowledgment; no automatic rollback. |
| Phone confirmation to feeding start | At most 15 seconds on the defined normal test network; to be measured. |
| Raw telemetry / outcomes retention | Proposed 7 days / 365 days; no deletion policy enabled. |

Hardware-approved clock uncertainty, dose/cooldown/runtime limits and calibration supersede simulator values. Owners and gates remain in [requirements.md](requirements.md). ART-6 is now integrated as the frozen v1.0.0 wire contract in [`contracts/`](../contracts/README.md); that README records the validator commands and current results. The TypeScript/Ajv and Python/jsonschema runners each pass all 36 schema fixtures and 17 behavior fixtures. This contract evidence does not mean the app, backend, simulator, firmware, or hardware behavior has been implemented.

## Implementation workflow availability

Orca 1.4.217 is connected and the app worktree is registered. Actual Codex status confirmed `gpt-6-luna` / Max and the assigned repository; ART-5 and ART-6 are reviewed and integrated (PRs 1 and 2), with the v1.0.0 contract recorded under `contracts/`. Orca's direct model/effort validator still rejects Luna Max, so the installed [orchestration skill](C:/Users/user/.agents/skills/orchestration/SKILL.md) custom-terminal route is used, with explicit model verification before task injection.

Per-launch update checking is disabled for the supervised worker so startup does not enter an installer prompt; the main Codex home/settings are preserved. This is a compatibility workaround, not evidence that all worker launch paths or interruption/pilot checks are verified. The UI/protocol pilot and evaluation still gate parallel implementation.
