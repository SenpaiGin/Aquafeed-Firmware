import * as SecureStore from "expo-secure-store";

import { requestAppApi } from "./device-access";
import type { MonitoringSnapshot } from "./monitoring";

export type ManualTarget = {
  nozzle_number: 1 | 2;
  dose:
    | { mode: "grams"; amount_g: number }
    | { mode: "fixed_portion"; fixed_portion_id: string };
};

export type NozzleResult = {
  nozzle_number: 1 | 2;
  status: string;
  requested_dose: ManualTarget["dose"];
  estimated_dispensed_g: number | null;
  measured_dispensed_g: number | null;
  measurement_quality: "valid" | "unavailable" | "uncalibrated" | "error";
};

export type ManualCommand = {
  command_id: string;
  sequence_id: string;
  device_id: string;
  request_id: string;
  idempotency_key: string;
  status: string;
  status_sequence: number;
  created_at: string;
  start_before: string;
  targets: ManualTarget[];
  nozzle_results: NozzleResult[];
  safety_lockout: boolean;
  lockout_resolution: {
    resolution_at: string;
    resolution_reason: string;
    source: string;
  } | null;
};

export type HistoryRecord = Omit<
  ManualCommand,
  "command_id" | "request_id" | "idempotency_key"
> & {
  command_id: string | null;
  request_id: string | null;
  idempotency_key: string | null;
  source: "manual" | "scheduled";
  reason_code: string | null;
  started_at: string | null;
  completed_at: string | null;
};

export type HistoryPage = {
  request_id: string;
  from_date: string;
  to_date: string;
  timezone: string;
  timezone_known: boolean;
  totals: {
    total: number;
    completed: number;
    needs_attention: number;
    in_progress: number;
  };
  records: HistoryRecord[];
  next_cursor: string | null;
};

export type PendingManualFeed = {
  request_id: string;
  idempotency_key: string;
  device_id: string;
  capabilities_revision: number;
  targets: ManualTarget[];
};

type PendingRequest = PendingManualFeed;

function apiPath(deviceId: string) {
  return `/devices/${deviceId.toLowerCase()}`;
}

function uuid() {
  const cryptoApi = (
    globalThis as typeof globalThis & {
      crypto?: {
        randomUUID?: () => string;
        getRandomValues?: (value: Uint8Array) => Uint8Array;
      };
    }
  ).crypto;
  if (cryptoApi?.randomUUID) return cryptoApi.randomUUID();
  if (!cryptoApi?.getRandomValues)
    throw new Error(
      "Secure request identifiers are unavailable on this device.",
    );
  const bytes = cryptoApi.getRandomValues(new Uint8Array(16));
  bytes[6] = (bytes[6] & 0x0f) | 0x40;
  bytes[8] = (bytes[8] & 0x3f) | 0x80;
  const hex = [...bytes]
    .map((byte) => byte.toString(16).padStart(2, "0"))
    .join("");
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
}

function pendingKey(installationId: string, deviceId: string) {
  return `manual-feed.${installationId}.${deviceId.toLowerCase()}`;
}

const pendingMutations = new Map<string, Promise<void>>();

async function withPendingMutation<T>(
  installationId: string,
  deviceId: string,
  mutate: () => Promise<T>,
) {
  const key = pendingKey(installationId, deviceId);
  const previous = pendingMutations.get(key) ?? Promise.resolve();
  let release!: () => void;
  const current = new Promise<void>((resolve) => {
    release = resolve;
  });
  pendingMutations.set(key, current);
  await previous;
  try {
    return await mutate();
  } finally {
    release();
    if (pendingMutations.get(key) === current) pendingMutations.delete(key);
  }
}

function sameTargets(left: ManualTarget[], right: ManualTarget[]) {
  return JSON.stringify(left) === JSON.stringify(right);
}

export function manualInventoryIssue(
  snapshot: MonitoringSnapshot | null,
  targets: ManualTarget[],
) {
  const sample = snapshot?.latest_sample;
  if (
    !sample ||
    sample.feed_quality !== "valid" ||
    sample.feed_freshness !== "fresh" ||
    typeof sample.feed_remaining_g !== "number"
  )
    return "A fresh, valid measured feed-stock reading is required before feeding.";
  const hasFixedPortion = targets.some(
    (target) => target.dose.mode === "fixed_portion",
  );
  const requestedG = targets.reduce(
    (total, target) =>
      total + (target.dose.mode === "grams" ? target.dose.amount_g : 0),
    0,
  );
  if (requestedG > sample.feed_remaining_g)
    return "The selected doses exceed the feeder's measured remaining stock.";
  return hasFixedPortion && requestedG >= sample.feed_remaining_g
    ? "Measured stock must leave a positive remainder for a supported fixed portion."
    : null;
}

