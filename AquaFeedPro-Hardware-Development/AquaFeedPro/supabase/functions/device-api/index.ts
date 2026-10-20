import {
  admin,
  apiError,
  characterLength,
  isUuid,
  json,
  normalizeUtcTimestamp,
  normalizeUtcTimestampForResponse,
  onlyKeys,
  protocolMajor,
  readJson,
  record,
  requestIdFrom,
  sha256Hex,
  takeRateLimit,
} from "../_shared/device-access.ts";
import { validTelemetryBatch } from "../_shared/telemetry.ts";

function pairingWindowPath(request: Request) {
  const pathname = new URL(request.url).pathname;
  return /\/device-api\/v2\/pairing-window$/.test(pathname);
}

function deviceSyncPath(request: Request) {
  const pathname = new URL(request.url).pathname;
  return /\/device-api\/v2\/sync$/.test(pathname);
}

function deviceWaitPath(request: Request) {
  const pathname = new URL(request.url).pathname;
  return /\/device-api\/v2\/wait$/.test(pathname);
}

const MAX_SYNC_BODY_BYTES = 262_144;
const ERROR_CODES = new Set([
  "INVALID_INPUT",
  "AUTH_REQUIRED",
  "ACCESS_DENIED",
  "RESOURCE_NOT_FOUND",
  "DEVICE_OFFLINE",
  "DEVICE_BUSY",
  "DOSE_UNSUPPORTED",
  "DOSE_OUT_OF_RANGE",
  "CONFIG_CONFLICT",
  "CONFIG_PENDING",
  "CLOCK_UNTRUSTED",
  "PAIRING_EXPIRED",
  "PAIRING_INVALID",
  "ACCESS_REVOKED",
  "COMMAND_EXPIRED",
  "IDEMPOTENCY_CONFLICT",
  "SAFETY_LOCKOUT",
  "PROTOCOL_UNSUPPORTED",
  "PAYLOAD_TOO_LARGE",
  "RATE_LIMITED",
  "SERVICE_UNAVAILABLE",
  "CAPABILITY_MISMATCH",
  "VALIDATION_FAILED",
]);

function validDose(value: unknown) {
  const dose = record(value);
  if (!dose) return false;
  if (
    dose.mode === "grams" &&
    onlyKeys(dose, ["mode", "amount_g"]) &&
    typeof dose.amount_g === "number" &&
    Number.isFinite(dose.amount_g) &&
    dose.amount_g > 0
  )
    return true;
  return (
    dose.mode === "fixed_portion" &&
    onlyKeys(dose, ["mode", "fixed_portion_id"]) &&
    typeof dose.fixed_portion_id === "string" &&
    /^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/.test(dose.fixed_portion_id)
  );
}

function validLocalDate(value: unknown) {
  if (typeof value !== "string" || !/^\d{4}-\d{2}-\d{2}$/.test(value))
    return false;
  const date = new Date(`${value}T00:00:00Z`);
  return (
    !Number.isNaN(date.valueOf()) && date.toISOString().slice(0, 10) === value
  );
}

// One nozzle, or Both as nozzle 1 then nozzle 2, each with its own dose.
function validScheduleTargets(value: unknown) {
  if (!Array.isArray(value) || value.length < 1 || value.length > 2) return false;
  return value.every((item, index) => {
    const target = record(item);
    return (
      !!target &&
      onlyKeys(target, ["nozzle_number", "dose"]) &&
      (value.length === 2
        ? target.nozzle_number === index + 1
        : target.nozzle_number === 1 || target.nozzle_number === 2) &&
      validDose(target.dose)
    );
  });
}

