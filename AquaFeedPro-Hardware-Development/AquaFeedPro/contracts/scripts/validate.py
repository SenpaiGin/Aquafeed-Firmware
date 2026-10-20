from __future__ import annotations

import datetime as dt
import copy
import json
import math
import re
import sys
from importlib.metadata import version
from pathlib import Path
from zoneinfo import ZoneInfo, ZoneInfoNotFoundError, available_timezones

import yaml
from jsonschema import Draft202012Validator, FormatChecker


CONTRACT_DIR = Path(__file__).resolve().parents[1]
SCHEMA_PATH = CONTRACT_DIR / "schemas" / "v2.schema.json"
MANIFEST_PATH = CONTRACT_DIR / "fixtures" / "manifest.json"
UUID_RE = re.compile(r"^[0-9a-fA-F]{8}-(?:[0-9a-fA-F]{4}-){3}[0-9a-fA-F]{12}$")
DATE_RE = re.compile(r"^(\d{4})-(\d{2})-(\d{2})$")
UTC_RE = re.compile(r"^(\d{4}-\d{2}-\d{2})T(?:[01]\d|2[0-3]):[0-5]\d:[0-5]\d(?:\.\d+)?Z$")
LOCAL_TIME_RE = re.compile(r"^(?:[01]\d|2[0-3]):[0-5]\d$")


def valid_uuid(value: object) -> bool:
    return isinstance(value, str) and UUID_RE.fullmatch(value) is not None


def valid_date(value: object) -> bool:
    if not isinstance(value, str) or DATE_RE.fullmatch(value) is None:
        return False
    try:
        dt.date.fromisoformat(value)
        return True
    except ValueError:
        return False


def valid_utc_datetime(value: object) -> bool:
    if not isinstance(value, str):
        return False
    match = UTC_RE.fullmatch(value)
    if match is None or not valid_date(match.group(1)):
        return False
    try:
        dt.datetime.fromisoformat(value[:-1] + "+00:00")
        return True
    except ValueError:
        return False


def valid_local_time(value: object) -> bool:
    return isinstance(value, str) and LOCAL_TIME_RE.fullmatch(value) is not None


def resolve_iana_time_zone(value: object) -> str | None:
    if not isinstance(value, str) or not value:
        return None
    if re.fullmatch(r"(?:(?:UTC|GMT))?[+-]\d{1,2}(?::?\d{2})?", value, re.IGNORECASE):
        return None
    zones = available_timezones()
    if value in zones:
        return value
    matches = [zone for zone in zones if zone.casefold() == value.casefold()]
    if len(matches) != 1:
        return None
    try:
        ZoneInfo(matches[0])
        return matches[0]
    except (ZoneInfoNotFoundError, ValueError):
        return None


def valid_iana_time_zone(value: object) -> bool:
    return resolve_iana_time_zone(value) is not None


FORMAT_CHECKER = FormatChecker()
FORMAT_CHECKER.checks("uuid")(valid_uuid)
FORMAT_CHECKER.checks("date")(valid_date)
FORMAT_CHECKER.checks("date-time")(valid_utc_datetime)
FORMAT_CHECKER.checks("local-time")(valid_local_time)
FORMAT_CHECKER.checks("iana-time-zone")(valid_iana_time_zone)


def pointer_escape(part: object) -> str:
    return str(part).replace("~", "~0").replace("/", "~1")


def pointer(parts: object) -> str:
    return "".join("/" + pointer_escape(part) for part in parts)  # type: ignore[arg-type]


def non_finite_path(value: object, current: str = "") -> str | None:
    if isinstance(value, float) and not math.isfinite(value):
        return current
    if isinstance(value, list):
        for index, child in enumerate(value):
            bad = non_finite_path(child, current + "/" + str(index))
            if bad is not None:
                return bad
    elif isinstance(value, dict):
        for key, child in value.items():
            bad = non_finite_path(child, current + "/" + pointer_escape(key))
            if bad is not None:
                return bad
    return None


def semantic_dose(value: dict) -> dict:
    if value["mode"] == "grams":
        return {"mode": value["mode"], "amount_g": value["amount_g"]}
    return {"mode": value["mode"], "fixed_portion_id": value["fixed_portion_id"]}


def manual_semantic(request: dict) -> dict:
    return {"targets": [{"nozzle_number": target["nozzle_number"], "dose": semantic_dose(target["dose"])} for target in request["targets"]], "capabilities_revision": request["capabilities_revision"]}