export function manualInventoryNotice(targets: ManualTarget[]) {
  return targets.some((target) => target.dose.mode === "fixed_portion")
    ? "A fixed portion has no gram equivalent. Fresh stock and the known gram subtotal are checked, but the portion's total mass cannot be verified."
    : null;
}

const uuidPattern = /^[0-9a-f]{8}-(?:[0-9a-f]{4}-){3}[0-9a-f]{12}$/i;
const commandStates = new Set([
  "queued",
  "accepted",
  "running",
  "completed",
  "partial",
  "failed",
  "rejected",
  "expired",
  "unknown",
]);
const stepStates = new Set([
  "queued",
  "accepted",
  "running",
  "completed",
  "failed",
  "rejected",
  "expired",
  "unknown",
  "not_started",
]);
const definitiveAdmissionRefusals = new Map([
  ["CAPABILITY_MISMATCH", new Set([409])],
  ["DEVICE_BUSY", new Set([409])],
  ["DEVICE_OFFLINE", new Set([409])],
  ["DOSE_OUT_OF_RANGE", new Set([422])],
  ["DOSE_UNSUPPORTED", new Set([422])],
  ["INSUFFICIENT_INVENTORY", new Set([409])],
  ["INVENTORY_UNAVAILABLE", new Set([409])],
  ["INVALID_INPUT", new Set([400])],
  ["PROTOCOL_UNSUPPORTED", new Set([422])],
  ["RATE_LIMITED", new Set([429])],
  ["SAFETY_LOCKOUT", new Set([409])],
  ["VALIDATION_FAILED", new Set([422])],
]);

function isDefinitiveAdmissionRefusal(value: unknown) {
  return (
    typeof value === "object" &&
    value !== null &&
    "code" in value &&
    typeof value.code === "string" &&
    "status" in value &&
    typeof value.status === "number" &&
    definitiveAdmissionRefusals.get(value.code)?.has(value.status) === true
  );
}
const measurementQualities = new Set([
  "valid",
  "unavailable",
  "uncalibrated",
  "error",
]);

function validDose(value: unknown): value is ManualTarget["dose"] {
  if (!value || typeof value !== "object") return false;
  const dose = value as Record<string, unknown>;
  return dose.mode === "grams"
    ? typeof dose.amount_g === "number" &&
        Number.isFinite(dose.amount_g) &&
        dose.amount_g > 0
    : dose.mode === "fixed_portion" &&
        typeof dose.fixed_portion_id === "string" &&
        dose.fixed_portion_id.length > 0;
}

function validTargets(value: unknown): value is ManualTarget[] {
  return (
    Array.isArray(value) &&
    value.length > 0 &&
    value.length <= 2 &&
    value.every(
      (target) =>
        target &&
        typeof target === "object" &&
        (target.nozzle_number === 1 || target.nozzle_number === 2) &&
        validDose(target.dose),
    ) &&
    (value.length === 1 ||
      (value[0].nozzle_number === 1 && value[1].nozzle_number === 2))
  );
}

function sameDose(left: ManualTarget["dose"], right: ManualTarget["dose"]) {
  return (
    left.mode === right.mode &&
    (left.mode === "grams"
      ? right.mode === "grams" && left.amount_g === right.amount_g
      : right.mode === "fixed_portion" &&
        left.fixed_portion_id === right.fixed_portion_id)
  );
}