function validConfigurationSnapshot(value: unknown) {
  const snapshot = record(value);
  const limits = record(snapshot?.monitoring_limits);
  if (
    !snapshot ||
    !onlyKeys(snapshot, [
      "revision",
      "based_on_revision",
      "timezone",
      "monitoring_limits",
      "low_feed_threshold_pct",
      "schedules",
    ]) ||
    !Number.isSafeInteger(snapshot.revision) ||
    Number(snapshot.revision) < 1 ||
    !Number.isSafeInteger(snapshot.based_on_revision) ||
    Number(snapshot.based_on_revision) < 0 ||
    typeof snapshot.timezone !== "string" ||
    !limits ||
    !onlyKeys(limits, ["do_low_mg_l", "do_high_mg_l"]) ||
    ![limits.do_low_mg_l, limits.do_high_mg_l].every(
      (item) =>
        item === null ||
        (typeof item === "number" && Number.isFinite(item) && item >= 0),
    ) ||
    !(
      snapshot.low_feed_threshold_pct === null ||
      (typeof snapshot.low_feed_threshold_pct === "number" &&
        Number.isFinite(snapshot.low_feed_threshold_pct) &&
        snapshot.low_feed_threshold_pct >= 0 &&
        snapshot.low_feed_threshold_pct <= 100)
    ) ||
    !Array.isArray(snapshot.schedules) ||
    snapshot.schedules.length > 100
  )
    return false;
  return snapshot.schedules.every((item) => {
    const schedule = record(item);
    return (
      !!schedule &&
      onlyKeys(schedule, [
        "schedule_id",
        "local_time",
        "weekdays",
        "enabled",
        "targets",
      ]) &&
      isUuid(schedule.schedule_id) &&
      typeof schedule.local_time === "string" &&
      /^([01]\d|2[0-3]):[0-5]\d$/.test(schedule.local_time) &&
      Array.isArray(schedule.weekdays) &&
      schedule.weekdays.length >= 1 &&
      schedule.weekdays.length <= 7 &&
      schedule.weekdays.every(
        (day) =>
          Number.isSafeInteger(day) && Number(day) >= 1 && Number(day) <= 7,
      ) &&
      new Set(schedule.weekdays).size === schedule.weekdays.length &&
      typeof schedule.enabled === "boolean" &&
      validScheduleTargets(schedule.targets)
    );
  });
}

const RUN_EVENT_KEYS = [
  "sequence_id",
  "event_sequence",
  "event_type",
  "outcome_status",
  "source",
  "device_at",
  "time_quality",
  "command_id",
  "schedule_id",
  "configuration_revision",
  "occurrence_local_date",
  "requested_dose",
  "estimated_dispensed_g",
  "measured_dispensed_g",
  "measurement_quality",
  "reason_code",
  "maintenance_resolution",
  "lockout_cleared",
  "nozzle_number",
  "step_index",
] as const;

// Device proof that a failed nozzle 1 may continue to nozzle 2; absent means no continuation.
function validContinuationEvidence(event: Record<string, unknown>) {
  if (
    event.continuation_evidence === undefined ||
    event.continuation_evidence === null
  )
    return true;
  const evidence = record(event.continuation_evidence);
  return (
    !!evidence &&
    onlyKeys(evidence, ["safe_stop", "device_fault", "baseline_ready_at"]) &&
    evidence.safe_stop === true &&
    evidence.device_fault === false &&
    normalizeUtcTimestamp(evidence.baseline_ready_at) !== null &&
    event.event_type === "failed" &&
    event.step_index === 1 &&
    event.nozzle_number === 1 &&
    event.measurement_quality === "valid" &&
    (event.time_quality === "synced" || event.time_quality === "rtc")
  );
}

function normalizedRunEvent(value: unknown) {
  const event = record(value)!;
  const dose = record(event.requested_dose)!;
  const resolution = record(event.maintenance_resolution);
  const evidence = record(event.continuation_evidence);
  return {
    ...Object.fromEntries(RUN_EVENT_KEYS.map((key) => [key, event[key]])),
    ...(evidence
      ? {
          continuation_evidence: {
            safe_stop: evidence.safe_stop,
            device_fault: evidence.device_fault,
            baseline_ready_at: evidence.baseline_ready_at,
          },
        }
      : {}),
    requested_dose:
      dose.mode === "grams"
        ? { mode: "grams", amount_g: dose.amount_g }
        : { mode: "fixed_portion", fixed_portion_id: dose.fixed_portion_id },
    maintenance_resolution: resolution
      ? {
          resolution_at: resolution.resolution_at,
          resolution_reason: resolution.resolution_reason,
        }
      : null,
  };
}

