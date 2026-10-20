export type DeviceRequestScope = {
  installationId: string | null;
  revision: number;
  selectedDeviceId: string | null;
};

export function sameDeviceRequestScope(
  request: DeviceRequestScope,
  current: DeviceRequestScope,
) {
  return (
    request.installationId === current.installationId &&
    request.revision === current.revision &&
    request.selectedDeviceId === current.selectedDeviceId
  );
}

export function enqueueSelectionWrite<T>(
  previous: Promise<void>,
  operation: () => Promise<T>,
) {
  const result = previous.then(operation, operation);
  return {
    result,
    next: result.then(
      () => undefined,
      () => undefined,
    ),
  };
}

export async function clearPersistedSelectionSafely(
  installationId: string,
  remove: () => Promise<unknown>,
  restore: (deviceId: string) => Promise<unknown>,
  isCurrent: () => boolean,
  currentSelection: () => Pick<
    DeviceRequestScope,
    "installationId" | "selectedDeviceId"
  >,
  clearVisibleSelection: () => void,
) {
  if (!isCurrent()) return false;
  await remove();
  if (isCurrent()) {
    clearVisibleSelection();
    return true;
  }
  const latest = currentSelection();
  if (
    latest.installationId === installationId &&
    latest.selectedDeviceId !== null
  ) {
    await restore(latest.selectedDeviceId);
    if (isCurrent()) return false;
    const afterRestore = currentSelection();
    if (afterRestore.installationId !== installationId) {
      await remove();
      if (isCurrent()) return false;
    } else if (afterRestore.selectedDeviceId !== latest.selectedDeviceId) {
      if (afterRestore.selectedDeviceId === null) {
        await remove();
      } else {
        await restore(afterRestore.selectedDeviceId);
      }
      if (isCurrent()) return false;
    }
  }
  return false;
}

export type PairingQrPayload = {
  protocol_major: 2;
  device_id: string;
  challenge_id: string;
  pairing_secret: string;
};

const uuidPattern =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
export function protocolStringLength(value: string) {
  return Array.from(value).length;
}

export function isUuid(value: unknown): value is string {
  return typeof value === "string" && uuidPattern.test(value);
}

export function canonicalUuid(value: unknown) {
  return isUuid(value) ? value.toLowerCase() : null;
}

export function normalizeUtcTimestamp(value: unknown) {
  if (typeof value !== "string") return null;
  const parts =
    /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2}):(\d{2})(?:\.\d+)?(?:Z|\+00:00)$/.exec(
      value,
    );
  if (!parts) return null;
  const timestamp = Date.parse(value);
  if (Number.isNaN(timestamp)) return null;
  const date = new Date(timestamp);
  if (
    date.getUTCFullYear() !== Number(parts[1]) ||
    date.getUTCMonth() + 1 !== Number(parts[2]) ||
    date.getUTCDate() !== Number(parts[3]) ||
    date.getUTCHours() !== Number(parts[4]) ||
    date.getUTCMinutes() !== Number(parts[5]) ||
    date.getUTCSeconds() !== Number(parts[6])
  ) {
    return null;
  }
  return date.toISOString();
}

// Same 45 s planning display policy the monitoring snapshot uses.
export const CONTACT_FRESH_MS = 45_000;

export function contactFreshnessAt(
  stored: "fresh" | "stale" | "unknown",
  contactAt: string | null,
  nowMs: number,
): "fresh" | "stale" | "unknown" {
  if (stored !== "fresh" || contactAt === null) return stored;
  // shortcut: compares with the phone clock, not server time; a phone clock that is
  // off can hide or add up to 45 s. Upgrade to a server-computed field if that matters.
  return Math.abs(nowMs - Date.parse(contactAt)) < CONTACT_FRESH_MS
    ? "fresh"
    : "stale";
}

export function parsePairingQrPayload(value: string): PairingQrPayload | null {
  if (value.length > 8192) return null;
  try {
    const payload: unknown = JSON.parse(value);
    if (typeof payload !== "object" || payload === null) return null;
    const record = payload as Record<string, unknown>;
    if (
      record.protocol_major !== 2 ||
      !isUuid(record.device_id) ||
      !isUuid(record.challenge_id) ||
      typeof record.pairing_secret !== "string" ||
      protocolStringLength(record.pairing_secret) < 1 ||
      protocolStringLength(record.pairing_secret) > 512 ||
      Object.keys(record).some(
        (key) =>
          key !== "protocol_major" &&
          key !== "device_id" &&
          key !== "challenge_id" &&
          key !== "pairing_secret",
      )
    ) {
      return null;
    }
    return {
      protocol_major: 2,
      device_id: record.device_id.toLowerCase(),
      challenge_id: record.challenge_id.toLowerCase(),
      pairing_secret: record.pairing_secret,
    };
  } catch {
    return null;
  }
}

// Permanent, printable and public: names the feeder only. It carries no secret and
// grants nothing; access still needs a fresh pairing window (PairingQrPayload).
export type DeviceIdentityQr = {
  protocol_major: 2;
  purpose: "device_identity";
  device_id: string;
};

// Key order is fixed so the printed bytes never change for the same feeder.
export function deviceIdentityQrPayload(deviceId: string) {
  return JSON.stringify({
    protocol_major: 2,
    purpose: "device_identity",
    device_id: deviceId.toLowerCase(),
  });
}

export function parseDeviceIdentityQrPayload(
  value: string,
): DeviceIdentityQr | null {
  if (value.length > 8192) return null;
  try {
    const record: unknown = JSON.parse(value);
    if (typeof record !== "object" || record === null) return null;
    const { protocol_major, purpose, device_id, ...extra } = record as Record<
      string,
      unknown
    >;
    if (
      protocol_major !== 2 ||
      purpose !== "device_identity" ||
      !isUuid(device_id) ||
      Object.keys(extra).length > 0
    ) {
      return null;
    }
    return {
      protocol_major: 2,
      purpose: "device_identity",
      device_id: device_id.toLowerCase(),
    };
  } catch {
    return null;
  }
}

export function isPairingSecret(value: string) {
  const length = protocolStringLength(value);
  return length >= 1 && length <= 512;
}

const pairingCodesSafeToRetry = new Set([
  "RATE_LIMITED",
  "ACCESS_REVOKED",
  "ACCESS_DENIED",
  "RESOURCE_NOT_FOUND",
  "INVALID_INPUT",
  "VALIDATION_FAILED",
  "PROTOCOL_UNSUPPORTED",
  "AUTH_REQUIRED",
  "SESSION_UNAVAILABLE",
  "SESSION_CHANGED",
]);

export function pairingFailureNeedsNewWindow(code: unknown) {
  return typeof code !== "string" || !pairingCodesSafeToRetry.has(code);
}

export function validatePairingLabels(alias: string, location: string) {
  const nameLength = protocolStringLength(alias.trim());
  const locationLength = protocolStringLength(location.trim());
  return {
    alias:
      nameLength === 0
        ? "Enter a name for this device."
        : nameLength > 100
          ? "Use 100 characters or fewer."
          : null,
    location: locationLength > 160 ? "Use 160 characters or fewer." : null,
  };
}
