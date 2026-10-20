import json
from pathlib import Path
from statistics import median

import RPi.GPIO as GPIO
from hx711 import HX711


# BCM GPIO numbers
DOUT_PIN = 5
SCK_PIN = 6
CALIBRATION_FILE = Path(__file__).with_name("loadcell_calibration.json")

_hx711 = HX711(
    dout_pin=DOUT_PIN,
    pd_sck_pin=SCK_PIN,
    channel="A",
    gain=128,
)
_hx711.reset()

_zero_raw = None
_counts_per_gram = None


def load_calibration():
    """Load the saved empty-scale value and calibration factor."""
    global _zero_raw, _counts_per_gram

    try:
        data = json.loads(CALIBRATION_FILE.read_text(encoding="utf-8"))
        zero_raw = float(data["zero_raw"])
        counts_per_gram = float(data["counts_per_gram"])
    except (FileNotFoundError, KeyError, TypeError, ValueError, json.JSONDecodeError):
        return False

    if counts_per_gram == 0:
        return False

    _zero_raw = zero_raw
    _counts_per_gram = counts_per_gram
    return True


def is_calibrated():
    """Return whether usable calibration values are loaded."""
    return _zero_raw is not None and _counts_per_gram is not None


def save_calibration():
    """Save calibration values for future program restarts."""
    CALIBRATION_FILE.write_text(
        json.dumps(
            {
                "zero_raw": _zero_raw,
                "counts_per_gram": _counts_per_gram,
            },
            indent=2,
        )
        + "\n",
        encoding="utf-8",
    )


def read_raw(samples=5):
    """Return a stable raw HX711 value."""
    return float(median(_hx711.get_raw_data(samples)))


def tare(samples=15):
    """Use the current empty-scale reading as zero."""
    global _zero_raw

    _zero_raw = read_raw(samples)
    return _zero_raw


def calibrate(known_weight_g, samples=15):
    """Calculate the number of raw HX711 counts per gram."""
    global _counts_per_gram

    if known_weight_g <= 0:
        raise ValueError("Known weight must be greater than zero.")
    if _zero_raw is None:
        raise RuntimeError("Call tare() before calibrate().")

    difference = read_raw(samples) - _zero_raw
    if abs(difference) < 1:
        raise RuntimeError(
            "The reading did not change. Check the wiring and known weight."
        )

    _counts_per_gram = difference / known_weight_g
    save_calibration()
    return _counts_per_gram


def read_grams(samples=5):
    """Return the current load-cell measurement in grams."""
    if _zero_raw is None or _counts_per_gram is None:
        raise RuntimeError("The load cell has not been calibrated.")

    weight_g = (read_raw(samples) - _zero_raw) / _counts_per_gram
    return round(weight_g, 1)


def cleanup():
    """Release the GPIO pins used by the HX711."""
    GPIO.cleanup([DOUT_PIN, SCK_PIN])


load_calibration()