function normalizedCommandDelivery(
  value: unknown,
): Record<string, unknown> | null | undefined {
  if (value === null) return null;
  const command = record(value);
  if (!command) return undefined;
  const createdAt = normalizeUtcTimestampForResponse(command.created_at);
  const startBefore = normalizeUtcTimestampForResponse(command.start_before);
  if (createdAt === null || startBefore === null) return undefined;
  return {
    ...command,
    created_at: createdAt,
    start_before: startBefore,
  };
}

function validRunEvent(value: unknown) {
  const event = record(value);
  if (
    !event ||
    !onlyKeys(event, [...RUN_EVENT_KEYS, "continuation_evidence"]) ||
    !validContinuationEvidence(event) ||
    !isUuid(event.sequence_id) ||
    !Number.isSafeInteger(event.event_sequence) ||
    Number(event.event_sequence) < 1 ||
    !(event.source === "manual" || event.source === "scheduled") ||
    (event.source === "manual" &&
      (!isUuid(event.command_id) ||
        event.schedule_id !== null ||
        event.configuration_revision !== null ||
        event.occurrence_local_date !== null)) ||
    (event.source === "scheduled" &&
      (event.command_id !== null ||
        !isUuid(event.schedule_id) ||
        !Number.isSafeInteger(event.configuration_revision) ||
        Number(event.configuration_revision) < 1 ||
        !validLocalDate(event.occurrence_local_date))) ||
    (event.source === "scheduled" &&
      event.event_type === "maintenance_acknowledged") ||
    (event.nozzle_number !== 1 && event.nozzle_number !== 2) ||
    (event.step_index !== 1 && event.step_index !== 2) ||
    !validDose(event.requested_dose) ||
    ![
      "queued",
      "accepted",
      "running",
      "completed",
      "failed",
      "rejected",
      "expired",
      "unknown",
      "not_started",
      "skipped",
      "maintenance_acknowledged",
    ].includes(String(event.event_type)) ||
    ![
      "queued",
      "accepted",
      "running",
      "completed",
      "failed",
      "rejected",
      "expired",
      "unknown",
      "not_started",
      "skipped",
    ].includes(String(event.outcome_status)) ||
    event.outcome_status !==
      (event.event_type === "maintenance_acknowledged"
        ? "unknown"
        : event.event_type) ||
    !["synced", "rtc", "uncertain", "invalid"].includes(
      String(event.time_quality),
    ) ||
    !["valid", "unavailable", "uncalibrated", "error"].includes(
      String(event.measurement_quality),
    ) ||
    typeof event.lockout_cleared !== "boolean" ||
    !(
      event.reason_code === null ||
      (typeof event.reason_code === "string" && event.reason_code.length <= 128)
    ) ||
    !(
      event.estimated_dispensed_g === null ||
      (typeof event.estimated_dispensed_g === "number" &&
        Number.isFinite(event.estimated_dispensed_g) &&
        event.estimated_dispensed_g >= 0)
    ) ||
    !(
      event.measured_dispensed_g === null ||
      (typeof event.measured_dispensed_g === "number" &&
        Number.isFinite(event.measured_dispensed_g) &&
        event.measured_dispensed_g >= 0)
    )
  )
    return false;

  const invalidTime = event.time_quality === "invalid";
  if (
    invalidTime
      ? event.device_at !== null
      : normalizeUtcTimestamp(event.device_at) === null
  )
    return false;
  if (
    event.measurement_quality === "valid"
      ? typeof event.measured_dispensed_g !== "number"
      : event.measured_dispensed_g !== null
  )
    return false;
  if (
    [
      "queued",
      "accepted",
      "rejected",
      "expired",
      "unknown",
      "not_started",
      "skipped",
    ].includes(String(event.outcome_status)) &&
    (event.measured_dispensed_g !== null ||
      event.measurement_quality === "valid")
  )
    return false;
  if (
    ["not_started", "skipped"].includes(String(event.event_type)) &&
    (typeof event.reason_code !== "string" || event.reason_code.length === 0)
  )
    return false;

  const resolution = record(event.maintenance_resolution);
  if (event.event_type === "maintenance_acknowledged") {
    if (
      !resolution ||
      !(
        resolution.resolution_at === null ||
        normalizeUtcTimestamp(resolution.resolution_at) !== null
      ) ||
      typeof resolution.resolution_reason !== "string" ||
      resolution.resolution_reason.length < 1 ||
      resolution.resolution_reason.length > 256 ||
      event.lockout_cleared !== true ||
      event.measured_dispensed_g !== null ||
      event.measurement_quality === "valid"
    )
      return false;
  } else if (
    event.maintenance_resolution !== null ||
    event.lockout_cleared !== false
  )
    return false;
  return true;
}

