import {
  admin,
  apiError,
  characterLength,
  installationId,
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
  type ErrorCode,
} from "../_shared/device-access.ts";

const UUID_IN_PATH = /^\/devices\/([0-9a-f-]{36})\/(alias|access)$/i;
const MANUAL_FEED_PATH = /^\/devices\/([0-9a-f-]{36})\/feed$/i;
const MANUAL_NO_ADMISSION_PATH = /^\/devices\/([0-9a-f-]{36})\/feed-recovery\/no-admission$/i;
const COMMAND_BY_KEY_PATH = /^\/devices\/([0-9a-f-]{36})\/commands\/by-key$/i;
const COMMAND_STATUS_PATH =
  /^\/devices\/([0-9a-f-]{36})\/commands\/([0-9a-f-]{36})$/i;
const HISTORY_PATH = /^\/devices\/([0-9a-f-]{36})\/history$/i;
const HISTORY_DETAIL_PATH =
  /^\/devices\/([0-9a-f-]{36})\/history\/([0-9a-f-]{36})$/i;
const CONFIGURATION_PATH = /^\/devices\/([0-9a-f-]{36})\/configuration$/i;
const NEXT_OCCURRENCE_PATH = /^\/devices\/([0-9a-f-]{36})\/next-occurrence$/i;
const MONITORING_PATH = /^\/devices\/([0-9a-f-]{36})\/monitoring$/i;
const DO_GRAPH_PATH = /^\/devices\/([0-9a-f-]{36})\/monitoring\/do$/i;
const NOTIFICATIONS_PATH = /^\/devices\/([0-9a-f-]{36})\/notifications$/i;
const NOTIFICATION_EVENT_PATH =
  /^\/devices\/([0-9a-f-]{36})\/notifications\/([0-9a-f-]{36})$/i;
const NOTIFICATIONS_BULK_PATH =
  /^\/devices\/([0-9a-f-]{36})\/notifications\/actions$/i;
const PUSH_TOKEN_PATH = /^\/push-token$/i;
const ANDROID_EAS_PROJECT_ID = "1b3dc89f-3111-49d4-b91f-d5567e71d996";
const EXPO_PUSH_TOKEN = /^(Exponent|Expo)PushToken\[[A-Za-z0-9_-]{1,255}\]$/;

type ManualTarget = {
  nozzle_number: 1 | 2;
  dose: Record<string, unknown>;
};

function manualTargets(value: unknown): ManualTarget[] | null {
  if (!Array.isArray(value) || value.length < 1 || value.length > 2)
    return null;
  const targets: ManualTarget[] = [];
  for (const item of value) {
    const target = record(item);
    const dose = record(target?.dose);
    if (
      !target ||
      !dose ||
      (target.nozzle_number !== 1 && target.nozzle_number !== 2)
    )
      return null;
    if (
      dose.mode === "grams" &&
      typeof dose.amount_g === "number" &&
      Number.isFinite(dose.amount_g) &&
      dose.amount_g > 0
    ) {
      targets.push({
        nozzle_number: target.nozzle_number,
        dose: { mode: "grams", amount_g: dose.amount_g },
      });
    } else if (
      dose.mode === "fixed_portion" &&
      typeof dose.fixed_portion_id === "string" &&
      /^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/.test(dose.fixed_portion_id)
    ) {
      targets.push({
        nozzle_number: target.nozzle_number,
        dose: {
          mode: "fixed_portion",
          fixed_portion_id: dose.fixed_portion_id,
        },
      });
    } else return null;
  }
  if (
    targets.length === 2 &&
    (targets[0].nozzle_number !== 1 || targets[1].nozzle_number !== 2)
  )
    return null;
  return targets;
}

function requestHeaderId(request: Request) {
  const value = request.headers.get("x-request-id");
  return isUuid(value) ? value.toLowerCase() : null;
}

function validProtocolHeader(request: Request) {
  return request.headers.get("x-protocol-major") === "2";
}

function localDate(value: string | null) {
  if (!value || !/^\d{4}-\d{2}-\d{2}$/.test(value)) return null;
  const date = new Date(`${value}T00:00:00Z`);
  return !Number.isNaN(date.valueOf()) &&
    date.toISOString().slice(0, 10) === value
    ? value
    : null;
}

function validTimeZone(value: unknown) {
  if (
    typeof value !== "string" ||
    characterLength(value) < 1 ||
    characterLength(value) > 100
  )
    return false;
  try {
    new Intl.DateTimeFormat("en", { timeZone: value });
    return true;
  } catch {
    return false;
  }
}

function validScheduleDose(value: unknown) {
  const dose = record(value);
  if (!dose) return false;
  return dose.mode === "grams"
    ? onlyKeys(dose, ["mode", "amount_g"]) &&
        typeof dose.amount_g === "number" &&
        Number.isFinite(dose.amount_g) &&
        dose.amount_g > 0
    : dose.mode === "fixed_portion" &&
        onlyKeys(dose, ["mode", "fixed_portion_id"]) &&
        typeof dose.fixed_portion_id === "string" &&
        /^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/.test(dose.fixed_portion_id);
}

