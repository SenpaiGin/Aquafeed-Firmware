import * as SecureStore from "expo-secure-store";

import { enqueueSelectionWrite } from "./device-access-state";
import { requestAppApi, type DeviceCapabilities } from "./device-access";

export type ScheduleDose =
  | { mode: "grams"; amount_g: number }
  | { mode: "fixed_portion"; fixed_portion_id: string };

export type ScheduleTarget = { nozzle_number: 1 | 2; dose: ScheduleDose };

export type Schedule = {
  schedule_id: string;
  local_time: string;
  weekdays: number[];
  enabled: boolean;
  /** One nozzle, or Both as nozzle 1 then nozzle 2. */
  targets: ScheduleTarget[];
};

export type ConfigurationValues = {
  timezone: string;
  monitoring_limits: {
    do_low_mg_l: number | null;
    do_high_mg_l: number | null;
  };
  low_feed_threshold_pct: number | null;
  schedules: Schedule[];
};

export type ConfigurationSnapshot = ConfigurationValues & {
  revision: number;
  based_on_revision: number;
};

export type ConfigurationRead = {
  request_id: string;
  receipt: {
    revision: number;
    based_on_revision: number;
    snapshot: ConfigurationValues;
  } | null;
  request_status: "pending" | "applied" | "rejected" | null;
  request_error_code: string | null;
  current_state: {
    desired_revision: number | null;
    applied_revision: number | null;
    last_attempt_revision: number | null;
    last_attempt_status: "pending" | "applied" | "rejected" | null;
    error_code: string | null;
  };
  desired_snapshot: ConfigurationSnapshot | null;
  applied_snapshot: ConfigurationSnapshot | null;
};

export type NextOccurrence = {
  occurrence_local_date: string;
  local_time: string;
  timezone: string;
  at: string;
  targets: { schedule_id: string; nozzle_number: 1 | 2; dose: ScheduleDose }[];
};

type PendingWrite = {
  request_id: string;
  based_on_revision: number;
  snapshot: ConfigurationValues;
};

const uuidPattern =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const localTimePattern = /^([01]\d|2[0-3]):[0-5]\d$/;
const localDatePattern = /^\d{4}-\d{2}-\d{2}$/;
const utcSecondPattern = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}Z$/;
const writes = new Map<string, Promise<void>>();

export function isValidTimezone(value: string) {
  try {
    new Intl.DateTimeFormat("en", { timeZone: value });
    return true;
  } catch {
    return false;
  }
}

