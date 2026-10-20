import copy
import json
from pathlib import Path

root = Path(__file__).resolve().parents[1]
source = root / "fixtures"
dest = source / "examples/v2"
dest.mkdir(parents=True, exist_ok=True)
old = json.loads((source / "manifest-v1.json").read_text(encoding="utf-8"))

def dose_target(dose, number=1):
    return {"nozzle_number": number, "dose": dose}

def convert(value):
    if isinstance(value, list):
        return [convert(child) for child in value]
    if not isinstance(value, dict):
        return value
    value = {key: convert(child) for key, child in value.items()}
    if value.get("protocol_major") == 1:
        value["protocol_major"] = 2
    if "active_run_id" in value:
        value["active_sequence_id"] = value.pop("active_run_id")
    if "event_sequence" in value and "run_id" in value:
        value["sequence_id"] = value.pop("run_id")
        if "event_type" in value:
            value["nozzle_number"] = 1
            value["step_index"] = 1
    if "schedule_id" in value and "local_time" in value and "dose" in value:
        value.setdefault("nozzle_number", 1)
    if "command_type" in value and "dose" in value:
        value["sequence_id"] = value.pop("run_id")
        value["device_id"] = "11111111-1111-4111-8111-111111111111"
        value["targets"] = [dose_target(value.pop("dose"))]
    elif "status_sequence" in value and "requested_dose" in value:
        value["sequence_id"] = value.pop("run_id")
        value["device_id"] = "11111111-1111-4111-8111-111111111111"
        requested = value.pop("requested_dose")
        estimated = value.pop("estimated_dispensed_g")
        measured = value.pop("measured_dispensed_g")
        quality = value.pop("measurement_quality")
        value["targets"] = [dose_target(requested)]
        value["nozzle_results"] = [{"nozzle_number": 1, "status": value["status"], "requested_dose": requested, "estimated_dispensed_g": estimated, "measured_dispensed_g": measured, "measurement_quality": quality}]
    elif "idempotency_key" in value and "dose" in value and "capabilities_revision" in value:
        value["device_id"] = value.get("device_id", "11111111-1111-4111-8111-111111111111")
        value["targets"] = [dose_target(value.pop("dose"))]
    return value

fixtures = []
for item in old["fixtures"]:
    original = json.loads((source / item["file"]).read_text(encoding="utf-8"))
    converted = convert(original)
    if item["name"] == "unsupported-major-invalid":
        converted["protocol_major"] = 3
    if item["schema"] == "DeviceDescriptor":
        old_cap = converted["capabilities"]
        capability = {key: old_cap[key] for key in ("do_monitoring", "feed_remaining_monitoring", "max_schedules", "local_schedule_execution", "max_clock_uncertainty_ms", "scheduler_wake_grace_ms")}
        capability["feed_capacity_g"] = 20000 if converted.get("is_simulated") is True else None
        capability["maximum_settling_ms"] = None
        capability["nozzles"] = {}
        for number in ("1", "2"):
            capability["nozzles"][number] = {"enabled": True, "dose_modes": old_cap["dose_modes"], "fixed_portion_ids": old_cap["fixed_portion_ids"], "min_dose_g": old_cap["min_dose_g"], "max_dose_g": old_cap["max_dose_g"], "dose_step_g": old_cap["dose_step_g"], "measured_dispensed_g": old_cap["measured_dispensed_g"], "max_actuation_ms": old_cap["max_actuation_ms"], "minimum_cooldown_ms": old_cap["minimum_cooldown_ms"]}
        converted["capabilities"] = capability
        if converted.get("is_simulated") is True:
            converted["capabilities_revision"] = 3
    if item["schema"] == "CommandAcceptedResponse":
        converted["sequence_id"] = converted.pop("run_id")
        converted["device_id"] = "11111111-1111-4111-8111-111111111111"
        converted["targets"] = [dose_target({"mode": "grams", "amount_g": 50})]
    failure = item.get("failure")
    if item["name"] == "unknown-dose-invalid": failure["path"] = "/targets/0/dose/mode"
    if item["name"] == "non-finite-number-invalid": failure["path"] = "/targets/0/dose/amount_g"
    if item["name"] == "unknown-command-invented-measurement-invalid": failure["path"] = "/command/nozzle_results/0/measured_dispensed_g"
    new = dict(item)
    if item["name"] == "unsupported-major-invalid":
        new["reason"] = "protocol major outside v2 is explicitly rejected"
    else:
        new["reason"] = item["reason"].replace("v1", "v2")
    path = f"examples/v2/{item['name']}.json"
    (source / path).write_text(json.dumps(converted, separators=(",", ":"), ensure_ascii=False) + "\n", encoding="utf-8")
    new["file"] = path
    fixtures.append(new)