function validResults(
  targets: ManualTarget[],
  value: unknown,
): value is NozzleResult[] {
  return (
    Array.isArray(value) &&
    value.length === targets.length &&
    value.every((result, index) => {
      if (!result || typeof result !== "object") return false;
      const row = result as NozzleResult;
      const measuredValid =
        row.measured_dispensed_g === null ||
        (typeof row.measured_dispensed_g === "number" &&
          Number.isFinite(row.measured_dispensed_g) &&
          row.measured_dispensed_g >= 0);
      const estimatedValid =
        row.estimated_dispensed_g === null ||
        (typeof row.estimated_dispensed_g === "number" &&
          Number.isFinite(row.estimated_dispensed_g) &&
          row.estimated_dispensed_g >= 0);
      return (
        row.nozzle_number === targets[index].nozzle_number &&
        stepStates.has(row.status) &&
        measurementQualities.has(row.measurement_quality) &&
        validDose(row.requested_dose) &&
        sameDose(row.requested_dose, targets[index].dose) &&
        measuredValid &&
        estimatedValid &&
        (row.measurement_quality === "valid") ===
          (row.measured_dispensed_g !== null) &&
        (row.status !== "unknown" || row.measured_dispensed_g === null)
      );
    })
  );
}

function validLockoutResolution(value: unknown) {
  return (
    value === null ||
    (typeof value === "object" &&
      value !== null &&
      typeof (value as ManualCommand["lockout_resolution"])?.resolution_at ===
        "string" &&
      typeof (value as ManualCommand["lockout_resolution"])
        ?.resolution_reason === "string" &&
      (value as ManualCommand["lockout_resolution"])?.source ===
        "device_maintenance")
  );
}

function validCommand(
  value: unknown,
  deviceId: string,
  identity?: {
    requestId?: string;
    idempotencyKey?: string;
    commandId?: string;
  },
): value is ManualCommand {
  if (!value || typeof value !== "object") return false;
  const command = value as Partial<ManualCommand>;
  if (
    typeof command.device_id !== "string" ||
    command.device_id.toLowerCase() !== deviceId.toLowerCase() ||
    !uuidPattern.test(command.command_id ?? "") ||
    command.command_id !== command.sequence_id ||
    !uuidPattern.test(command.request_id ?? "") ||
    !uuidPattern.test(command.idempotency_key ?? "") ||
    (identity?.requestId && command.request_id !== identity.requestId) ||
    (identity?.idempotencyKey &&
      command.idempotency_key !== identity.idempotencyKey) ||
    (identity?.commandId && command.command_id !== identity.commandId) ||
    !command.status ||
    !commandStates.has(command.status) ||
    !Number.isSafeInteger(command.status_sequence) ||
    typeof command.created_at !== "string" ||
    typeof command.start_before !== "string" ||
    !validTargets(command.targets) ||
    !validResults(command.targets, command.nozzle_results) ||
    typeof command.safety_lockout !== "boolean" ||
    !validLockoutResolution(command.lockout_resolution)
  )
    return false;
  const hasUnknown = command.nozzle_results.some(
    (result) => result.status === "unknown",
  );
  return hasUnknown
    ? command.safety_lockout === (command.lockout_resolution === null)
    : command.safety_lockout === false && command.lockout_resolution === null;
}

function validHistoryRecord(
  value: unknown,
  deviceId: string,
): value is HistoryRecord {
  if (!value || typeof value !== "object") return false;
  const record = value as Partial<HistoryRecord>;
  const nullableId = (id: unknown) =>
    id === null || (typeof id === "string" && uuidPattern.test(id));
  return (
    typeof record.device_id === "string" &&
    record.device_id.toLowerCase() === deviceId.toLowerCase() &&
    (record.source === "manual" || record.source === "scheduled") &&
    typeof record.sequence_id === "string" &&
    uuidPattern.test(record.sequence_id) &&
    nullableId(record.command_id) &&
    nullableId(record.request_id) &&
    nullableId(record.idempotency_key) &&
    commandStates.has(record.status ?? "") &&
    Number.isSafeInteger(record.status_sequence) &&
    (record.status_sequence ?? 0) > 0 &&
    typeof record.created_at === "string" &&
    (record.started_at === null || typeof record.started_at === "string") &&
    (record.completed_at === null || typeof record.completed_at === "string") &&
    (record.reason_code === null || typeof record.reason_code === "string") &&
    validTargets(record.targets) &&
    validResults(record.targets, record.nozzle_results) &&
    typeof record.safety_lockout === "boolean" &&
    validLockoutResolution(record.lockout_resolution)
  );
}

function commandFromResponse(
  value: unknown,
  deviceId: string,
  identity?: {
    requestId?: string;
    idempotencyKey?: string;
    commandId?: string;
  },
) {
  if (
    !value ||
    typeof value !== "object" ||
    !validCommand((value as { command?: unknown }).command, deviceId, identity)
  ) {
    throw new Error(
      "The feeder returned a status for a different or invalid command.",
    );
  }
  return (value as { command: ManualCommand }).command;
}

