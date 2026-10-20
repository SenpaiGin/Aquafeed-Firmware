"""MG996R control using GPIO Zero with pigpio-timed PWM."""

from time import sleep

from gpiozero import AngularServo
from gpiozero.pins.pigpio import PiGPIOFactory


class Servo:
    """Control an MG996R with an Arduino-style angle API."""

    MIN_ANGLE = 0.0
    MAX_ANGLE = 90.0

    def __init__(self, signal_pin, min_pulse_ms=1.0, max_pulse_ms=2.0):
        if min_pulse_ms <= 0 or max_pulse_ms <= min_pulse_ms:
            raise ValueError("Pulse limits must be positive and increasing.")

        self.signal_pin = signal_pin
        self._closed = False
        self._factory = PiGPIOFactory()
        try:
            self._servo = AngularServo(
                signal_pin,
                initial_angle=None,
                min_angle=self.MIN_ANGLE,
                max_angle=self.MAX_ANGLE,
                min_pulse_width=min_pulse_ms / 1000,
                max_pulse_width=max_pulse_ms / 1000,
                frame_width=20 / 1000,
                pin_factory=self._factory,
            )
        except Exception:
            self._factory.close()
            raise

    def set_angle(self, angle):
        """Move the servo to an angle from 0 through 90 degrees."""
        if isinstance(angle, bool) or not isinstance(angle, (int, float)):
            raise ValueError("Angle must be a number from 0 through 90.")
        if not self.MIN_ANGLE <= angle <= self.MAX_ANGLE:
            raise ValueError("Angle must be from 0 through 90 degrees.")
        if self._closed:
            raise RuntimeError("The servo has already been cleaned up.")
        self._servo.angle = float(angle)

    def release(self):
        """Stop the control pulses so the servo is no longer commanded."""
        if not self._closed:
            self._servo.detach()

    def move_90_back_and_forth(self, step_delay_seconds=0.02):
        """Move smoothly from 0 to 90 degrees, then return to 0."""
        if (
            isinstance(step_delay_seconds, bool)
            or not isinstance(step_delay_seconds, (int, float))
            or step_delay_seconds < 0
        ):
            raise ValueError("Step delay must be a non-negative number.")

        try:
            for angle in range(0, 91):
                self.set_angle(angle)
                sleep(step_delay_seconds)

            for angle in range(89, -1, -1):
                self.set_angle(angle)
                sleep(step_delay_seconds)
        finally:
            self.release()

    def cleanup(self):
        """Release the servo and its connection to the pigpio daemon."""
        if self._closed:
            return

        try:
            self._servo.close()
        finally:
            self._factory.close()
            self._closed = True
