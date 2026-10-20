"""End-stop input helper for proposed BCM21 home and BCM26 scatter sensors."""

from __future__ import annotations
from . import pins
from .runtime import gpio_module


class SwingLimits:
    def __init__(self, active_level: str):
        if active_level not in ("HIGH", "LOW"):
            raise ValueError("limit_switch_active_level must be HIGH or LOW and physically verified")
        self.GPIO = gpio_module()
        self.active = self.GPIO.HIGH if active_level == "HIGH" else self.GPIO.LOW
        pull = self.GPIO.PUD_DOWN if self.active == self.GPIO.HIGH else self.GPIO.PUD_UP
        self.GPIO.setup(pins.SWING_HOME, self.GPIO.IN, pull_up_down=pull)
        self.GPIO.setup(pins.SWING_END, self.GPIO.IN, pull_up_down=pull)

    def home_active(self) -> bool:
        return self.GPIO.input(pins.SWING_HOME) == self.active

    def end_active(self) -> bool:
        return self.GPIO.input(pins.SWING_END) == self.active

    def close(self) -> None:
        self.GPIO.cleanup([pins.SWING_HOME, pins.SWING_END])