function validDeviceSync(value: unknown): value is Record<string, unknown> {
  const body = record(value);
  if (
    !body ||
    !onlyKeys(body, [
      "protocol_major",
      "request_id",
      "boot_id",
      "live_sequence",
      "firmware_version",
      "capabilities_revision",
      "clock",
      "actuator",
      "configuration",
      "latest_sample",
      "backlog_samples",
      "events",
    ]) ||
    body.protocol_major !== 2 ||
    !isUuid(body.request_id) ||
    !isUuid(body.boot_id) ||
    !Number.isSafeInteger(body.live_sequence) ||
    Number(body.live_sequence) < 0 ||
    typeof body.firmware_version !== "string" ||
    body.firmware_version.length < 1 ||
    body.firmware_version.length > 100 ||
    !Number.isSafeInteger(body.capabilities_revision) ||
    Number(body.capabilities_revision) < 1 ||
    !validTelemetryBatch(
      body.boot_id,
      Number(body.live_sequence),
      body.latest_sample,
      body.backlog_samples,
    ) ||
    !Array.isArray(body.events) ||
    body.events.length > 100 ||
    !body.events.every(validRunEvent)
  )
    return false;

  const clock = record(body.clock);
  const actuator = record(body.actuator);
  const configuration = record(body.configuration);
  if (
    !clock ||
    !onlyKeys(clock, ["quality", "uncertainty_ms"]) ||
    !["synced", "rtc", "uncertain", "invalid"].includes(
      String(clock.quality),
    ) ||
    (clock.quality === "invalid"
      ? clock.uncertainty_ms !== null
      : !Number.isSafeInteger(clock.uncertainty_ms) ||
        Number(clock.uncertainty_ms) < 0) ||
    !actuator ||
    !onlyKeys(actuator, ["state", "active_sequence_id", "fault_code"]) ||
    !["idle", "feeding", "fault", "unknown"].includes(String(actuator.state)) ||
    !(
      actuator.active_sequence_id === null ||
      isUuid(actuator.active_sequence_id)
    ) ||
    !(
      actuator.fault_code === null ||
      (typeof actuator.fault_code === "string" &&
        actuator.fault_code.length <= 128)
    ) ||
    (actuator.state === "idle" && actuator.active_sequence_id !== null) ||
    (actuator.state === "feeding" && actuator.active_sequence_id === null) ||
    !configuration ||
    !onlyKeys(configuration, [
      "applied_revision",
      "last_attempt_revision",
      "last_attempt_status",
      "error_code",
    ]) ||
    !(
      configuration.applied_revision === null ||
      (Number.isSafeInteger(configuration.applied_revision) &&
        Number(configuration.applied_revision) >= 0)
    ) ||
    !(
      configuration.last_attempt_revision === null ||
      (Number.isSafeInteger(configuration.last_attempt_revision) &&
        Number(configuration.last_attempt_revision) >= 1)
    ) ||
    !(
      configuration.last_attempt_status === null ||
      ["pending", "applied", "rejected"].includes(
        String(configuration.last_attempt_status),
      )
    ) ||
    !(
      configuration.error_code === null ||
      (typeof configuration.error_code === "string" &&
        ERROR_CODES.has(configuration.error_code))
    ) ||
    (configuration.last_attempt_status === null &&
      (configuration.last_attempt_revision !== null ||
        configuration.error_code !== null)) ||
    (configuration.last_attempt_status === "applied" &&
      configuration.last_attempt_revision !== configuration.applied_revision) ||
    (configuration.last_attempt_status !== null &&
      configuration.last_attempt_revision === null) ||
    (configuration.last_attempt_status === "rejected" &&
      configuration.error_code === null) ||
    (configuration.last_attempt_status !== "rejected" &&
      configuration.error_code !== null)
  )
    return false;
  return true;
}