manifest = {"contract_version": "2.4.0", "schema": "../schemas/v2.schema.json", "fixtures": fixtures, "behavior_cases": []}
behavior = []
for item in old["behavior_cases"]:
    value = convert(json.loads((source / item["file"]).read_text(encoding="utf-8")))
    if item["rule"] == "feed-idempotency":
        base = copy.deepcopy(value["requests"][0])
        both = copy.deepcopy(base)
        both["targets"] = [dose_target({"mode": "grams", "amount_g": 50}, 1), dose_target({"mode": "grams", "amount_g": 60}, 2)]
        changed = copy.deepcopy(both)
        changed["targets"][1]["dose"]["amount_g"] = 61
        target_change = copy.deepcopy(base)
        target_change["targets"] = [dose_target({"mode": "grams", "amount_g": 50}, 2)]
        value["requests"] = [base, copy.deepcopy(base), value["requests"][2], value["requests"][3], both, changed, target_change]
        item["expected"].update({"changed_second_dose": "IDEMPOTENCY_CONFLICT", "changed_target": "IDEMPOTENCY_CONFLICT"})
    if item["rule"] == "semantic-replay":
        first = value["feed"]["first"]
        replay = value["feed"]["replay"]
        first["targets"] = [dose_target({"mode": "grams", "amount_g": 50}, 1), dose_target({"mode": "grams", "amount_g": 60}, 2)]
        replay["targets"] = copy.deepcopy(first["targets"])
        changed_dose = copy.deepcopy(replay)
        changed_dose["targets"][1]["dose"]["amount_g"] = 61
        changed_nozzle = copy.deepcopy(replay)
        changed_nozzle["targets"][1]["nozzle_number"] = 1
        value["feed"]["changed_dose"] = changed_dose
        value["feed"]["changed_nozzle"] = changed_nozzle
        item["expected"].update({"feed_changed_second_dose": "IDEMPOTENCY_CONFLICT", "feed_changed_nozzle": "IDEMPOTENCY_CONFLICT"})
    if item["rule"] == "schedule-ledger":
        value["first"].update({"nozzle_number": 1, "dose": {"mode": "grams", "amount_g": 40}})
        value["edited"].update({"nozzle_number": 2, "dose": {"mode": "grams", "amount_g": 75}})
    path = f"examples/v2/{item['name']}.json"
    (source / path).write_text(json.dumps(value, separators=(",", ":"), ensure_ascii=False) + "\n", encoding="utf-8")
    copied = dict(item)
    copied["file"] = path
    behavior.append(copied)

def add_fixture(name, value, schema_name, expect="valid", failure=None, reason="two-nozzle v2 contract example"):
    path = f"examples/v2/{name}.json"
    (source / path).write_text(json.dumps(value, separators=(",", ":"), ensure_ascii=False) + "\n", encoding="utf-8")
    row = {"name": name, "file": path, "schema": schema_name, "expect": expect, "reason": reason}
    if failure:
        row["failure"] = failure
    fixtures.append(row)