def command_status_consistent(command: object) -> bool:
    if not isinstance(command, dict):
        return False
    targets = command.get("targets")
    results = command.get("nozzle_results")
    if not isinstance(targets, list) or not isinstance(results, list) or len(targets) != len(results):
        return False
    for target, result in zip(targets, results):
        if target.get("nozzle_number") != result.get("nozzle_number"):
            return False
        if semantic_dose(target.get("dose", {})) != semantic_dose(result.get("requested_dose", {})):
            return False

    statuses = [result.get("status") for result in results]
    status = command.get("status")
    if status == "completed" and any(value != "completed" for value in statuses):
        return False
    if status == "partial" and not (len(statuses) == 2 and (
            (statuses[0] == "completed" and statuses[1] in {"failed", "unknown", "not_started"})
            or (statuses[0] == "failed" and statuses[1] == "completed"))):
        return False
    has_unknown = "unknown" in statuses
    if status == "unknown" and not has_unknown:
        return False
    if has_unknown:
        resolution = command.get("lockout_resolution")
        if command.get("safety_lockout") is True:
            if resolution is not None:
                return False
        elif not isinstance(resolution, dict) or resolution.get("source") != "device_maintenance":
            return False
    elif command.get("lockout_resolution") is not None:
        return False

    # Nozzle 2 may only act after nozzle 1 completed, or failed with a valid settled weighing.
    if len(statuses) == 2 and statuses[1] in {"running", "completed", "failed", "unknown"} and not (
            statuses[0] == "completed" or (statuses[0] == "failed" and results[0].get("measurement_quality") == "valid")):
        return False
    return True


def configuration_semantic(based_on_revision: object, snapshot: dict) -> dict:
    schedules = [
        {
            "schedule_id": schedule["schedule_id"],
            "local_time": schedule["local_time"],
            "weekdays": sorted(schedule["weekdays"]),
            "enabled": schedule["enabled"],
            "targets": [{"nozzle_number": target["nozzle_number"], "dose": semantic_dose(target["dose"])} for target in schedule["targets"]],
        }
        for schedule in snapshot["schedules"]
    ]
    schedules.sort(key=lambda schedule: schedule["schedule_id"])
    semantic_snapshot = {
        "timezone": snapshot["timezone"].casefold(),
        "monitoring_limits": {
            "do_low_mg_l": snapshot["monitoring_limits"]["do_low_mg_l"],
            "do_high_mg_l": snapshot["monitoring_limits"]["do_high_mg_l"],
        },
        "low_feed_threshold_pct": snapshot["low_feed_threshold_pct"],
        "schedules": schedules,
    }
    return {"based_on_revision": based_on_revision, "snapshot": semantic_snapshot}


def matching_utc_instants(time_zone: str, local_date: str, local_time: str) -> set[dt.datetime]:
    canonical_zone = resolve_iana_time_zone(time_zone)
    if canonical_zone is None:
        raise ValueError(f"unknown IANA time zone {time_zone}")
    zone = ZoneInfo(canonical_zone)
    local = dt.datetime.fromisoformat(f"{local_date}T{local_time}")
    matches: set[dt.datetime] = set()
    for fold in (0, 1):
        instant = local.replace(tzinfo=zone, fold=fold).astimezone(dt.timezone.utc)
        round_trip = instant.astimezone(zone).replace(tzinfo=None)
        if round_trip == local:
            matches.add(instant)
    return matches


def read_json(path: Path) -> object:
    return json.loads(path.read_text(encoding="utf-8"))


def resolve_pointer(document: object, fragment: str) -> object:
    if fragment in ("", "#"):
        return document
    if not fragment.startswith("#/"):
        raise AssertionError(f"unsupported JSON pointer: {fragment}")
    value = document
    for token in fragment[2:].split("/"):
        part = token.replace("~1", "/").replace("~0", "~")
        if not isinstance(value, dict) or part not in value:
            raise AssertionError(f"unresolved JSON pointer: {fragment}")
        value = value[part]
    return value


