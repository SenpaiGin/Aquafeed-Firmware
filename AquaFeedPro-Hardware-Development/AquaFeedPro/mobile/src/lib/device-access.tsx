import { AppState, Platform } from "react-native";
import * as SecureStore from "expo-secure-store";
import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useRef,
  useState,
  type ReactNode,
} from "react";

import {
  canonicalUuid,
  clearPersistedSelectionSafely,
  contactFreshnessAt,
  isPairingSecret,
  isUuid,
  enqueueSelectionWrite,
  normalizeUtcTimestamp,
  protocolStringLength,
  sameDeviceRequestScope,
  type DeviceRequestScope,
  type PairingQrPayload,
} from "./device-access-state";
import { subscribeDeviceChanges } from "./device-changes";
import {
  getSecureStorageFailure,
  resetSecureStorageFailure,
  SecureSessionStorageError,
} from "./secure-session-storage";
import {
  removeLegacySqliteSession,
  secureSessionStorage,
  supabase,
} from "./supabase";

export type NozzleCapability = {
  enabled: boolean;
  doseModes: string[];
  fixedPortionIds: string[];
  minDoseG: number | null;
  maxDoseG: number | null;
  doseStepG: number | null;
  measuredDispensedG: boolean;
  maxActuationMs: number | null;
  minimumCooldownMs: number | null;
};

export type DeviceCapabilities = {
  doMonitoring: boolean;
  feedRemainingMonitoring: boolean;
  feedCapacityG: number | null;
  localScheduleExecution: boolean;
  scheduledBoth: boolean;
  maxSchedules: number | null;
  maxClockUncertaintyMs: number | null;
  schedulerWakeGraceMs: number | null;
  maximumSettlingMs: number | null;
  nozzles: { "1": NozzleCapability; "2": NozzleCapability };
};

export type DeviceRecord = {
  deviceId: string;
  alias: string | null;
  location: string | null;
  metadataRevision: number;
  metadataConflict: boolean;
  model: string;
  firmwareVersion: string;
  protocolMajor: 2;
  isSimulated: boolean;
  capabilitiesRevision: number;
  capabilities: DeviceCapabilities;
  contactFreshness: string;
  lastAuthenticatedContactAt: string | null;
};

type AccessPhase = "loading" | "ready" | "error";

type PairingDetails = Pick<
  PairingQrPayload,
  "device_id" | "challenge_id" | "pairing_secret"
>;

type DeviceAccessContextValue = {
  phase: AccessPhase;
  bootstrapError: string | null;
  installationId: string | null;
  scopeRevision: number;
  devices: DeviceRecord[];
  selectedDeviceId: string | null;
  selectedDevice: DeviceRecord | null;
  deviceError: string | null;
  refreshing: boolean;
  retryBootstrap: () => void;
  refreshDevices: () => Promise<DeviceRecord[]>;
  selectDevice: (deviceId: string | null) => Promise<void>;
  pairDevice: (pairing: PairingDetails) => Promise<DeviceRecord>;
  updateDeviceLabels: (
    deviceId: string,
    alias: string | null,
    location: string | null,
    expectedRevision: number,
  ) => Promise<number>;
  revokeDevice: (deviceId: string) => Promise<void>;
};

class DeviceAccessError extends Error {
  readonly code: string;
  readonly status?: number;
  readonly metadataRevision?: number;

  constructor(
    code: string,
    message: string,
    status?: number,
    metadataRevision?: number,
  ) {
    super(message);
    this.name = "DeviceAccessError";
    this.code = code;
    this.status = status;
    this.metadataRevision = metadataRevision;
  }
}

const DeviceAccessContext = createContext<DeviceAccessContextValue | null>(
  null,
);
const supabaseUrl = process.env.EXPO_PUBLIC_SUPABASE_URL!;
const publishableKey = process.env.EXPO_PUBLIC_SUPABASE_PUBLISHABLE_KEY!;

function selectionKey(installationId: string) {
  return `aquafeed-selected-device-v2.${installationId}`;
}

function safeRecord(value: unknown): Record<string, unknown> | null {
  return typeof value === "object" && value !== null
    ? (value as Record<string, unknown>)
    : null;
}

function nullableFiniteNumber(value: unknown, positive = false) {
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

function parseCapabilities(value: unknown): DeviceCapabilities | null {
  const source = safeRecord(value);
  const nozzles = safeRecord(source?.nozzles);
  const first = safeRecord(nozzles?.["1"]);
  const second = safeRecord(nozzles?.["2"]);
  if (
    !source ||
    typeof source.do_monitoring !== "boolean" ||
    typeof source.feed_remaining_monitoring !== "boolean" ||
    typeof source.local_schedule_execution !== "boolean" ||
    (source.scheduled_both !== undefined &&
      typeof source.scheduled_both !== "boolean") ||
    !nullableInteger(source.max_schedules, true) ||
    !nullableInteger(source.max_clock_uncertainty_ms) ||
    !nullableInteger(source.scheduler_wake_grace_ms) ||
    !nullableInteger(source.maximum_settling_ms, true) ||
    (Object.prototype.hasOwnProperty.call(source, "feed_capacity_g") &&
      !nullableFiniteNumber(source.feed_capacity_g, true)) ||
    !first ||
    !second
  )
    return null;

  const parseNozzle = (nozzle: Record<string, unknown>) => {
    if (
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
          protocolStringLength(id) >= 1 &&
          protocolStringLength(id) <= 80,
      ) ||
      new Set(nozzle.fixed_portion_ids).size !==
        nozzle.fixed_portion_ids.length ||
      typeof nozzle.measured_dispensed_g !== "boolean" ||
      !nullableInteger(nozzle.max_actuation_ms, true) ||
      !nullableInteger(nozzle.minimum_cooldown_ms)
    ) {
      return null;
    }
    const minDose = nozzle.min_dose_g;
    const maxDose = nozzle.max_dose_g;
    const doseStep = nozzle.dose_step_g;
    const supportsGrams = nozzle.dose_modes.includes("grams");
    const supportsFixed = nozzle.dose_modes.includes("fixed_portion");
    if (
      !nullableFiniteNumber(minDose, true) ||
      !nullableFiniteNumber(maxDose, true) ||
      !nullableFiniteNumber(doseStep, true) ||
      (supportsGrams &&
        (typeof minDose !== "number" ||
          typeof maxDose !== "number" ||
          typeof doseStep !== "number" ||
          minDose > maxDose)) ||
      (!supportsGrams &&
        (minDose !== null || maxDose !== null || doseStep !== null)) ||
      supportsFixed !== nozzle.fixed_portion_ids.length > 0 ||
      nozzle.enabled !== nozzle.dose_modes.length > 0 ||
      (!nozzle.enabled && nozzle.measured_dispensed_g)
    ) {
      return null;
    }
    return {
      enabled: nozzle.enabled,
      doseModes: nozzle.dose_modes as string[],
      fixedPortionIds: nozzle.fixed_portion_ids as string[],
      minDoseG: minDose as number | null,
      maxDoseG: maxDose as number | null,
      doseStepG: doseStep as number | null,
      measuredDispensedG: nozzle.measured_dispensed_g,
      maxActuationMs: nozzle.max_actuation_ms as number | null,
      minimumCooldownMs: nozzle.minimum_cooldown_ms as number | null,
    };
  };
  const parsedFirst = parseNozzle(first);
  const parsedSecond = parseNozzle(second);
  if (!parsedFirst || !parsedSecond) return null;

  if (
    source.local_schedule_execution
      ? typeof source.max_schedules !== "number" || source.max_schedules < 1
      : source.max_schedules !== null
  ) {
    return null;
  }
  return {
    doMonitoring: source.do_monitoring,
    feedRemainingMonitoring: source.feed_remaining_monitoring,
    feedCapacityG: (source.feed_capacity_g ?? null) as number | null,
    localScheduleExecution: source.local_schedule_execution,
    // A profile without the flag never runs Both schedules.
    scheduledBoth: source.scheduled_both === true,
    maxSchedules: source.max_schedules as number | null,
    maxClockUncertaintyMs: source.max_clock_uncertainty_ms as number | null,
    schedulerWakeGraceMs: source.scheduler_wake_grace_ms as number | null,
    maximumSettlingMs: source.maximum_settling_ms as number | null,
    nozzles: { "1": parsedFirst, "2": parsedSecond },
  };
}