request = {"protocol_major": 2, "request_id": "22222222-2222-4222-8222-222222222222", "device_id": "11111111-1111-4111-8111-111111111111", "idempotency_key": "33333333-3333-4333-8333-333333333333", "capabilities_revision": 1}
add_fixture("manual-feed-nozzle2-valid", {**request, "targets": [dose_target({"mode": "grams", "amount_g": 25}, 2)]}, "ManualFeedRequest")
add_fixture("manual-feed-both-valid", {**request, "targets": [dose_target({"mode": "grams", "amount_g": 25}, 1), dose_target({"mode": "grams", "amount_g": 40}, 2)]}, "ManualFeedRequest")
add_fixture("manual-feed-both-order-invalid", {**request, "targets": [dose_target({"mode": "grams", "amount_g": 40}, 2), dose_target({"mode": "grams", "amount_g": 25}, 1)]}, "ManualFeedRequest", "invalid", {"path": "/targets", "keyword": "oneOf"}, "Both cannot reorder nozzle 1 and nozzle 2")
add_fixture("unknown-nozzle-invalid", {**request, "targets": [dose_target({"mode": "grams", "amount_g": 25}, 3)]}, "ManualFeedRequest", "invalid", {"path": "/targets/0/nozzle_number", "keyword": "enum"}, "Only nozzles 1 and 2 are supported")
add_fixture("legacy-v1-manual-feed-invalid", {"protocol_major": 1, "request_id": request["request_id"], "idempotency_key": request["idempotency_key"], "dose": {"mode": "grams", "amount_g": 50}, "capabilities_revision": 1}, "ManualFeedRequest", "invalid", {"path": "/protocol_major", "keyword": "const"}, "A v1 payload is rejected explicitly; no default nozzle is inferred")
add_fixture("partial-both-nozzle2-not-started-valid", {"command_id": "66666666-6666-4666-8666-666666666666", "sequence_id": "55555555-5555-4555-8555-555555555555", "device_id": request["device_id"], "request_id": request["request_id"], "idempotency_key": request["idempotency_key"], "status": "partial", "status_sequence": 4, "created_at": "2026-10-01T04:00:00Z", "start_before": "2026-10-01T04:01:00Z", "targets": [dose_target({"mode": "grams", "amount_g": 25}, 1), dose_target({"mode": "grams", "amount_g": 40}, 2)], "nozzle_results": [{"nozzle_number": 1, "status": "completed", "requested_dose": {"mode": "grams", "amount_g": 25}, "estimated_dispensed_g": None, "measured_dispensed_g": 24.5, "measurement_quality": "valid"}, {"nozzle_number": 2, "status": "not_started", "requested_dose": {"mode": "grams", "amount_g": 40}, "estimated_dispensed_g": None, "measured_dispensed_g": None, "measurement_quality": "error"}], "safety_lockout": True, "lockout_resolution": None}, "CommandStatusDTO", reason="Partial outcome preserves nozzle 1 measurement and nozzle 2 not_started")
add_fixture("run-event-not-started-valid", {"sequence_id": "55555555-5555-4555-8555-555555555555", "event_sequence": 5, "event_type": "not_started", "outcome_status": "not_started", "source": "scheduled", "device_at": "2026-10-01T04:00:12Z", "time_quality": "synced", "command_id": None, "schedule_id": "44444444-4444-4444-8444-444444444444", "configuration_revision": 3, "occurrence_local_date": "2026-10-01", "nozzle_number": 2, "step_index": 2, "requested_dose": {"mode": "grams", "amount_g": 40}, "estimated_dispensed_g": None, "measured_dispensed_g": None, "measurement_quality": "unavailable", "reason_code": "PRIOR_NOZZLE_UNCERTAIN", "maintenance_resolution": None, "lockout_cleared": False}, "RunEvent")
add_fixture("scheduled-sequence-admission-valid", {"protocol_major": 2, "device_id": request["device_id"], "sequence_id": "55555555-5555-4555-8555-555555555555", "due_at": "2026-10-01T04:00:00Z", "admitted_at": "2026-10-01T04:00:03Z", "first_start_before": "2026-10-01T04:00:30Z", "targets": [{"schedule_id": "44444444-4444-4444-8444-444444444444", "nozzle_number": 1, "occurrence_local_date": "2026-10-01", "configuration_revision": 3, "dose": {"mode": "grams", "amount_g": 25}}, {"schedule_id": "77777777-7777-4777-8777-777777777777", "nozzle_number": 2, "occurrence_local_date": "2026-10-01", "configuration_revision": 3, "dose": {"mode": "grams", "amount_g": 40}}]}, "ScheduledSequenceAdmission")