def check_openapi(schema: dict, openapi_path: Path) -> None:
    openapi = yaml.safe_load(openapi_path.read_text(encoding="utf-8"))
    assert openapi["openapi"] == "3.1.1"
    assert openapi["servers"][0]["url"] == "/functions/v1"
    assert openapi["security"] == [], "each route must declare its own caller credential"
    paths = openapi["paths"]
    expected = {
        "/app-api/v2/pair": ("post", "InstallationJwt", "PairRequest", {"201": "PairResponse"}),
        "/app-api/v2/devices/{id}/feed": ("post", "InstallationJwt", "ManualFeedRequest", {"200": "CommandStatusResponse", "202": "CommandAcceptedResponse"}),
        "/app-api/v2/devices/{id}/feed-recovery/no-admission": ("post", "InstallationJwt", "ManualFeedRequest", {"200": "ManualFeedRecoveryResponse"}),
        "/app-api/v2/devices/{id}/commands/{commandId}": ("get", "InstallationJwt", None, {"200": "CommandStatusResponse"}),
        "/app-api/v2/devices/{id}/commands/by-key": ("get", "InstallationJwt", None, {"200": "CommandByKeyResponse"}),
        "/app-api/v2/devices/{id}/history": ("get", "InstallationJwt", None, {"200": "HistoryPageResponse"}),
        "/app-api/v2/devices/{id}/history/{sequenceId}": ("get", "InstallationJwt", None, {"200": "HistoryDetailResponse"}),
        "/app-api/v2/devices/{id}/configuration": ("put", "InstallationJwt", "ConfigurationWriteRequest", {"200": "ConfigurationWriteResponse", "202": "ConfigurationWriteResponse"}),
        "/app-api/v2/devices/{id}/next-occurrence": ("get", "InstallationJwt", None, {"200": "NextAppliedOccurrenceResponse"}),
        "/app-api/v2/devices/{id}/monitoring": ("get", "InstallationJwt", None, {"200": "MonitoringSnapshotResponse"}),
        "/app-api/v2/devices/{id}/monitoring/do": ("get", "InstallationJwt", None, {"200": "DoGraphResponse"}),
        "/app-api/v2/devices/{id}/notifications": ("get", "InstallationJwt", None, {"200": "NotificationsPageResponse"}),
        "/app-api/v2/devices/{id}/notifications/{eventId}": ("patch", "InstallationJwt", "NotificationActionRequest", {"200": "NotificationActionResponse"}),
        "/app-api/v2/devices/{id}/notifications/actions": ("post", "InstallationJwt", "NotificationBulkActionRequest", {"200": "NotificationBulkActionResponse"}),
        "/app-api/v2/push-token": ("post", "InstallationJwt", "AndroidPushTokenRegistrationRequest", {"200": "AndroidPushTokenRegistrationResponse"}),
        "/app-api/v2/devices/{id}/alias": ("patch", "InstallationJwt", "AliasUpdateRequest", {"200": "AliasUpdateResponse"}),
        "/app-api/v2/devices/{id}/access": ("delete", "InstallationJwt", None, {"200": "AccessRevokedResponse"}),
        "/device-api/v2/sync": ("post", "DeviceCredential", "DeviceSyncRequest", {"200": "DeviceSyncResponse"}),
        "/device-api/v2/wait": ("post", "DeviceCredential", "DeviceWaitRequest", {"200": "DeviceWaitResponse"}),
        "/device-api/v2/pairing-window": ("post", "DeviceCredential", "PairingWindowRequest", {"201": "PairingWindowResponse"}),
    }
    assert set(paths) == set(expected), "OpenAPI must contain the twenty implemented paths"
    definitions = schema["$defs"]
    for name, component in openapi["components"]["schemas"].items():
        assert component == {"$ref": f"./schemas/v2.schema.json#/$defs/{name}"}, f"component {name} must reference the canonical schema"
        assert name in definitions, f"component {name} is missing from canonical definitions"

    for path, (method, auth, request_dto, response_dtos) in expected.items():
        item = paths[path]
        operation = item[method]
        assert operation["security"] == [{auth: []}], f"wrong credential on {path}"
        if request_dto:
            body_schema = operation["requestBody"]["content"]["application/json"]["schema"]
            assert body_schema["$ref"] == f"#/components/schemas/{request_dto}", f"wrong request DTO on {path}"
        for code, dto in response_dtos.items():
            response_schema = operation["responses"][code]["content"]["application/json"]["schema"]
            assert response_schema["$ref"] == f"#/components/schemas/{dto}", f"wrong {code} response DTO on {path}"

    configuration_read = paths["/app-api/v2/devices/{id}/configuration"]["get"]
    assert configuration_read["security"] == [{"InstallationJwt": []}]
    assert configuration_read["responses"]["200"]["content"]["application/json"]["schema"]["$ref"] == "#/components/schemas/ConfigurationReadResponse"
    assert any(parameter["name"] == "request_id" and parameter["in"] == "query" for parameter in configuration_read["parameters"])

    for path in (
        "/app-api/v2/devices/{id}/commands/{commandId}",
        "/app-api/v2/devices/{id}/commands/by-key",
        "/app-api/v2/devices/{id}/history",
        "/app-api/v2/devices/{id}/history/{sequenceId}",
        "/app-api/v2/devices/{id}/configuration",
        "/app-api/v2/devices/{id}/next-occurrence",
        "/app-api/v2/devices/{id}/monitoring",
        "/app-api/v2/devices/{id}/monitoring/do",
        "/app-api/v2/devices/{id}/notifications",
        "/app-api/v2/devices/{id}/notifications/{eventId}",
        "/app-api/v2/devices/{id}/notifications/actions",
        "/app-api/v2/push-token",
        "/app-api/v2/devices/{id}/access",
    ):
        item = paths[path]
        operation = item[expected[path][0]]
        parameters = item.get("parameters", []) + operation.get("parameters", [])
        parameters = [resolve_pointer(openapi, parameter["$ref"]) if "$ref" in parameter else parameter for parameter in parameters]
        for header in ("X-Protocol-Major", "X-Request-Id"):
            assert any(p["name"] == header and p["in"] == "header" and p["required"] is True for p in parameters), f"{path} must require {header}"
    by_key_params = paths["/app-api/v2/devices/{id}/commands/by-key"]["get"]["parameters"]
    assert any(p["name"] == "key" and p["in"] == "query" and p["required"] is True for p in by_key_params)
    history_params = paths["/app-api/v2/devices/{id}/history"]["get"]["parameters"]
    for name in ("from", "to", "source", "status", "cursor"):
        assert any(p["name"] == name and p["in"] == "query" for p in history_params), f"history must define its {name} filter"
    notification_params = paths["/app-api/v2/devices/{id}/notifications"]["get"]["parameters"]
    notification_cursor = next((p for p in notification_params if p.get("name") == "cursor" and p.get("in") == "query"), None)
    assert notification_cursor is not None, "notification list must define its cursor"
    assert notification_cursor["required"] is False and notification_cursor["schema"]["maxLength"] == 1024
    event_path_params = paths["/app-api/v2/devices/{id}/notifications/{eventId}"].get("parameters", [])
    assert any(p.get("$ref") == "#/components/parameters/NotificationEventId" for p in event_path_params), "notification action path must bind one event UUID"
    event_read = paths["/app-api/v2/devices/{id}/notifications/{eventId}"]["get"]
    assert event_read["security"] == [{"InstallationJwt": []}]
    assert event_read["responses"]["200"]["content"]["application/json"]["schema"]["$ref"] == "#/components/schemas/NotificationEventReadResponse"
    event_read_parameters = event_path_params + event_read.get("parameters", [])
    for header in ("X-Protocol-Major", "X-Request-Id"):
        assert any((resolve_pointer(openapi, parameter["$ref"]) if "$ref" in parameter else parameter).get("name") == header for parameter in event_read_parameters), f"event GET must require {header}"
    token_delete = paths["/app-api/v2/push-token"]["delete"]
    assert token_delete["security"] == [{"InstallationJwt": []}]
    token_delete_parameters = token_delete.get("parameters", [])
    for header in ("X-Protocol-Major", "X-Request-Id"):
        assert any((resolve_pointer(openapi, parameter["$ref"]) if "$ref" in parameter else parameter).get("name") == header for parameter in token_delete_parameters), f"token DELETE must require {header}"
    assert token_delete["requestBody"]["content"]["application/json"]["schema"]["$ref"] == "#/components/schemas/AndroidPushTokenRevocationRequest"
    assert token_delete["responses"]["200"]["content"]["application/json"]["schema"]["$ref"] == "#/components/schemas/AndroidPushTokenRevocationResponse"

    def visit(node: object) -> None:
        if isinstance(node, list):
            for child in node:
                visit(child)
        elif isinstance(node, dict):
            for key, child in node.items():
                if key == "$ref" and isinstance(child, str):
                    file_part, separator, fragment = child.partition("#")
                    if not file_part:
                        resolve_pointer(openapi, "#" + fragment if separator else "")
                    else:
                        assert not re.match(r"^[A-Za-z][A-Za-z0-9+.-]*:", file_part), f"network ref forbidden: {child}"
                        target = (openapi_path.parent / file_part).resolve()
                        assert target == SCHEMA_PATH.resolve(), f"external ref must target canonical schema: {child}"
                        resolve_pointer(schema, "#" + fragment if separator else "")
                else:
                    visit(child)

    visit(openapi)


