from time import monotonic, sleep

from loadcell import cleanup, is_calibrated, read_grams


UPDATE_INTERVAL_SECONDS = 1.0


try:
    if not is_calibrated():
        raise RuntimeError(
            "No saved calibration. Run: python src/calibrateLoadcell.py"
        )

    print("Saved load-cell calibration loaded.")
    print("Reading weight once per second. Press Ctrl+C to stop.")

    while True:
        started = monotonic()
        weight_g = read_grams()
        print(f"\rWeight: {weight_g:8.1f} g", end="", flush=True)
        sleep(max(0, UPDATE_INTERVAL_SECONDS - (monotonic() - started)))

except KeyboardInterrupt:
    print("\nLoad-cell reading stopped.")
except (RuntimeError, ValueError) as error:
    print(f"\nError: {error}")
finally:
    cleanup()