behavior.extend([
    {"name": "same-time-schedule-group", "file": "examples/v2/same-time-schedule-group.json", "rule": "schedule-group", "expected": {"admitted_together": True, "order": [1, 2], "sequence_reserved_through_settling": True, "nozzle2_after_nozzle1_normal_completion": "ready", "nozzle2_start_deadline": "baseline_ready_at_plus_wake_grace"}},
    {"name": "nozzle-sequence-safe-stop", "file": "examples/v2/nozzle-sequence-safe-stop.json", "rule": "sequence-abort", "expected": {"fault": ["failed", "not_started", "failed"], "uncertain_stop": ["unknown", "not_started", "unknown"], "invalid_weighing": ["completed", "not_started", "partial"], "automatic_resume": False}},
    {"name": "same-nozzle-schedule-collision", "file": "examples/v2/same-nozzle-schedule-collision.json", "rule": "schedule-collisions", "expected": {"same_nozzle_overlap": "reject", "cross_nozzle_same_time": [1, 2]}}
])
(source / "examples/v2/same-time-schedule-group.json").write_text(json.dumps({"due_at": "2026-10-01T04:00:00Z", "wake_grace_ms": 30000, "sequence_start": "2026-10-01T04:00:20Z", "nozzle1_completed": "2026-10-01T04:00:55Z", "baseline_ready_at": "2026-10-01T04:01:12Z", "nozzle2_started": "2026-10-01T04:01:30Z", "both_admitted": True, "targets": [2, 1], "reservation_released_at": "2026-10-01T04:01:40Z"}, separators=(",", ":")) + "\n", encoding="utf-8")
(source / "examples/v2/nozzle-sequence-safe-stop.json").write_text(json.dumps({"cases": {"fault": {"failure": "fault", "first_completed": False}, "uncertain_stop": {"failure": "uncertain_stop", "first_completed": False}, "invalid_weighing": {"failure": "invalid_weighing", "first_completed": True}}}, separators=(",", ":")) + "\n", encoding="utf-8")
(source / "examples/v2/same-nozzle-schedule-collision.json").write_text(json.dumps({"slots": [{"nozzle_number": 1, "local_time": "06:00", "weekdays": [1, 3, 5]}, {"nozzle_number": 2, "local_time": "06:00", "weekdays": [1, 3, 5]}, {"nozzle_number": 1, "local_time": "06:00", "weekdays": [3]}]}, separators=(",", ":")) + "\n", encoding="utf-8")
monitoring_path = source / "examples/v2/monitoring-snapshot-valid.json"
monitoring = json.loads(monitoring_path.read_text(encoding="utf-8"))
monitoring["profile"]["capabilities_revision"] = 3
monitoring["profile"]["capabilities"]["feed_capacity_g"] = 20000
monitoring["latest_sample"]["feed_remaining_g"] = 20000
monitoring["latest_sample"]["feed_percent"] = 100
monitoring_path.write_text(json.dumps(monitoring, separators=(",", ":")) + "\n", encoding="utf-8")
fixtures.append({"name": "monitoring-snapshot-valid", "file": "examples/v2/monitoring-snapshot-valid.json", "schema": "MonitoringSnapshotResponse", "expect": "valid", "reason": "shared inventory percentage uses the declared 20 kg simulator capacity"})
manifest["behavior_cases"] = behavior
(source / "manifest.json").write_text(json.dumps(manifest, indent=2, ensure_ascii=False) + "\n", encoding="utf-8")
