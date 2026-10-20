from loadcell import CALIBRATION_FILE, calibrate, cleanup, tare


def calibrate_loadcell():
    """Calibrate once and save the result for main.py."""
    known_weight_g = float(
        input("Enter the exact calibration weight in grams: ")
    )

    input("Leave the empty tray on the load cell, then press Enter...")
    zero = tare()
    print(f"Zero raw value: {zero:.0f}")

    input(
        f"Place exactly {known_weight_g:g} grams on the load cell, "
        "then press Enter..."
    )
    factor = calibrate(known_weight_g)

    print(f"Calibration factor: {factor:.3f} raw counts per gram")
    print(f"Calibration saved to: {CALIBRATION_FILE}")


if __name__ == "__main__":
    try:
        calibrate_loadcell()
    except KeyboardInterrupt:
        print("\nCalibration cancelled.")
    except (RuntimeError, ValueError) as error:
        print(f"\nCalibration failed: {error}")
    finally:
        cleanup()