function validConfigurationValues(value: unknown) {
  const snapshot = record(value);
  const limits = record(snapshot?.monitoring_limits);
  if (
    !snapshot ||
    !onlyKeys(snapshot, [
      "timezone",
      "monitoring_limits",
      "low_feed_threshold_pct",
      "schedules",
    ]) ||
    typeof snapshot.timezone !== "string" ||
    characterLength(snapshot.timezone) < 1 ||
    characterLength(snapshot.timezone) > 100 ||
    !limits ||
    !onlyKeys(limits, ["do_low_mg_l", "do_high_mg_l"]) ||
    ![limits.do_low_mg_l, limits.do_high_mg_l].every(
      (n) =>
        n === null || (typeof n === "number" && Number.isFinite(n) && n >= 0),
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
  const ids = new Set<string>();
  return snapshot.schedules.every((value) => {
    const schedule = record(value);
    const targets = schedule?.targets;
    if (
      !schedule ||
      !onlyKeys(schedule, [
        "schedule_id",
        "local_time",
        "weekdays",
        "enabled",
        "targets",
      ]) ||
      !isUuid(schedule.schedule_id) ||
      ids.has(String(schedule.schedule_id).toLowerCase()) ||
      typeof schedule.local_time !== "string" ||
      !/^([01]\d|2[0-3]):[0-5]\d$/.test(schedule.local_time) ||
      !Array.isArray(schedule.weekdays) ||
      schedule.weekdays.length < 1 ||
      schedule.weekdays.length > 7 ||
      !schedule.weekdays.every(
        (day) =>
          Number.isSafeInteger(day) && Number(day) >= 1 && Number(day) <= 7,
      ) ||
      new Set(schedule.weekdays).size !== schedule.weekdays.length ||
      typeof schedule.enabled !== "boolean" ||
      !Array.isArray(targets) ||
      targets.length < 1 ||
      targets.length > 2
    )
      return false;
    ids.add(String(schedule.schedule_id).toLowerCase());
    // One nozzle, or Both as nozzle 1 then nozzle 2, each with its own dose.
    return targets.every((item: unknown, index: number) => {
      const target = record(item);
      return (
        !!target &&
        onlyKeys(target, ["nozzle_number", "dose"]) &&
        (targets.length === 2
          ? target.nozzle_number === index + 1
          : target.nozzle_number === 1 || target.nozzle_number === 2) &&
        validScheduleDose(target.dose)
      );
    });
  });
}

function configurationReadResult(value: unknown, requestId: string) {
  const result = record(value);
  const current = record(result?.current_state);
  const validState =
    !!current &&
    (current.desired_revision === null ||
      (Number.isSafeInteger(current.desired_revision) &&
        Number(current.desired_revision) > 0)) &&
    (current.applied_revision === null ||
      (Number.isSafeInteger(current.applied_revision) &&
        Number(current.applied_revision) >= 0)) &&
    (current.last_attempt_revision === null ||
      (Number.isSafeInteger(current.last_attempt_revision) &&
        Number(current.last_attempt_revision) > 0)) &&
    (current.last_attempt_status === null ||
      ["pending", "applied", "rejected"].includes(
        String(current.last_attempt_status),
      )) &&
    (current.error_code === null ||
      isConfigurationErrorCode(current.error_code));
  const validSnapshot = (candidate: unknown) => {
    if (candidate === null) return true;
    const snapshot = record(candidate);
    return (
      !!snapshot &&
      Number.isSafeInteger(snapshot.revision) &&
      Number(snapshot.revision) > 0 &&
      Number.isSafeInteger(snapshot.based_on_revision) &&
      Number(snapshot.based_on_revision) >= 0 &&
      validConfigurationValues({
        timezone: snapshot.timezone,
        monitoring_limits: snapshot.monitoring_limits,
        low_feed_threshold_pct: snapshot.low_feed_threshold_pct,
        schedules: snapshot.schedules,
      })
    );
  };
  if (
    result?.status !== "ok" ||
    !validState ||
    !(
      result.request_status === null ||
      ["pending", "applied", "rejected"].includes(String(result.request_status))
    ) ||
    !(
      result.request_error_code === null ||
      isConfigurationErrorCode(result.request_error_code)
    ) ||
    !validSnapshot(result.desired_snapshot) ||
    !validSnapshot(result.applied_snapshot)
  )
    return null;
  if (!(
    result.receipt === null ||
    (() => {
      const receipt = record(result.receipt);
      return (
        !!receipt &&
        Number.isSafeInteger(receipt.revision) &&
        Number(receipt.revision) > 0 &&
        Number.isSafeInteger(receipt.based_on_revision) &&
        Number(receipt.based_on_revision) >= 0 &&
        validConfigurationValues(receipt.snapshot)
      );
    })()
  ))
    return null;
  return {
    request_id: requestId,
    receipt: result.receipt,
    request_status: result.request_status,
    request_error_code: result.request_error_code,
    current_state: current,
    desired_snapshot: result.desired_snapshot,
    applied_snapshot: result.applied_snapshot,
  };
}

const ERROR_CODES = new Set<ErrorCode>([
  "CONFIG_CONFLICT",
  "CONFIG_PENDING",
  "CAPABILITY_MISMATCH",
  "DOSE_UNSUPPORTED",
  "DOSE_OUT_OF_RANGE",
  "VALIDATION_FAILED",
  "CLOCK_UNTRUSTED",
  "IDEMPOTENCY_CONFLICT",
]);

function isConfigurationErrorCode(value: unknown): value is ErrorCode {
  return typeof value === "string" && ERROR_CODES.has(value as ErrorCode);
}

type HistoryCursor = {
  device_id: string;
  from_date: string;
  to_date: string;
  source: string;
  status: string;
  created_at: string;
  sequence_id: string;
};

function decodeHistoryCursor(value: string | null): HistoryCursor | null {
  if (!value || value.length > 2048 || !/^[A-Za-z0-9_-]+$/.test(value))
    return null;
  try {
    const base64 = value.replace(/-/g, "+").replace(/_/g, "/");
    const bytes = Uint8Array.from(
      atob(base64.padEnd(Math.ceil(base64.length / 4) * 4, "=")),
      (char) => char.charCodeAt(0),
    );
    const cursor: unknown = JSON.parse(new TextDecoder().decode(bytes));
    const item = record(cursor);
    if (
      !item ||
      !isUuid(item.device_id) ||
      !localDate(String(item.from_date)) ||
      !localDate(String(item.to_date)) ||
      !(
        item.source === "all" ||
        item.source === "manual" ||
        item.source === "scheduled"
      ) ||
      !(
        item.status === "all" ||
        item.status === "completed" ||
        item.status === "failed" ||
        item.status === "in_progress" ||
        item.status === "unknown"
      ) ||
      normalizeUtcTimestamp(item.created_at) === null ||
      !isUuid(item.sequence_id)
    )
      return null;
    return item as HistoryCursor;
  } catch {
    return null;
  }
}

function encodeHistoryCursor(cursor: HistoryCursor) {
  const bytes = new TextEncoder().encode(JSON.stringify(cursor));
  let binary = "";
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary)
    .replace(/\+/g, "-")
    .replace(/\//g, "_")
    .replace(/=+$/g, "");
}

type AlertCursor = {
  device_id: string;
  raised_at: string;
  event_id: string;
};

function decodeAlertCursor(value: string | null): AlertCursor | null {
  if (!value || value.length > 1024 || !/^[A-Za-z0-9_-]+$/.test(value))
    return null;
  try {
    const base64 = value.replace(/-/g, "+").replace(/_/g, "/");
    const bytes = Uint8Array.from(
      atob(base64.padEnd(Math.ceil(base64.length / 4) * 4, "=")),
      (char) => char.charCodeAt(0),
    );
    const item = record(JSON.parse(new TextDecoder().decode(bytes)));
    const raisedAt = normalizeUtcTimestampForResponse(item?.raised_at);
    if (
      !item ||
      !onlyKeys(item, ["device_id", "raised_at", "event_id"]) ||
      !isUuid(item.device_id) ||
      !isUuid(item.event_id) ||
      !raisedAt ||
      alertTimestampMicros(raisedAt) === null
    )
      return null;
    return {
      device_id: item.device_id.toLowerCase(),
      raised_at: raisedAt,
      event_id: item.event_id.toLowerCase(),
    };
  } catch {
    return null;
  }
}

function encodeAlertCursor(cursor: AlertCursor) {
  const bytes = new TextEncoder().encode(JSON.stringify(cursor));
  let binary = "";
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary)
    .replace(/\+/g, "-")
    .replace(/\//g, "_")
    .replace(/=+$/g, "");
}

function alertTimestampMicros(value: string): bigint | null {
  const match =
    /^(\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2})(?:\.(\d{1,6}))?Z$/.exec(value);
  if (!match) return null;
  const milliseconds = Date.parse(match[1] + "Z");
  if (Number.isNaN(milliseconds)) return null;
  const seconds = BigInt(Math.floor(milliseconds / 1000));
  const fractionalMicros = BigInt((match[2] ?? "").padEnd(6, "0"));
  return seconds * 1_000_000n + fractionalMicros;
}

function normalizedLockoutResolution(
  value: unknown,
): Record<string, unknown> | null | undefined {
  if (value === null) return null;
  const resolution = record(value);
  if (!resolution) return undefined;
  const resolutionAt =
    resolution.resolution_at === null
      ? null
      : normalizeUtcTimestampForResponse(resolution.resolution_at);
  if (resolutionAt === null && resolution.resolution_at !== null)
    return undefined;
  return { ...resolution, resolution_at: resolutionAt };
}

function normalizedCommand(value: unknown): Record<string, unknown> | null {
  const command = record(value);
  if (!command) return null;
  const createdAt = normalizeUtcTimestampForResponse(command.created_at);
  const startBefore = normalizeUtcTimestampForResponse(command.start_before);
  const lockoutResolution = normalizedLockoutResolution(
    command.lockout_resolution,
  );
  if (
    createdAt === null ||
    startBefore === null ||
    lockoutResolution === undefined
  )
    return null;
  return {
    ...command,
    created_at: createdAt,
    start_before: startBefore,
    lockout_resolution: lockoutResolution,
  };
}

function normalizedHistoryRecord(
  value: unknown,
): Record<string, unknown> | null {
  const item = record(value);
  if (!item) return null;
  const createdAt = normalizeUtcTimestampForResponse(item.created_at);
  const startedAt =
    item.started_at === null
      ? null
      : normalizeUtcTimestampForResponse(item.started_at);
  const completedAt =
    item.completed_at === null
      ? null
      : normalizeUtcTimestampForResponse(item.completed_at);
  const startBefore =
    item.start_before === undefined || item.start_before === null
      ? item.start_before
      : normalizeUtcTimestampForResponse(item.start_before);
  const lockoutResolution = normalizedLockoutResolution(
    item.lockout_resolution,
  );
  if (
    createdAt === null ||
    (startedAt === null && item.started_at !== null) ||
    (completedAt === null && item.completed_at !== null) ||
    (startBefore === null &&
      item.start_before !== null &&
      item.start_before !== undefined) ||
    lockoutResolution === undefined
  )
    return null;
  return {
    ...item,
    created_at: createdAt,
    started_at: startedAt,
    completed_at: completedAt,
    ...(item.start_before === undefined ? {} : { start_before: startBefore }),
    lockout_resolution: lockoutResolution,
  };
}

function nullableNumber(value: unknown, positive = false) {
  return (
    value === null ||
    (typeof value === "number" &&
      Number.isFinite(value) &&
      (positive ? value > 0 : value >= 0))
  );
}

function nullableInteger(value: unknown, positive = false) {
  return (
    value === null ||
    (typeof value === "number" &&
      Number.isSafeInteger(value) &&
      (positive ? value > 0 : value >= 0))
  );
}

function validCapabilities(value: unknown) {
  const profile = record(value);
  const nozzles = record(profile?.nozzles);
  if (
    !profile ||
    !nozzles ||
    typeof profile.do_monitoring !== "boolean" ||
    typeof profile.feed_remaining_monitoring !== "boolean" ||
    typeof profile.local_schedule_execution !== "boolean" ||
    typeof profile.scheduled_both !== "boolean" ||
    (Object.hasOwn(profile, "feed_capacity_g") &&
      !nullableNumber(profile.feed_capacity_g, true)) ||
    !nullableInteger(profile.max_schedules, true) ||
    !nullableInteger(profile.max_clock_uncertainty_ms) ||
    !nullableInteger(profile.scheduler_wake_grace_ms) ||
    !nullableInteger(profile.maximum_settling_ms, true)
  )
    return false;
  if (
    profile.local_schedule_execution
      ? typeof profile.max_schedules !== "number" || profile.max_schedules < 1
      : profile.max_schedules !== null
  )
    return false;

  return (["1", "2"] as const).every((number) => {
    const nozzle = record(nozzles[number]);
    if (
      !nozzle ||
      typeof nozzle.enabled !== "boolean" ||
      !Array.isArray(nozzle.dose_modes) ||
      !nozzle.dose_modes.every(
        (mode) => mode === "grams" || mode === "fixed_portion",
      ) ||
      new Set(nozzle.dose_modes).size !== nozzle.dose_modes.length ||
      !Array.isArray(nozzle.fixed_portion_ids) ||
      !nozzle.fixed_portion_ids.every(
        (id) =>
          typeof id === "string" &&
          characterLength(id) >= 1 &&
          characterLength(id) <= 80,
      ) ||
      new Set(nozzle.fixed_portion_ids).size !==
        nozzle.fixed_portion_ids.length ||
      typeof nozzle.measured_dispensed_g !== "boolean" ||
      !nullableInteger(nozzle.max_actuation_ms, true) ||
      !nullableInteger(nozzle.minimum_cooldown_ms)
    )
      return false;
    const supportsGrams = nozzle.dose_modes.includes("grams");
    const supportsFixed = nozzle.dose_modes.includes("fixed_portion");
    return (
      nullableNumber(nozzle.min_dose_g, true) &&
      nullableNumber(nozzle.max_dose_g, true) &&
      nullableNumber(nozzle.dose_step_g, true) &&
      (supportsGrams
        ? typeof nozzle.min_dose_g === "number" &&
          typeof nozzle.max_dose_g === "number" &&
          typeof nozzle.dose_step_g === "number" &&
          nozzle.min_dose_g <= nozzle.max_dose_g
        : nozzle.min_dose_g === null &&
          nozzle.max_dose_g === null &&
          nozzle.dose_step_g === null) &&
      supportsFixed === nozzle.fixed_portion_ids.length > 0 &&
      nozzle.enabled === nozzle.dose_modes.length > 0 &&
      (nozzle.enabled || nozzle.measured_dispensed_g === false)
    );
  });
}

function normalizedDeviceDescriptor(value: unknown, expectedDeviceId: string) {
  const device = record(value);
  if (!(
    !!device &&
    isUuid(device.device_id) &&
    device.device_id.toLowerCase() === expectedDeviceId &&
    typeof device.model === "string" &&
    characterLength(device.model) >= 1 &&
    characterLength(device.model) <= 100 &&
    typeof device.firmware_version === "string" &&
    characterLength(device.firmware_version) >= 1 &&
    characterLength(device.firmware_version) <= 100 &&
    device.protocol_major === 2 &&
    typeof device.is_simulated === "boolean" &&
    typeof device.capabilities_revision === "number" &&
    Number.isSafeInteger(device.capabilities_revision) &&
    device.capabilities_revision > 0 &&
    validCapabilities(device.capabilities)
  ))
    return null;
  const capabilities = record(device.capabilities);
  return {
    ...device,
    device_id: expectedDeviceId,
    capabilities: {
      ...capabilities,
      feed_capacity_g: capabilities.feed_capacity_g ?? null,
    },
  };
}

function normalizedAccess(value: unknown, expectedDeviceId: string) {
  const access = record(value);
  const deviceId = isUuid(access?.device_id)
    ? access.device_id.toLowerCase()
    : null;
  const grantedAt = normalizeUtcTimestamp(access?.granted_at);
  if (!access || deviceId !== expectedDeviceId || grantedAt === null) {
    return null;
  }
  return { device_id: expectedDeviceId, granted_at: grantedAt };
}

function normalizedMetadata(value: unknown, expectedDeviceId: string) {
  const metadata = record(value);
  const deviceId = isUuid(metadata?.device_id)
    ? metadata.device_id.toLowerCase()
    : null;
  if (
    !metadata ||
    deviceId !== expectedDeviceId ||
    !(
      metadata.alias === null ||
      (typeof metadata.alias === "string" &&
        characterLength(metadata.alias) <= 100)
    ) ||
    !(
      metadata.location === null ||
      (typeof metadata.location === "string" &&
        characterLength(metadata.location) <= 160)
    ) ||
    typeof metadata.metadata_revision !== "number" ||
    !Number.isSafeInteger(metadata.metadata_revision) ||
    metadata.metadata_revision < 1 ||
    typeof metadata.metadata_conflict !== "boolean"
  ) {
    return null;
  }
  return {
    device_id: expectedDeviceId,
    alias: metadata.alias,
    location: metadata.location,
    metadata_revision: metadata.metadata_revision,
    metadata_conflict: metadata.metadata_conflict,
  };
}

function routePath(request: Request) {
  const pathname = new URL(request.url).pathname;
  const match = pathname.match(/\/app-api\/v2(\/.*)?$/);
  return match ? match[1] || "/" : null;
}

function operationError(requestId: string, status: unknown) {
  switch (status) {
    case "not_active":
      return apiError(
        requestId,
        403,
        "ACCESS_REVOKED",
        "This installation no longer has access to that device.",
      );
    case "not_found":
      return apiError(
        requestId,
        404,
        "RESOURCE_NOT_FOUND",
        "That feeding record is not available for this installation.",
      );
    case "idempotency_conflict":
      return apiError(
        requestId,
        409,
        "IDEMPOTENCY_CONFLICT",
        "This feed key was already used with different targets or doses.",
      );
    case "device_busy":
      return apiError(
        requestId,
        409,
        "DEVICE_BUSY",
        "This feeder is already handling a feeding operation.",
      );
    case "device_offline":
      return apiError(
        requestId,
        409,
        "DEVICE_OFFLINE",
        "The feeder has not contacted the service recently enough to accept a new feed.",
      );
    case "safety_lockout":
      return apiError(
        requestId,
        409,
        "SAFETY_LOCKOUT",
        "The feeder needs an in person safety check before another feed.",
      );
    case "capability_mismatch":
      return apiError(
        requestId,
        409,
        "CAPABILITY_MISMATCH",
        "The feeder capabilities changed. Refresh the device before confirming.",
      );
    case "dose_unsupported":
      return apiError(
        requestId,
        422,
        "DOSE_UNSUPPORTED",
        "This feeder does not support the selected dose.",
      );
    case "dose_out_of_range":
      return apiError(
        requestId,
        422,
        "DOSE_OUT_OF_RANGE",
        "One of the selected doses is outside this nozzle's supported range.",
      );
    case "inventory_unavailable":
      return apiError(
        requestId,
        409,
        "INVENTORY_UNAVAILABLE",
        "A fresh, valid measured feed-stock reading is required before feeding.",
      );
    case "insufficient_inventory":
      return apiError(
        requestId,
        409,
        "INSUFFICIENT_INVENTORY",
        "The selected doses exceed the feeder's measured remaining stock.",
      );
    case "invalid":
      return apiError(
        requestId,
        422,
        "VALIDATION_FAILED",
        "The requested feeding or history filters are invalid.",
      );
    default:
      return apiError(
        requestId,
        503,
        "SERVICE_UNAVAILABLE",
        "The device service is temporarily unavailable.",
        true,
      );
  }
}

async function createManualFeed(
  request: Request,
  installation: string,
  deviceId: string,
) {
  const parsed = await readJson(request, crypto.randomUUID());
  if (parsed.response) return parsed.response;
  const body = record(parsed.value);
  const requestId = requestIdFrom(body);
  const targets = manualTargets(body?.targets);
  if (
    !body ||
    !protocolMajor(body) ||
    !isUuid(body.request_id) ||
    !isUuid(body.device_id) ||
    body.device_id.toLowerCase() !== deviceId ||
    !isUuid(body.idempotency_key) ||
    !Number.isSafeInteger(body.capabilities_revision) ||
    Number(body.capabilities_revision) < 1 ||
    !targets
  )
    return apiError(
      requestId,
      422,
      "VALIDATION_FAILED",
      "The manual feed request is invalid.",
    );
  if (!(await takeRateLimit("device_write", installation))) {
    return apiError(
      requestId,
      429,
      "RATE_LIMITED",
      "Manual feeding is temporarily limited. Wait briefly before trying again.",
      true,
    );
  }
  const { data, error } = await admin.rpc("art31_create_manual_feed", {
    p_device_id: deviceId,
    p_installation_id: installation,
    p_request_id: requestId,
    p_idempotency_key: body.idempotency_key.toLowerCase(),
    p_targets: targets,
    p_capabilities_revision: body.capabilities_revision,
  });
  if (error)
    return apiError(
      requestId,
      503,
      "SERVICE_UNAVAILABLE",
      "The feed could not be safely recorded.",
      true,
    );
  const result = record(data);
  if (result?.status !== "created" && result?.status !== "existing") {
    return operationError(requestId, result?.status);
  }
  const command = normalizedCommand(result.command);
  if (!command)
    return apiError(
      requestId,
      503,
      "SERVICE_UNAVAILABLE",
      "The stored feed status could not be verified.",
      true,
    );
  if (result.status === "existing")
    return json({ request_id: requestId, command });
  return json(
    {
      request_id: requestId,
      device_id: deviceId,
      command_id: command.command_id,
      sequence_id: command.sequence_id,
      idempotency_key: command.idempotency_key,
      targets: command.targets,
      status: command.status,
      created_at: command.created_at,
      start_before: command.start_before,
    },
    202,
  );
}

async function resolveManualNoAdmission(
  request: Request,
  installation: string,
  deviceId: string,
) {
  const parsed = await readJson(request, crypto.randomUUID());
  if (parsed.response) return parsed.response;
  const body = record(parsed.value);
  const requestId = requestIdFrom(body);
  const targets = manualTargets(body?.targets);
  if (
    !body ||
    !protocolMajor(body) ||
    !isUuid(body.request_id) ||
    !isUuid(body.device_id) ||
    body.device_id.toLowerCase() !== deviceId ||
    !isUuid(body.idempotency_key) ||
    !Number.isSafeInteger(body.capabilities_revision) ||
    Number(body.capabilities_revision) < 1 ||
    !targets
  )
    return apiError(
      requestId,
      422,
      "VALIDATION_FAILED",
      "The saved feed recovery request is invalid.",
    );
  if (!(await takeRateLimit("device_write", installation))) {
    return apiError(
      requestId,
      429,
      "RATE_LIMITED",
      "Feed recovery is temporarily limited.",
      true,
    );
  }
  const { data, error } = await admin.rpc("art31_resolve_manual_feed_no_admission", {
    p_device_id: deviceId,
    p_installation_id: installation,
    p_request_id: requestId,
    p_idempotency_key: body.idempotency_key.toLowerCase(),
    p_targets: targets,
    p_capabilities_revision: body.capabilities_revision,
  });
  if (error)
    return apiError(
      requestId,
      503,
      "SERVICE_UNAVAILABLE",
      "The saved feed could not be safely resolved.",
      true,
    );
  const result = record(data);
  if (result?.status !== "created" && result?.status !== "existing")
    return operationError(requestId, result?.status);
  const command = normalizedCommand(result.command);
  if (
    !command ||
    command.request_id !== requestId ||
    command.idempotency_key !== body.idempotency_key.toLowerCase() ||
    JSON.stringify(command.targets) !== JSON.stringify(targets)
  )
    return apiError(
      requestId,
      503,
      "SERVICE_UNAVAILABLE",
      "The saved feed resolution could not be verified.",
      true,
    );
  return json({ request_id: requestId, resolution: result.status, command });
}

async function readManualCommand(
  installation: string,
  deviceId: string,
  lookup: string,
  byKey: boolean,
  requestId: string,
) {
  const { data, error } = await admin.rpc("art31_read_manual_command", {
    p_device_id: deviceId,
    p_installation_id: installation,
    p_lookup: lookup,
    p_by_key: byKey,
  });
  if (error)
    return apiError(
      requestId,
      503,
      "SERVICE_UNAVAILABLE",
      "The feed status could not be checked.",
      true,
    );
  const result = record(data);
  if (result?.status !== "found")
    return operationError(requestId, result?.status);
  const command = normalizedCommand(result.command);
  if (!command)
    return apiError(
      requestId,
      503,
      "SERVICE_UNAVAILABLE",
      "The stored feed status could not be verified.",
      true,
    );
  return json({ request_id: requestId, command });
}

async function readFeedHistory(
  request: Request,
  installation: string,
  deviceId: string,
  requestId: string,
) {
  const url = new URL(request.url);
  const rawFrom = url.searchParams.get("from");
  const rawTo = url.searchParams.get("to");
  const parsedFrom = rawFrom === null ? null : localDate(rawFrom);
  const parsedTo = rawTo === null ? null : localDate(rawTo);
  const cursor = decodeHistoryCursor(url.searchParams.get("cursor"));
  if (url.searchParams.has("cursor") && !cursor)
    return apiError(
      requestId,
      400,
      "INVALID_INPUT",
      "The history cursor is invalid.",
    );

  const rawSource = url.searchParams.get("source");
  const rawStatus = url.searchParams.get("status");
  const source = rawSource ?? cursor?.source ?? "all";
  const status = rawStatus ?? cursor?.status ?? "all";
  const fromDate = parsedFrom ?? cursor?.from_date ?? null;
  const toDate = parsedTo ?? cursor?.to_date ?? null;
  if (
    (rawFrom !== null && !parsedFrom) ||
    (rawTo !== null && !parsedTo) ||
    (rawFrom === null) !== (rawTo === null) ||
    !(source === "all" || source === "manual" || source === "scheduled") ||
    !(
      status === "all" ||
      status === "completed" ||
      status === "failed" ||
      status === "in_progress" ||
      status === "unknown"
    ) ||
    (cursor &&
      (cursor.device_id.toLowerCase() !== deviceId ||
        cursor.source !== source ||
        cursor.status !== status ||
        (parsedFrom !== null && cursor.from_date !== parsedFrom) ||
        (parsedTo !== null && cursor.to_date !== parsedTo))) ||
    (fromDate &&
      toDate &&
      (Date.parse(`${toDate}T00:00:00Z`) -
        Date.parse(`${fromDate}T00:00:00Z`)) /
        86_400_000 >
        366)
  )
    return apiError(
      requestId,
      400,
      "INVALID_INPUT",
      "The history filters are invalid or do not match this cursor.",
    );

  const { data, error } = await admin.rpc("art31_history_page", {
    p_device_id: deviceId,
    p_installation_id: installation,
    p_from_date: fromDate,
    p_to_date: toDate,
    p_source: source,
    p_status: status,
    p_before_created_at: cursor?.created_at ?? null,
    p_before_sequence_id: cursor?.sequence_id ?? null,
  });
  if (error)
    return apiError(
      requestId,
      503,
      "SERVICE_UNAVAILABLE",
      "Feeding history could not be loaded.",
      true,
    );
  const result = record(data);
  if (result?.status !== "ok") return operationError(requestId, result?.status);
  const next = record(result.next);
  const nextCreatedAt = normalizeUtcTimestampForResponse(next?.created_at);
  const nextSequenceId = isUuid(next?.sequence_id) ? next.sequence_id : null;
  const cursorFromDate = localDate(String(result.from_date));
  const cursorToDate = localDate(String(result.to_date));
  if (
    result.has_more === true &&
    (!next ||
      !nextCreatedAt ||
      !nextSequenceId ||
      !cursorFromDate ||
      !cursorToDate)
  ) {
    return apiError(
      requestId,
      503,
      "SERVICE_UNAVAILABLE",
      "Feeding history could not be loaded.",
      true,
    );
  }
  if (!Array.isArray(result.records))
    return apiError(
      requestId,
      503,
      "SERVICE_UNAVAILABLE",
      "Feeding history could not be loaded.",
      true,
    );
  const records = result.records.map(normalizedHistoryRecord);
  if (records.some((item) => item === null))
    return apiError(
      requestId,
      503,
      "SERVICE_UNAVAILABLE",
      "Feeding history could not be loaded.",
      true,
    );
  const nextCursor =
    result.has_more === true
      ? encodeHistoryCursor({
          device_id: deviceId,
          from_date: cursorFromDate!,
          to_date: cursorToDate!,
          source,
          status,
          created_at: nextCreatedAt!,
          sequence_id: nextSequenceId!,
        })
      : null;
  return json({
    request_id: requestId,
    from_date: result.from_date,
    to_date: result.to_date,
    timezone: result.timezone,
    timezone_known: result.timezone_known,
    totals: {
      total: result.total,
      completed: result.completed_total,
      needs_attention: result.needs_attention_total,
      in_progress: result.in_progress_total,
    },
    records,
    next_cursor: nextCursor,
  });
}

type NormalizedAlertEvent = {
  event_id: string;
  device_id: string;
  kind: string;
  value: number | null;
  limit: number | null;
  measured_at: string | null;
  raised_at: string;
  applied_revision: number | null;
  boot_id: string | null;
  sample_sequence: number | null;
  sequence_id: string | null;
  is_simulated: boolean;
  is_read: boolean;
  is_dismissed: boolean;
};

function normalizedAlertEvent(
  value: unknown,
  deviceId: string,
): NormalizedAlertEvent | null {
  const item = record(value);
  const measuredAt = normalizeUtcTimestampForResponse(item?.measured_at);
  const raisedAt = normalizeUtcTimestampForResponse(item?.raised_at);
  // Feeding outcomes reference their sequence and carry no reading facts (ART-100).
  const feeding =
    item?.kind === "feeding_failed" ||
    item?.kind === "feeding_partial" ||
    item?.kind === "feeding_unknown" ||
    item?.kind === "feeding_unmeasured";
  if (
    item &&
    feeding &&
    onlyKeys(item, [
      "event_id",
      "device_id",
      "kind",
      "value",
      "limit",
      "measured_at",
      "raised_at",
      "applied_revision",
      "boot_id",
      "sample_sequence",
      "sequence_id",
      "is_simulated",
      "is_read",
      "is_dismissed",
    ]) &&
    isUuid(item.event_id) &&
    isUuid(item.device_id) &&
    item.device_id.toLowerCase() === deviceId &&
    isUuid(item.sequence_id) &&
    [
      item.value,
      item.limit,
      item.measured_at,
      item.applied_revision,
      item.boot_id,
      item.sample_sequence,
    ].every((field) => field === null) &&
    raisedAt &&
    alertTimestampMicros(raisedAt) !== null &&
    typeof item.is_simulated === "boolean" &&
    typeof item.is_read === "boolean" &&
    item.is_dismissed === false
  )
    return {
      event_id: item.event_id.toLowerCase(),
      device_id: item.device_id.toLowerCase(),
      kind: item.kind as string,
      value: null,
      limit: null,
      measured_at: null,
      raised_at: raisedAt,
      applied_revision: null,
      boot_id: null,
      sample_sequence: null,
      sequence_id: item.sequence_id.toLowerCase(),
      is_simulated: item.is_simulated,
      is_read: item.is_read,
      is_dismissed: item.is_dismissed,
    };
  if (
    !item ||
    !onlyKeys(item, [
      "event_id",
      "device_id",
      "kind",
      "value",
      "limit",
      "measured_at",
      "raised_at",
      "applied_revision",
      "boot_id",
      "sample_sequence",
      "sequence_id",
      "is_simulated",
      "is_read",
      "is_dismissed",
    ]) ||
    // Absent before the ART-100 migration, null after it.
    (item.sequence_id ?? null) !== null ||
    !isUuid(item.event_id) ||
    !isUuid(item.device_id) ||
    item.device_id.toLowerCase() !== deviceId ||
    !isUuid(item.boot_id) ||
    !(item.kind === "do_low" || item.kind === "do_high" || item.kind === "feed_low") ||
    typeof item.value !== "number" ||
    !Number.isFinite(item.value) ||
    typeof item.limit !== "number" ||
    !Number.isFinite(item.limit) ||
    !measuredAt ||
    !raisedAt ||
    alertTimestampMicros(raisedAt) === null ||
    typeof item.applied_revision !== "number" ||
    !Number.isSafeInteger(item.applied_revision) ||
    item.applied_revision < 1 ||
    typeof item.sample_sequence !== "number" ||
    !Number.isSafeInteger(item.sample_sequence) ||
    item.sample_sequence < 0 ||
    typeof item.is_simulated !== "boolean" ||
    typeof item.is_read !== "boolean" ||
    typeof item.is_dismissed !== "boolean" ||
    item.is_dismissed !== false
  )
    return null;
  return {
    event_id: item.event_id.toLowerCase(),
    device_id: item.device_id.toLowerCase(),
    kind: item.kind,
    value: item.value,
    limit: item.limit,
    measured_at: measuredAt,
    raised_at: raisedAt,
    applied_revision: item.applied_revision,
    boot_id: item.boot_id.toLowerCase(),
    sample_sequence: item.sample_sequence,
    sequence_id: null,
    is_simulated: item.is_simulated,
    is_read: item.is_read,
    is_dismissed: item.is_dismissed,
  };
}

function orderedAlertEvents(events: NormalizedAlertEvent[]) {
  const ids = new Set<string>();
  for (let index = 0; index < events.length; index += 1) {
    const event = events[index];
    if (ids.has(event.event_id)) return false;
    ids.add(event.event_id);
    const previous = events[index - 1];
    if (previous) {
      const previousTime = alertTimestampMicros(previous.raised_at);
      const currentTime = alertTimestampMicros(event.raised_at);
      if (
        previousTime === null ||
        currentTime === null ||
        previousTime < currentTime ||
        (previousTime === currentTime && previous.event_id <= event.event_id)
      )
        return false;
    }
  }
  return true;
}

function notificationProtocolError(requestId: string) {
  return apiError(
    requestId,
    422,
    "PROTOCOL_UNSUPPORTED",
    "Protocol major 2 is required.",
  );
}

async function readNotifications(
  request: Request,
  installation: string,
  deviceId: string,
) {
  const requestId = requestHeaderId(request);
  if (!validProtocolHeader(request))
    return notificationProtocolError(requestId ?? crypto.randomUUID());
  if (!requestId)
    return apiError(
      crypto.randomUUID(),
      400,
      "INVALID_INPUT",
      "A valid X-Request-Id header is required.",
    );

  const url = new URL(request.url);
  const queryKeys = [...url.searchParams.keys()];
  const rawCursors = url.searchParams.getAll("cursor");
  if (
    queryKeys.some((key) => key !== "cursor") ||
    rawCursors.length > 1
  )
    return apiError(
      requestId,
      400,
      "INVALID_INPUT",
      "The notification query is invalid.",
    );
  const cursor = decodeAlertCursor(rawCursors[0] ?? null);
  if (
    (rawCursors.length === 1 && !cursor) ||
    (cursor && cursor.device_id !== deviceId)
  )
    return apiError(
      requestId,
      400,
      "INVALID_INPUT",
      "The notification cursor is invalid.",
    );

  const { data, error } = await admin.rpc("art95_list_alert_events", {
    p_device_id: deviceId,
    p_installation_id: installation,
    p_before_raised_at: cursor?.raised_at ?? null,
    p_before_event_id: cursor?.event_id ?? null,
  });
  if (error)
    return apiError(
      requestId,
      503,
      "SERVICE_UNAVAILABLE",
      "Notifications could not be loaded.",
      true,
    );
  const result = record(data);
  if (!result || result.status !== "ok") {
    if (result?.status === "not_active")
      return apiError(
        requestId,
        403,
        "ACCESS_REVOKED",
        "This installation no longer has access to the device.",
      );
    if (result?.status === "invalid_cursor")
      return apiError(
        requestId,
        400,
        "INVALID_INPUT",
        "The notification cursor is invalid.",
      );
    return apiError(
      requestId,
      503,
      "SERVICE_UNAVAILABLE",
      "Notifications could not be loaded.",
      true,
    );
  }
  if (
    !onlyKeys(result, ["status", "events", "has_more", "unread_count"]) ||
    !Array.isArray(result.events) ||
    result.events.length > 51 ||
    typeof result.has_more !== "boolean" ||
    typeof result.unread_count !== "number" ||
    !Number.isSafeInteger(result.unread_count) ||
    result.unread_count < 0 ||
    result.unread_count > 2_147_483_647 ||
    (result.has_more && result.events.length !== 51) ||
    (!result.has_more && result.events.length > 50)
  )
    return apiError(
      requestId,
      503,
      "SERVICE_UNAVAILABLE",
      "Notifications could not be loaded.",
      true,
    );
  const events = result.events.map((event) =>
    normalizedAlertEvent(event, deviceId)
  );
  if (
    events.some((event) => event === null) ||
    !orderedAlertEvents(events as NormalizedAlertEvent[])
  )
    return apiError(
      requestId,
      503,
      "SERVICE_UNAVAILABLE",
      "Notifications could not be loaded.",
      true,
    );
  const normalized = events as NormalizedAlertEvent[];
  const visible = normalized.slice(0, 50);
  const last = visible.at(-1);
  const nextCursor =
    result.has_more && last
      ? encodeAlertCursor({
          device_id: deviceId,
          raised_at: last.raised_at,
          event_id: last.event_id,
        })
      : null;
  return json({
    request_id: requestId,
    device_id: deviceId,
    events: visible,
    has_more: result.has_more,
    unread_count: result.unread_count,
    next_cursor: nextCursor,
  });
}

async function readNotificationEvent(
  request: Request,
  installation: string,
  deviceId: string,
  eventId: string,
) {
  const requestId = requestHeaderId(request);
  if (!validProtocolHeader(request))
    return notificationProtocolError(requestId ?? crypto.randomUUID());
  if (!requestId)
    return apiError(crypto.randomUUID(), 400, "INVALID_INPUT", "A valid X-Request-Id header is required.");
  if (new URL(request.url).search !== "")
    return apiError(requestId, 400, "INVALID_INPUT", "The notification query is invalid.");
  const { data, error } = await admin.rpc("art96_read_alert_event", {
    p_device_id: deviceId,
    p_event_id: eventId,
    p_installation_id: installation,
  });
  if (error)
    return apiError(requestId, 503, "SERVICE_UNAVAILABLE", "The notification could not be loaded.", true);
  const result = record(data);
  if (!result)
    return apiError(requestId, 503, "SERVICE_UNAVAILABLE", "The notification could not be loaded.", true);
  if (result?.status === "not_active")
    return apiError(requestId, 403, "ACCESS_REVOKED", "This installation no longer has access to the device.");
  if (result?.status === "not_found" || result?.is_dismissed === true)
    return apiError(requestId, 404, "RESOURCE_NOT_FOUND", "The notification is not available for this device.");
  const event = normalizedAlertEvent(
    Object.fromEntries(Object.entries(result).filter(([key]) => key !== "status")),
    deviceId,
  );
  if (!event || event.event_id !== eventId)
    return apiError(requestId, 503, "SERVICE_UNAVAILABLE", "The notification could not be loaded.", true);
  return json({ request_id: requestId, device_id: deviceId, event });
}

async function pushTokenBody(
  request: Request,
  keys: string[],
): Promise<{ ok: true; body: Record<string, unknown>; requestId: string } | { ok: false; response: Response }> {
  const parsed = await readJson(request, crypto.randomUUID());
  if (parsed.response) return { ok: false, response: parsed.response };
  const body = record(parsed.value);
  const headerId = requestHeaderId(request);
  const requestId = requestIdFrom(body);
  if (!validProtocolHeader(request))
    return { ok: false, response: notificationProtocolError(headerId ?? crypto.randomUUID()) };
  if (!headerId || !requestId || headerId !== requestId)
    return { ok: false, response: apiError(headerId ?? crypto.randomUUID(), 400, "INVALID_INPUT", "Matching X-Request-Id and request_id values are required.") };
  if (!body || !onlyKeys(body, keys) || body.protocol_major !== 2 || body.request_id !== requestId)
    return { ok: false, response: apiError(requestId, 400, "INVALID_INPUT", "The push token request is invalid.") };
  return { ok: true, body, requestId };
}

async function registerPushToken(request: Request, installation: string) {
  const parsed = await pushTokenBody(request, [
    "protocol_major", "request_id", "platform", "eas_project_id", "expo_push_token",
  ]);
  if (!parsed.ok) return parsed.response;
  const { body, requestId } = parsed;
  if (
    body.platform !== "android" ||
    body.eas_project_id !== ANDROID_EAS_PROJECT_ID ||
    typeof body.expo_push_token !== "string" ||
    body.expo_push_token.length > 280 ||
    !EXPO_PUSH_TOKEN.test(body.expo_push_token)
  )
    return apiError(requestId, 400, "INVALID_INPUT", "The Android push token request is invalid.");
  if (!(await takeRateLimit("device_write", installation)))
    return apiError(requestId, 429, "RATE_LIMITED", "Too many push token changes were requested.", true);
  const { data, error } = await admin.rpc("art96_register_push_token", {
    p_installation_id: installation,
    p_eas_project_id: ANDROID_EAS_PROJECT_ID,
    p_platform: "android",
    p_expo_push_token: body.expo_push_token,
  });
  if (error)
    return apiError(requestId, 503, "SERVICE_UNAVAILABLE", "Push registration could not be saved.", true);
  const result = record(data);
  if (result?.status === "not_active")
    return apiError(requestId, 403, "ACCESS_REVOKED", "Pair a feeder before enabling push notifications.");
  if (result?.status !== "ok" || typeof result.generation !== "number" || !Number.isSafeInteger(result.generation))
    return apiError(requestId, 503, "SERVICE_UNAVAILABLE", "Push registration could not be verified.", true);
  return json({ request_id: requestId, registered: true });
}

async function revokePushToken(request: Request, installation: string) {
  const parsed = await pushTokenBody(request, ["protocol_major", "request_id"]);
  if (!parsed.ok) return parsed.response;
  const { requestId } = parsed;
  if (!(await takeRateLimit("device_write", installation)))
    return apiError(requestId, 429, "RATE_LIMITED", "Too many push token changes were requested.", true);
  const { data, error } = await admin.rpc("art96_revoke_push_token", {
    p_installation_id: installation,
  });
  if (error)
    return apiError(requestId, 503, "SERVICE_UNAVAILABLE", "Push registration could not be removed.", true);
  const result = record(data);
  if (result?.status === "not_active")
    return apiError(requestId, 403, "ACCESS_REVOKED", "This installation no longer has access to a feeder.");
  if (result?.status !== "ok")
    return apiError(requestId, 503, "SERVICE_UNAVAILABLE", "Push registration could not be removed.", true);
  return json({ request_id: requestId, registered: false });
}

async function readNotificationActionBody(
  request: Request,
  allowedKeys: string[],
): Promise<
  | { ok: true; body: Record<string, unknown>; requestId: string }
  | { ok: false; response: Response }
> {
  const parsed = await readJson(request, crypto.randomUUID());
  if (parsed.response) return { ok: false, response: parsed.response };
  const body = record(parsed.value);
  const headerId = requestHeaderId(request);
  const requestId = requestIdFrom(body);
  if (!validProtocolHeader(request))
    return {
      ok: false,
      response: notificationProtocolError(headerId ?? crypto.randomUUID()),
    };
  if (!headerId || !requestId || headerId !== requestId)
    return {
      ok: false,
      response: apiError(
        headerId ?? crypto.randomUUID(),
        400,
        "INVALID_INPUT",
        "Matching X-Request-Id and request_id values are required.",
      ),
    };
  if (
    !body ||
    !onlyKeys(body, allowedKeys) ||
    body.protocol_major !== 2 ||
    body.request_id !== requestId
  )
    return {
      ok: false,
      response: apiError(
        requestId,
        400,
        "INVALID_INPUT",
        "The notification action is invalid.",
      ),
    };
  return { ok: true, body, requestId };
}

async function updateNotificationState(
  request: Request,
  installation: string,
  deviceId: string,
  eventId: string,
) {
  const parsed = await readNotificationActionBody(request, [
    "protocol_major",
    "request_id",
    "action",
  ]);
  if (!parsed.ok) return parsed.response;
  const { body, requestId } = parsed;
  if (!(body.action === "read" || body.action === "dismiss"))
    return apiError(
      requestId,
      400,
      "INVALID_INPUT",
      "The notification action is invalid.",
    );
  if (!(await takeRateLimit("device_write", installation)))
    return apiError(
      requestId,
      429,
      "RATE_LIMITED",
      "Too many notification actions were requested.",
      true,
    );
  const { data, error } = await admin.rpc("art95_set_alert_event_state", {
    p_device_id: deviceId,
    p_event_id: eventId,
    p_installation_id: installation,
    p_action: body.action,
  });
  if (error)
    return apiError(
      requestId,
      503,
      "SERVICE_UNAVAILABLE",
      "The notification could not be updated.",
      true,
    );
  const result = record(data);
  if (result?.status === "not_active")
    return apiError(
      requestId,
      403,
      "ACCESS_REVOKED",
      "This installation no longer has access to the device.",
    );
  if (result?.status === "not_found")
    return apiError(
      requestId,
      404,
      "RESOURCE_NOT_FOUND",
      "The notification is not available for this device.",
    );
  if (
    !result ||
    result.status !== "ok" ||
    !onlyKeys(result, ["status", "event_id", "is_read", "is_dismissed"]) ||
    !isUuid(result.event_id) ||
    result.event_id.toLowerCase() !== eventId ||
    typeof result.is_read !== "boolean" ||
    typeof result.is_dismissed !== "boolean" ||
    (result.is_dismissed && !result.is_read)
  )
    return apiError(
      requestId,
      503,
      "SERVICE_UNAVAILABLE",
      "The notification could not be updated.",
      true,
    );
  return json({
    request_id: requestId,
    device_id: deviceId,
    event_id: eventId,
    is_read: result.is_read,
    is_dismissed: result.is_dismissed,
  });
}

async function bulkUpdateNotificationState(
  request: Request,
  installation: string,
  deviceId: string,
) {
  const parsed = await readNotificationActionBody(request, [
    "protocol_major",
    "request_id",
    "action",
    "through",
  ]);
  if (!parsed.ok) return parsed.response;
  const { body, requestId } = parsed;
  const through = record(body.through);
  const raisedAt = normalizeUtcTimestampForResponse(through?.raised_at);
  if (
    !(body.action === "mark_read" || body.action === "dismiss") ||
    !through ||
    !onlyKeys(through, ["raised_at", "event_id"]) ||
    !raisedAt ||
    alertTimestampMicros(raisedAt) === null ||
    !isUuid(through.event_id)
  )
    return apiError(
      requestId,
      400,
      "INVALID_INPUT",
      "The notification cutoff is invalid.",
    );
  if (!(await takeRateLimit("device_write", installation)))
    return apiError(
      requestId,
      429,
      "RATE_LIMITED",
      "Too many notification actions were requested.",
      true,
    );
  const eventId = through.event_id.toLowerCase();
  const { data, error } = await admin.rpc("art95_bulk_alert_event_state", {
    p_device_id: deviceId,
    p_installation_id: installation,
    p_action: body.action,
    p_through_raised_at: raisedAt,
    p_through_event_id: eventId,
  });
  if (error)
    return apiError(
      requestId,
      503,
      "SERVICE_UNAVAILABLE",
      "The notifications could not be updated.",
      true,
    );
  const result = record(data);
  if (result?.status === "not_active")
    return apiError(
      requestId,
      403,
      "ACCESS_REVOKED",
      "This installation no longer has access to the device.",
    );
  if (result?.status === "invalid_cutoff")
    return apiError(
      requestId,
      400,
      "INVALID_INPUT",
      "The notification cutoff is invalid.",
    );
  const responseRaisedAt = normalizeUtcTimestampForResponse(
    result?.through_raised_at,
  );
  const responseRaisedAtMicros = responseRaisedAt
    ? alertTimestampMicros(responseRaisedAt)
    : null;
  const requestedRaisedAtMicros = alertTimestampMicros(raisedAt);
  if (
    !result ||
    result.status !== "ok" ||
    !onlyKeys(result, [
      "status",
      "action",
      "through_raised_at",
      "through_event_id",
    ]) ||
    result.action !== body.action ||
    !responseRaisedAt ||
    responseRaisedAtMicros === null ||
    requestedRaisedAtMicros === null ||
    !isUuid(result.through_event_id) ||
    result.through_event_id.toLowerCase() !== eventId ||
    responseRaisedAtMicros !== requestedRaisedAtMicros
  )
    return apiError(
      requestId,
      503,
      "SERVICE_UNAVAILABLE",
      "The notifications could not be updated.",
      true,
    );
  return json({
    request_id: requestId,
    device_id: deviceId,
    action: body.action,
    through: {
      raised_at: responseRaisedAt,
      event_id: eventId,
    },
  });
}

async function readHistoryDetail(
  installation: string,
  deviceId: string,
  sequenceId: string,
  requestId: string,
) {
  const { data, error } = await admin.rpc("art31_history_detail", {
    p_device_id: deviceId,
    p_installation_id: installation,
    p_sequence_id: sequenceId,
  });
  if (error)
    return apiError(
      requestId,
      503,
      "SERVICE_UNAVAILABLE",
      "Feeding details could not be loaded.",
      true,
    );
  const result = record(data);
  if (result?.status !== "ok") return operationError(requestId, result?.status);
  const historyRecord = normalizedHistoryRecord(result.record);
  if (!historyRecord)
    return apiError(
      requestId,
      503,
      "SERVICE_UNAVAILABLE",
      "Feeding details could not be loaded.",
      true,
    );
  return json({
    request_id: requestId,
    timezone: result.timezone,
    timezone_known: result.timezone_known,
    record: historyRecord,
  });
}

function configurationError(
  requestId: string,
  status: unknown,
  errorCode?: unknown,
) {
  if (status === "not_active")
    return apiError(
      requestId,
      403,
      "ACCESS_REVOKED",
      "This installation no longer has access to the device.",
    );
  if (status === "not_found")
    return apiError(
      requestId,
      404,
      "RESOURCE_NOT_FOUND",
      "The requested device is not available.",
    );
  if (status === "conflict")
    return apiError(
      requestId,
      409,
      "CONFIG_CONFLICT",
      "Refresh the applied configuration before saving this schedule.",
    );
  if (status === "pending")
    return apiError(
      requestId,
      409,
      "CONFIG_PENDING",
      "The device has not resolved the previous configuration revision yet.",
      true,
    );
  if (status === "idempotency_conflict")
    return apiError(
      requestId,
      409,
      "IDEMPOTENCY_CONFLICT",
      "This configuration request identifier was already used with different values.",
    );
  if (status === "rejected") {
    const code = isConfigurationErrorCode(errorCode)
      ? errorCode
      : "VALIDATION_FAILED";
    return apiError(
      requestId,
      422,
      code,
      "The complete schedule configuration was rejected. The previously applied schedule remains active.",
    );
  }
  return apiError(
    requestId,
    503,
    "SERVICE_UNAVAILABLE",
    "The configuration service is temporarily unavailable.",
    true,
  );
}

async function readConfiguration(
  request: Request,
  installation: string,
  deviceId: string,
) {
  const requestId = requestHeaderId(request);
  if (!validProtocolHeader(request))
    return apiError(
      requestId ?? crypto.randomUUID(),
      422,
      "PROTOCOL_UNSUPPORTED",
      "Protocol major 2 is required.",
    );
  if (!requestId)
    return apiError(
      crypto.randomUUID(),
      400,
      "INVALID_INPUT",
      "A valid X-Request-Id header is required.",
    );
  const parameters = new URL(request.url).searchParams;
  if ([...parameters.keys()].some((key) => key !== "request_id"))
    return apiError(
      requestId,
      400,
      "INVALID_INPUT",
      "The configuration query is invalid.",
    );
  const receiptId = parameters.get("request_id");
  if (receiptId !== null && !isUuid(receiptId))
    return apiError(
      requestId,
      400,
      "INVALID_INPUT",
      "The original configuration request identifier is invalid.",
    );
  const { data, error } = await admin.rpc("art33_read_configuration", {
    p_device_id: deviceId,
    p_installation_id: installation,
    p_request_id: receiptId?.toLowerCase() ?? null,
  });
  if (error)
    return apiError(
      requestId,
      503,
      "SERVICE_UNAVAILABLE",
      "The configuration could not be loaded.",
      true,
    );
  const response = configurationReadResult(data, requestId);
  if (!response) {
    const result = record(data);
    if (result?.status !== "ok")
      return configurationError(requestId, result?.status);
    return apiError(
      requestId,
      503,
      "SERVICE_UNAVAILABLE",
      "The configuration response could not be verified.",
      true,
    );
  }
  return json(response);
}

async function writeConfiguration(
  request: Request,
  installation: string,
  deviceId: string,
) {
  const parsed = await readJson(request, crypto.randomUUID());
  if (parsed.response) return parsed.response;
  const body = record(parsed.value);
  const requestId = requestIdFrom(body);
  if (
    !body ||
    !onlyKeys(body, [
      "protocol_major",
      "request_id",
      "based_on_revision",
      "snapshot",
    ]) ||
    !protocolMajor(body) ||
    !isUuid(body.request_id) ||
    !Number.isSafeInteger(body.based_on_revision) ||
    Number(body.based_on_revision) < 0 ||
    !validConfigurationValues(body.snapshot)
  ) {
    return apiError(
      requestId,
      422,
      "VALIDATION_FAILED",
      "Provide a complete, valid protocol 2 configuration snapshot.",
    );
  }
  if (!(await takeRateLimit("device_write", installation)))
    return apiError(
      requestId,
      429,
      "RATE_LIMITED",
      "Device changes are temporarily limited.",
      true,
    );
  const { data, error } = await admin.rpc("art33_write_configuration", {
    p_device_id: deviceId,
    p_installation_id: installation,
    p_request_id: String(body.request_id).toLowerCase(),
    p_based_on_revision: body.based_on_revision,
    p_snapshot: body.snapshot,
  });
  if (error)
    return apiError(
      requestId,
      503,
      "SERVICE_UNAVAILABLE",
      "The configuration could not be safely recorded.",
      true,
    );
  const result = record(data);
  if (result?.status !== "ok")
    return configurationError(requestId, result?.status, result?.error_code);
  const response = configurationReadResult(
    {
      status: "ok",
      receipt: result.receipt,
      request_status: "pending",
      request_error_code: null,
      current_state: result.current_state,
      desired_snapshot:
        result.receipt &&
        record(result.receipt)?.revision ===
          record(result.current_state)?.desired_revision
          ? {
              ...(body.snapshot as Record<string, unknown>),
              revision: record(result.receipt)?.revision,
              based_on_revision: body.based_on_revision,
            }
          : null,
      applied_snapshot: null,
    },
    requestId,
  );
  if (!response || !response.receipt)
    return apiError(
      requestId,
      503,
      "SERVICE_UNAVAILABLE",
      "The saved configuration could not be verified.",
      true,
    );
  return json(
    {
      request_id: requestId,
      receipt: response.receipt,
      current_state: response.current_state,
    },
    202,
  );
}

async function readNextOccurrence(
  request: Request,
  installation: string,
  deviceId: string,
) {
  const requestId = requestHeaderId(request);
  if (!validProtocolHeader(request))
    return apiError(
      requestId ?? crypto.randomUUID(),
      422,
      "PROTOCOL_UNSUPPORTED",
      "Protocol major 2 is required.",
    );
  if (!requestId)
    return apiError(
      crypto.randomUUID(),
      400,
      "INVALID_INPUT",
      "A valid X-Request-Id header is required.",
    );
  if ([...new URL(request.url).searchParams.keys()].length > 0)
    return apiError(
      requestId,
      400,
      "INVALID_INPUT",
      "The next feeding query is invalid.",
    );
  const { data, error } = await admin.rpc("art33_next_applied_occurrence", {
    p_device_id: deviceId,
    p_installation_id: installation,
  });
  if (error)
    return apiError(
      requestId,
      503,
      "SERVICE_UNAVAILABLE",
      "The next applied feeding could not be loaded.",
      true,
    );
  const result = record(data);
  if (result?.status !== "ok")
    return configurationError(requestId, result?.status);
  const occurrence =
    result.occurrence === null ? null : record(result.occurrence);
  const targets = occurrence?.targets;
  if (
    result.occurrence !== null &&
    (!occurrence ||
      !localDate(String(occurrence.occurrence_local_date)) ||
      typeof occurrence.local_time !== "string" ||
      !/^([01]\d|2[0-3]):[0-5]\d$/.test(occurrence.local_time) ||
      !validTimeZone(occurrence.timezone) ||
      occurrence.timezone !== result.timezone ||
      normalizeUtcTimestampForResponse(occurrence.at) === null ||
      !Array.isArray(targets) ||
      targets.length < 1 ||
      targets.length > 2 ||
      targets.some((value: unknown, index: number) => {
        const target = record(value);
        const dose = record(target?.dose);
        return (
          !target ||
          !onlyKeys(target, ["schedule_id", "nozzle_number", "dose"]) ||
          !isUuid(target.schedule_id) ||
          (target.nozzle_number !== 1 && target.nozzle_number !== 2) ||
          !dose ||
          !validScheduleDose(dose) ||
          (targets.length === 2 && target.nozzle_number !== index + 1)
        );
      }))
  )
    return apiError(
      requestId,
      503,
      "SERVICE_UNAVAILABLE",
      "The next applied feeding could not be verified.",
      true,
    );
  const timezone =
    result.timezone === null
      ? null
      : validTimeZone(result.timezone)
        ? (result.timezone as string)
        : undefined;
  if (timezone === undefined)
    return apiError(
      requestId,
      503,
      "SERVICE_UNAVAILABLE",
      "The next applied feeding could not be verified.",
      true,
    );
  return json({
    request_id: requestId,
    timezone,
    occurrence: occurrence && {
      ...occurrence,
      at: normalizeUtcTimestampForResponse(occurrence.at),
    },
  });
}

function monitoringError(requestId: string, status: unknown) {
  if (status === "not_active")
    return apiError(requestId, 403, "ACCESS_REVOKED", "This installation no longer has access to the device.");
  if (status === "not_found")
    return apiError(requestId, 404, "RESOURCE_NOT_FOUND", "The requested device was not found.");
  if (status === "invalid")
    return apiError(requestId, 400, "INVALID_INPUT", "The monitoring query is invalid.");
  return apiError(requestId, 503, "SERVICE_UNAVAILABLE", "Monitoring data could not be loaded.", true);
}

function nullableResponseTimestamp(value: unknown): string | null | undefined {
  if (value === null) return null;
  return normalizeUtcTimestampForResponse(value) ?? undefined;
}

async function readMonitoringSnapshot(request: Request, installation: string, deviceId: string) {
  const requestId = requestHeaderId(request);
  if (!validProtocolHeader(request))
    return apiError(requestId ?? crypto.randomUUID(), 422, "PROTOCOL_UNSUPPORTED", "Protocol major 2 is required.");
  if (!requestId)
    return apiError(crypto.randomUUID(), 400, "INVALID_INPUT", "A valid X-Request-Id header is required.");
  if ([...new URL(request.url).searchParams.keys()].length)
    return apiError(requestId, 400, "INVALID_INPUT", "The monitoring query is invalid.");
  const { data, error } = await admin.rpc("art27_monitoring_snapshot", {
    p_device_id: deviceId,
    p_installation_id: installation,
    p_request_id: requestId,
  });
  if (error) return monitoringError(requestId, "service_error");
  const result = record(data);
  if (result?.status !== "ok") return monitoringError(requestId, result?.status);
  const serverTime = normalizeUtcTimestampForResponse(result.server_time);
  const contact = record(result.contact);
  const latest = result.latest_sample === null ? null : record(result.latest_sample);
  const authenticatedAt = contact && nullableResponseTimestamp(contact.authenticated_at);
  const measuredAt = latest && nullableResponseTimestamp(latest.measured_at);
  const receivedAt = latest && normalizeUtcTimestampForResponse(latest.received_at);
  if (result.request_id !== requestId || result.device_id !== deviceId || serverTime === null || !contact ||
    !Object.prototype.hasOwnProperty.call(contact, "authenticated_at") || authenticatedAt === undefined ||
    (result.latest_sample !== null && (!latest || !Object.prototype.hasOwnProperty.call(latest, "measured_at") || measuredAt === undefined || receivedAt === null)))
    return monitoringError(requestId, "service_error");
  const { status: _status, ...response } = result;
  return json({
    ...response,
    server_time: serverTime,
    contact: { ...contact, authenticated_at: authenticatedAt },
    latest_sample: latest ? { ...latest, measured_at: measuredAt, received_at: receivedAt } : null,
  });
}

async function readDoGraph(request: Request, installation: string, deviceId: string) {
  const requestId = requestHeaderId(request);
  if (!validProtocolHeader(request))
    return apiError(requestId ?? crypto.randomUUID(), 422, "PROTOCOL_UNSUPPORTED", "Protocol major 2 is required.");
  if (!requestId)
    return apiError(crypto.randomUUID(), 400, "INVALID_INPUT", "A valid X-Request-Id header is required.");
  const parameters = new URL(request.url).searchParams;
  if ([...parameters.keys()].some((key) => key !== "window" && key !== "count"))
    return apiError(requestId, 400, "INVALID_INPUT", "The monitoring query is invalid.");
  const window = parameters.get("window") ?? "1h";
  const defaults: Record<string, number> = { "1h": 60, "6h": 72, "24h": 96 };
  const countText = parameters.get("count");
  const count = countText === null ? defaults[window] : /^\d+$/.test(countText) ? Number(countText) : NaN;
  if (!(window in defaults) || !Number.isSafeInteger(count) || count < 1 || count > 100)
    return apiError(requestId, 400, "INVALID_INPUT", "The monitoring query is invalid.");
  const { data, error } = await admin.rpc("art27_do_graph", {
    p_device_id: deviceId,
    p_installation_id: installation,
    p_request_id: requestId,
    p_window: window,
    p_count: count,
  });
  if (error) return monitoringError(requestId, "service_error");
  const result = record(data);
  if (result?.status !== "ok") return monitoringError(requestId, result?.status);
  const serverTime = normalizeUtcTimestampForResponse(result.server_time);
  const windowStart = normalizeUtcTimestampForResponse(result.window_start);
  const windowEnd = normalizeUtcTimestampForResponse(result.window_end);
  const samples = Array.isArray(result.samples) ? result.samples.map((sample) => {
    const point = record(sample);
    const bucketStart = point && normalizeUtcTimestampForResponse(point.bucket_start);
    const bucketEnd = point && normalizeUtcTimestampForResponse(point.bucket_end);
    const measuredAt = point && nullableResponseTimestamp(point.measured_at);
    const receivedAt = point && nullableResponseTimestamp(point.received_at);
    return point && bucketStart !== null && bucketStart !== undefined && bucketEnd !== null && bucketEnd !== undefined &&
      measuredAt !== undefined && receivedAt !== undefined
      ? { ...point, bucket_start: bucketStart, bucket_end: bucketEnd, measured_at: measuredAt, received_at: receivedAt }
      : null;
  }) : null;
  if (result.request_id !== requestId || result.device_id !== deviceId || serverTime === null || windowStart === null || windowEnd === null || !samples || samples.length > 100 || samples.some((point) => point === null))
    return monitoringError(requestId, "service_error");
  const { status: _status, ...response } = result;
  return json({ ...response, samples, server_time: serverTime, window_start: windowStart, window_end: windowEnd });
}

function badMethod(requestId: string) {
  return apiError(
    requestId,
    405,
    "INVALID_INPUT",
    "This method is not available for the requested route.",
  );
}

async function pairInstallation(request: Request, installation: string) {
  const parsed = await readJson(request, crypto.randomUUID());
  if (parsed.response) return parsed.response;
  const body = record(parsed.value);
  const requestId = requestIdFrom(body);
  if (
    !body ||
    !onlyKeys(body, [
      "protocol_major",
      "request_id",
      "device_id",
      "challenge_id",
      "pairing_secret",
    ])
  ) {
    return apiError(
      requestId,
      400,
      "INVALID_INPUT",
      "The pairing request is invalid.",
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
  if (
    !isUuid(body.request_id) ||
    !isUuid(body.device_id) ||
    !isUuid(body.challenge_id) ||
    typeof body.pairing_secret !== "string" ||
    characterLength(body.pairing_secret) < 1 ||
    characterLength(body.pairing_secret) > 512
  ) {
    return apiError(
      requestId,
      422,
      "VALIDATION_FAILED",
      "The pairing request is invalid.",
    );
  }
  const deviceId = body.device_id.toLowerCase();
  const challengeId = body.challenge_id.toLowerCase();
  try {
    if (!(await takeRateLimit("pair", installation))) {
      return apiError(
        requestId,
        429,
        "RATE_LIMITED",
        "Pairing requests are temporarily limited.",
        true,
      );
    }
    const { data, error } = await admin.rpc("art38_redeem_pairing_challenge", {
      p_device_id: deviceId,
      p_challenge_id: challengeId,
      p_installation_id: installation,
      p_verifier_hex: await sha256Hex(body.pairing_secret),
    });
    if (error)
      return apiError(
        requestId,
        503,
        "SERVICE_UNAVAILABLE",
        "The pairing service is temporarily unavailable.",
        true,
      );
    const result = record(data);
    switch (result?.status) {
      case "paired": {
        const device = normalizedDeviceDescriptor(result.device, deviceId);
        const access = normalizedAccess(result.access, deviceId);
        const shared = await admin
          .from("devices")
          .select(
            "device_id, alias, location, metadata_revision, metadata_conflict",
          )
          .eq("device_id", deviceId)
          .maybeSingle();
        const metadata = normalizedMetadata(shared.data, deviceId);
        if (!device || !access || !metadata) {
          return apiError(
            requestId,
            503,
            "SERVICE_UNAVAILABLE",
            "The paired device profile could not be verified.",
            true,
          );
        }
        return json({ request_id: requestId, device, access, metadata }, 201);
      }
      case "expired":
        return apiError(
          requestId,
          422,
          "PAIRING_EXPIRED",
          "The pairing challenge expired. Open a new pairing window on the device.",
        );
      case "attempts_exceeded":
        return apiError(
          requestId,
          429,
          "RATE_LIMITED",
          "Too many pairing attempts. Open a new pairing window on the device.",
        );
      case "already_paired":
        return apiError(
          requestId,
          409,
          "ACCESS_DENIED",
          "This installation already has access to the device.",
        );
      default:
        return apiError(
          requestId,
          422,
          "PAIRING_INVALID",
          "The pairing challenge is invalid or was already used.",
        );
    }
  } catch {
    return apiError(
      requestId,
      503,
      "SERVICE_UNAVAILABLE",
      "The pairing service is temporarily unavailable.",
      true,
    );
  }
}

async function updateDeviceLabels(
  request: Request,
  installation: string,
  deviceId: string,
) {
  const parsed = await readJson(request, crypto.randomUUID());
  if (parsed.response) return parsed.response;
  const body = record(parsed.value);
  const requestId = requestIdFrom(body);
  if (
    !body ||
    !onlyKeys(body, [
      "protocol_major",
      "request_id",
      "expected_revision",
      "alias",
      "location",
    ]) ||
    !Object.prototype.hasOwnProperty.call(body, "alias") ||
    !Object.prototype.hasOwnProperty.call(body, "location")
  ) {
    return apiError(
      requestId,
      400,
      "INVALID_INPUT",
      "Provide the device label and location to save.",
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
  // A missing revision is a legacy write: reject it rather than overwrite shared data.
  const expectedRevision = body.expected_revision;
  if (
    typeof expectedRevision !== "number" ||
    !Number.isSafeInteger(expectedRevision) ||
    expectedRevision < 1
  ) {
    return apiError(
      requestId,
      422,
      "VALIDATION_FAILED",
      "The device label was loaded without a revision. Refresh and try again.",
    );
  }
  const label = (value: unknown, maximum: number) =>
    value === null
      ? null
      : typeof value === "string" && characterLength(value.trim()) <= maximum
        ? value.trim()
        : undefined;
  const alias = label(body.alias, 100);
  const location = label(body.location, 160);
  if (alias === undefined || location === undefined) {
    return apiError(
      requestId,
      422,
      "VALIDATION_FAILED",
      "The device label or location is too long.",
    );
  }
  try {
    if (!(await takeRateLimit("device_write", installation))) {
      return apiError(
        requestId,
        429,
        "RATE_LIMITED",
        "Device changes are temporarily limited.",
        true,
      );
    }
    const { data, error } = await admin.rpc("art102_update_device_metadata", {
      p_device_id: deviceId,
      p_installation_id: installation,
      p_alias: alias,
      p_location: location,
      p_expected_revision: expectedRevision,
    });
    if (error)
      return apiError(
        requestId,
        503,
        "SERVICE_UNAVAILABLE",
        "The device service is temporarily unavailable.",
        true,
      );
    const result = record(data);
    if (result?.status === "not_active") {
      return apiError(
        requestId,
        403,
        "ACCESS_REVOKED",
        "This installation no longer has access to the device.",
      );
    }
    if (result?.status === "invalid") {
      return apiError(
        requestId,
        422,
        "VALIDATION_FAILED",
        "The device label or location is invalid.",
      );
    }
    if (result?.status === "conflict") {
      return apiError(
        requestId,
        409,
        "METADATA_CONFLICT",
        "Another phone changed the name or location. Review it and save again.",
      );
    }
    const metadata = normalizedMetadata(result, deviceId);
    if (result?.status !== "updated" || !metadata) {
      return apiError(
        requestId,
        503,
        "SERVICE_UNAVAILABLE",
        "The updated device label could not be verified.",
        true,
      );
    }
    return json({ request_id: requestId, metadata });
  } catch {
    return apiError(
      requestId,
      503,
      "SERVICE_UNAVAILABLE",
      "The device service is temporarily unavailable.",
      true,
    );
  }
}

async function revokeDeviceAccess(
  request: Request,
  installation: string,
  deviceId: string,
) {
  const rawRequestId = request.headers.get("x-request-id") ?? "";
  if (request.headers.get("x-protocol-major") !== "2") {
    return apiError(
      isUuid(rawRequestId) ? rawRequestId.toLowerCase() : crypto.randomUUID(),
      422,
      "PROTOCOL_UNSUPPORTED",
      "Protocol major 2 is required.",
    );
  }
  if (!isUuid(rawRequestId)) {
    return apiError(
      crypto.randomUUID(),
      400,
      "INVALID_INPUT",
      "A valid request identifier is required.",
    );
  }
  const requestId = rawRequestId.toLowerCase();
  try {
    if (!(await takeRateLimit("device_write", installation))) {
      return apiError(
        requestId,
        429,
        "RATE_LIMITED",
        "Device changes are temporarily limited.",
        true,
      );
    }
    const { data, error } = await admin.rpc("art38_revoke_device_access", {
      p_device_id: deviceId,
      p_installation_id: installation,
    });
    if (error)
      return apiError(
        requestId,
        503,
        "SERVICE_UNAVAILABLE",
        "The device service is temporarily unavailable.",
        true,
      );
    const result = record(data);
    if (result?.status === "not_active") {
      return apiError(
        requestId,
        403,
        "ACCESS_REVOKED",
        "This installation no longer has access to the device.",
      );
    }
    const revokedAt = normalizeUtcTimestamp(result?.revoked_at);
    if (result?.status !== "revoked" || revokedAt === null) {
      return apiError(
        requestId,
        503,
        "SERVICE_UNAVAILABLE",
        "The device access change could not be verified.",
        true,
      );
    }
    return json({
      request_id: requestId,
      device_id: deviceId.toLowerCase(),
      revoked_at: revokedAt,
    });
  } catch {
    return apiError(
      requestId,
      503,
      "SERVICE_UNAVAILABLE",
      "The device service is temporarily unavailable.",
      true,
    );
  }
}

Deno.serve(async (request: Request) => {
  const fallbackRequestId = crypto.randomUUID();
  try {
    const installation = await installationId(request);
    if (!installation) {
      return apiError(
        fallbackRequestId,
        401,
        "AUTH_REQUIRED",
        "A verified anonymous installation session is required.",
      );
    }
    const path = routePath(request);
    if (path?.match(PUSH_TOKEN_PATH)) {
      if (request.method === "POST") return await registerPushToken(request, installation);
      if (request.method === "DELETE") return await revokePushToken(request, installation);
      return badMethod(requestHeaderId(request) ?? fallbackRequestId);
    }
    const notificationsBulkMatch = path?.match(NOTIFICATIONS_BULK_PATH);
    if (notificationsBulkMatch && isUuid(notificationsBulkMatch[1])) {
      return request.method === "POST"
        ? await bulkUpdateNotificationState(
            request,
            installation,
            notificationsBulkMatch[1].toLowerCase(),
          )
        : badMethod(requestHeaderId(request) ?? fallbackRequestId);
    }
    const notificationEventMatch = path?.match(NOTIFICATION_EVENT_PATH);
    if (
      notificationEventMatch &&
      isUuid(notificationEventMatch[1]) &&
      isUuid(notificationEventMatch[2])
    ) {
      if (request.method === "GET")
        return await readNotificationEvent(
          request,
          installation,
          notificationEventMatch[1].toLowerCase(),
          notificationEventMatch[2].toLowerCase(),
        );
      return request.method === "PATCH"
        ? await updateNotificationState(
            request,
            installation,
            notificationEventMatch[1].toLowerCase(),
            notificationEventMatch[2].toLowerCase(),
          )
        : badMethod(requestHeaderId(request) ?? fallbackRequestId);
    }
    const notificationsMatch = path?.match(NOTIFICATIONS_PATH);
    if (notificationsMatch && isUuid(notificationsMatch[1])) {
      return request.method === "GET"
        ? await readNotifications(
            request,
            installation,
            notificationsMatch[1].toLowerCase(),
          )
        : badMethod(requestHeaderId(request) ?? fallbackRequestId);
    }
    const configurationMatch = path?.match(CONFIGURATION_PATH);
    if (configurationMatch && isUuid(configurationMatch[1])) {
      const deviceId = configurationMatch[1].toLowerCase();
      if (request.method === "GET")
        return await readConfiguration(request, installation, deviceId);
      if (request.method === "PUT")
        return await writeConfiguration(request, installation, deviceId);
      return badMethod(requestHeaderId(request) ?? fallbackRequestId);
    }
    const doGraphMatch = path?.match(DO_GRAPH_PATH);
    if (doGraphMatch && isUuid(doGraphMatch[1])) {
      return request.method === "GET"
        ? await readDoGraph(request, installation, doGraphMatch[1].toLowerCase())
        : badMethod(requestHeaderId(request) ?? fallbackRequestId);
    }
    const monitoringMatch = path?.match(MONITORING_PATH);
    if (monitoringMatch && isUuid(monitoringMatch[1])) {
      return request.method === "GET"
        ? await readMonitoringSnapshot(request, installation, monitoringMatch[1].toLowerCase())
        : badMethod(requestHeaderId(request) ?? fallbackRequestId);
    }
    const nextOccurrenceMatch = path?.match(NEXT_OCCURRENCE_PATH);
    if (nextOccurrenceMatch && isUuid(nextOccurrenceMatch[1])) {
      return request.method === "GET"
        ? await readNextOccurrence(
            request,
            installation,
            nextOccurrenceMatch[1].toLowerCase(),
          )
        : badMethod(requestHeaderId(request) ?? fallbackRequestId);
    }
    const feedMatch = path?.match(MANUAL_FEED_PATH);
    if (feedMatch && isUuid(feedMatch[1])) {
      return request.method === "POST"
        ? await createManualFeed(
            request,
            installation,
            feedMatch[1].toLowerCase(),
          )
        : badMethod(fallbackRequestId);
    }
    const noAdmissionMatch = path?.match(MANUAL_NO_ADMISSION_PATH);
    if (noAdmissionMatch && isUuid(noAdmissionMatch[1])) {
      return request.method === "POST"
        ? await resolveManualNoAdmission(
            request,
            installation,
            noAdmissionMatch[1].toLowerCase(),
          )
        : badMethod(fallbackRequestId);
    }
    const byKeyMatch = path?.match(COMMAND_BY_KEY_PATH);
    if (byKeyMatch && isUuid(byKeyMatch[1])) {
      const requestId = requestHeaderId(request);
      if (!validProtocolHeader(request))
        return apiError(
          requestId ?? fallbackRequestId,
          422,
          "PROTOCOL_UNSUPPORTED",
          "Protocol major 2 is required.",
        );
      if (!requestId)
        return apiError(
          fallbackRequestId,
          400,
          "INVALID_INPUT",
          "A valid X-Request-Id header is required.",
        );
      if (request.method !== "GET") return badMethod(requestId);
      const key = new URL(request.url).searchParams.get("key");
      if (!isUuid(key))
        return apiError(
          requestId,
          400,
          "INVALID_INPUT",
          "The original feed key is required.",
        );
      return await readManualCommand(
        installation,
        byKeyMatch[1].toLowerCase(),
        key.toLowerCase(),
        true,
        requestId,
      );
    }
    const commandMatch = path?.match(COMMAND_STATUS_PATH);
    if (commandMatch && isUuid(commandMatch[1]) && isUuid(commandMatch[2])) {
      const requestId = requestHeaderId(request);
      if (!validProtocolHeader(request))
        return apiError(
          requestId ?? fallbackRequestId,
          422,
          "PROTOCOL_UNSUPPORTED",
          "Protocol major 2 is required.",
        );
      if (!requestId)
        return apiError(
          fallbackRequestId,
          400,
          "INVALID_INPUT",
          "A valid X-Request-Id header is required.",
        );
      if (request.method !== "GET") return badMethod(requestId);
      return await readManualCommand(
        installation,
        commandMatch[1].toLowerCase(),
        commandMatch[2].toLowerCase(),
        false,
        requestId,
      );
    }
    const historyMatch = path?.match(HISTORY_PATH);
    if (historyMatch && isUuid(historyMatch[1])) {
      const requestId = requestHeaderId(request);
      if (!validProtocolHeader(request))
        return apiError(
          requestId ?? fallbackRequestId,
          422,
          "PROTOCOL_UNSUPPORTED",
          "Protocol major 2 is required.",
        );
      if (!requestId)
        return apiError(
          fallbackRequestId,
          400,
          "INVALID_INPUT",
          "A valid X-Request-Id header is required.",
        );
      if (request.method !== "GET") return badMethod(requestId);
      return await readFeedHistory(
        request,
        installation,
        historyMatch[1].toLowerCase(),
        requestId,
      );
    }
    const historyDetailMatch = path?.match(HISTORY_DETAIL_PATH);
    if (
      historyDetailMatch &&
      isUuid(historyDetailMatch[1]) &&
      isUuid(historyDetailMatch[2])
    ) {
      const requestId = requestHeaderId(request);
      if (!validProtocolHeader(request))
        return apiError(
          requestId ?? fallbackRequestId,
          422,
          "PROTOCOL_UNSUPPORTED",
          "Protocol major 2 is required.",
        );
      if (!requestId)
        return apiError(
          fallbackRequestId,
          400,
          "INVALID_INPUT",
          "A valid X-Request-Id header is required.",
        );
      if (request.method !== "GET") return badMethod(requestId);
      return await readHistoryDetail(
        installation,
        historyDetailMatch[1].toLowerCase(),
        historyDetailMatch[2].toLowerCase(),
        requestId,
      );
    }
    if (path === "/pair") {
      return request.method === "POST"
        ? await pairInstallation(request, installation)
        : badMethod(fallbackRequestId);
    }
    const match = path?.match(UUID_IN_PATH);
    if (match && isUuid(match[1])) {
      const deviceId = match[1].toLowerCase();
      if (match[2] === "alias") {
        return request.method === "PATCH"
          ? await updateDeviceLabels(request, installation, deviceId)
          : badMethod(fallbackRequestId);
      }
      return request.method === "DELETE"
        ? await revokeDeviceAccess(request, installation, deviceId)
        : badMethod(fallbackRequestId);
    }
    return apiError(
      fallbackRequestId,
      404,
      "RESOURCE_NOT_FOUND",
      "The requested device route was not found.",
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
