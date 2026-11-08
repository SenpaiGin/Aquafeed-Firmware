# AquaFeed DO Monitor

A localhost web companion for the YINMIK BLE-9100 dissolved oxygen meter. It connects directly from a desktop browser and keeps readings and settings in that browser's local storage.

## Run

```sh
python3 server.py
```

Open <http://127.0.0.1:8765> in Chrome or Edge on the same computer. The browser must have access to a Bluetooth Low Energy adapter. Turn on the meter, then long-press its power button until the Bluetooth symbol appears. Select **Connect meter** and choose **BLE-9100**.

The meter uses the custom GATT service `FF01` and characteristic `FF02`. The app subscribes to notifications and uses a read fallback when complete frames are not arriving by notification.

## Features

- Live DO concentration (`mg/L`), saturation (`%`), temperature (`°C`/`°F`), ORP, and battery readings.
- Locally configured DO display limits, with an out-of-range indicator.
- Freeze/resume of the displayed value without sending a command to the instrument.
- Manual and interval-based local saving, measurement history, CSV export, and printing.
- Calibration guidance and a local calibration log.
- Raw Bluetooth packet diagnostics.

Saved records and settings are stored in the browser profile on the computer running this page. They are not uploaded. Clearing browser site data removes them, so export readings you need to keep.

## Reverse-engineering notes

See [REVERSE_ENGINEERING.md](REVERSE_ENGINEERING.md) for the REA setup, examined APK identity, evidence boundaries, and protocol details. The decoder is in [protocol.js](protocol.js).

The application reads the meter and does not send configuration, backlight, or calibration writes. The corresponding command frames were not confirmed. Perform instrument calibration with the meter's physical MODE/CAL key and follow the BLE-9100 manual.

## Limitations

- Web Bluetooth is available in compatible Chromium browsers on a secure context such as `localhost`; it is not exposed by every browser/OS combination.
- The app has not yet been exercised against the owner's physical meter. Review the raw frame diagnostics and compare displayed values with the BLE-9100 LCD before using readings operationally.
- The packet reference came from an independent BLE-9100 integration, while REA confirmed the YINMIK Android package structure and app feature strings. The vendor's Flutter Dart AOT measurement routine was not decompiled by REA's JADX bridge.
- Salt/altitude compensation remains configured on the instrument. The local alert limits do not change the meter or provide aquaculture safety advice.
