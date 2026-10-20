"""Lazy HX711 wrapper using the legacy library and an explicit calibration file."""

from __future__ import annotations
import json
from pathlib import Path
from statistics import median
from . import pins


class LoadCell:
    def __init__(self, calibration_file: str):
        try:
            from hx711 import HX711
        except ImportError as exc:
            raise RuntimeError("Install and pin the HX711 library selected for this Pi") from exc
        data = json.loads(Path(calibration_file).read_text(encoding="utf-8"))
        self.zero_raw = float(data["zero_raw"])
        self.counts_per_gram = float(data["counts_per_gram"])
        if self.counts_per_gram == 0:
            raise ValueError("counts_per_gram must be nonzero")
        self.hx = HX711(dout_pin=pins.HX711_DOUT, pd_sck_pin=pins.HX711_SCK,
                        channel="A", gain=128)
        self.hx.reset()

    def weight_g(self, samples: int = 7) -> float:
        if type(samples) is not int or samples < 3:
            raise ValueError("Use at least three HX711 samples")
        raw = float(median(self.hx.get_raw_data(samples)))
        value = (raw - self.zero_raw) / self.counts_per_gram
        if not (-1e7 < value < 1e7):
            raise RuntimeError("Load-cell value is outside the plausible numeric range")
        return value

    def close(self) -> None:
        from .runtime import gpio_module
        gpio_module().cleanup([pins.HX711_DOUT, pins.HX711_SCK])