// Feeder time zones offered in Settings, version 1. Every ID was checked against the
// server's pg_timezone_names and the simulator's zoneinfo; add a zone only after both.
// Philippines stays first.
export const timezoneCatalog: readonly { zone: string; label: string }[] = [
  { zone: "Asia/Manila", label: "Philippines" },
  { zone: "UTC", label: "Coordinated Universal Time" },
  { zone: "Asia/Singapore", label: "Singapore" },
  { zone: "Asia/Kuala_Lumpur", label: "Malaysia" },
  { zone: "Asia/Jakarta", label: "Indonesia — Jakarta" },
  { zone: "Asia/Bangkok", label: "Thailand" },
  { zone: "Asia/Ho_Chi_Minh", label: "Vietnam" },
  { zone: "Asia/Hong_Kong", label: "Hong Kong" },
  { zone: "Asia/Shanghai", label: "China" },
  { zone: "Asia/Taipei", label: "Taiwan" },
  { zone: "Asia/Tokyo", label: "Japan" },
  { zone: "Asia/Seoul", label: "South Korea" },
  { zone: "Pacific/Guam", label: "Guam" },
  { zone: "Asia/Kolkata", label: "India" },
  { zone: "Asia/Kathmandu", label: "Nepal" },
  { zone: "Asia/Dhaka", label: "Bangladesh" },
  { zone: "Asia/Karachi", label: "Pakistan" },
  { zone: "Asia/Dubai", label: "United Arab Emirates" },
  { zone: "Asia/Tehran", label: "Iran" },
  { zone: "Asia/Riyadh", label: "Saudi Arabia" },
  { zone: "Australia/Perth", label: "Australia — Perth" },
  { zone: "Australia/Darwin", label: "Australia — Darwin" },
  { zone: "Australia/Adelaide", label: "Australia — Adelaide" },
  { zone: "Australia/Brisbane", label: "Australia — Brisbane" },
  { zone: "Australia/Sydney", label: "Australia — Sydney" },
  { zone: "Pacific/Auckland", label: "New Zealand" },
  { zone: "Pacific/Honolulu", label: "United States — Hawaii" },
  { zone: "America/Anchorage", label: "United States — Alaska" },
  { zone: "America/Los_Angeles", label: "United States — Pacific" },
  { zone: "America/Denver", label: "United States — Mountain" },
  { zone: "America/Phoenix", label: "United States — Arizona" },
  { zone: "America/Chicago", label: "United States — Central" },
  { zone: "America/New_York", label: "United States — Eastern" },
  { zone: "America/Halifax", label: "Canada — Atlantic" },
  { zone: "America/St_Johns", label: "Canada — Newfoundland" },
  { zone: "America/Mexico_City", label: "Mexico" },
  { zone: "America/Bogota", label: "Colombia" },
  { zone: "America/Lima", label: "Peru" },
  { zone: "America/Sao_Paulo", label: "Brazil — São Paulo" },
  { zone: "Europe/London", label: "United Kingdom" },
  { zone: "Europe/Lisbon", label: "Portugal" },
  { zone: "Europe/Paris", label: "France" },
  { zone: "Europe/Berlin", label: "Germany" },
  { zone: "Europe/Madrid", label: "Spain" },
  { zone: "Europe/Rome", label: "Italy" },
  { zone: "Europe/Amsterdam", label: "Netherlands" },
  { zone: "Europe/Athens", label: "Greece" },
  { zone: "Europe/Istanbul", label: "Turkey" },
  { zone: "Europe/Moscow", label: "Russia — Moscow" },
  { zone: "Africa/Cairo", label: "Egypt" },
  { zone: "Africa/Lagos", label: "Nigeria" },
  { zone: "Africa/Nairobi", label: "Kenya" },
  { zone: "Africa/Johannesburg", label: "South Africa" },
];

/** Catalog zones this phone can display, matching the label, city or IANA ID; Philippines first. */
export function searchTimezones(query: string) {
  const words = query.trim().toLowerCase().split(/\s+/).filter(Boolean);
  return timezoneCatalog.filter(({ zone, label }) => {
    const text = (
      label +
      " " +
      zone +
      " " +
      zone.replace(/_/g, " ")
    ).toLowerCase();
    return isValidTimezone(zone) && words.every((word) => text.includes(word));
  });
}

async function serializeDeviceWrite<T>(
  key: string,
  operation: () => Promise<T>,
) {
  const task = enqueueSelectionWrite(
    writes.get(key) ?? Promise.resolve(),
    operation,
  );
  writes.set(key, task.next);
  try {
    return await task.result;
  } finally {
    if (writes.get(key) === task.next) writes.delete(key);
  }
}

function object(value: unknown): Record<string, unknown> | null {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}

function onlyKeys(value: Record<string, unknown>, allowed: string[]) {
  return Object.keys(value).every((key) => allowed.includes(key));
}

function uuid() {
  const random = globalThis.crypto?.randomUUID?.();
  if (random) return random.toLowerCase();
  const cryptoApi = globalThis.crypto;
  if (!cryptoApi?.getRandomValues)
    throw new Error("Secure request identifiers are unavailable.");
  const bytes = cryptoApi.getRandomValues(new Uint8Array(16));
  bytes[6] = (bytes[6] & 0x0f) | 0x40;
  bytes[8] = (bytes[8] & 0x3f) | 0x80;
  const hex = [...bytes]
    .map((byte) => byte.toString(16).padStart(2, "0"))
    .join("");
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
}

function requestHeaders(requestId: string) {
  return { "X-Protocol-Major": "2", "X-Request-Id": requestId };
}

function stateKey(installationId: string, deviceId: string) {
  return `device-schedule.pending.${installationId}.${deviceId.toLowerCase()}`;
}