def reduce_command(fixture: dict) -> dict:
    status = fixture["initial_status"]
    sequence = int(fixture["initial_sequence"])
    safety_lockout = status == "unknown"
    transitions = {
        "queued": {"accepted", "rejected", "expired"},
        "accepted": {"running", "rejected", "expired", "unknown"},
        "running": {"completed", "failed", "unknown"},
        "unknown": {"completed", "failed"},
    }
    terminal = {"completed", "failed", "rejected", "expired"}
    for event in sorted(fixture["events"], key=lambda item: int(item["event_sequence"])):
        event_sequence = int(event["event_sequence"])
        if event_sequence <= sequence:
            continue
        sequence = event_sequence
        incoming = event["status"]
        if status in terminal or event.get("reliable") is not True:
            continue
        if incoming == "reboot":
            if status in {"running", "accepted"}:
                status = "unknown"
                safety_lockout = True
            continue
        if incoming == "maintenance_acknowledged":
            if status == "unknown" and event.get("device_authenticated") is True:
                safety_lockout = False
            continue
        if incoming == "expired":
            if status in {"queued", "accepted"} and event.get("confirmed_not_started") is True and event.get("possible_movement") is not True:
                status = "expired"
                safety_lockout = False
            elif event.get("possible_movement") is True or status == "running":
                status = "unknown"
                safety_lockout = True
            continue
        if status == "unknown" and incoming in {"completed", "failed"}:
            status = incoming
            safety_lockout = False
        elif incoming in transitions.get(status, set()):
            status = incoming
            safety_lockout = status == "unknown"
    result = {"status": status, "safety_lockout": safety_lockout}
    if "initial_measured_dispensed_g" in fixture:
        result["measured_dispensed_g"] = fixture["initial_measured_dispensed_g"]
    return result


