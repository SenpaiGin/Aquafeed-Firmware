"""BCM pin assignments from AquaFeedPro Wiring Revision B handoff."""

# Dispensing DRV8871s: IN2 is hard-wired to GND; these are IN1 only.
NOZZLE_1_IN1 = 18
NOZZLE_2_IN1 = 17

# Swing DRV8871 uses both inputs.
SWING_IN1 = 22
SWING_IN2 = 23

# Blower relay module input.
BLOWER_RELAY_IN = 24

# HX711. DT is output to Pi; SCK is output from Pi.
HX711_DOUT = 5
HX711_SCK = 6

# Proposed feedback pins in the wiring handoff; not wired/verified in the drawing.
NOZZLE_1_INDEX = 16
NOZZLE_2_INDEX = 20
SWING_HOME = 21
SWING_END = 26