function parseDose(value: unknown): ScheduleDose | null {
  const dose = object(value);
  if (!dose) return null;
  if (
    dose.mode === "grams" &&
    onlyKeys(dose, ["mode", "amount_g"]) &&
    typeof dose.amount_g === "number" &&
    Number.isFinite(dose.amount_g) &&
    dose.amount_g > 0
  ) {
    return { mode: "grams", amount_g: dose.amount_g };
  }
  if (
    dose.mode === "fixed_portion" &&
    onlyKeys(dose, ["mode", "fixed_portion_id"]) &&
    typeof dose.fixed_portion_id === "string" &&
    /^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/.test(dose.fixed_portion_id)
  ) {
    return { mode: "fixed_portion", fixed_portion_id: dose.fixed_portion_id };
  }
  return null;
}

function parseTargets(value: unknown): ScheduleTarget[] | null {
  if (!Array.isArray(value) || value.length < 1 || value.length > 2)
    return null;
  const targets = value.map((item, index) => {
    const target = object(item);
    const dose = parseDose(target?.dose);
    return target &&
      onlyKeys(target, ["nozzle_number", "dose"]) &&
      dose &&
      (value.length === 2
        ? target.nozzle_number === index + 1
        : target.nozzle_number === 1 || target.nozzle_number === 2)
      ? { nozzle_number: target.nozzle_number as 1 | 2, dose }
      : null;
  });
  return targets.every((target) => target !== null)
    ? (targets as ScheduleTarget[])
    : null;
}

// A pending write saved before contract 2.5.0 holds one scalar nozzle and dose.
function legacyTargets(schedule: Record<string, unknown>) {
  return parseTargets([
    { nozzle_number: schedule.nozzle_number, dose: schedule.dose },
  ]);
}

function parseSchedule(value: unknown, legacy = false): Schedule | null {
  const schedule = object(value);
  const isLegacy = legacy && !!schedule && !("targets" in schedule);
  const targets = !schedule
    ? null
    : isLegacy
      ? legacyTargets(schedule)
      : parseTargets(schedule.targets);
  if (
    !schedule ||
    !onlyKeys(
      schedule,
      isLegacy
        ? [
            "schedule_id",
            "local_time",
            "weekdays",
            "enabled",
            "dose",
            "nozzle_number",
          ]
        : ["schedule_id", "local_time", "weekdays", "enabled", "targets"],
    ) ||
    typeof schedule.schedule_id !== "string" ||
    !uuidPattern.test(schedule.schedule_id) ||
    typeof schedule.local_time !== "string" ||
    !localTimePattern.test(schedule.local_time) ||
    !Array.isArray(schedule.weekdays) ||
    schedule.weekdays.length < 1 ||
    schedule.weekdays.length > 7 ||
    !schedule.weekdays.every(
      (day) =>
        Number.isSafeInteger(day) && Number(day) >= 1 && Number(day) <= 7,
    ) ||
    new Set(schedule.weekdays).size !== schedule.weekdays.length ||
    typeof schedule.enabled !== "boolean" ||
    !targets
  )
    return null;
  return {
    schedule_id: schedule.schedule_id.toLowerCase(),
    local_time: schedule.local_time,
    weekdays: [...schedule.weekdays] as number[],
    enabled: schedule.enabled,
    targets,
  };
}

