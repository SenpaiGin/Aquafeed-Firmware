"""Relay output for the blower; relay polarity must be commissioned explicitly."""

from __future__ import annotations
from . import pins
from .runtime import gpio_module


class BlowerRelay:
    def __init__(self, active_level: str):
        if active_level not in ("HIGH", "LOW"):
            raise ValueError("blower_relay_active_level must be HIGH or LOW, based on the actual module")
        self.GPIO = gpio_module()
        self.active = self.GPIO.HIGH if active_level == "HIGH" else self.GPIO.LOW
        self.inactive = self.GPIO.LOW if self.active == self.GPIO.HIGH else self.GPIO.HIGH
        self.GPIO.setup(pins.BLOWER_RELAY_IN, self.GPIO.OUT, initial=self.inactive)

    def on(self) -> None:
        self.GPIO.output(pins.BLOWER_RELAY_IN, self.active)

    def off(self) -> None:
        self.GPIO.output(pins.BLOWER_RELAY_IN, self.inactive)

    def close(self) -> None:
        try:
            self.off()
        finally:
            self.GPIO.cleanup([pins.BLOWER_RELAY_IN])

