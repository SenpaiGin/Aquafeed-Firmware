"""Interactive test menu for the feeder motor and MG996R servo."""

import sys
from pathlib import Path
from time import sleep


sys.path.insert(0, str(Path(__file__).resolve().parents[1]))

from motor import Motor
from servo import Servo


MOTOR_IN1_PIN = 18
MOTOR_IN2_PIN = 13
MOTOR_RUN_SECONDS = 2

SERVO_PIN = 19
SERVO_STEP_DELAY_SECONDS = 0.02


def test_motor():
    motor = Motor(MOTOR_IN1_PIN, MOTOR_IN2_PIN)

    print("\nMotor: BCM GPIO18=IN1, BCM GPIO13=IN2.")
    print("Speed levels: 1=25%, 2=50%, 3=75%, 4=100%.")

    try:
        while True:
            direction = input("Direction (left/right) or back: ").strip().lower()
            if direction == "back":
                return
            if direction not in {"left", "right"}:
                print("Please enter left, right, or back.")
                continue

            try:
                speed_level = int(input("Speed level (1-4): ").strip())
            except ValueError:
                print("Please enter an integer from 1 to 4.")
                continue
            if speed_level not in Motor.SPEED_DUTIES:
                print("Please enter an integer from 1 to 4.")
                continue

            input(
                f"WARNING: Motor will run {direction} at level {speed_level} "
                f"for {MOTOR_RUN_SECONDS} seconds. Press Enter to continue..."
            )

            try:
                motor.run(direction, speed_level)
                sleep(MOTOR_RUN_SECONDS)
            finally:
                motor.stop()
    finally:
        motor.cleanup()


def test_servo():
    servo = Servo(SERVO_PIN)

    print("\nMG996R servo: BCM GPIO19, physical pin 35.")
    print("Use a separate regulated 5-6 V supply with common ground.")
    print("Each cycle moves 0 -> 90 -> 0 degrees.")

    try:
        while True:
            command = input(
                "Press Enter for one 90-degree cycle, or type back: "
            ).strip().lower()
            if command == "back":
                return
            if command:
                print("Please press Enter or type back.")
                continue

            servo.move_90_back_and_forth(SERVO_STEP_DELAY_SECONDS)
            print("Completed one 90-degree back-and-forth cycle.")
    finally:
        servo.cleanup()


def main():
    try:
        while True:
            print("\nHardware Test")
            print("1 - Motor")
            print("2 - Servo")
            print("q - Quit")

            choice = input("Choose: ").strip().lower()
            if choice == "1":
                test_motor()
            elif choice == "2":
                test_servo()
            elif choice == "q":
                break
            else:
                print("Please enter 1, 2, or q.")
    except KeyboardInterrupt:
        print("\nHardware test stopped.")


if __name__ == "__main__":
    main()