function parseValues(
  value: unknown,
  legacy = false,
): ConfigurationValues | null {
  const source = object(value);
  const limits = object(source?.monitoring_limits);
  if (
    !source ||
    !onlyKeys(source, [
      "timezone",
      "monitoring_limits",
      "low_feed_threshold_pct",
      "schedules",
    ]) ||
    typeof source.timezone !== "string" ||
    source.timezone.length < 1 ||
    source.timezone.length > 100 ||
    !limits ||
    !onlyKeys(limits, ["do_low_mg_l", "do_high_mg_l"]) ||
    ![limits.do_low_mg_l, limits.do_high_mg_l].every(
      (item) =>
        item === null ||
        (typeof item === "number" && Number.isFinite(item) && item >= 0),
    ) ||
    !(
      source.low_feed_threshold_pct === null ||
      (typeof source.low_feed_threshold_pct === "number" &&
        Number.isFinite(source.low_feed_threshold_pct) &&
        source.low_feed_threshold_pct >= 0 &&
        source.low_feed_threshold_pct <= 100)
    ) ||
    !Array.isArray(source.schedules)
  )
    return null;
  if (!isValidTimezone(source.timezone)) return null;
  const schedules = source.schedules.map((item) => parseSchedule(item, legacy));
  if (schedules.some((schedule) => schedule === null) || schedules.length > 100)
    return null;
  return {
    timezone: source.timezone,
    monitoring_limits: {
      do_low_mg_l: limits.do_low_mg_l as number | null,
      do_high_mg_l: limits.do_high_mg_l as number | null,
    },
    low_feed_threshold_pct: source.low_feed_threshold_pct as number | null,
    schedules: schedules as Schedule[],
  };
}

function parseSnapshot(value: unknown): ConfigurationSnapshot | null {
  const snapshot = object(value);
  if (
    !snapshot ||
    !onlyKeys(snapshot, [
      "revision",
      "based_on_revision",
      "timezone",
      "monitoring_limits",
      "low_feed_threshold_pct",
      "schedules",
    ])
  )
    return null;
  const values = parseValues(
    snapshot && {
      timezone: snapshot.timezone,
      monitoring_limits: snapshot.monitoring_limits,
      low_feed_threshold_pct: snapshot.low_feed_threshold_pct,
      schedules: snapshot.schedules,
    },
  );
  if (
    !snapshot ||
    !values ||
    !Number.isSafeInteger(snapshot.revision) ||
    Number(snapshot.revision) < 1 ||
    !Number.isSafeInteger(snapshot.based_on_revision) ||
    Number(snapshot.based_on_revision) < 0
  )
    return null;
  return {
    ...values,
    revision: Number(snapshot.revision),
    based_on_revision: Number(snapshot.based_on_revision),
  };
}

function parseConfigurationRead(value: unknown): ConfigurationRead | null {
  const response = object(value);
  const current = object(response?.current_state);
  const parseOptionalSnapshot = (item: unknown) =>
    item === null ? null : parseSnapshot(item);
  const parseReceipt = (item: unknown) => {
    if (item === null) return null;
    const receipt = object(item);
    if (
      !receipt ||
      !onlyKeys(receipt, ["revision", "based_on_revision", "snapshot"])
    )
      return undefined;
    const snapshot = parseValues(receipt?.snapshot);
    return receipt &&
      snapshot &&
      Number.isSafeInteger(receipt.revision) &&
      Number(receipt.revision) > 0 &&
      Number.isSafeInteger(receipt.based_on_revision) &&
      Number(receipt.based_on_revision) >= 0
      ? {
          revision: Number(receipt.revision),
          based_on_revision: Number(receipt.based_on_revision),
          snapshot,
        }
      : undefined;
  };
  const receipt = parseReceipt(response?.receipt);
  if (
    !response ||
    !onlyKeys(response, [
      "request_id",
      "receipt",
      "request_status",
      "request_error_code",
      "current_state",
      "desired_snapshot",
      "applied_snapshot",
    ]) ||
    !current ||
    !onlyKeys(current, [
      "desired_revision",
      "applied_revision",
      "last_attempt_revision",
      "last_attempt_status",
      "error_code",
    ]) ||
    !uuidPattern.test(String(response.request_id)) ||
    !(
      response.request_status === null ||
      ["pending", "applied", "rejected"].includes(
        String(response.request_status),
      )
    ) ||
    !(
      response.request_error_code === null ||
      typeof response.request_error_code === "string"
    ) ||
    !(
      current.desired_revision === null ||
      (Number.isSafeInteger(current.desired_revision) &&
        Number(current.desired_revision) > 0)
    ) ||
    !(
      current.applied_revision === null ||
      (Number.isSafeInteger(current.applied_revision) &&
        Number(current.applied_revision) >= 0)
    ) ||
    !(
      current.last_attempt_revision === null ||
      (Number.isSafeInteger(current.last_attempt_revision) &&
        Number(current.last_attempt_revision) > 0)
    ) ||
    !(
      current.last_attempt_status === null ||
      ["pending", "applied", "rejected"].includes(
        String(current.last_attempt_status),
      )
    ) ||
    !(current.error_code === null || typeof current.error_code === "string") ||
    (response.receipt !== null && receipt === undefined)
  )
    return null;
  const desired = parseOptionalSnapshot(response.desired_snapshot);
  const applied = parseOptionalSnapshot(response.applied_snapshot);
  if (
    (response.desired_snapshot !== null && !desired) ||
    (response.applied_snapshot !== null && !applied)
  )
    return null;
  return {
    request_id: String(response.request_id).toLowerCase(),
    receipt: receipt ?? null,
    request_status:
      response.request_status as ConfigurationRead["request_status"],
    request_error_code: response.request_error_code as string | null,
    current_state: current as ConfigurationRead["current_state"],
    desired_snapshot: desired,
    applied_snapshot: applied,
  };
}

