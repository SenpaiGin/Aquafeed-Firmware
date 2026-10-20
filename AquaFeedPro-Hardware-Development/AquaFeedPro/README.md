# AquaFeed Pro

AquaFeed Pro is an Expo and React Native fish-feeding application. This directory is the Git repository root; the app and its npm lockfile are under `mobile/`, and the frozen wire contract is under `contracts/`. Run app commands from `mobile/`, not from the repository root.

The app uses Expo SDK 57, TypeScript, React Native `StyleSheet` with shared design tokens, and Lucide icons from `@react-native-vector-icons/lucide`. See [`docs/toolchain.md`](docs/toolchain.md) for the recorded package baseline and environment status.

## Requirements

- Node.js 24 and npm, for the app and contract validators.
- Python 3.14, for the Python contract validator.
- Expo Go on Android for the user-confirmed development flow. This does not establish standalone native build compatibility or completion.

## Install and start the mobile app

On Windows, from the repository root:

```powershell
cd mobile
npm.cmd ci
npm.cmd run start -- --go
```

On other platforms:

```sh
cd mobile
npm ci
npm run start -- --go
```

`--go` opens the Expo Go flow. To run the web preview instead, use `npm run web` (or `npm.cmd run web` on Windows) from `mobile/`.

## Environment values

`mobile/.env.example` contains blank placeholders for `EXPO_PUBLIC_SUPABASE_URL` and `EXPO_PUBLIC_SUPABASE_PUBLISHABLE_KEY`. If a local integration needs them, copy the example to the ignored `mobile/.env.local` and fill in development values. These public client settings are not authorization; never put a service-role/project secret or device credential in the app bundle.

## Checks

Run from `mobile/`:

```powershell
npm.cmd run format:check
npm.cmd run lint
npm.cmd run typecheck
```

Use `npm` instead of `npm.cmd` outside Windows. The pull-request and `main` CI workflow runs these checks and both TypeScript and Python contract validators. See [`contracts/README.md`](contracts/README.md) for the exact contract setup and check commands.

## Platform status

Android package ID is `com.aquafeedpro.app`, and the app-link scheme is `aquafeedpro`. Android Expo Go use was confirmed during setup, while package compatibility checks were run independently. An EAS development profile is configured, but no native APK or iOS build is verified; the iOS bundle identifier and macOS/Xcode build access remain pending. Simulator latency and data-retention values are proposals, not measured service targets or enabled policies; details are in [`docs/toolchain.md`](docs/toolchain.md).