def check_behavior(rule: str, fixture: dict) -> dict:
    if rule == "command-history":
        return reduce_command(fixture)
    if rule == "command-progress":
        return {name: command_status_consistent(command) for name, command in fixture["cases"].items()}
    if rule == "feed-idempotency":
        by_key: dict[str, dict] = {}
        results: list[str] = []
        for request in fixture["requests"]:
            key = f"{fixture['device_id']}:{fixture['installation_id']}:{request['idempotency_key']}"
            previous = by_key.get(key)
            if previous is None:
                by_key[key] = request
                results.append("new-command")
            elif manual_semantic(previous) == manual_semantic(request):
                results.append("same-command")
            else:
                results.append("IDEMPOTENCY_CONFLICT")
        return {
            "same_payload": results[1],
            "changed_payload": results[2],
            "request_id_only": results[3],
            "changed_second_dose": results[5],
            "changed_target": results[6],
        }
    if rule == "configuration-replay":
        original = configuration_semantic(fixture["based_on_revision"], fixture["snapshot"])
        same = original == configuration_semantic(fixture.get("replay_based_on_revision", fixture["based_on_revision"]), fixture["replay_snapshot"])
        changed = original != configuration_semantic(fixture["based_on_revision"], fixture["changed_snapshot"])
        changed_base = original != configuration_semantic(fixture["changed_base_revision"], fixture["snapshot"])
        return {
            "same_snapshot": "same-revision" if same else "CONFIG_CONFLICT",
            "changed_snapshot": "CONFIG_CONFLICT" if changed else "same-revision",
            "changed_base_payload": "CONFIG_CONFLICT" if changed_base else "same-revision",
            "pending_second_edit": "CONFIG_PENDING" if fixture["pending"] and fixture["next_request_id"] != fixture["request_id"] else "accepted",
        }
    if rule == "sync-dedup":
        def sample_key(record: dict) -> str:
            return f"{record['boot_id']}:{record['sequence']}"

        def event_key(record: dict) -> str:
            return f"{record['sequence_id']}:{record['event_sequence']}"

        def identity(record: dict) -> str:
            if record["type"] == "sample":
                return f"sample:{sample_key(record)}"
            return f"event:{event_key(record)}"

        unique_samples = {sample_key(record) for record in fixture["samples"]}
        unique_events = {event_key(record) for record in fixture["events"]}
        acknowledged_samples = {sample_key(record) for record in fixture["acknowledgements"]["samples"]}
        acknowledged_events = {event_key(record) for record in fixture["acknowledgements"]["events"]}
        remaining = sorted(
            identity(record)
            for record in fixture["outbox"]
            if (record["type"] == "sample" and sample_key(record) not in acknowledged_samples)
            or (record["type"] == "event" and event_key(record) not in acknowledged_events)
        )
        return {
            "unique_sample_acks": len(acknowledged_samples),
            "unique_event_acks": len(acknowledged_events),
            "effects": len(unique_samples) + len(unique_events),
            "outbox_remaining": remaining,
        }
    if rule == "schedule-ledger":
        def occurrence_key(record: dict) -> str:
            return f"{fixture['device_id']}:{fixture['schedule_id']}:{record['local_date']}"

        return {"first": "execute", "edited_timezone_same_date": "duplicate" if occurrence_key(fixture["first"]) == occurrence_key(fixture["edited"]) else "execute"}
    if rule == "dst":
        repeated = fixture["repeated"]
        nonexistent = fixture["nonexistent"]
        repeated_count = len(matching_utc_instants(repeated["timezone"], repeated["date"], repeated["local_time"]))
        nonexistent_count = len(matching_utc_instants(nonexistent["timezone"], nonexistent["date"], nonexistent["local_time"]))
        return {
            "repeated_wall_time_instants": repeated_count,
            "executions": 1 if repeated_count > 0 else 0,
            "nonexistent_wall_time_instants": nonexistent_count,
            "nonexistent_action": "skip" if nonexistent_count == 0 else "execute",
        }
    if rule == "schedule-clock":
        return {
            "forward_after_reboot": "skip" if fixture["rebooted_after_due_time"] or fixture["forward_clock_jump_after_due_time"] else "execute",
            "backward_with_ledger": "duplicate" if fixture["backward_clock_has_ledger_entry"] else "execute",
            "invalid_clock": "pause" if fixture["clock_quality"] == "invalid" else "execute",
            "actuator_collision": "DEVICE_BUSY" if fixture["manual_and_schedule_overlap"] else "execute",
        }
    if rule == "schedule-group":
        due = dt.datetime.fromisoformat(fixture["due_at"].replace("Z", "+00:00"))
        baseline = dt.datetime.fromisoformat(fixture["baseline_ready_at"].replace("Z", "+00:00"))
        second = dt.datetime.fromisoformat(fixture["nozzle2_started"].replace("Z", "+00:00"))
        first_completed = dt.datetime.fromisoformat(fixture["nozzle1_completed"].replace("Z", "+00:00"))
        released = dt.datetime.fromisoformat(fixture["reservation_released_at"].replace("Z", "+00:00"))
        grace = dt.timedelta(milliseconds=fixture["wake_grace_ms"])
        return {
            "admitted_together": fixture["both_admitted"] is True and len(fixture["targets"]) == 2,
            "order": sorted(fixture["targets"]),
            "sequence_reserved_through_settling": released >= baseline,
            "nozzle2_after_nozzle1_normal_completion": "ready" if first_completed <= second and second >= baseline else "blocked",
            "nozzle2_start_deadline": "baseline_ready_at_plus_wake_grace" if baseline + grace >= second and due + grace < second else "first_deadline_reused",
        }
    if rule == "sequence-abort":
        gates = ("safe_stop", "settled_weighing", "device_healthy", "target_authorized", "capability", "inventory", "deadline")

        def summary(item: dict) -> list[str]:
            first = "unknown" if item["failure"] == "uncertain_stop" else "completed" if item["first_completed"] is True else "failed"
            proof = item.get("gates", {})
            continues = (item["failure"] != "invalid_weighing" if first == "completed"
                         else item["failure"] == "recoverable" and all(proof.get(gate) is True for gate in gates))
            second = item["nozzle2_outcome"] if continues else "not_started"
            completed = [first, second].count("completed")
            outcome = "unknown" if "unknown" in (first, second) else {1: "partial", 2: "completed"}.get(completed, "failed")
            return [first, second, outcome]

        return {**{name: summary(item) for name, item in fixture["cases"].items()}, "automatic_resume": False}
    if rule == "notification-history":
        def tuple_key(event: dict) -> tuple:
            timestamp = dt.datetime.fromisoformat(event["raised_at"].replace("Z", "+00:00"))
            return (timestamp, event["event_id"])

        events = sorted(fixture["events"], key=tuple_key, reverse=True)
        page_size = fixture["page_size"]

        def is_through(event: dict, cutoff: object) -> bool:
            return isinstance(cutoff, dict) and tuple_key(event) <= tuple_key(cutoff)

        def state_flags(event: dict, state: dict) -> tuple[bool, bool]:
            event_id = event["event_id"]
            dismissed = event_id in state["dismissed_event_ids"] or is_through(event, state["dismissed_through"])
            read = dismissed or event_id in state["read_event_ids"] or is_through(event, state["read_through"])
            return read, dismissed

        def pages_for(state: dict) -> tuple[list[dict], dict | None, list[dict]]:
            visible = [event for event in events if not state_flags(event, state)[1]]
            first_page = visible[:page_size]
            cursor = first_page[-1] if first_page else None
            second_page = [event for event in visible if cursor is not None and tuple_key(event) < tuple_key(cursor)][:page_size]
            return first_page, cursor, second_page

        first = fixture["installations"]["first"]
        second = fixture["installations"]["second"]
        first_page, first_cursor, first_next = pages_for(first)
        second_page, _, second_next = pages_for(second)
        return {
            "shared_event_ids": [event["event_id"] for event in events],
            "first_page_event_ids": [event["event_id"] for event in first_page],
            "first_next_cursor": None if first_cursor is None else {
                "raised_at": first_cursor["raised_at"],
                "event_id": first_cursor["event_id"],
            },
            "first_second_page_event_ids": [event["event_id"] for event in first_next],
            "first_unread_count": sum(
                1 for event in events if not state_flags(event, first)[0] and not state_flags(event, first)[1]
            ),
            "second_page_event_ids": [event["event_id"] for event in second_page],
            "second_second_page_event_ids": [event["event_id"] for event in second_next],
            "second_unread_count": sum(
                1 for event in events if not state_flags(event, second)[0] and not state_flags(event, second)[1]
            ),
            "newer_than_bulk_cutoff_unread": not state_flags(events[0], second)[0] and not state_flags(events[0], second)[1],
        }
    if rule == "schedule-collisions":
        # Expand each schedule to its nozzle slots; a repeated nozzle slot is rejected.
        result = {}
        for name, schedules in fixture["groups"].items():
            due: dict[tuple, list[int]] = {}
            for schedule in schedules:
                for day in schedule["weekdays"]:
                    due.setdefault((schedule["local_time"], day), []).extend(schedule["nozzles"])
            groups = list(due.values())
            result[name] = "reject" if any(len(set(g)) != len(g) for g in groups) else sorted(max(groups, key=len, default=[]))
        return result
    if rule == "semantic-replay":
        feed = fixture["feed"]
        config = fixture["configuration"]
        first_feed = feed["first"]
        replay_feed = feed["replay"]
        return {
            "feed_reordered_with_additive_fields": "same-command" if first_feed["device_id"] == replay_feed["device_id"] and first_feed["installation_id"] == replay_feed["installation_id"] and first_feed["idempotency_key"] == replay_feed["idempotency_key"] and manual_semantic(first_feed) == manual_semantic(replay_feed) else "IDEMPOTENCY_CONFLICT",
            "feed_numeric_spelling_equal": semantic_dose(first_feed["targets"][0]["dose"]) == semantic_dose(replay_feed["targets"][0]["dose"]),
            "feed_changed_second_dose": "same-command" if manual_semantic(first_feed) == manual_semantic(feed["changed_dose"]) else "IDEMPOTENCY_CONFLICT",
            "feed_changed_nozzle": "same-command" if manual_semantic(first_feed) == manual_semantic(feed["changed_nozzle"]) else "IDEMPOTENCY_CONFLICT",
            "config_reordered_with_additive_fields": "same-revision" if config["request_id"] == config["replay_request_id"] and configuration_semantic(config["based_on_revision"], config["first"]) == configuration_semantic(config["replay_based_on_revision"], config["replay"]) else "CONFIG_CONFLICT",
            "config_numeric_spelling_equal": config["first"]["low_feed_threshold_pct"] == config["replay"]["low_feed_threshold_pct"],
            "config_distinct_alias_conflict": "CONFIG_CONFLICT" if configuration_semantic(config["based_on_revision"], config["first"]) != configuration_semantic(config["based_on_revision"], config["different_alias"]) else "same-revision",
            "config_changed_base_revision": "same-revision" if configuration_semantic(config["based_on_revision"], config["first"]) == configuration_semantic(config["changed_base_revision"], config["first"]) else "CONFIG_CONFLICT",
        }
    if rule == "timezone-casing":
        return {
            "canonical": resolve_iana_time_zone(fixture["canonical"]) is not None,
            "lowercase_variant": resolve_iana_time_zone(fixture["lowercase_variant"]) is not None,
            "alias": resolve_iana_time_zone(fixture["alias"]) is not None,
            "second_alias": resolve_iana_time_zone(fixture["second_alias"]) is not None,
            "numeric_offset": resolve_iana_time_zone(fixture["numeric_offset"]) is not None,
            "nonexistent": resolve_iana_time_zone(fixture["nonexistent"]) is not None,
        }
    raise AssertionError(f"unknown behavior rule: {rule}")