export function validateSchedule(
  schedule: Schedule,
  otherSchedules: Schedule[],
  capabilities: DeviceCapabilities,
) {
  if (
    !capabilities.localScheduleExecution ||
    capabilities.maxSchedules === null ||
    capabilities.maxSchedules < 1 ||
    capabilities.maxClockUncertaintyMs === null ||
    capabilities.maximumSettlingMs === null ||
    capabilities.schedulerWakeGraceMs === null
  )
    return "This feeder has no approved local scheduling profile.";
  const numbers = schedule.targets.map((target) => target.nozzle_number);
  if (numbers.length === 2 && !capabilities.scheduledBoth)
    return "This feeder cannot run both nozzles from one schedule.";
  if (
    !localTimePattern.test(schedule.local_time) ||
    schedule.weekdays.length < 1 ||
    schedule.weekdays.some(
      (day) => !Number.isInteger(day) || day < 1 || day > 7,
    ) ||
    new Set(schedule.weekdays).size !== schedule.weekdays.length
  )
    return "Choose a valid time and at least one repeat day.";
  for (const { nozzle_number: nozzle, dose } of schedule.targets) {
    const capability = capabilities.nozzles[String(nozzle) as "1" | "2"];
    if (!capability.enabled) return `Nozzle ${nozzle} is unavailable.`;
    if (dose.mode === "grams") {
      if (!capability.doseModes.includes("grams"))
        return `Nozzle ${nozzle} does not support gram doses.`;
      const { minDoseG, maxDoseG, doseStepG } = capability;
      const amount = dose.amount_g;
      if (
        minDoseG === null ||
        maxDoseG === null ||
        doseStepG === null ||
        doseStepG <= 0 ||
        !Number.isFinite(amount) ||
        amount < minDoseG ||
        amount > maxDoseG ||
        Math.abs(
          (amount - minDoseG) / doseStepG -
            Math.round((amount - minDoseG) / doseStepG),
        ) > 1e-8
      ) {
        return `Nozzle ${nozzle}: use ${minDoseG ?? "?"} to ${maxDoseG ?? "?"} g in ${doseStepG ?? "?"} g steps.`;
      }
    } else if (
      !capability.doseModes.includes("fixed_portion") ||
      !capability.fixedPortionIds.includes(dose.fixed_portion_id)
    ) {
      return `Nozzle ${nozzle} does not support this fixed portion.`;
    }
  }
  // A nozzle cannot be due twice at once, including Both against a single schedule.
  const conflict = otherSchedules.find(
    (other) =>
      other.schedule_id !== schedule.schedule_id &&
      other.local_time === schedule.local_time &&
      other.weekdays.some((day) => schedule.weekdays.includes(day)) &&
      other.targets.some((target) => numbers.includes(target.nozzle_number)),
  );
  if (!conflict) return null;
  const shared = numbers.find((number) =>
    conflict.targets.some((target) => target.nozzle_number === number),
  );
  return `Nozzle ${shared} already has a schedule at this time on an overlapping day.`;
}

