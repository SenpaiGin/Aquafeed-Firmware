# Simulator 2222

This folder contains the simulator code, device credential, public development-project configuration, and a consistent SQLite snapshot copied on 2026-10-16 (Asia/Manila).

## Run

Install Python 3.10 or newer and make `python` available in PowerShell. On Windows, schedule timezone support may require `python -m pip install tzdata`.

Stop any other running simulator for device 2222 first. Both copies use the same device identity and backend; this copied database is a snapshot and does not stay synchronized with the original.

Open PowerShell in this folder and run:

```powershell
.\run-demo.ps1
```

If local PowerShell policy blocks the script, launch it for this process only:

```powershell
powershell.exe -NoProfile -ExecutionPolicy Bypass -File .\run-demo.ps1
```

Stop with Ctrl+C. Keep all bundled files together. Runtime state is saved to the SQLite database in this folder. No repository checkout is required.

The device credential JSON is private and authorizes access as simulator 2222. Keep this packet private and do not publish or commit that file. This is a synthetic simulator connected to the configured development backend; running it can process queued simulated commands and update backend telemetry/state. It does not operate feeder hardware.

Packaging verification: Python source and credential match the originals; SQLite snapshot integrity checked; launcher syntax and argument wiring checked offline. No live simulator connection was started during packaging.