function headers(requestId: string) {
  return { "X-Protocol-Major": "2", "X-Request-Id": requestId };
}

async function readPending(
  installationId: string,
  deviceId: string,
): Promise<PendingRequest | null> {
  const raw = await SecureStore.getItemAsync(
    pendingKey(installationId, deviceId),
  );
  if (!raw) return null;
  const value: unknown = JSON.parse(raw);
  if (!value || typeof value !== "object")
    throw new Error("A saved feed request could not be read safely.");
  const request = value as PendingRequest;
  if (
    request.device_id !== deviceId.toLowerCase() ||
    !uuidPattern.test(request.request_id ?? "") ||
    !uuidPattern.test(request.idempotency_key ?? "") ||
    !validTargets(request.targets) ||
    !Number.isSafeInteger(request.capabilities_revision) ||
    request.capabilities_revision < 1
  ) {
    throw new Error("A saved feed request could not be read safely.");
  }
  return request;
}

async function savePending(installationId: string, request: PendingRequest) {
  await SecureStore.setItemAsync(
    pendingKey(installationId, request.device_id),
    JSON.stringify(request),
  );
}

async function readByKey(
  installationId: string,
  deviceId: string,
  key: string,
) {
  const requestId = uuid();
  let value: unknown;
  try {
    value = await requestAppApi(
      installationId,
      `${apiPath(deviceId)}/commands/by-key?key=${encodeURIComponent(key)}`,
      "GET",
      undefined,
      headers(requestId),
    );
  } catch (reason) {
    const apiError = reason as { code?: unknown; status?: unknown };
    if (
      typeof reason === "object" &&
      reason !== null &&
      apiError.code === "RESOURCE_NOT_FOUND" &&
      apiError.status === 404
    ) {
      throw new Error(
        "No status was found for this saved feed. Its result is still unknown; resolve it safely before starting another feed.",
      );
    }
    throw reason;
  }
  return commandFromResponse(value, deviceId, { idempotencyKey: key });
}

async function readById(
  installationId: string,
  deviceId: string,
  commandId: string,
) {
  const requestId = uuid();
  const value = await requestAppApi(
    installationId,
    `${apiPath(deviceId)}/commands/${commandId}`,
    "GET",
    undefined,
    headers(requestId),
  );
  return commandFromResponse(value, deviceId, { commandId });
}

async function releaseTerminalPending(
  installationId: string,
  command: ManualCommand,
  scopeIsCurrent: () => boolean = () => true,
) {
  const hasUnknown = command.nozzle_results.some(
    (result) => result.status === "unknown",
  );
  if (
    ["completed", "failed", "rejected", "expired"].includes(command.status) ||
    (hasUnknown &&
      !command.safety_lockout &&
      command.lockout_resolution !== null) ||
    (command.status === "partial" && !command.safety_lockout && !hasUnknown)
  ) {
    await withPendingMutation(installationId, command.device_id, async () => {
      if (!scopeIsCurrent()) return;
      const pending = await readPending(installationId, command.device_id);
      if (
        !scopeIsCurrent() ||
        !pending ||
        pending.idempotency_key !== command.idempotency_key
      )
        return;
      await SecureStore.deleteItemAsync(
        pendingKey(installationId, command.device_id),
      );
    });
  }
}

async function clearOwnedPending(
  installationId: string,
  pending: PendingRequest,
  scopeIsCurrent: () => boolean,
) {
  return withPendingMutation(installationId, pending.device_id, async () => {
    if (!scopeIsCurrent()) return false;
    const current = await readPending(installationId, pending.device_id);
    if (
      !scopeIsCurrent() ||
      current?.request_id !== pending.request_id ||
      current.idempotency_key !== pending.idempotency_key
    ) {
      return false;
    }
    await SecureStore.deleteItemAsync(
      pendingKey(installationId, pending.device_id),
    );
    return true;
  });
}