export async function readConfiguration(
  installationId: string,
  deviceId: string,
  requestId = uuid(),
  receiptRequestId?: string,
) {
  const query = receiptRequestId
    ? `?request_id=${encodeURIComponent(receiptRequestId)}`
    : "";
  const value = await requestAppApi(
    installationId,
    `/devices/${deviceId}/configuration${query}`,
    "GET",
    undefined,
    requestHeaders(requestId),
  );
  const parsed = parseConfigurationRead(value);
  if (!parsed) throw new Error("The feeder returned an invalid configuration.");
  return parsed;
}

export async function readNextOccurrence(
  installationId: string,
  deviceId: string,
) {
  const requestId = uuid();
  const value = await requestAppApi(
    installationId,
    `/devices/${deviceId}/next-occurrence`,
    "GET",
    undefined,
    requestHeaders(requestId),
  );
  const response = object(value);
  if (
    !response ||
    !onlyKeys(response, ["request_id", "timezone", "occurrence"]) ||
    response.request_id !== requestId ||
    !(response.timezone === null || typeof response.timezone === "string")
  ) {
    throw new Error("The feeder returned an invalid next feeding.");
  }
  if (response.timezone !== null && !isValidTimezone(response.timezone)) {
    throw new Error("The feeder returned an invalid next feeding.");
  }
  if (response.occurrence === null)
    return {
      timezone: response.timezone,
      occurrence: null as NextOccurrence | null,
    };
  const item = object(response.occurrence);
  if (
    item &&
    !onlyKeys(item, [
      "occurrence_local_date",
      "local_time",
      "timezone",
      "at",
      "targets",
    ])
  )
    throw new Error("The feeder returned an invalid next feeding.");
  const occurrenceDate = item?.occurrence_local_date;
  const occurrenceAt = item?.at;
  const localDateTimestamp =
    typeof occurrenceDate === "string"
      ? Date.parse(`${occurrenceDate}T00:00:00Z`)
      : Number.NaN;
  const localDate =
    typeof occurrenceDate === "string" &&
    localDatePattern.test(occurrenceDate) &&
    Number.isFinite(localDateTimestamp) &&
    new Date(localDateTimestamp).toISOString().slice(0, 10) === occurrenceDate;
  const utcAt =
    typeof occurrenceAt === "string" &&
    utcSecondPattern.test(occurrenceAt) &&
    Number.isFinite(Date.parse(occurrenceAt)) &&
    new Date(occurrenceAt).toISOString().replace(".000Z", "Z") === occurrenceAt;
  const targets = Array.isArray(item?.targets)
    ? item.targets.map((target) => {
        const entry = object(target);
        const dose = parseDose(entry?.dose);
        return entry &&
          onlyKeys(entry, ["schedule_id", "nozzle_number", "dose"]) &&
          dose &&
          typeof entry.schedule_id === "string" &&
          uuidPattern.test(entry.schedule_id) &&
          (entry.nozzle_number === 1 || entry.nozzle_number === 2)
          ? {
              schedule_id: entry.schedule_id.toLowerCase(),
              nozzle_number: entry.nozzle_number,
              dose,
            }
          : null;
      })
    : [];
  if (
    !item ||
    !localDate ||
    typeof item.local_time !== "string" ||
    !localTimePattern.test(item.local_time) ||
    typeof item.timezone !== "string" ||
    typeof item.at !== "string" ||
    !utcAt ||
    item.timezone !== response.timezone ||
    targets.length < 1 ||
    targets.length > 2 ||
    targets.some((target) => target === null) ||
    (targets.length === 2 &&
      (targets[0]?.nozzle_number !== 1 || targets[1]?.nozzle_number !== 2))
  ) {
    throw new Error("The feeder returned an invalid next feeding.");
  }
  return {
    timezone: response.timezone,
    occurrence: { ...item, targets } as NextOccurrence,
  };
}