async function syncManualFeed(
  request: Request,
  authenticatedDeviceId: string,
  deviceVerifier: string,
) {
  const fallbackRequestId = crypto.randomUUID();
  const parsed = await readJson(
    request,
    fallbackRequestId,
    MAX_SYNC_BODY_BYTES,
  );
  if (parsed.response) return parsed.response;
  const body = record(parsed.value);
  const requestId = requestIdFrom(body);
  if (!body || body.protocol_major !== 2) {
    return apiError(
      requestId,
      422,
      "PROTOCOL_UNSUPPORTED",
      "Protocol major 2 is required.",
    );
  }
  if (!validDeviceSync(body)) {
    return apiError(
      requestId,
      422,
      "VALIDATION_FAILED",
      "The device sync payload is invalid or includes a flow that is not enabled yet.",
    );
  }
  const telemetry = await admin.rpc("art27_sync_telemetry", {
    p_device_id: authenticatedDeviceId,
    p_device_verifier_hex: deviceVerifier,
    p_boot_id: body.boot_id,
    p_live_sequence: body.live_sequence,
    p_latest_sample: body.latest_sample,
    p_backlog_samples: body.backlog_samples,
  });
  if (telemetry.error)
    return apiError(
      requestId,
      telemetry.error.code === "23505" ? 409 : telemetry.error.code === "22023" ? 422 : 503,
      telemetry.error.code === "23505" ? "IDEMPOTENCY_CONFLICT" : telemetry.error.code === "22023" ? "VALIDATION_FAILED" : "SERVICE_UNAVAILABLE",
      "Device telemetry could not be safely recorded.",
      telemetry.error.code !== "23505" && telemetry.error.code !== "22023",
    );
  const telemetryResult = record(telemetry.data);
  if (telemetryResult?.status === "auth_required")
    return apiError(
      requestId,
      401,
      "AUTH_REQUIRED",
      "A valid device credential is required.",
    );
  if (
    telemetryResult?.status !== "ok" ||
    !Array.isArray(telemetryResult.acknowledged_samples)
  )
    return apiError(
      requestId,
      503,
      "SERVICE_UNAVAILABLE",
      "Device telemetry could not be safely recorded.",
      true,
    );
  const actuator = record(body.actuator)!;
  const clock = record(body.clock)!;
  const configuration = record(body.configuration)!;
  const report = await admin.rpc("art33_device_configuration_report", {
    p_device_id: authenticatedDeviceId,
    p_device_verifier_hex: deviceVerifier,
    p_applied_revision: configuration.applied_revision,
    p_last_attempt_revision: configuration.last_attempt_revision,
    p_last_attempt_status: configuration.last_attempt_status,
    p_error_code: configuration.error_code,
  });
  if (report.error)
    return apiError(
      requestId,
      503,
      "SERVICE_UNAVAILABLE",
      "The device configuration could not be safely acknowledged.",
      true,
    );
  const reportResult = record(report.data);
  if (reportResult?.status === "auth_required")
    return apiError(
      requestId,
      401,
      "AUTH_REQUIRED",
      "A valid device credential is required.",
    );
  if (reportResult?.status === "stale")
    return apiError(
      requestId,
      409,
      "CONFIG_CONFLICT",
      "The configuration acknowledgement is stale.",
    );
  if (reportResult?.status !== "ok")
    return apiError(
      requestId,
      422,
      "VALIDATION_FAILED",
      "The device configuration report is invalid.",
    );
  const events = body.events as unknown[];
  const manualEvents = events.filter(
    (event) => record(event)?.source === "manual",
  );
  const scheduledEvents = events.filter(
    (event) => record(event)?.source === "scheduled",
  );
  let scheduledAcks: unknown[] = [];
  if (scheduledEvents.length > 0) {
    const scheduled = await admin.rpc("art33_record_scheduled_events", {
      p_device_id: authenticatedDeviceId,
      p_device_verifier_hex: deviceVerifier,
      p_events: scheduledEvents.map(normalizedRunEvent),
      p_clock_quality: clock.quality,
      p_clock_uncertainty_ms: clock.uncertainty_ms,
      p_actuator_state: actuator.state,
      p_active_sequence_id: actuator.active_sequence_id,
    });
    if (scheduled.error)
      return apiError(
        requestId,
        503,
        "SERVICE_UNAVAILABLE",
        "Scheduled feeding history could not be safely recorded.",
        true,
      );
    const scheduledResult = record(scheduled.data);
    if (scheduledResult?.status === "auth_required")
      return apiError(
        requestId,
        401,
        "AUTH_REQUIRED",
        "A valid device credential is required.",
      );
    if (scheduledResult?.status === "conflict")
      return apiError(
        requestId,
        409,
        "DEVICE_BUSY",
        "A scheduled sequence collided with an active device operation.",
      );
    if (
      scheduledResult?.status !== "ok" ||
      !Array.isArray(scheduledResult.acknowledged_events)
    )
      return apiError(
        requestId,
        422,
        "VALIDATION_FAILED",
        "Scheduled feeding history is invalid or out of order.",
      );
    scheduledAcks = scheduledResult.acknowledged_events;
  }
  const { data, error } = await admin.rpc("art31_sync_manual_feed", {
    p_device_id: authenticatedDeviceId,
    p_device_verifier_hex: deviceVerifier,
    p_capabilities_revision: body.capabilities_revision,
    p_events: manualEvents.map(normalizedRunEvent),
    p_actuator_state: actuator.state,
    p_active_sequence_id: actuator.active_sequence_id,
    p_clock_quality: clock.quality,
    p_clock_uncertainty_ms: clock.uncertainty_ms,
  });
  if (error) {
    if (error.code === "23505")
      return apiError(
        requestId,
        409,
        "IDEMPOTENCY_CONFLICT",
        "A device event identity was reused with different content.",
      );
    if (error.code === "22023")
      return apiError(
        requestId,
        422,
        "VALIDATION_FAILED",
        "Device events are invalid or out of order.",
      );
    return apiError(
      requestId,
      503,
      "SERVICE_UNAVAILABLE",
      "Device sync could not be safely recorded.",
      true,
    );
  }
  const result = record(data);
  if (result?.status === "auth_required")
    return apiError(
      requestId,
      401,
      "AUTH_REQUIRED",
      "A valid device credential is required.",
    );
  if (result?.status !== "ok")
    return apiError(
      requestId,
      503,
      "SERVICE_UNAVAILABLE",
      "Device sync could not be safely recorded.",
      true,
    );
  const serverTime = normalizeUtcTimestampForResponse(result.server_time);
  const command = normalizedCommandDelivery(result.command);
  const desiredConfiguration =
    reportResult.desired_configuration === null
      ? null
      : reportResult.desired_configuration;
  if (
    serverTime === null ||
    command === undefined ||
    (desiredConfiguration !== null &&
      !validConfigurationSnapshot(desiredConfiguration))
  )
    return apiError(
      requestId,
      503,
      "SERVICE_UNAVAILABLE",
      "Device sync could not be safely recorded.",
      true,
    );
  return json({
    protocol_major: 2,
    request_id: requestId,
    server_time: serverTime,
    acknowledged_samples: telemetryResult.acknowledged_samples,
    acknowledged_events: [
      ...(Array.isArray(result.acknowledged_events)
        ? result.acknowledged_events
        : []),
      ...scheduledAcks,
    ],
    desired_configuration: desiredConfiguration,
    command,
    next_sync_after_ms: result.next_sync_after_ms,
  });
}