async function resolveOriginalAfterFailure(
  reason: unknown,
  installationId: string,
  deviceId: string,
  pending: PendingRequest,
) {
  try {
    const command = await readByKey(
      installationId,
      deviceId,
      pending.idempotency_key,
    );
    await releaseTerminalPending(installationId, command);
    return command;
  } catch {
    throw new Error(
      reason instanceof Error
        ? `${reason.message} The original feed key is saved; check its status before trying again.`
        : "The feed response was lost. The original feed key is saved; check its status before trying again.",
    );
  }
}

async function submitManualFeedOnce(
  installationId: string,
  deviceId: string,
  capabilitiesRevision: number,
  targets: ManualTarget[],
  scopeIsCurrent: () => boolean,
) {
  const normalizedDeviceId = deviceId.toLowerCase();
  const state = await withPendingMutation(
    installationId,
    normalizedDeviceId,
    async () => {
      const pending = await readPending(installationId, normalizedDeviceId);
      if (pending) return { pending, isNew: false };
      const pendingRequest = {
        request_id: uuid(),
        idempotency_key: uuid(),
        device_id: normalizedDeviceId,
        capabilities_revision: capabilitiesRevision,
        targets,
      };
      await savePending(installationId, pendingRequest);
      return { pending: pendingRequest, isNew: true };
    },
  );
  const { pending } = state;
  if (!state.isNew) {
    if (
      pending.capabilities_revision !== capabilitiesRevision ||
      !sameTargets(pending.targets, targets)
    ) {
      throw new Error(
        "A previous feed still needs a status check. Its saved doses cannot be changed.",
      );
    }
    return reconcileManualFeed(
      installationId,
      normalizedDeviceId,
      pending.idempotency_key,
    );
  }
  const body = { protocol_major: 2, ...pending };
  let value: unknown;
  try {
    value = await requestAppApi(
      installationId,
      `${apiPath(normalizedDeviceId)}/feed`,
      "POST",
      body,
      headers(pending.request_id),
    );
  } catch (reason) {
    if (isDefinitiveAdmissionRefusal(reason)) {
      await clearOwnedPending(installationId, pending, scopeIsCurrent);
      throw reason;
    }
    return resolveOriginalAfterFailure(
      reason,
      installationId,
      normalizedDeviceId,
      pending,
    );
  }
  try {
    const accepted = value as { command_id?: unknown; command?: unknown };
    const command =
      accepted.command &&
      validCommand(accepted.command, normalizedDeviceId, {
        requestId: pending.request_id,
        idempotencyKey: pending.idempotency_key,
      })
        ? accepted.command
        : typeof accepted.command_id === "string"
          ? await readById(
              installationId,
              normalizedDeviceId,
              accepted.command_id,
            )
          : await readByKey(
              installationId,
              normalizedDeviceId,
              pending.idempotency_key,
            );
    await releaseTerminalPending(installationId, command);
    return command;
  } catch (reason) {
    return resolveOriginalAfterFailure(
      reason,
      installationId,
      normalizedDeviceId,
      pending,
    );
  }
}

const inFlightSubmissions = new Map<
  string,
  {
    capabilitiesRevision: number;
    targets: ManualTarget[];
    promise: ReturnType<typeof submitManualFeedOnce>;
  }
>();

export function submitManualFeed(
  installationId: string,
  deviceId: string,
  capabilitiesRevision: number,
  targets: ManualTarget[],
  scopeIsCurrent: () => boolean = () => true,
) {
  const normalizedDeviceId = deviceId.toLowerCase();
  const scope = `${installationId}.${normalizedDeviceId}`;
  const active = inFlightSubmissions.get(scope);
  if (active) {
    if (
      active.capabilitiesRevision !== capabilitiesRevision ||
      !sameTargets(active.targets, targets)
    ) {
      return Promise.reject(
        new Error(
          "A previous feed still needs a status check. Its saved doses cannot be changed.",
        ),
      );
    }
    return active.promise;
  }

  const promise = submitManualFeedOnce(
    installationId,
    normalizedDeviceId,
    capabilitiesRevision,
    targets,
    scopeIsCurrent,
  );
  inFlightSubmissions.set(scope, {
    capabilitiesRevision,
    targets: JSON.parse(JSON.stringify(targets)) as ManualTarget[],
    promise,
  });
  void promise.then(
    () => {
      if (inFlightSubmissions.get(scope)?.promise === promise)
        inFlightSubmissions.delete(scope);
    },
    () => {
      if (inFlightSubmissions.get(scope)?.promise === promise)
        inFlightSubmissions.delete(scope);
    },
  );
  return promise;
}

