"""One-direction dispensing motor on a DRV8871 with IN2 tied to GND."""

from __future__ import annotations
from . import pins
from .runtime import gpio_module


class DispensingMotor:
    PWM_HZ = 1000

    def __init__(self, nozzle: int):
        self.pin = {1: pins.NOZZLE_1_IN1, 2: pins.NOZZLE_2_IN1}[nozzle]
        self.GPIO = gpio_module()
        self.GPIO.setup(self.pin, self.GPIO.OUT, initial=self.GPIO.LOW)
        self.pwm = self.GPIO.PWM(self.pin, self.PWM_HZ)
        self.pwm.start(0)

    def run(self, duty_percent: float) -> None:
        if isinstance(duty_percent, bool) or not 0 < float(duty_percent) <= 100:
            raise ValueError("PWM duty must be greater than 0 and at most 100 percent")
        self.pwm.ChangeDutyCycle(float(duty_percent))

    def stop(self) -> None:
        # IN2 is grounded in the drawing; zero duty coasts and is not a brake.
        self.pwm.ChangeDutyCycle(0)
        self.GPIO.output(self.pin, self.GPIO.LOW)

    def close(self) -> None:
        try:
            self.stop()
            self.pwm.stop()
        finally:
            self.GPIO.cleanup([self.pin])

