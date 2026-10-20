"""Reusable DRV8871 motor control using two PWM input pins."""

from time import sleep

import RPi.GPIO as GPIO


class Motor:
    """Control one DRV8871-connected DC motor."""

    PWM_FREQUENCY_HZ = 1000
    REVERSAL_PAUSE_SECONDS = 0.05
    SPEED_DUTIES = {1: 25, 2: 50, 3: 75, 4: 100}

    def __init__(self, in1_pin, in2_pin):
        if in1_pin == in2_pin:
            raise ValueError("IN1 and IN2 must use different GPIO pins.")

        self.in1_pin = in1_pin
        self.in2_pin = in2_pin
        self._cleaned_up = False

        GPIO.setmode(GPIO.BCM)
        GPIO.setup(self.in1_pin, GPIO.OUT, initial=GPIO.LOW)
        GPIO.setup(self.in2_pin, GPIO.OUT, initial=GPIO.LOW)

        self._in1_pwm = GPIO.PWM(self.in1_pin, self.PWM_FREQUENCY_HZ)
        self._in2_pwm = GPIO.PWM(self.in2_pin, self.PWM_FREQUENCY_HZ)
        self._in1_pwm.start(0)
        self._in2_pwm.start(0)

    def run(self, direction, speed_level):
        """Run left or right at speed level 1 through 4."""
        if not isinstance(direction, str) or direction.lower() not in {
            "left",
            "right",
        }:
            raise ValueError("Direction must be 'left' or 'right'.")
        if type(speed_level) is not int or speed_level not in self.SPEED_DUTIES:
            raise ValueError("Speed level must be an integer from 1 to 4.")
        if self._cleaned_up:
            raise RuntimeError("The motor has already been cleaned up.")

        direction = direction.lower()
        duty = self.SPEED_DUTIES[speed_level]

        self.stop()
        sleep(self.REVERSAL_PAUSE_SECONDS)

        if direction == "left":
            self._in1_pwm.ChangeDutyCycle(duty)
        else:
            self._in2_pwm.ChangeDutyCycle(duty)

    def stop(self):
        """Stop the motor without releasing its GPIO pins."""
        if not self._cleaned_up:
            self._in1_pwm.ChangeDutyCycle(0)
            self._in2_pwm.ChangeDutyCycle(0)

    def cleanup(self):
        """Stop the motor and release only its two GPIO pins."""
        if self._cleaned_up:
            return

        self.stop()
        self._in1_pwm.stop()
        self._in2_pwm.stop()
        GPIO.cleanup([self.in1_pin, self.in2_pin])
        self._cleaned_up = True