export async function loadPendingWrite(
  installationId: string,
  deviceId: string,
): Promise<PendingWrite | null> {
  const raw = await SecureStore.getItemAsync(
    stateKey(installationId, deviceId),
  );
  if (raw === null) return null;
  let value: Record<string, unknown> | null;
  try {
    value = object(JSON.parse(raw));
  } catch {
    throw new Error(
      "The saved schedule request is unreadable. Resolve it before making another change.",
    );
  }
  const snapshot = parseValues(value?.snapshot, true);
  if (
    value &&
    uuidPattern.test(String(value.request_id)) &&
    Number.isSafeInteger(value.based_on_revision) &&
    Number(value.based_on_revision) >= 0 &&
    snapshot
  ) {
    return {
      request_id: String(value.request_id).toLowerCase(),
      based_on_revision: Number(value.based_on_revision),
      snapshot,
    };
  }
  throw new Error(
    "The saved schedule request is unreadable. Resolve it before making another change.",
  );
}

export function isConfirmedScheduleRejection(error: unknown) {
  const status = object(error)?.status;
  return (
    typeof status === "number" &&
    [400, 401, 403, 404, 409, 422, 429].includes(status)
  );
}

export async function saveConfiguration(
  installationId: string,
  deviceId: string,
  basedOnRevision: number,
  snapshot: ConfigurationValues,
  original?: PendingWrite,
) {
  const key = stateKey(installationId, deviceId);
  return serializeDeviceWrite(key, async () => {
    const saved = await loadPendingWrite(installationId, deviceId);
    if (original) {
      if (
        !saved ||
        saved.request_id !== original.request_id ||
        saved.based_on_revision !== original.based_on_revision
      ) {
        throw new Error(
          "The original schedule request changed. Check its status before retrying.",
        );
      }
    } else if (saved) {
      throw new Error(
        "Resolve the earlier schedule request before making another change.",
      );
    }
    const pending: PendingWrite = original ?? {
      request_id: uuid(),
      based_on_revision: basedOnRevision,
      snapshot,
    };
    if (!original) await SecureStore.setItemAsync(key, JSON.stringify(pending));
    let value: unknown;
    try {
      value = await requestAppApi(
        installationId,
        `/devices/${deviceId}/configuration`,
        "PUT",
        {
          protocol_major: 2,
          request_id: pending.request_id,
          based_on_revision: pending.based_on_revision,
          snapshot: pending.snapshot,
        },
      );
    } catch (error) {
      if (!original && isConfirmedScheduleRejection(error))
        await SecureStore.deleteItemAsync(key);
      throw error;
    }
    const response = object(value);
    const parsedResponse =
      response &&
      parseConfigurationRead({
        ...response,
        request_status: "pending",
        request_error_code: null,
        desired_snapshot: null,
        applied_snapshot: null,
      });
    const expectedSnapshot = parseValues(pending.snapshot);
    if (
      !parsedResponse ||
      parsedResponse.request_id !== pending.request_id ||
      !parsedResponse.receipt ||
      parsedResponse.receipt.based_on_revision !== pending.based_on_revision ||
      !expectedSnapshot ||
      JSON.stringify(parsedResponse.receipt.snapshot) !==
        JSON.stringify(expectedSnapshot)
    ) {
      throw new Error("The configuration save response could not be verified.");
    }
    await SecureStore.deleteItemAsync(key);
    return response;
  });
}

export async function checkPendingWrite(
  installationId: string,
  deviceId: string,
) {
  const key = stateKey(installationId, deviceId);
  return serializeDeviceWrite(key, async () => {
    const pending = await loadPendingWrite(installationId, deviceId);
    if (!pending) return { pending: null, state: null };
    const state = await readConfiguration(
      installationId,
      deviceId,
      uuid(),
      pending.request_id,
    );
    const conflict =
      state.request_status === null &&
      (state.current_state.desired_revision ?? 0) !== pending.based_on_revision;
    if (state.request_status !== null || conflict)
      await SecureStore.deleteItemAsync(key);
    return { pending: conflict ? null : pending, state, conflict };
  });
}

export async function retryPendingWrite(
  installationId: string,
  deviceId: string,
) {
  const pending = await loadPendingWrite(installationId, deviceId);
  if (!pending) throw new Error("There is no original schedule save to retry.");
  return saveConfiguration(
    installationId,
    deviceId,
    pending.based_on_revision,
    pending.snapshot,
    pending,
  );
}

export function newScheduleId() {
  return uuid();
}
