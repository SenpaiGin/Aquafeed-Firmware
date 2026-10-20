"""Hardware interfaces. No imports that initialize GPIO occur at module import."""

from dataclasses import dataclass


@dataclass(frozen=True)
class Reading:
    value: float | None
    quality: str
    acquired_monotonic: float | None = None


class HardwareUnavailable(RuntimeError):
    pass


class Sensors:
    """Placeholder boundary for commissioned HX711 and Bluetooth DO adapters."""

    def __init__(self, config: dict):
        self.config = config

    def feed_remaining_g(self) -> Reading:
        return Reading(None, "unavailable")

    def dissolved_oxygen_mg_l(self) -> Reading:
        return Reading(None, "unavailable")


class Actuators:
    """Safe-by-default actuator boundary; real GPIO driver is commissioning-specific."""

    def __init__(self, config: dict):
        self.enabled = False
        if config.get("gpio_enabled"):
            from .safety import actuator_permission
            if not actuator_permission(config):
                raise HardwareUnavailable("GPIO requested without complete approved commissioning evidence")
            # GPIO setup intentionally remains unavailable until the installed board and
            # independent cutoff have been inspected and a matching driver is supplied.
            raise HardwareUnavailable("no commissioned GPIO driver is installed")

    def all_off(self) -> None:
        return

    def execute(self, targets: list[dict]) -> None:
        raise HardwareUnavailable("physical actuation is not commissioned")
