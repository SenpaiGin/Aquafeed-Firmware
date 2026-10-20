export const SESSION_STORAGE_KEY = "aquafeed-installation-session-v2";

export type SecureStorageIssue =
  "unavailable" | "too_large" | "invalid_session";

export class SecureSessionStorageError extends Error {
  readonly issue: SecureStorageIssue;
  readonly serializedBytes: number | null;

  constructor(
    issue: SecureStorageIssue,
    serializedBytes: number | null = null,
  ) {
    const messages: Record<
      SecureStorageIssue,
      (bytes: number | null) => string
    > = {
      unavailable: () =>
        "Secure session storage is unavailable. No plain-text fallback was used.",
      too_large: (bytes) =>
        `Native secure storage rejected the ${bytes ?? "unknown-size"}-byte installation session as too large.`,
      invalid_session: () =>
        "The stored installation session is invalid. Device access is blocked until it is repaired.",
    };
    super(messages[issue](serializedBytes));
    this.name = "SecureSessionStorageError";
    this.issue = issue;
    this.serializedBytes = serializedBytes;
  }
}

export type SecureKeyValueStore = {
  getItemAsync(key: string, options?: unknown): Promise<string | null>;
  setItemAsync(key: string, value: string, options?: unknown): Promise<void>;
  deleteItemAsync(key: string, options?: unknown): Promise<void>;
};

let storageFailure: SecureSessionStorageError | null = null;

export function getSecureStorageFailure() {
  return storageFailure;
}

export function resetSecureStorageFailure() {
  storageFailure = null;
}

export function secureUtf8ByteLength(value: string) {
  let bytes = 0;
  for (const character of value) {
    const codePoint = character.codePointAt(0) ?? 0;
    bytes +=
      codePoint <= 0x7f
        ? 1
        : codePoint <= 0x7ff
          ? 2
          : codePoint <= 0xffff
            ? 3
            : 4;
  }
  return bytes;
}

function validInstallationSession(value: string) {
  try {
    const session: unknown = JSON.parse(value);
    if (typeof session !== "object" || session === null) return false;
    const record = session as Record<string, unknown>;
    const user = record.user;
    if (typeof user !== "object" || user === null) return false;
    const userRecord = user as Record<string, unknown>;
    return (
      typeof record.access_token === "string" &&
      record.access_token.length > 0 &&
      typeof record.refresh_token === "string" &&
      record.refresh_token.length > 0 &&
      (record.expires_at === undefined ||
        (typeof record.expires_at === "number" &&
          Number.isFinite(record.expires_at))) &&
      typeof userRecord.id === "string" &&
      /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(
        userRecord.id,
      ) &&
      userRecord.is_anonymous === true
    );
  } catch {
    return false;
  }
}

export function createSecureSessionStorage(
  secureStore: SecureKeyValueStore,
  options?: unknown,
) {
  const fail = (
    issue: SecureStorageIssue,
    serializedBytes: number | null = null,
  ): never => {
    const error = new SecureSessionStorageError(issue, serializedBytes);
    storageFailure = error;
    throw error;
  };

  const failForNativeError = (
    error: unknown,
    serializedBytes: number | null,
  ) => {
    const detail = error instanceof Error ? error.message : "";
    return /too large|payload size|value size|size limit|maximum.*size/i.test(
      detail,
    )
      ? fail("too_large", serializedBytes)
      : fail("unavailable", serializedBytes);
  };

  return {
    async getItem(key: string) {
      let value: string | null;
      try {
        value = await secureStore.getItemAsync(key, options);
      } catch (error) {
        return failForNativeError(error, null);
      }
      if (value === null) return null;
      if (key === SESSION_STORAGE_KEY && !validInstallationSession(value)) {
        return fail("invalid_session");
      }
      return value;
    },
    async setItem(key: string, value: string) {
      const serializedBytes = secureUtf8ByteLength(value);
      if (key === SESSION_STORAGE_KEY && !validInstallationSession(value)) {
        return fail("invalid_session");
      }
      try {
        await secureStore.setItemAsync(key, value, options);
      } catch (error) {
        return failForNativeError(error, serializedBytes);
      }
    },
    async removeItem(key: string) {
      try {
        await secureStore.deleteItemAsync(key, options);
      } catch {
        return fail("unavailable");
      }
    },
  };
}