export async function reconcileManualFeed(
  installationId: string,
  deviceId: string,
  key?: string,
) {
  const pending = await readPending(installationId, deviceId);
  if (!pending || (key && pending.idempotency_key !== key))
    throw new Error("No saved feed request is available for this feeder.");
  const command = await readByKey(
    installationId,
    deviceId,
    pending.idempotency_key,
  );
  await releaseTerminalPending(installationId, command);
  return command;
}

export async function resolveSavedManualFeedNoAdmission(
  installationId: string,
  deviceId: string,
  scopeIsCurrent: () => boolean = () => true,
) {
  const normalizedDeviceId = deviceId.toLowerCase();
  const pending = await readPending(installationId, normalizedDeviceId);
  if (!pending)
    throw new Error("No saved feed request is available to resolve.");
  if (!scopeIsCurrent()) throw new Error("The selected feeder changed.");
  const value = await requestAppApi(
    installationId,
    `${apiPath(normalizedDeviceId)}/feed-recovery/no-admission`,
    "POST",
    { protocol_major: 2, ...pending },
    headers(pending.request_id),
  );
  const command = commandFromResponse(value, normalizedDeviceId, {
    requestId: pending.request_id,
    idempotencyKey: pending.idempotency_key,
  });
  if (!sameTargets(command.targets, pending.targets))
    throw new Error("The feeder returned a different saved request.");
  await releaseTerminalPending(installationId, command, scopeIsCurrent);
  return {
    command,
    noAdmissionRecorded:
      !!value &&
      typeof value === "object" &&
      (value as { resolution?: unknown }).resolution === "created",
  };
}

export async function loadPendingManualFeed(
  installationId: string,
  deviceId: string,
) {
  return readPending(installationId, deviceId);
}

export async function readHistoryPage(
  installationId: string,
  deviceId: string,
  filters: {
    from?: string;
    to?: string;
    source: string;
    status: string;
    cursor?: string | null;
  },
) {
  const query = new URLSearchParams();
  if (filters.from) query.set("from", filters.from);
  if (filters.to) query.set("to", filters.to);
  query.set("source", filters.source);
  query.set("status", filters.status);
  if (filters.cursor) query.set("cursor", filters.cursor);
  const requestId = uuid();
  const value = await requestAppApi(
    installationId,
    `${apiPath(deviceId)}/history?${query.toString()}`,
    "GET",
    undefined,
    headers(requestId),
  );
  if (!value || typeof value !== "object")
    throw new Error("Feeding history returned an invalid response.");
  const page = value as Partial<HistoryPage>;
  if (
    !uuidPattern.test(page.request_id ?? "") ||
    !Array.isArray(page.records) ||
    page.records.length > 50 ||
    !page.records.every((record) => validHistoryRecord(record, deviceId)) ||
    !page.totals ||
    ![
      page.totals.total,
      page.totals.completed,
      page.totals.needs_attention,
      page.totals.in_progress,
    ].every((count) => Number.isSafeInteger(count) && count! >= 0) ||
    typeof page.from_date !== "string" ||
    typeof page.to_date !== "string" ||
    typeof page.timezone !== "string" ||
    typeof page.timezone_known !== "boolean" ||
    !(
      page.next_cursor === null ||
      (typeof page.next_cursor === "string" && page.next_cursor.length > 0)
    )
  ) {
    throw new Error("Feeding history returned an invalid response.");
  }
  return page as HistoryPage;
}

export async function readHistoryDetail(
  installationId: string,
  deviceId: string,
  sequenceId: string,
) {
  const requestId = uuid();
  const value = await requestAppApi(
    installationId,
    `${apiPath(deviceId)}/history/${sequenceId}`,
    "GET",
    undefined,
    headers(requestId),
  );
  const detail = value as {
    record?: unknown;
    timezone?: unknown;
    timezone_known?: unknown;
  } | null;
  if (
    !value ||
    typeof value !== "object" ||
    !validHistoryRecord(detail?.record, deviceId) ||
    typeof detail.timezone !== "string" ||
    typeof detail.timezone_known !== "boolean"
  ) {
    throw new Error("Feeding details returned an invalid response.");
  }
  return value as {
    record: HistoryRecord;
    timezone: string;
    timezone_known: boolean;
  };
}