function boundedText(value: unknown, minimum: number, maximum: number) {
  return (
    typeof value === "string" &&
    protocolStringLength(value) >= minimum &&
    protocolStringLength(value) <= maximum
  );
}

function parseDeviceState(value: unknown) {
  if (value === undefined || value === null) {
    return { contactFreshness: "unknown", lastAuthenticatedContactAt: null };
  }
  const state = safeRecord(value);
  const freshness = state?.contact_freshness;
  const contactAt = state?.last_authenticated_contact_at;
  const normalizedContactAt =
    contactAt === null ? null : normalizeUtcTimestamp(contactAt);
  if (
    !state ||
    (freshness !== "fresh" &&
      freshness !== "stale" &&
      freshness !== "unknown") ||
    (contactAt !== null && normalizedContactAt === null) ||
    (freshness === "unknown") !== (contactAt === null)
  ) {
    throw new DeviceAccessError(
      "INVALID_DEVICE_STATE",
      "A paired device returned invalid contact status. Its details are hidden until it can be checked.",
    );
  }
  return {
    contactFreshness: contactFreshnessAt(
      freshness,
      normalizedContactAt,
      Date.now(),
    ),
    lastAuthenticatedContactAt: normalizedContactAt,
  };
}

function parseDeviceRecord(
  membershipValue: unknown,
  profileValue: unknown,
  stateValue?: unknown,
): DeviceRecord {
  const membership = safeRecord(membershipValue);
  const profile = safeRecord(profileValue);
  const deviceId = canonicalUuid(membership?.device_id);
  const profileDeviceId = canonicalUuid(profile?.device_id);
  if (
    !membership ||
    !profile ||
    !deviceId ||
    profileDeviceId !== deviceId ||
    !(profile.alias === null || boundedText(profile.alias, 0, 100)) ||
    !(profile.location === null || boundedText(profile.location, 0, 160)) ||
    !Number.isSafeInteger(profile.metadata_revision) ||
    (profile.metadata_revision as number) < 1 ||
    typeof profile.metadata_conflict !== "boolean" ||
    !boundedText(profile.model, 1, 100) ||
    !boundedText(profile.firmware_version, 1, 100) ||
    profile.protocol_major !== 2 ||
    typeof profile.is_simulated !== "boolean" ||
    !Number.isSafeInteger(profile.capabilities_revision) ||
    (profile.capabilities_revision as number) < 1
  ) {
    throw new DeviceAccessError(
      "INVALID_DEVICE_PROFILE",
      "This feeder's profile could not be verified. Its details are hidden until it can be checked.",
    );
  }
  const capabilities = parseCapabilities(profile.capabilities);
  if (!capabilities) {
    throw new DeviceAccessError(
      "INVALID_DEVICE_PROFILE",
      "This feeder's capabilities could not be verified. Its details are hidden until they can be checked.",
    );
  }
  const state = parseDeviceState(stateValue);
  return {
    deviceId,
    alias: profile.alias as string | null,
    location: profile.location as string | null,
    metadataRevision: profile.metadata_revision as number,
    metadataConflict: profile.metadata_conflict,
    model: profile.model as string,
    firmwareVersion: profile.firmware_version as string,
    protocolMajor: 2,
    isSimulated: profile.is_simulated,
    capabilitiesRevision: profile.capabilities_revision as number,
    capabilities,
    contactFreshness: state.contactFreshness,
    lastAuthenticatedContactAt: state.lastAuthenticatedContactAt,
  };
}

