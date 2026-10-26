# Dispersion firmware flows

`drop_feed.py` and `scatter_feed.py` are the two mode entry points. Hardware drivers are in `hardware/` and use BCM numbering from the AquaFeedPro Revision B wiring handoff:

`drop_feed_indi.py` and `scatter_feed_indi.py` are standalone flow-check variants that omit all HX711/load-cell access. They run the actuator sequence only and print `load_cell=not_used`. Their safety gate requires commissioning, a verified independent cutoff, verified stop behavior, and the explicit environment opt-in, but does not require load-cell calibration. No load-cell library or calibration file is read by these two variants.

| Function | BCM | Reference connection |
| --- | ---: | --- |
| Nozzle 1 motor IN1 | 18 | DRV8871 IN1; IN2 grounded |
| Nozzle 2 motor IN1 | 17 | DRV8871 IN1; IN2 grounded |
| Swing motor IN1 / IN2 | 22 / 23 | Third DRV8871 |
| Blower relay input | 24 | Relay IN |
| HX711 DOUT / SCK | 5 / 6 | Shared hopper load cell |
| Swing home / end switch | 21 / 26 | Proposed handoff pins, not confirmed by the drawing |

## Direct-drop sequence

Load commissioned settings and calibration, establish a stable scale reading, run only the selected nozzle for its configured bounded duration, stop it, wait for settling, and report the hopper mass change. Nozzle 1 and Nozzle 2 are never run concurrently. Since nozzle DRV8871 IN2 is grounded, setting PWM to zero coasts; it is not a positive brake or position guarantee.

## Scatter sequence

Perform the same pre-feed checks, require verified home and endpoint feedback, then turn on the blower, run one selected nozzle, and shuttle the swing motor between end switches while feeding. On completion or a fault, stop the nozzle and swing and switch the blower off, then measure after settling. Missing endpoints or an endpoint timeout aborts the cycle.

The order, duty, duration, settling threshold, relay polarity, and endpoint wiring are commissioning inputs; the example config leaves them unset. The code reports hopper mass change only. It does not treat a hopper decrease as proof that pellets reached the pond or as a dose accuracy claim.

## Safety gate and invocation

Importing the modules does not import `RPi.GPIO` or configure pins. Before any motor/relay GPIO initialization, both `commissioned: true` and `AQUAFEED_HARDWARE_ENABLE=YES_I_HAVE_VERIFIED_THE_WIRING` are required, along with verified cutoff, stop behavior, and load-cell calibration. Scatter additionally requires verified swing position feedback. The GPIO drivers then set motor outputs low and use only BCM pins.

After filling a private copy of `hardware-config.example.json` with measured/approved values and installing the Pi-specific `RPi.GPIO` and HX711 packages:

```sh
cd system-flow-tests
AQUAFEED_HARDWARE_CONFIG=/etc/aquafeed/hardware.json \
AQUAFEED_HARDWARE_ENABLE=YES_I_HAVE_VERIFIED_THE_WIRING \
python3 drop_feed.py --nozzle 1 --run-seconds <approved-duration>
```

For scatter, use `python3 scatter_feed.py` with the same options. These commands actuate real hardware once the explicit gate is enabled. The swing limit pins are proposed rather than present in the schematic; do not enable scatter until switches and polarity are installed and verified. This code does not provide a remote command queue, persistent command journal, watchdog, or production service integration.

The independent variants accept the same `--nozzle`, `--run-seconds`, and `--config` arguments:

```sh
python3 drop_feed_indi.py --nozzle 1 --run-seconds <approved-duration>
python3 scatter_feed_indi.py --nozzle 1 --run-seconds <approved-duration>
```

They still actuate real hardware when enabled. The `*_indi.py` suffix means independent of load-cell measurement, not electrically isolated or safe to run concurrently with another feeder process.