def normalize_error(error: object) -> list[tuple[str, str]]:
    results: list[tuple[str, str]] = []
    validator = getattr(error, "validator", None)
    parts = list(getattr(error, "absolute_path", []))
    base = pointer(parts)
    if validator == "required":
        instance = getattr(error, "instance", {})
        schema = getattr(error, "schema", {})
        missing = [name for name in schema.get("required", []) if name not in instance]
        if missing:
            results.extend((base + "/" + pointer_escape(name), "required") for name in missing)
        else:
            results.append((base, "required"))
    elif validator == "additionalProperties":
        instance = getattr(error, "instance", {})
        schema = getattr(error, "schema", {})
        extras = [name for name in instance if name not in schema.get("properties", {})]
        results.extend((base + "/" + pointer_escape(name), "additionalProperties") for name in extras)
    else:
        results.append((base, str(validator)))
    for child in getattr(error, "context", []):
        results.extend(normalize_error(child))
    return results


def main() -> int:
    schema = read_json(SCHEMA_PATH)
    manifest = read_json(MANIFEST_PATH)
    assert isinstance(schema, dict) and isinstance(manifest, dict)
    assert manifest["contract_version"] == "2.7.0"
    assert manifest["schema"] == "../schemas/v2.schema.json"
    assert schema["$defs"]["ProtocolMajor"]["const"] == 2, "v1 protocol messages must fail validation"
    Draft202012Validator.check_schema(schema)
    check_openapi(schema, CONTRACT_DIR / "openapi.yaml")
    print("PASS OpenAPI 3.1.1 routes, auth separation, canonical DTO refs, and local reference resolution")

    validators: dict[str, Draft202012Validator] = {}
    for name in schema["$defs"]:
        wrapper = {
            "$schema": schema["$schema"],
            "$id": f"{schema['$id']}/fixture/{name}",
            "$defs": schema["$defs"],
            "$ref": f"#/$defs/{name}",
        }
        validators[name] = Draft202012Validator(wrapper, format_checker=FORMAT_CHECKER)

    passed = 0
    for fixture in manifest["fixtures"]:
        assert fixture["schema"] in validators, f"{fixture['name']}: unknown schema"
        value = read_json((CONTRACT_DIR / "fixtures" / fixture["file"]).resolve())
        bad_number = non_finite_path(value)
        errors = [(bad_number, "finite-number")] if bad_number is not None else []
        if bad_number is None:
            for error in validators[fixture["schema"]].iter_errors(value):
                errors.extend(normalize_error(error))
        if fixture["expect"] == "valid":
            assert not errors, f"{fixture['name']}: expected valid ({fixture['reason']}), got {errors[:5]}"
        else:
            failure = fixture.get("failure")
            assert failure is not None, f"{fixture['name']}: invalid fixture needs named failure"
            wanted = (failure["path"], failure["keyword"])
            assert wanted in errors, f"{fixture['name']}: expected {wanted} ({fixture['reason']}), got {errors[:12]}"
        if fixture["schema"] == "CommandStatusDTO":
            assert command_status_consistent(value) == (fixture["expect"] == "valid"), f"{fixture['name']}: command intent and nozzle results do not agree"
        if fixture["schema"] == "HistoryPageResponse" and fixture["expect"] == "valid":
            assert value["records"], f"{fixture['name']}: page-size boundary fixture needs one valid record"
            oversized = {**value, "records": [value["records"][0]] * 51}
            page_errors = list(validators["HistoryPageResponse"].iter_errors(oversized))
            assert any(error.validator == "maxItems" and list(error.path) == ["records"] for error in page_errors), "history responses above 50 rows must fail at records"
        if fixture["schema"] == "NotificationsPageResponse" and fixture["expect"] == "valid":
            oversized = {**value, "events": [value["events"][0]] * 51}
            page_errors = list(validators["NotificationsPageResponse"].iter_errors(oversized))
            assert any(error.validator == "maxItems" and list(error.path) == ["events"] for error in page_errors), "notification responses above 50 visible events must fail at events"
        print(f"PASS fixture {fixture['name']}: {fixture['expect']} - {fixture['reason']}")
        passed += 1

    simulator_fixture = next(
        item for item in manifest["fixtures"] if item["name"] == "simulator-capabilities-valid"
    )
    simulator_descriptor = read_json((CONTRACT_DIR / "fixtures" / simulator_fixture["file"]).resolve())
    synthetic_descriptor = copy.deepcopy(simulator_descriptor)
    synthetic_descriptor["capabilities"]["nozzles"]["1"]["max_dose_g"] = 250
    assert validators["DeviceDescriptor"].is_valid(synthetic_descriptor), "synthetic per-nozzle dose bounds above 100 g must remain profile-valid"
    invalid_capacity = copy.deepcopy(simulator_descriptor)
    invalid_capacity["capabilities"]["feed_capacity_g"] = 0
    capacity_errors = [
        (path, keyword)
        for error in validators["DeviceDescriptor"].iter_errors(invalid_capacity)
        for path, keyword in normalize_error(error)
    ]
    assert ("/capabilities/feed_capacity_g", "exclusiveMinimum") in capacity_errors, "capacity must be positive and distinct from the dose maximum"
    failed_event_fixture = next(
        item for item in manifest["fixtures"] if item["name"] == "run-event-failed-valid"
    )
    failed_event = read_json((CONTRACT_DIR / "fixtures" / failed_event_fixture["file"]).resolve())
    failed_event.update({"measurement_quality": "valid", "measured_dispensed_g": 12.5})
    assert validators["RunEvent"].is_valid(failed_event), "a failed operation may retain known measured depletion"

    behavior_passed = 0
    for case in manifest["behavior_cases"]:
        fixture = read_json((CONTRACT_DIR / "fixtures" / case["file"]).resolve())
        actual = check_behavior(case["rule"], fixture)
        assert actual == case["expected"], f"{case['name']}: expected {case['expected']}, got {actual}"
        print(f"PASS behavior {case['name']}")
        behavior_passed += 1
    print(f"Validated {passed} schema fixtures and {behavior_passed} behavior fixtures with jsonschema {version('jsonschema')} and PyYAML {version('PyYAML')}.")
    return 0


if __name__ == "__main__":
    try:
        raise SystemExit(main())
    except Exception as error:
        print(f"FAIL {error}", file=sys.stderr)
        raise