function makeDeviceRecords(
  membershipValues: unknown,
  profileValues: unknown,
  stateValues: unknown,
) {
  if (
    !Array.isArray(membershipValues) ||
    !Array.isArray(profileValues) ||
    !Array.isArray(stateValues)
  ) {
    throw new DeviceAccessError(
      "INVALID_RESPONSE",
      "The device service returned invalid access data.",
    );
  }
  const memberships = membershipValues.map((value) => {
    const record = safeRecord(value);
    const deviceId = canonicalUuid(record?.device_id);
    if (!record || !deviceId) {
      throw new DeviceAccessError(
        "INVALID_RESPONSE",
        "The device service returned invalid access data.",
      );
    }
    return { ...record, device_id: deviceId };
  });
  const membershipIds = new Set(
    memberships.map((row) => row.device_id as string),
  );
  if (membershipIds.size !== memberships.length) {
    throw new DeviceAccessError(
      "INVALID_RESPONSE",
      "The device service returned duplicate device access data.",
    );
  }
  const profileById = new Map<string, unknown>();
  for (const value of profileValues) {
    const profile = safeRecord(value);
    const deviceId = canonicalUuid(profile?.device_id);
    if (!profile || !deviceId || !membershipIds.has(deviceId)) {
      throw new DeviceAccessError(
        "INVALID_RESPONSE",
        "The device service returned out-of-scope device data.",
      );
    }
    if (profileById.has(deviceId)) {
      throw new DeviceAccessError(
        "INVALID_RESPONSE",
        "The device service returned duplicate device profiles.",
      );
    }
    profileById.set(deviceId, profile);
  }
  const stateById = new Map<string, unknown>();
  for (const value of stateValues) {
    const state = safeRecord(value);
    const deviceId = canonicalUuid(state?.device_id);
    if (!state || !deviceId || !membershipIds.has(deviceId)) {
      throw new DeviceAccessError(
        "INVALID_RESPONSE",
        "The device service returned out-of-scope device state.",
      );
    }
    if (stateById.has(deviceId)) {
      throw new DeviceAccessError(
        "INVALID_RESPONSE",
        "The device service returned duplicate device state.",
      );
    }
    stateById.set(deviceId, state);
  }
  const records: DeviceRecord[] = [];

  for (const membership of memberships) {
    const deviceId = membership.device_id as string;
    const profile = profileById.get(deviceId);
    if (!profile) {
      throw new DeviceAccessError(
        "INVALID_DEVICE_PROFILE",
        "This feeder's profile could not be verified. Its details are hidden until it can be checked.",
      );
    }
    records.push(
      parseDeviceRecord(membership, profile, stateById.get(deviceId)),
    );
  }
  return records;
}

function requestId() {
  const cryptoApi = globalThis.crypto;
  if (cryptoApi && "randomUUID" in cryptoApi) return cryptoApi.randomUUID();
  return "xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx".replace(/[xy]/g, (part) => {
    const value = Math.floor(Math.random() * 16);
    return (part === "x" ? value : (value & 0x3) | 0x8).toString(16);
  });
}

function apiError(status: number, value: unknown) {
  const root = safeRecord(value);
  const record = safeRecord(root?.error) ?? root;
  const code =
    typeof record?.code === "string" ? record.code : `HTTP_${status}`;
  const messages: Record<string, string> = {
    PAIRING_EXPIRED:
      "This pairing challenge expired. Open a new pairing window on the device.",
    PAIRING_INVALID:
      "This pairing code is incorrect or was already used. Open a new pairing window on the device.",
    RATE_LIMITED: "Too many requests. Wait briefly, then try again.",
    ACCESS_REVOKED: "This installation no longer has access to that device.",
    ACCESS_DENIED:
      "This installation is not allowed to perform that device action.",
    RESOURCE_NOT_FOUND: "That device is not available for this installation.",
    INVALID_INPUT:
      "The request is invalid. Check the device details and try again.",
    VALIDATION_FAILED:
      "The request is invalid. Check the device details and try again.",
    PROTOCOL_UNSUPPORTED: "This feeder isn't supported by the app.",
    IDEMPOTENCY_CONFLICT:
      "This request key was already used with different details. Check its status before trying again.",
    DEVICE_OFFLINE:
      "This feeder is offline. Restore its connection, then try again.",
    DEVICE_BUSY:
      "The feeder is already handling a feed. Wait for it to finish, then try again.",
    DOSE_UNSUPPORTED:
      "This feeder does not support the selected dose. Choose a supported dose.",
    DOSE_OUT_OF_RANGE:
      "The selected dose is outside the supported range. Adjust it and confirm again.",
    METADATA_CONFLICT:
      "Another phone changed the name or location. Review it and save again.",
    SAFETY_LOCKOUT:
      "Feeding is locked for safety. Check the feeder in person before trying again.",
    CAPABILITY_MISMATCH:
      "The feeder's capabilities changed. Refresh its details before confirming again.",
    AUTH_REQUIRED:
      "The installation session expired. Restart the app to restore device access.",
    SERVICE_UNAVAILABLE:
      "The device service is temporarily unavailable. Try again shortly.",
  };
  return new DeviceAccessError(
    code,
    messages[code] ?? "The device request could not be completed. Try again.",
    status,
  );
}

async function callAppApi(
  session: NonNullable<Awaited<ReturnType<typeof currentSession>>>,
  path: string,
  method: "GET" | "POST" | "PUT" | "PATCH" | "DELETE",
  body?: unknown,
  extraHeaders?: Record<string, string>,
) {
  const response = await fetch(
    `${supabaseUrl}/functions/v1/app-api/v2${path}`,
    {
      method,
      headers: {
        apikey: publishableKey,
        Authorization: `Bearer ${session.access_token}`,
        "Content-Type": "application/json",
        ...extraHeaders,
      },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    },
  );
  const text = await response.text();
  const responseLimit =
    method === "GET" && /(?:^|\/)history(?:\/|$)/.test(path.split("?")[0])
      ? 128_000
      : 16_384;
  if (text.length > responseLimit) {
    throw new DeviceAccessError(
      "INVALID_RESPONSE",
      "The device service returned an invalid response.",
    );
  }
  let value: unknown = null;
  if (text) {
    try {
      value = JSON.parse(text);
    } catch {
      throw new DeviceAccessError(
        "INVALID_RESPONSE",
        "The device service returned an invalid response.",
      );
    }
  }
  if (!response.ok) throw apiError(response.status, value);
  return value;
}

export async function requestAppApi(
  expectedInstallationId: string,
  path: string,
  method: "GET" | "POST" | "PUT" | "PATCH" | "DELETE",
  body?: unknown,
  extraHeaders?: Record<string, string>,
) {
  const session = await currentSession();
  if (session.user.id.toLowerCase() !== expectedInstallationId.toLowerCase()) {
    throw new DeviceAccessError(
      "SESSION_UNAVAILABLE",
      "The installation changed. Reopen the selected feeder before continuing.",
    );
  }
  return callAppApi(session, path, method, body, extraHeaders);
}