function newPairingSecret() {
  const bytes = crypto.getRandomValues(new Uint8Array(32));
  return btoa(String.fromCharCode(...bytes))
    .replace(/\+/g, "-")
    .replace(/\//g, "_")
    .replace(/=+$/g, "");
}

Deno.serve(async (request: Request) => {
  const fallbackRequestId = crypto.randomUUID();
  try {
    const match = /^Bearer\s+(\S+)$/i.exec(
      request.headers.get("authorization") ?? "",
    );
    if (
      !match ||
      characterLength(match[1]) < 1 ||
      characterLength(match[1]) > 512
    ) {
      return apiError(
        fallbackRequestId,
        401,
        "AUTH_REQUIRED",
        "A valid device credential is required.",
      );
    }
    const deviceVerifier = await sha256Hex(match[1]);
    const authenticated = await admin.rpc("art38_authenticate_device", {
      p_verifier_hex: deviceVerifier,
    });
    if (authenticated.error) {
      return apiError(
        fallbackRequestId,
        503,
        "SERVICE_UNAVAILABLE",
        "The device service is temporarily unavailable.",
        true,
      );
    }
    const authenticatedDeviceId = authenticated.data;
    if (!isUuid(authenticatedDeviceId)) {
      return apiError(
        fallbackRequestId,
        401,
        "AUTH_REQUIRED",
        "A valid device credential is required.",
      );
    }
    const deviceId = authenticatedDeviceId.toLowerCase();
    const syncPath = deviceSyncPath(request);
    const waitPath = deviceWaitPath(request);
    const pairPath = pairingWindowPath(request);
    if (!syncPath && !waitPath && !pairPath) {
      return apiError(
        fallbackRequestId,
        404,
        "RESOURCE_NOT_FOUND",
        "The requested device route was not found.",
      );
    }
    if (request.method !== "POST") {
      return apiError(
        fallbackRequestId,
        405,
        "INVALID_INPUT",
        "This method is not available for the requested route.",
      );
    }
    if (syncPath)
      return await syncManualFeed(request, deviceId, deviceVerifier);

    if (waitPath) {
      const parsed = await readJson(request, crypto.randomUUID());
      if (parsed.response) return parsed.response;
      const body = record(parsed.value);
      const requestId = requestIdFrom(body);
      if (
        !body ||
        !onlyKeys(body, ["protocol_major", "request_id", "seen_work_token"])
      ) {
        return apiError(
          requestId,
          400,
          "INVALID_INPUT",
          "The device wait request is invalid.",
        );
      }
      if (!protocolMajor(body)) {
        return apiError(
          requestId,
          422,
          "PROTOCOL_UNSUPPORTED",
          "Protocol major 2 is required.",
        );
      }
      if (!isUuid(body.request_id)) {
        return apiError(
          requestId,
          422,
          "VALIDATION_FAILED",
          "The request identifier is invalid.",
        );
      }
      const seenWorkToken = body.seen_work_token;
      if (
        seenWorkToken !== null &&
        (typeof seenWorkToken !== "string" ||
          characterLength(seenWorkToken) > 128)
      ) {
        return apiError(
          requestId,
          422,
          "VALIDATION_FAILED",
          "The seen work token is invalid.",
        );
      }

      const deadline = performance.now() + 20_000;
      const readWorkToken = async () => {
        const { data, error } = await admin
          .rpc("rt01_device_work_token", { p_device_id: deviceId })
          .abortSignal(request.signal);
        if (error || typeof data !== "string") {
          throw new Error("device work token read failed");
        }
        return data;
      };
      try {
        let workToken = await readWorkToken();
        let changed = workToken !== seenWorkToken;
        // shortcut: polls a one-row token every 300 ms per waiting feeder; move to LISTEN/NOTIFY or Realtime inside the function if many feeders ever wait at once.
        while (!changed && performance.now() < deadline) {
          await new Promise((resolve) =>
            setTimeout(resolve, Math.min(300, deadline - performance.now()))
          );
          if (request.signal.aborted) return new Response(null, { status: 204 });
          workToken = await readWorkToken();
          if (request.signal.aborted) return new Response(null, { status: 204 });
          changed = workToken !== seenWorkToken;
        }
        if (request.signal.aborted) return new Response(null, { status: 204 });
        return json({
          protocol_major: 2,
          request_id: body.request_id,
          work_token: workToken,
          changed,
        });
      } catch {
        if (request.signal.aborted) return new Response(null, { status: 204 });
        return apiError(
          requestId,
          503,
          "SERVICE_UNAVAILABLE",
          "The device work token could not be read.",
          true,
        );
      }
    }

    const parsed = await readJson(request, crypto.randomUUID());
    if (parsed.response) return parsed.response;
    const body = record(parsed.value);
    const requestId = requestIdFrom(body);
    if (!body || !onlyKeys(body, ["protocol_major", "request_id"])) {
      return apiError(
        requestId,
        400,
        "INVALID_INPUT",
        "The pairing-window request is invalid.",
      );
    }
    if (!protocolMajor(body)) {
      return apiError(
        requestId,
        422,
        "PROTOCOL_UNSUPPORTED",
        "Protocol major 2 is required.",
      );
    }
    if (!isUuid(body.request_id)) {
      return apiError(
        requestId,
        422,
        "VALIDATION_FAILED",
        "The request identifier is invalid.",
      );
    }
    if (!(await takeRateLimit("pairing_window", deviceId))) {
      return apiError(
        requestId,
        429,
        "RATE_LIMITED",
        "Pairing windows are temporarily limited.",
        true,
      );
    }

    const pairingSecret = newPairingSecret();
    const challengeId = crypto.randomUUID();
    const created = await admin.rpc("art38_create_pairing_challenge", {
      p_device_id: deviceId,
      p_challenge_id: challengeId,
      p_request_id: requestId,
      p_verifier_hex: await sha256Hex(pairingSecret),
      p_device_verifier_hex: deviceVerifier,
    });
    if (created.error) {
      return apiError(
        requestId,
        503,
        "SERVICE_UNAVAILABLE",
        "The pairing service is temporarily unavailable.",
        true,
      );
    }
    const result = record(created.data);
    if (result?.status === "request_reused") {
      return apiError(
        requestId,
        409,
        "IDEMPOTENCY_CONFLICT",
        "This request identifier was already used.",
      );
    }
    if (result?.status === "not_active") {
      return apiError(
        requestId,
        401,
        "AUTH_REQUIRED",
        "The device credential is no longer active.",
      );
    }
    const expiresAt = normalizeUtcTimestamp(result?.expires_at);
    if (result?.status !== "created" || expiresAt === null) {
      return apiError(
        requestId,
        503,
        "SERVICE_UNAVAILABLE",
        "The pairing window could not be verified.",
        true,
      );
    }
    return json(
      {
        request_id: requestId,
        challenge_id: challengeId,
        pairing_secret: pairingSecret,
        expires_at: expiresAt,
      },
      201,
    );
  } catch {
    return apiError(
      fallbackRequestId,
      503,
      "SERVICE_UNAVAILABLE",
      "The device service is temporarily unavailable.",
      true,
    );
  }
});
