"""Two-input DRV8871 driver for the nozzle swing DC motor."""

from __future__ import annotations
from . import pins
from .runtime import gpio_module


class SwingMotor:
    PWM_HZ = 1000

    def __init__(self):
        self.GPIO = gpio_module()
        self.GPIO.setup(pins.SWING_IN1, self.GPIO.OUT, initial=self.GPIO.LOW)
        self.GPIO.setup(pins.SWING_IN2, self.GPIO.OUT, initial=self.GPIO.LOW)
        self.a = self.GPIO.PWM(pins.SWING_IN1, self.PWM_HZ)
        self.b = self.GPIO.PWM(pins.SWING_IN2, self.PWM_HZ)
        self.a.start(0)
        self.b.start(0)

    def drive(self, direction: str, duty_percent: float) -> None:
        if direction not in ("home", "scatter"):
            raise ValueError("direction must be 'home' or 'scatter'")
        if isinstance(duty_percent, bool) or not 0 < float(duty_percent) <= 100:
            raise ValueError("PWM duty must be greater than 0 and at most 100 percent")
        self.stop()
        pwm = self.a if direction == "scatter" else self.b
        pwm.ChangeDutyCycle(float(duty_percent))

    def stop(self) -> None:
        self.a.ChangeDutyCycle(0)
        self.b.ChangeDutyCycle(0)
        self.GPIO.output(pins.SWING_IN1, self.GPIO.LOW)
        self.GPIO.output(pins.SWING_IN2, self.GPIO.LOW)

    def close(self) -> None:
        try:
            self.stop()
            self.a.stop()
            self.b.stop()
        finally:
            self.GPIO.cleanup([pins.SWING_IN1, pins.SWING_IN2])