async function currentSession() {
  const { data, error } = await supabase.auth.getSession();
  const storageError = getSecureStorageFailure();
  if (storageError) throw storageError;
  if (error || !data.session) {
    throw new DeviceAccessError(
      "SESSION_UNAVAILABLE",
      "The installation session expired. Restart the app to pair this installation again.",
    );
  }
  let session = data.session;
  if (
    session.expires_at !== undefined &&
    session.expires_at <= Date.now() / 1000
  ) {
    const refreshed = await supabase.auth.refreshSession();
    if (getSecureStorageFailure()) throw getSecureStorageFailure();
    if (refreshed.error || !refreshed.data.session) {
      throw new DeviceAccessError(
        "SESSION_UNAVAILABLE",
        "The installation session expired. Restart the app to pair this installation again.",
      );
    }
    session = refreshed.data.session;
  }
  if (session.user.is_anonymous !== true) {
    throw new DeviceAccessError(
      "SESSION_UNAVAILABLE",
      "This installation session is invalid. Device access is blocked.",
    );
  }
  return session;
}

export function DeviceAccessProvider({ children }: { children: ReactNode }) {
  const [phase, setPhase] = useState<AccessPhase>("loading");
  const [bootstrapError, setBootstrapError] = useState<string | null>(null);
  const [installationId, setInstallationId] = useState<string | null>(null);
  const [scopeRevision, setScopeRevision] = useState(0);
  const [devices, setDevices] = useState<DeviceRecord[]>([]);
  const [selectedDeviceId, setSelectedDeviceId] = useState<string | null>(null);
  const [deviceError, setDeviceError] = useState<string | null>(null);
  const [refreshing, setRefreshing] = useState(false);
  const [bootstrapAttempt, setBootstrapAttempt] = useState(0);
  const stateRef = useRef<DeviceRequestScope>({
    installationId: null,
    revision: 0,
    selectedDeviceId: null,
  });
  const devicesRef = useRef<DeviceRecord[]>([]);
  const bootstrapPromiseRef = useRef<Promise<void> | null>(null);
  const bootstrapGenerationRef = useRef(0);
  const activationRef = useRef<{ id: string; promise: Promise<void> } | null>(
    null,
  );
  const refreshRef = useRef<() => Promise<DeviceRecord[]>>(async () => []);
  const refreshRunRef = useRef(0);
  const selectionWritesRef = useRef(Promise.resolve());

  const clearVisibleDevices = useCallback(() => {
    devicesRef.current = [];
    setDevices([]);
  }, []);

  const setBootstrapFailure = useCallback(
    (error: unknown, expectedScope?: DeviceRequestScope) => {
      if (
        expectedScope &&
        !sameDeviceRequestScope(expectedScope, stateRef.current)
      )
        return;
      const storageFailure = getSecureStorageFailure();
      const message =
        storageFailure?.message ??
        (error instanceof SecureSessionStorageError
          ? error.message
          : error instanceof DeviceAccessError
            ? error.message
            : "The installation could not be started. Check the connection and try again.");
      stateRef.current = {
        installationId: null,
        revision: stateRef.current.revision + 1,
        selectedDeviceId: null,
      };
      setScopeRevision(stateRef.current.revision);
      setInstallationId(null);
      setSelectedDeviceId(null);
      clearVisibleDevices();
      refreshRunRef.current += 1;
      setRefreshing(false);
      activationRef.current = null;
      setBootstrapError(message);
      setPhase("error");
    },
    [clearVisibleDevices],
  );

  const deactivateInstallation = useCallback(
    (message: string) => {
      stateRef.current = {
        installationId: null,
        revision: stateRef.current.revision + 1,
        selectedDeviceId: null,
      };
      setScopeRevision(stateRef.current.revision);
      activationRef.current = null;
      setInstallationId(null);
      setSelectedDeviceId(null);
      clearVisibleDevices();
      refreshRunRef.current += 1;
      setRefreshing(false);
      setDeviceError(null);
      setBootstrapError(message);
      setPhase("error");
    },
    [clearVisibleDevices],
  );

  const activateInstallation = useCallback(
    (userId: string) => {
      if (!isUuid(userId)) {
        deactivateInstallation(
          "The installation identity is invalid. Device access is blocked.",
        );
        return Promise.resolve();
      }
      const current = stateRef.current;
      if (current.installationId === userId) {
        if (activationRef.current?.id === userId) {
          return activationRef.current.promise;
        }
        return Promise.resolve();
      }
      if (activationRef.current?.id === userId)
        return activationRef.current.promise;

      const nextState: DeviceRequestScope = {
        installationId: userId,
        revision: current.revision + 1,
        selectedDeviceId: null,
      };
      stateRef.current = nextState;
      setScopeRevision(nextState.revision);
      setInstallationId(userId);
      setSelectedDeviceId(null);
      setDeviceError(null);
      clearVisibleDevices();
      refreshRunRef.current += 1;
      setRefreshing(false);
      setPhase("loading");

      const promise = (async () => {
        let expectedScope = nextState;
        try {
          const savedSelection = await secureSessionStorage.getItem(
            selectionKey(userId),
          );
          if (getSecureStorageFailure()) throw getSecureStorageFailure();
          if (!sameDeviceRequestScope(expectedScope, stateRef.current)) return;
          if (savedSelection && isUuid(savedSelection)) {
            const selectedState = {
              ...stateRef.current,
              selectedDeviceId: savedSelection.toLowerCase(),
            };
            stateRef.current = selectedState;
            setScopeRevision(selectedState.revision);
            expectedScope = selectedState;
            setSelectedDeviceId(selectedState.selectedDeviceId);
          } else if (savedSelection !== null) {
            await secureSessionStorage.removeItem(selectionKey(userId));
            if (getSecureStorageFailure()) throw getSecureStorageFailure();
            if (!sameDeviceRequestScope(expectedScope, stateRef.current))
              return;
          }
          if (!sameDeviceRequestScope(expectedScope, stateRef.current)) return;
          setPhase("ready");
          await refreshRef.current();
        } catch (error) {
          if (sameDeviceRequestScope(expectedScope, stateRef.current)) {
            setBootstrapFailure(error, expectedScope);
          }
        }
      })();
      const activation = { id: userId, promise };
      activationRef.current = activation;
      void promise.finally(() => {
        if (activationRef.current === activation) activationRef.current = null;
      });
      return promise;
    },
    [clearVisibleDevices, deactivateInstallation, setBootstrapFailure],
  );

  const clearPersistedSelection = useCallback(
    (expectedScope: DeviceRequestScope, expectedRunId?: number) => {
      const clear = async () => {
        const userId = expectedScope.installationId;
        const isCurrent = () =>
          sameDeviceRequestScope(expectedScope, stateRef.current) &&
          (expectedRunId === undefined ||
            expectedRunId === refreshRunRef.current);
        if (!userId || !isCurrent()) return false;
        const cleared = await clearPersistedSelectionSafely(
          userId,
          () => secureSessionStorage.removeItem(selectionKey(userId)),
          (deviceId) =>
            secureSessionStorage.setItem(selectionKey(userId), deviceId),
          isCurrent,
          () => stateRef.current,
          () => {
            if (stateRef.current.selectedDeviceId !== null) {
              stateRef.current = {
                ...stateRef.current,
                revision: stateRef.current.revision + 1,
                selectedDeviceId: null,
              };
              setScopeRevision(stateRef.current.revision);
              setSelectedDeviceId(null);
              refreshRunRef.current += 1;
              setRefreshing(false);
            }
          },
        );
        if (getSecureStorageFailure()) throw getSecureStorageFailure();
        return cleared;
      };
      const task = enqueueSelectionWrite(selectionWritesRef.current, clear);
      selectionWritesRef.current = task.next;
      return task.result;
    },
    [],
  );

  const refreshDevices = useCallback(async () => {
    const scope = stateRef.current;
    const userId = scope.installationId;
    if (!userId) return [];
    const runId = ++refreshRunRef.current;
    setRefreshing(true);
    setDeviceError(null);
    try {
      const session = await currentSession();
      if (
        !sameDeviceRequestScope(scope, stateRef.current) ||
        runId !== refreshRunRef.current
      )
        return [];
      if (session.user.id !== userId) {
        deactivateInstallation(
          "The installation session changed. Device access is blocked until it is restored.",
        );
        return [];
      }

      const membershipsResult = await supabase
        .from("device_access")
        .select("device_id")
        .eq("installation_id", userId)
        .eq("status", "active")
        .order("granted_at", { ascending: false });
      if (membershipsResult.error) throw new Error("membership query denied");
      const memberships = membershipsResult.data ?? [];
      if (
        !sameDeviceRequestScope(scope, stateRef.current) ||
        runId !== refreshRunRef.current
      )
        return [];
      if (memberships.length === 0) {
        devicesRef.current = [];
        setDevices([]);
        await clearPersistedSelection(scope, runId);
        return [];
      }

      const ids = memberships.map((row) => row.device_id);
      const [profilesResult, statesResult] = await Promise.all([
        supabase
          .from("devices")
          .select(
            "device_id, alias, location, metadata_revision, metadata_conflict, model, firmware_version, protocol_major, is_simulated, capabilities_revision, capabilities",
          )
          .in("device_id", ids),
        supabase
          .from("device_state")
          .select("device_id, contact_freshness, last_authenticated_contact_at")
          .in("device_id", ids),
      ]);
      if (profilesResult.error || statesResult.error)
        throw new Error("device read denied");
      if (
        !sameDeviceRequestScope(scope, stateRef.current) ||
        runId !== refreshRunRef.current
      )
        return [];
      const authorizedRecords = makeDeviceRecords(
        memberships,
        profilesResult.data ?? [],
        statesResult.data ?? [],
      );
      if (
        !sameDeviceRequestScope(scope, stateRef.current) ||
        runId !== refreshRunRef.current
      )
        return [];
      devicesRef.current = authorizedRecords;
      setDevices(authorizedRecords);
      const selected = stateRef.current.selectedDeviceId;
      if (
        selected &&
        !authorizedRecords.some((device) => device.deviceId === selected)
      ) {
        await clearPersistedSelection(scope, runId);
      }
      return authorizedRecords;
    } catch (error) {
      if (
        sameDeviceRequestScope(scope, stateRef.current) &&
        runId === refreshRunRef.current
      ) {
        if (getSecureStorageFailure()) {
          setBootstrapFailure(error, scope);
        } else {
          if (
            error instanceof DeviceAccessError &&
            error.code.startsWith("INVALID_")
          )
            clearVisibleDevices();
          setDeviceError(
            error instanceof DeviceAccessError
              ? error.message
              : "Authorized device data could not be read. Refresh when the connection is available.",
          );
        }
      }
      if (getSecureStorageFailure()) throw getSecureStorageFailure();
      return [];
    } finally {
      if (
        runId === refreshRunRef.current &&
        sameDeviceRequestScope(scope, stateRef.current)
      )
        setRefreshing(false);
    }
  }, [
    clearPersistedSelection,
    clearVisibleDevices,
    deactivateInstallation,
    setBootstrapFailure,
  ]);
  useEffect(() => {
    refreshRef.current = refreshDevices;
  }, [refreshDevices]);

  const selectDevice = useCallback(
    (deviceId: string | null) => {
      const selectedDeviceId = canonicalUuid(deviceId) ?? deviceId;
      const select = async () => {
        const snapshot = stateRef.current;
        const userId = snapshot.installationId;
        if (!userId)
          throw new DeviceAccessError(
            "SESSION_UNAVAILABLE",
            "The installation session is unavailable.",
          );
        if (
          selectedDeviceId !== null &&
          !devicesRef.current.some(
            (device) => device.deviceId === selectedDeviceId,
          )
        ) {
          throw new DeviceAccessError(
            "DEVICE_NOT_FOUND",
            "That device is not available for this installation.",
          );
        }
        try {
          const key = selectionKey(userId);
          if (selectedDeviceId !== null)
            await secureSessionStorage.setItem(key, selectedDeviceId);
          else await secureSessionStorage.removeItem(key);
          if (getSecureStorageFailure()) throw getSecureStorageFailure();
        } catch {
          const error =
            getSecureStorageFailure() ??
            new SecureSessionStorageError("unavailable");
          if (sameDeviceRequestScope(snapshot, stateRef.current)) {
            deactivateInstallation(error.message);
          }
          throw error;
        }
        if (!sameDeviceRequestScope(snapshot, stateRef.current)) {
          throw new DeviceAccessError(
            "SESSION_CHANGED",
            "The installation or device selection changed. Try again.",
          );
        }
        if (
          selectedDeviceId !== null &&
          !devicesRef.current.some(
            (device) => device.deviceId === selectedDeviceId,
          )
        ) {
          try {
            await secureSessionStorage.removeItem(selectionKey(userId));
            if (getSecureStorageFailure()) throw getSecureStorageFailure();
          } catch {
            const error =
              getSecureStorageFailure() ??
              new SecureSessionStorageError("unavailable");
            if (sameDeviceRequestScope(snapshot, stateRef.current)) {
              deactivateInstallation(error.message);
            }
            throw error;
          }
          if (!sameDeviceRequestScope(snapshot, stateRef.current)) {
            throw new DeviceAccessError(
              "SESSION_CHANGED",
              "The installation or device selection changed. Try again.",
            );
          }
          throw new DeviceAccessError(
            "DEVICE_NOT_FOUND",
            "That device is no longer available for this installation.",
          );
        }
        stateRef.current = {
          ...stateRef.current,
          revision: stateRef.current.revision + 1,
          selectedDeviceId,
        };
        setScopeRevision(stateRef.current.revision);
        setSelectedDeviceId(selectedDeviceId);
        setDeviceError(null);
        refreshRunRef.current += 1;
        setRefreshing(false);
      };
      const task = enqueueSelectionWrite(selectionWritesRef.current, select);
      selectionWritesRef.current = task.next;
      return task.result;
    },
    [deactivateInstallation],
  );

  const pairDevice = useCallback(
    async (pairing: PairingDetails) => {
      const deviceId = canonicalUuid(pairing.device_id);
      const challengeId = canonicalUuid(pairing.challenge_id);
      if (
        !deviceId ||
        !challengeId ||
        !isPairingSecret(pairing.pairing_secret)
      ) {
        throw new DeviceAccessError(
          "INVALID_REQUEST",
          "Enter valid pairing details.",
        );
      }
      const scope = stateRef.current;
      const userId = scope.installationId;
      if (!userId)
        throw new DeviceAccessError(
          "SESSION_UNAVAILABLE",
          "The installation session is unavailable.",
        );
      if (devicesRef.current.some((device) => device.deviceId === deviceId)) {
        throw new DeviceAccessError(
          "ALREADY_PAIRED",
          "This installation already has access to that device.",
        );
      }
      const session = await currentSession();
      if (!sameDeviceRequestScope(scope, stateRef.current)) {
        throw new DeviceAccessError(
          "SESSION_CHANGED",
          "The installation changed. Start pairing again.",
        );
      }
      if (session.user.id !== userId)
        throw new DeviceAccessError(
          "SESSION_CHANGED",
          "The installation changed. Start pairing again.",
        );
      const id = requestId();
      let value: unknown;
      try {
        value = await callAppApi(session, "/pair", "POST", {
          protocol_major: 2,
          request_id: id,
          device_id: deviceId,
          challenge_id: challengeId,
          pairing_secret: pairing.pairing_secret,
        });
      } catch (error) {
        if (
          error instanceof DeviceAccessError &&
          [
            "PAIRING_EXPIRED",
            "PAIRING_INVALID",
            "RATE_LIMITED",
            "ACCESS_REVOKED",
            "ACCESS_DENIED",
            "RESOURCE_NOT_FOUND",
            "INVALID_INPUT",
            "VALIDATION_FAILED",
            "PROTOCOL_UNSUPPORTED",
            "IDEMPOTENCY_CONFLICT",
            "AUTH_REQUIRED",
          ].includes(error.code)
        ) {
          throw error;
        }
        throw new DeviceAccessError(
          "PAIRING_UNCONFIRMED",
          "Pairing could not be confirmed. Check Device before reusing this code; if the feeder is not listed, open a new pairing window.",
        );
      }
      if (stateRef.current.installationId !== userId) {
        throw new DeviceAccessError(
          "PAIRING_UNCONFIRMED",
          "The installation changed while pairing. Check Device before reusing this code.",
        );
      }
      const response = safeRecord(value);
      const pairedDevice = safeRecord(response?.device);
      const access = safeRecord(response?.access);
      const metadata = safeRecord(response?.metadata);
      if (
        response?.request_id !== id ||
        !pairedDevice ||
        canonicalUuid(pairedDevice.device_id) !== deviceId ||
        !access ||
        canonicalUuid(access.device_id) !== deviceId ||
        normalizeUtcTimestamp(access.granted_at) === null ||
        !metadata ||
        canonicalUuid(metadata.device_id) !== deviceId
      ) {
        throw new DeviceAccessError(
          "PAIRING_UNCONFIRMED",
          "Pairing could not be confirmed. Check Device before reusing this code; if the feeder is not listed, open a new pairing window.",
        );
      }
      let pairedRecord: DeviceRecord;
      try {
        pairedRecord = parseDeviceRecord(
          { device_id: deviceId },
          { ...pairedDevice, ...metadata },
        );
      } catch {
        throw new DeviceAccessError(
          "PAIRING_UNCONFIRMED",
          "Pairing was accepted, but the device profile could not be checked. Check Device before reusing this code.",
        );
      }
      if (stateRef.current.installationId !== userId) {
        throw new DeviceAccessError(
          "PAIRING_UNCONFIRMED",
          "The installation changed while pairing. Check Device before reusing this code.",
        );
      }
      const nextDevices = [
        pairedRecord,
        ...devicesRef.current.filter((device) => device.deviceId !== deviceId),
      ];
      refreshRunRef.current += 1;
      devicesRef.current = nextDevices;
      setDevices(nextDevices);
      void refreshDevices().catch(() => {});
      return pairedRecord;
    },
    [refreshDevices],
  );

  const updateDeviceLabels = useCallback(
    async (
      deviceId: string,
      alias: string | null,
      location: string | null,
      expectedRevision: number,
    ) => {
      if (!isUuid(deviceId))
        throw new DeviceAccessError(
          "INVALID_REQUEST",
          "The device identity is invalid.",
        );
      const name = alias === null ? null : alias.trim() || null;
      const place = location === null ? null : location.trim() || null;
      if (name !== null && protocolStringLength(name) > 100) {
        throw new DeviceAccessError(
          "INVALID_REQUEST",
          "Enter a device label up to 100 characters.",
        );
      }
      if (place !== null && protocolStringLength(place) > 160) {
        throw new DeviceAccessError(
          "INVALID_REQUEST",
          "Enter a location up to 160 characters.",
        );
      }
      const scope = stateRef.current;
      const normalizedDeviceId = deviceId.toLowerCase();
      const userId = scope.installationId;
      if (!userId)
        throw new DeviceAccessError(
          "SESSION_UNAVAILABLE",
          "The installation session is unavailable.",
        );
      if (
        !devicesRef.current.some(
          (device) => device.deviceId === normalizedDeviceId,
        )
      ) {
        throw new DeviceAccessError(
          "DEVICE_NOT_FOUND",
          "This installation no longer has access to that device.",
        );
      }
      const session = await currentSession();
      if (stateRef.current.installationId !== userId) {
        throw new DeviceAccessError(
          "SESSION_CHANGED",
          "The installation changed. Try again.",
        );
      }
      if (session.user.id !== userId)
        throw new DeviceAccessError(
          "SESSION_CHANGED",
          "The installation changed. Try again.",
        );
      const id = requestId();
      let value: unknown;
      try {
        value = await callAppApi(
          session,
          `/devices/${normalizedDeviceId}/alias`,
          "PATCH",
          {
            protocol_major: 2,
            request_id: id,
            expected_revision: expectedRevision,
            alias: name,
            location: place,
          },
        );
      } catch (error) {
        if (
          !(error instanceof DeviceAccessError) ||
          error.code !== "METADATA_CONFLICT"
        )
          throw error;
        // Reload the canonical values. An earlier uncertain attempt may already have saved
        // exactly this edit; otherwise the editor keeps its draft and saves again explicitly.
        const current = (await refreshDevices()).find(
          (device) => device.deviceId === normalizedDeviceId,
        );
        if (current && current.alias === name && current.location === place)
          return current.metadataRevision;
        throw new DeviceAccessError(
          error.code,
          error.message,
          error.status,
          current?.metadataRevision,
        );
      }
      const response = safeRecord(value);
      const metadata = safeRecord(response?.metadata);
      if (
        response?.request_id !== id ||
        !metadata ||
        canonicalUuid(metadata.device_id) !== normalizedDeviceId ||
        !(metadata.alias === null || boundedText(metadata.alias, 0, 100)) ||
        !(
          metadata.location === null || boundedText(metadata.location, 0, 160)
        ) ||
        !Number.isSafeInteger(metadata.metadata_revision) ||
        (metadata.metadata_revision as number) < 1 ||
        typeof metadata.metadata_conflict !== "boolean"
      ) {
        throw new DeviceAccessError(
          "INVALID_RESPONSE",
          "The device service returned an invalid label update.",
        );
      }
      if (stateRef.current.installationId !== userId) {
        throw new DeviceAccessError(
          "SESSION_CHANGED",
          "The installation changed before the label update was confirmed.",
        );
      }
      const currentDevice = devicesRef.current.find(
        (device) => device.deviceId === normalizedDeviceId,
      );
      if (!currentDevice) {
        throw new DeviceAccessError(
          "ACCESS_REVOKED",
          "Access to this device changed before its label was saved.",
        );
      }
      const nextDevices = devicesRef.current.map((device) =>
        device.deviceId === normalizedDeviceId
          ? {
              ...device,
              alias: metadata.alias as string | null,
              location: metadata.location as string | null,
              metadataRevision: metadata.metadata_revision as number,
              metadataConflict: metadata.metadata_conflict as boolean,
            }
          : device,
      );
      refreshRunRef.current += 1;
      devicesRef.current = nextDevices;
      setDevices(nextDevices);
      void refreshDevices().catch(() => {});
      return metadata.metadata_revision as number;
    },
    [refreshDevices],
  );

  const revokeDevice = useCallback(
    async (deviceId: string) => {
      if (!isUuid(deviceId))
        throw new DeviceAccessError(
          "INVALID_REQUEST",
          "The device identity is invalid.",
        );
      const scope = stateRef.current;
      const normalizedDeviceId = deviceId.toLowerCase();
      const userId = scope.installationId;
      if (!userId)
        throw new DeviceAccessError(
          "SESSION_UNAVAILABLE",
          "The installation session is unavailable.",
        );
      const session = await currentSession();
      if (!sameDeviceRequestScope(scope, stateRef.current)) {
        throw new DeviceAccessError(
          "SESSION_CHANGED",
          "The installation changed. Try again.",
        );
      }
      if (session.user.id !== userId)
        throw new DeviceAccessError(
          "SESSION_CHANGED",
          "The installation changed. Try again.",
        );
      const id = requestId();
      const value = await callAppApi(
        session,
        `/devices/${normalizedDeviceId}/access`,
        "DELETE",
        undefined,
        {
          "X-Protocol-Major": "2",
          "X-Request-Id": id,
        },
      );
      const response = safeRecord(value);
      if (
        response?.request_id !== id ||
        canonicalUuid(response.device_id) !== normalizedDeviceId ||
        normalizeUtcTimestamp(response.revoked_at) === null
      ) {
        throw new DeviceAccessError(
          "INVALID_RESPONSE",
          "The device service returned an invalid access removal result.",
        );
      }
      if (!sameDeviceRequestScope(scope, stateRef.current)) return;
      const remaining = devicesRef.current.filter(
        (device) => device.deviceId !== normalizedDeviceId,
      );
      devicesRef.current = remaining;
      setDevices(remaining);
      if (stateRef.current.selectedDeviceId === normalizedDeviceId) {
        const nextDeviceId = remaining[0]?.deviceId ?? null;
        await selectDevice(nextDeviceId);
        if (
          stateRef.current.installationId !== userId ||
          stateRef.current.selectedDeviceId !== nextDeviceId
        )
          throw new DeviceAccessError(
            "SESSION_CHANGED",
            "The installation changed. Check the selected device again.",
          );
      }
    },
    [selectDevice],
  );

  const runBootstrap = useCallback(() => {
    if (bootstrapPromiseRef.current) return bootstrapPromiseRef.current;
    const generation = ++bootstrapGenerationRef.current;
    const initialScope = stateRef.current;
    const attempt = (async () => {
      setPhase("loading");
      setBootstrapError(null);
      clearVisibleDevices();
      try {
        resetSecureStorageFailure();
        const secureStoreAvailable = await SecureStore.isAvailableAsync().catch(
          () => false,
        );
        if (generation !== bootstrapGenerationRef.current) return;
        if (Platform.OS === "web" || !secureStoreAvailable) {
          throw new SecureSessionStorageError("unavailable");
        }
        removeLegacySqliteSession();
        const current = await supabase.auth.getSession();
        if (getSecureStorageFailure()) throw getSecureStorageFailure();
        if (generation !== bootstrapGenerationRef.current) return;
        if (current.error) throw new Error("session restore failed");
        if (!current.data.session) {
          const result = await supabase.auth.signInAnonymously();
          if (getSecureStorageFailure()) throw getSecureStorageFailure();
          if (result.error || !result.data.session) {
            throw new DeviceAccessError(
              "AUTH_UNAVAILABLE",
              "Anonymous installation sign-in is unavailable. Check the connection and try again.",
            );
          }
        }
        if (generation !== bootstrapGenerationRef.current) return;
        const session = await currentSession();
        const verified = await supabase.auth.getUser(session.access_token);
        if (getSecureStorageFailure()) throw getSecureStorageFailure();
        if (generation !== bootstrapGenerationRef.current) return;
        const verifiedUser = verified.data.user;
        if (
          verified.error ||
          !verifiedUser ||
          verifiedUser.id !== session.user.id ||
          verifiedUser.is_anonymous !== true
        ) {
          throw new DeviceAccessError(
            "INVALID_INSTALLATION",
            "The installation session could not be verified. Device access is blocked.",
          );
        }
        if (session.user.is_anonymous !== true) {
          throw new DeviceAccessError(
            "INVALID_INSTALLATION",
            "This is not an anonymous installation session. Device access is blocked.",
          );
        }
        await activateInstallation(verifiedUser.id);
        if (
          generation === bootstrapGenerationRef.current &&
          stateRef.current.installationId === verifiedUser.id &&
          !getSecureStorageFailure()
        )
          setPhase("ready");
      } catch (error) {
        if (generation === bootstrapGenerationRef.current) {
          setBootstrapFailure(error, initialScope);
        }
      }
    })();
    bootstrapPromiseRef.current = attempt;
    void attempt.finally(() => {
      if (bootstrapPromiseRef.current === attempt)
        bootstrapPromiseRef.current = null;
    });
    return attempt;
  }, [activateInstallation, clearVisibleDevices, setBootstrapFailure]);

  useEffect(() => {
    void runBootstrap();
  }, [bootstrapAttempt, runBootstrap]);

  useEffect(() => {
    const { data } = supabase.auth.onAuthStateChange((event, session) => {
      if (event === "INITIAL_SESSION") return;
      if (event === "SIGNED_OUT" || !session) {
        bootstrapGenerationRef.current += 1;
        deactivateInstallation(
          "The installation session ended. Restart the app to pair this installation again.",
        );
        return;
      }
      if (session.user.is_anonymous !== true) {
        bootstrapGenerationRef.current += 1;
        deactivateInstallation(
          "The installation session is invalid. Device access is blocked.",
        );
        return;
      }
      if (
        event === "TOKEN_REFRESHED" &&
        session.user.id === stateRef.current.installationId
      ) {
        setTimeout(() => void refreshRef.current().catch(() => {}), 0);
        return;
      }
      if (session.user.id !== stateRef.current.installationId) {
        if (bootstrapPromiseRef.current) return;
        bootstrapGenerationRef.current += 1;
        deactivateInstallation(
          "The installation changed. Verifying the new installation session.",
        );
        const expectedScope = stateRef.current;
        const expectedUserId = session.user.id;
        setTimeout(() => {
          void (async () => {
            try {
              const restored = await currentSession();
              if (
                !sameDeviceRequestScope(expectedScope, stateRef.current) ||
                restored.user.id !== expectedUserId
              )
                return;
              const verified = await supabase.auth.getUser(
                restored.access_token,
              );
              if (getSecureStorageFailure()) throw getSecureStorageFailure();
              if (
                verified.error ||
                verified.data.user?.id !== expectedUserId ||
                verified.data.user.is_anonymous !== true ||
                !sameDeviceRequestScope(expectedScope, stateRef.current)
              ) {
                throw new DeviceAccessError(
                  "INVALID_INSTALLATION",
                  "The installation session could not be verified. Device access is blocked.",
                );
              }
              await activateInstallation(expectedUserId);
            } catch (error) {
              setBootstrapFailure(error, expectedScope);
            }
          })();
        }, 0);
      }
    });
    return () => data.subscription.unsubscribe();
  }, [activateInstallation, deactivateInstallation, setBootstrapFailure]);

  useEffect(() => {
    const refreshLifecycle = (state: string) => {
      if (state === "active") {
        void supabase.auth.startAutoRefresh();
        void refreshRef.current().catch(() => {});
      } else {
        void supabase.auth.stopAutoRefresh();
      }
    };
    refreshLifecycle(AppState.currentState ?? "active");
    const subscription = AppState.addEventListener("change", refreshLifecycle);
    return () => {
      subscription.remove();
      void supabase.auth.stopAutoRefresh();
    };
  }, []);

  // Another phone's name/location edit wakes this phone; it refetches through RLS and
  // never trusts the event payload. Focus and reconnect refresh above remain the fallback.
  const deviceIdsKey = devices.map((device) => device.deviceId).join(",");
  useEffect(() => {
    if (!deviceIdsKey) return;
    const stops = deviceIdsKey.split(",").map((id) =>
      subscribeDeviceChanges("device-metadata", id, ["devices"], () => {
        void refreshRef.current().catch(() => {});
      }),
    );
    return () => stops.forEach((stop) => stop());
  }, [deviceIdsKey]);

  const retryBootstrap = useCallback(() => {
    setBootstrapAttempt((attempt) => attempt + 1);
  }, []);

  const selectedDevice = useMemo(
    () =>
      devices.find((device) => device.deviceId === selectedDeviceId) ?? null,
    [devices, selectedDeviceId],
  );
  const value = useMemo<DeviceAccessContextValue>(
    () => ({
      phase,
      bootstrapError,
      installationId,
      scopeRevision,
      devices,
      selectedDeviceId,
      selectedDevice,
      deviceError,
      refreshing,
      retryBootstrap,
      refreshDevices,
      selectDevice,
      pairDevice,
      updateDeviceLabels,
      revokeDevice,
    }),
    [
      phase,
      bootstrapError,
      installationId,
      scopeRevision,
      devices,
      selectedDeviceId,
      selectedDevice,
      deviceError,
      refreshing,
      retryBootstrap,
      refreshDevices,
      selectDevice,
      pairDevice,
      updateDeviceLabels,
      revokeDevice,
    ],
  );

  return (
    <DeviceAccessContext.Provider value={value}>
      {children}
    </DeviceAccessContext.Provider>
  );
}

export function useDeviceAccess() {
  const value = useContext(DeviceAccessContext);
  if (!value)
    throw new Error("useDeviceAccess must be used inside DeviceAccessProvider");
  return value;
}
