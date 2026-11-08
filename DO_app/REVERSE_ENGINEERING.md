# YINMIK / BLE-9100 investigation

## REA setup

- Installed the [requested REA project](https://github.com/sgunin/ReverseEngineerAnything) from its published `rea-agents` package.
- Installed REA `rea-agents@6.8.0` and its bundled reverse-engineering skill.
- Added the `rea` MCP server to `/home/pi/.codex/config.toml` and configured a stable Node 24.22.2 runtime, Temurin JDK 21, and the JADX bridge. The Codex client must restart to load this server into an already-running chat.
- JADX bridge `jadx-headless-mcp-0.7.1-all.jar` SHA-256: `6e5eacf500b64292bfb73c49797c1958f6ee44646e43e868039ae7feb573ff75`.
- REA `doctor --client codex --provider jadx --json` reports `healthy: true` and `environment_healthy: true`.

## Android package observations

REA inspected an APK with package `com.hq.yinmik`, app version `1.0.0` (version code `24`), minimum Android API 24 and target API 36. The inspection reported 1,184 DEX classes and 322 resources. Evidence ID: `ev_f090d4ebddb7e70d7f1a16a27a46d75f68e356e3a20486984af44fa32c745413`.

REA's `inspect-android-class` result for `com.hq.yinmik.MainActivity` contained only its constructor. The APK is a Flutter app; its application logic is compiled into Flutter Dart AOT code in an ABI split. The extracted asset strings include the BLE-9100 product page, measurement labels, calibration/settings screens, and `flutter_blue_plus` BLE method names. JADX does not recover the Dart measurement decoder from that AOT library, so those strings alone do not establish the payload implementation.

The downloaded XAPK came from a third-party mirror because the HTTPS certificate on the vendor APK URL was expired and the vendor's HTTP endpoint was extremely slow. The inspected APK's SHA-256 is `326d7f56257f43c482f9b7eea8249bf0009b89fa80b008eef5494f884c7c760e`; this did not match the mirror page's listed base-APK digest. It was used for static inspection only and was not installed or run. The package name and version metadata matched the listing. The APK itself is not included in this source directory.

## BLE observations and decoder

The [BLE-9100 manual](https://manuals.plus/yinmik/ble-9100-dissolved-oxygen-meter-manual) describes live DO in `mg/L` and `%`, temperature, manual/automatic record saving, limits, and calibration. A published YINMIK protocol snippet identifies service `FF01` and read/write/notify characteristic `FF02` ([protocol report](https://github.com/don/cordova-plugin-ble-central/issues/971)).

An independent BLE-9100 Home Assistant integration documents a 24-byte characteristic frame, the bit-pair inversion transform, and the following decoded offsets ([integration post](https://community.home-assistant.io/t/how-to-get-stable-sensor-reading/648308)):

| Decoded byte offsets | Field | Conversion |
| --- | --- | --- |
| 3–4 | DO concentration | unsigned big-endian / 100 → mg/L |
| 5–6 | DO saturation | unsigned big-endian / 10 → % |
| 13–14 | Temperature | unsigned big-endian / 10 → °C |
| 15–16 | Battery | unsigned big-endian / 31.9 → % |
| 20–21 | ORP | unsigned big-endian → mV |

`protocol.js` follows that pairwise transform in-place, requires a 24-byte value, and rejects DO, saturation, or temperature outside expected BLE-9100 ranges. It does not validate a checksum because the inspected integration did not define one. The app retains the raw frame in its diagnostic log.

## Boundaries still needing physical confirmation

- No live packet was captured from the owner's meter. Compare the web app against the meter LCD in both DO modes before relying on the decoder.
- No vendor write payload was verified. The browser app therefore does not write measurement settings, backlight, calibration, or other commands.
- Web Bluetooth availability and 24-byte notification/read behavior vary by OS/browser and adapter. The app subscribes to notifications and polls with GATT reads when it has not received a complete valid frame recently.
