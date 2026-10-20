import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import vm from "node:vm";
import ts from "typescript";

import {
  canonicalUuid,
  clearPersistedSelectionSafely,
  contactFreshnessAt,
  deviceIdentityQrPayload,
  enqueueSelectionWrite,
  isPairingSecret,
  normalizeUtcTimestamp,
  pairingFailureNeedsNewWindow,
  parseDeviceIdentityQrPayload,
  parsePairingQrPayload,
  sameDeviceRequestScope,
  validatePairingLabels,
} from "../src/lib/device-access-state.ts";
import {
  createSecureSessionStorage,
  getSecureStorageFailure,
  resetSecureStorageFailure,
  secureUtf8ByteLength,
  SESSION_STORAGE_KEY,
} from "../src/lib/secure-session-storage.ts";
import * as deviceAccessState from "../src/lib/device-access-state.ts";

const deviceId = "22222222-2222-4222-8222-222222222222";
const challengeId = "33333333-3333-4333-8333-333333333333";
const pairing = {
  protocol_major: 2,
  device_id: deviceId,
  challenge_id: challengeId,
};

assert.deepEqual(
  parsePairingQrPayload(JSON.stringify({ ...pairing, pairing_secret: "x" })),
  { ...pairing, pairing_secret: "x" },
);
assert.equal(isPairingSecret("x"), true);
assert.equal(isPairingSecret("x".repeat(512)), true);
assert.equal(isPairingSecret("x".repeat(513)), false);
assert.equal(pairingFailureNeedsNewWindow("PAIRING_UNCONFIRMED"), true);
assert.equal(pairingFailureNeedsNewWindow("PAIRING_INVALID"), true);
assert.equal(pairingFailureNeedsNewWindow("RATE_LIMITED"), false);
assert.deepEqual(validatePairingLabels("  ", ""), {
  alias: "Enter a name for this device.",
  location: null,
});
assert.deepEqual(validatePairingLabels("Pond feeder", "Main pond"), {
  alias: null,
  location: null,
});
assert.deepEqual(
  validatePairingLabels("🐟".repeat(100), "pond 🐟".repeat(20)),
  { alias: null, location: null },
);
assert.equal(
  validatePairingLabels("🐟".repeat(101), "").alias,
  "Use 100 characters or fewer.",
);
assert.equal(
  validatePairingLabels("Pond feeder", "🐟".repeat(161)).location,
  "Use 160 characters or fewer.",
);
assert.equal(
  parsePairingQrPayload(JSON.stringify({ ...pairing, pairing_secret: "" })),
  null,
);
assert.equal(
  parsePairingQrPayload(
    JSON.stringify({ ...pairing, pairing_secret: "x".repeat(513) }),
  ),
  null,
);
assert.equal(
  parsePairingQrPayload(
    JSON.stringify({ ...pairing, protocol_major: 1, pairing_secret: "x" }),
  ),
  null,
);
assert.equal(
  parsePairingQrPayload(
    JSON.stringify({ ...pairing, pairing_secret: "x", unexpected: true }),
  ),
  null,
);
assert.equal(parsePairingQrPayload("not-json"), null);

// Public identity QR: names the feeder only, and is never confused with the temporary
// challenge QR (each parser rejects the other's payload).
const identityText = deviceIdentityQrPayload(deviceId.toUpperCase());
assert.equal(
  identityText,
  `{"protocol_major":2,"purpose":"device_identity","device_id":"${deviceId}"}`,
);
assert.deepEqual(parseDeviceIdentityQrPayload(identityText), {
  protocol_major: 2,
  purpose: "device_identity",
  device_id: deviceId,
});
const identity = JSON.parse(identityText);
for (const bad of [
  { ...identity, protocol_major: 1 },
  { ...identity, protocol_major: 3 },
  { ...identity, purpose: "pairing" },
  { ...identity, device_id: "not-a-uuid" },
  { ...identity, pairing_secret: "x" },
  { ...identity, challenge_id: challengeId },
  { ...identity, url: "https://example.com" },
  { protocol_major: 2, device_id: deviceId },
]) {
  assert.equal(parseDeviceIdentityQrPayload(JSON.stringify(bad)), null);
}
assert.equal(parseDeviceIdentityQrPayload("not-json"), null);
assert.equal(parseDeviceIdentityQrPayload("[]"), null);
assert.equal(parseDeviceIdentityQrPayload("https://example.com"), null);
assert.equal(parsePairingQrPayload(identityText), null);
assert.equal(
  parseDeviceIdentityQrPayload(
    JSON.stringify({ ...pairing, pairing_secret: "x" }),
  ),
  null,
);
assert.equal(isPairingSecret("😀".repeat(512)), true);
assert.equal(isPairingSecret("😀".repeat(513)), false);
assert.equal(canonicalUuid(deviceId.toUpperCase()), deviceId);
assert.equal(
  normalizeUtcTimestamp("2026-10-03T05:20:11+00:00"),
  "2026-10-03T05:20:11.000Z",
);
assert.equal(normalizeUtcTimestamp("2026-10-03T05:20:11+01:00"), null);
assert.equal(normalizeUtcTimestamp("2026-02-31T05:20:11Z"), null);

const contactNow = Date.parse("2026-10-13T00:00:00Z");
const contactAtOffset = (ms) => new Date(contactNow + ms).toISOString();
for (const [stored, offsetMs, expected] of [
  ["fresh", -10_000, "fresh"],
  ["fresh", -44_900, "fresh"],
  ["fresh", -45_000, "stale"],
  ["fresh", -3 * 86_400_000, "stale"],
  ["fresh", 5_000, "fresh"],
  ["fresh", 60_000, "stale"],
  ["stale", -1_000, "stale"],
]) {
  assert.equal(
    contactFreshnessAt(stored, contactAtOffset(offsetMs), contactNow),
    expected,
    `${stored} contact ${offsetMs} ms from now is ${expected}`,
  );
}
assert.equal(contactFreshnessAt("unknown", null, contactNow), "unknown");

const escapedAstralSecret = "\\udbff\\udfff".repeat(512);
const escapedQr = `{"protocol_major":2,"device_id":"${deviceId.toUpperCase()}","challenge_id":"${challengeId.toUpperCase()}","pairing_secret":"${escapedAstralSecret}"}`;
const decodedQr = parsePairingQrPayload(escapedQr);
assert.ok(escapedQr.length > 4096 && escapedQr.length <= 8192);
assert.equal(decodedQr?.pairing_secret, "\u{10ffff}".repeat(512));
assert.equal(decodedQr?.device_id, deviceId);
assert.equal(decodedQr?.challenge_id, challengeId);

const scope = {
  installationId: deviceId,
  revision: 4,
  selectedDeviceId: challengeId,
};
assert.equal(sameDeviceRequestScope(scope, { ...scope }), true);
assert.equal(sameDeviceRequestScope(scope, { ...scope, revision: 5 }), false);
assert.equal(
  sameDeviceRequestScope(scope, { ...scope, selectedDeviceId: null }),
  false,
);
assert.equal(
  sameDeviceRequestScope(scope, { ...scope, installationId: challengeId }),
  false,
);

const writeOrder = [];
let releaseFirstWrite;
const firstWriteGate = new Promise((resolve) => {
  releaseFirstWrite = resolve;
});
const firstWrite = enqueueSelectionWrite(Promise.resolve(), async () => {
  writeOrder.push("persist:first");
  await firstWriteGate;
  writeOrder.push("visible:first");
});
const secondWrite = enqueueSelectionWrite(firstWrite.next, async () => {
  writeOrder.push("persist:second");
  writeOrder.push("visible:second");
});
await new Promise((resolve) => setImmediate(resolve));
assert.deepEqual(writeOrder, ["persist:first"]);
releaseFirstWrite();
await Promise.all([firstWrite.result, secondWrite.result]);
assert.deepEqual(writeOrder, [
  "persist:first",
  "visible:first",
  "persist:second",
  "visible:second",
]);

const failedWrite = enqueueSelectionWrite(secondWrite.next, async () => {
  throw new Error("storage unavailable");
});
const afterFailure = enqueueSelectionWrite(failedWrite.next, async () => {
  writeOrder.push("after:failure");
});
await assert.rejects(failedWrite.result, /storage unavailable/);
await afterFailure.result;
assert.equal(writeOrder.at(-1), "after:failure");

const selectedKey = `selection.${deviceId}`;
const selectedStorage = new Map([[selectedKey, challengeId]]);
let currentSelection = {
  installationId: deviceId,
  selectedDeviceId: challengeId,
};
let clearIsCurrent = true;
let clearVisibleCalls = 0;
let finishDelete;
const deleteGate = new Promise((resolve) => {
  finishDelete = resolve;
});
const staleClear = clearPersistedSelectionSafely(
  deviceId,
  async () => {
    selectedStorage.delete(selectedKey);
    await deleteGate;
  },
  async (value) => selectedStorage.set(selectedKey, value),
  () => clearIsCurrent,
  () => currentSelection,
  () => {
    clearVisibleCalls += 1;
    currentSelection = { ...currentSelection, selectedDeviceId: null };
  },
);
await new Promise((resolve) => setImmediate(resolve));
clearIsCurrent = false;
finishDelete();
assert.equal(await staleClear, false);
assert.equal(selectedStorage.get(selectedKey), challengeId);
assert.equal(currentSelection.selectedDeviceId, challengeId);
assert.equal(clearVisibleCalls, 0);

const switchedKey = `selection.${deviceId}`;
const switchedStorage = new Map();
let selectionDuringRestore = {
  installationId: deviceId,
  selectedDeviceId: challengeId,
};
let restoreIsCurrent = true;
let releaseRestore;
const restoreGate = new Promise((resolve) => {
  releaseRestore = resolve;
});
const staleRestore = clearPersistedSelectionSafely(
  deviceId,
  async () => {
    switchedStorage.delete(switchedKey);
    restoreIsCurrent = false;
  },
  async (value) => {
    switchedStorage.set(switchedKey, value);
    await restoreGate;
  },
  () => restoreIsCurrent,
  () => selectionDuringRestore,
  () => {},
);
await new Promise((resolve) => setImmediate(resolve));
restoreIsCurrent = false;
selectionDuringRestore = {
  installationId: "44444444-4444-4444-8444-444444444444",
  selectedDeviceId: null,
};
releaseRestore();
assert.equal(await staleRestore, false);
assert.equal(switchedStorage.has(switchedKey), false);

const session = JSON.stringify({
  access_token: "opaque-session-token",
  refresh_token: "opaque-refresh-token",
  expires_at: 1_900_000_000,
  user: { id: deviceId, is_anonymous: true },
  utf8_sample: "pond 🐟",
});
const nativeValues = new Map();
const secureStore = {
  async getItemAsync(key) {
    return nativeValues.get(key) ?? null;
  },
  async setItemAsync(key, value) {
    nativeValues.set(key, value);
  },
  async deleteItemAsync(key) {
    nativeValues.delete(key);
  },
};
resetSecureStorageFailure();
const storage = createSecureSessionStorage(secureStore);
await storage.setItem(SESSION_STORAGE_KEY, session);
assert.equal(await storage.getItem(SESSION_STORAGE_KEY), session);
assert.equal(secureUtf8ByteLength("pond 🐟"), 9);
await assert.rejects(
  storage.setItem(
    SESSION_STORAGE_KEY,
    JSON.stringify({
      ...JSON.parse(session),
      user: { id: deviceId, is_anonymous: false },
    }),
  ),
  (error) => error.issue === "invalid_session",
);

resetSecureStorageFailure();
const nativeFailure = createSecureSessionStorage({
  async getItemAsync() {
    return null;
  },
  async setItemAsync() {
    throw new Error("Native SecureStore payload size too large");
  },
  async deleteItemAsync() {},
});
await assert.rejects(
  nativeFailure.setItem(SESSION_STORAGE_KEY, session),
  (error) =>
    error.issue === "too_large" &&
    error.serializedBytes === secureUtf8ByteLength(session) &&
    !error.message.includes("opaque-session-token"),
);
assert.equal(getSecureStorageFailure()?.issue, "too_large");
resetSecureStorageFailure();

const readFailure = createSecureSessionStorage({
  async getItemAsync() {
    throw new Error("native keychain temporarily unavailable");
  },
  async setItemAsync() {},
  async deleteItemAsync() {},
});
await assert.rejects(
  readFailure.getItem(SESSION_STORAGE_KEY),
  (error) =>
    error.issue === "unavailable" &&
    error.serializedBytes === null &&
    !error.message.includes("opaque-session-token"),
);
resetSecureStorageFailure();

const providerInstallationA = "11111111-1111-4111-8111-111111111111";
const providerInstallationB = "44444444-4444-4444-8444-444444444444";
const providerDeviceA = "55555555-5555-4555-8555-555555555555";
const providerDeviceB = "77777777-7777-4777-8777-777777777777";
const wireNozzle = {
  enabled: true,
  dose_modes: ["grams"],
  fixed_portion_ids: [],
  min_dose_g: 5,
  max_dose_g: 20000,
  dose_step_g: 1,
  measured_dispensed_g: true,
  max_actuation_ms: 15000,
  minimum_cooldown_ms: null,
};
const pairProfile = (id) => ({
  device_id: id,
  model: "AquaFeed Duo",
  firmware_version: "simulator-fixture",
  protocol_major: 2,
  is_simulated: true,
  capabilities_revision: 4,
  capabilities: {
    do_monitoring: false,
    feed_remaining_monitoring: true,
    feed_capacity_g: 20000,
    local_schedule_execution: false,
    max_schedules: null,
    max_clock_uncertainty_ms: null,
    scheduler_wake_grace_ms: null,
    maximum_settling_ms: null,
    nozzles: { 1: wireNozzle, 2: wireNozzle },
  },
});
const localRecord = (deviceId, alias = null, location = null) => ({
  deviceId,
  alias,
  location,
  metadataRevision: 1,
  metadataConflict: false,
});
// One shared server record per feeder, as public.devices holds it; memberships only authorize.
const newServer = () => ({ meta: new Map(), members: new Set() });
const deferred = () => {
  let resolve;
  const promise = new Promise((done) => (resolve = done));
  return { promise, resolve };
};
const providerCode = ts.transpileModule(
  await readFile(
    new URL("../src/lib/device-access.tsx", import.meta.url),
    "utf8",
  ),
  {
    compilerOptions: {
      jsx: ts.JsxEmit.ReactJSX,
      module: ts.ModuleKind.CommonJS,
      target: ts.ScriptTarget.ES2022,
    },
  },
).outputText;

function providerHarness(
  installationId,
  initialRecords = [],
  server = newServer(),
) {
  const refs = [];
  const storage = new Map();
  const storageCalls = [];
  const requests = [];
  for (const item of initialRecords) {
    server.members.add(`${installationId}|${item.deviceId}`);
    if (!server.meta.has(item.deviceId))
      server.meta.set(item.deviceId, {
        alias: item.alias,
        location: item.location,
        rev: 1,
        conflict: false,
      });
  }
  let storageGate;
  let fetchGate;
  let labelFailures = 0;
  const session = () => ({
    access_token: "unit-test-access-token",
    expires_at: Math.floor(Date.now() / 1000) + 60,
    user: { id: installationId, is_anonymous: true },
  });
  const secureSessionStorage = {
    getItem: async (key) => storage.get(key) ?? null,
    async setItem(key, value) {
      storageCalls.push({ key, value });
      const gate = storageGate;
      storageGate = null;
      if (gate) await gate;
      storage.set(key, value);
    },
    removeItem: async (key) => storage.delete(key),
  };
  const supabase = {
    auth: {
      getSession: async () => ({ data: { session: session() }, error: null }),
    },
    from(table) {
      const filters = {};
      const query = {
        select: () => query,
        eq: (column, value) => ((filters[column] = value), query),
        order: () => query,
        in: (column, values) => ((filters[column] = values), query),
        then: (resolve, reject) => {
          const mine = [...server.meta.keys()].filter((id) =>
            server.members.has(`${installationId}|${id}`),
          );
          const wanted = (id) =>
            !filters.device_id || filters.device_id.includes(id);
          const rows =
            table === "device_access"
              ? // legacy per-phone labels stay on the row but must never be read
                mine.map((id) => ({
                  device_id: id,
                  alias: "Stale phone alias",
                  location: "Stale phone place",
                }))
              : table === "devices"
                ? mine.filter(wanted).map((id) => {
                    const meta = server.meta.get(id);
                    return {
                      ...pairProfile(id),
                      alias: meta.alias,
                      location: meta.location,
                      metadata_revision: meta.rev,
                      metadata_conflict: meta.conflict,
                    };
                  })
                : mine.filter(wanted).map((id) => ({
                    device_id: id,
                    contact_freshness: "unknown",
                    last_authenticated_contact_at: null,
                  }));
          return Promise.resolve({ data: rows, error: null }).then(
            resolve,
            reject,
          );
        },
      };
      return query;
    },
  };
  const http = (value, status = 200) => ({
    ok: status >= 200 && status < 300,
    status,
    text: async () => JSON.stringify(value),
  });
  const fetch = async (url, init) => {
    const path = url.slice(url.indexOf("/v2") + 3);
    const body = init.body ? JSON.parse(init.body) : null;
    requests.push({ path, method: init.method, body });
    if (fetchGate?.path === path) {
      const gate = fetchGate.promise;
      fetchGate = null;
      await gate;
    }
    if (path === "/pair") {
      const device = pairProfile(body.device_id);
      if (!server.meta.has(body.device_id))
        server.meta.set(body.device_id, {
          alias: "Original pond name",
          location: "North pond",
          rev: 1,
          conflict: false,
        });
      server.members.add(`${installationId}|${body.device_id}`);
      const meta = server.meta.get(body.device_id);
      return http({
        request_id: body.request_id,
        device,
        access: {
          device_id: body.device_id,
          granted_at: "2026-10-04T00:00:00Z",
        },
        metadata: {
          device_id: body.device_id,
          alias: meta.alias,
          location: meta.location,
          metadata_revision: meta.rev,
          metadata_conflict: meta.conflict,
        },
      });
    }
    if (path.endsWith("/history?fixture=large")) {
      const doses = [
        { mode: "grams", amount_g: 25 },
        { mode: "grams", amount_g: 40 },
      ];
      const records = Array.from({ length: 50 }, (_, index) => ({
        sequence_id: `70000000-0000-4000-8000-${String(index + 1).padStart(12, "0")}`,
        device_id: providerDeviceA,
        request_id: "88888888-8888-4888-8888-888888888888",
        idempotency_key: "99999999-9999-4999-8999-999999999999",
        source: "manual",
        status: "completed",
        status_sequence: 4,
        created_at: "2026-10-08T00:00:00Z",
        started_at: "2026-10-08T00:00:01Z",
        completed_at: "2026-10-08T00:00:03Z",
        reason_code: null,
        targets: doses.map((dose, targetIndex) => ({
          nozzle_number: targetIndex + 1,
          dose,
        })),
        nozzle_results: doses.map((dose, targetIndex) => ({
          nozzle_number: targetIndex + 1,
          status: "completed",
          requested_dose: dose,
          estimated_dispensed_g: null,
          measured_dispensed_g: 24.5 + targetIndex,
          measurement_quality: "valid",
        })),
      }));
      return http({ records });
    }
    if (path === "/fixture/device-offline")
      return http({ error: { code: "DEVICE_OFFLINE" } }, 409);
    if (path.startsWith("/fixture/api-error/")) {
      const code = path.split("/").at(-1);
      const status =
        code === "DOSE_UNSUPPORTED" || code === "DOSE_OUT_OF_RANGE" ? 422 : 409;
      return http(
        { error: { code, message: "untrusted server text" } },
        status,
      );
    }
    if (path === "/fixture/oversized")
      return http({ records: ["x".repeat(17_000)] });
    if (path.endsWith("/alias") && init.method === "PATCH") {
      if (labelFailures-- > 0) {
        labelFailures = 0;
        return http({ error: { code: "SERVICE_UNAVAILABLE" } }, 503);
      }
      const targetId = path.split("/")[2];
      const current = server.meta.get(targetId);
      assert.ok(
        current && server.members.has(`${installationId}|${targetId}`),
        "label update has active fixture access",
      );
      if (body.expected_revision !== current.rev)
        return http({ error: { code: "METADATA_CONFLICT" } }, 409);
      const next = {
        alias: body.alias,
        location: body.location,
        rev: current.rev + 1,
        conflict: false,
      };
      server.meta.set(targetId, next);
      return http({
        request_id: body.request_id,
        metadata: {
          device_id: targetId,
          alias: next.alias,
          location: next.location,
          metadata_revision: next.rev,
          metadata_conflict: false,
        },
      });
    }
    throw new Error("Unexpected provider API request.");
  };
  const react = {
    createContext: () => ({ Provider: {} }),
    useCallback: (fn) => fn,
    useContext: () => null,
    useEffect() {},
    useMemo: (fn) => fn(),
    useRef: (current) => {
      const ref = { current };
      refs.push(ref);
      return ref;
    },
    useState: (value) => [value, () => {}],
  };
  const imported = {
    react,
    "react/jsx-runtime": {
      Fragment: Symbol("Fragment"),
      jsx: (type, props) => ({ type, props }),
      jsxs: (type, props) => ({ type, props }),
    },
    "react-native": {
      AppState: {
        currentState: "active",
        addEventListener: () => ({ remove() {} }),
      },
      Platform: { OS: "android" },
    },
    "expo-secure-store": { isAvailableAsync: async () => true },
    "./device-access-state": deviceAccessState,
    "./secure-session-storage": {
      getSecureStorageFailure: () => null,
      resetSecureStorageFailure() {},
      SecureSessionStorageError: class SecureSessionStorageError extends Error {},
    },
    "./device-changes": { subscribeDeviceChanges: () => () => {} },
    "./supabase": {
      removeLegacySqliteSession() {},
      secureSessionStorage,
      supabase,
    },
  };
  const providerModule = { exports: {} };
  const context = vm.createContext({
    crypto: { randomUUID: () => "88888888-8888-4888-8888-888888888888" },
    fetch,
    module: providerModule,
    exports: providerModule.exports,
    process: {
      env: {
        EXPO_PUBLIC_SUPABASE_URL: "https://fixture.invalid",
        EXPO_PUBLIC_SUPABASE_PUBLISHABLE_KEY: "public-fixture-key",
      },
    },
    require: (name) => {
      assert.ok(
        Object.hasOwn(imported, name),
        "provider dependency is stubbed",
      );
      return imported[name];
    },
  });
  new vm.Script(providerCode).runInContext(context);
  const tree = providerModule.exports.DeviceAccessProvider({ children: null });
  const scopeRef = refs.find(
    (ref) =>
      ref.current &&
      Object.hasOwn(ref.current, "installationId") &&
      Object.hasOwn(ref.current, "selectedDeviceId"),
  );
  const devicesRef = refs.find((ref) => Array.isArray(ref.current));
  assert.ok(scopeRef && devicesRef);
  scopeRef.current = { installationId, revision: 1, selectedDeviceId: null };
  devicesRef.current = [...initialRecords];
  return {
    value: tree.props.value,
    requestAppApi: providerModule.exports.requestAppApi,
    scopeRef,
    devicesRef,
    requests,
    storageCalls,
    gateFetch(path, promise) {
      fetchGate = { path, promise };
    },
    gateStorage(promise) {
      storageGate = promise;
    },
    failLabel() {
      labelFailures = 1;
    },
  };
}

const apiTransport = providerHarness(providerInstallationA);
const historyResponse = await apiTransport.requestAppApi(
  providerInstallationA,
  `/devices/${providerDeviceA}/history?fixture=large`,
  "GET",
);
assert.equal(historyResponse.records.length, 50);
assert.ok(
  JSON.stringify(historyResponse).length > 16_384,
  "the serialized 50-row per-nozzle page exceeds the small-response limit",
);
await assert.rejects(
  apiTransport.requestAppApi(
    providerInstallationA,
    "/fixture/device-offline",
    "POST",
    {},
  ),
  (error) => error.code === "DEVICE_OFFLINE" && error.status === 409,
  "HTTP status is retained with the parsed refusal code",
);
for (const [code, message] of [
  [
    "DEVICE_OFFLINE",
    "This feeder is offline. Restore its connection, then try again.",
  ],
  [
    "DEVICE_BUSY",
    "The feeder is already handling a feed. Wait for it to finish, then try again.",
  ],
  [
    "DOSE_UNSUPPORTED",
    "This feeder does not support the selected dose. Choose a supported dose.",
  ],
  [
    "DOSE_OUT_OF_RANGE",
    "The selected dose is outside the supported range. Adjust it and confirm again.",
  ],
  [
    "SAFETY_LOCKOUT",
    "Feeding is locked for safety. Check the feeder in person before trying again.",
  ],
  [
    "CAPABILITY_MISMATCH",
    "The feeder's capabilities changed. Refresh its details before confirming again.",
  ],
  [
    "IDEMPOTENCY_CONFLICT",
    "This request key was already used with different details. Check its status before trying again.",
  ],
]) {
  const status = code.startsWith("DOSE_") ? 422 : 409;
  await assert.rejects(
    apiTransport.requestAppApi(
      providerInstallationA,
      `/fixture/api-error/${code}`,
      "POST",
      {},
    ),
    (error) =>
      error.code === code &&
      error.status === status &&
      error.message === message,
    `${code} maps to short recovery guidance without trusting response text`,
  );
}
await assert.rejects(
  apiTransport.requestAppApi(
    providerInstallationA,
    "/fixture/oversized",
    "GET",
  ),
  (error) => error.code === "INVALID_RESPONSE",
  "ordinary API responses keep the smaller bound",
);

const labels = providerHarness(providerInstallationA);
const paired = await labels.value.pairDevice({
  device_id: providerDeviceA,
  challenge_id: challengeId,
  pairing_secret: "test-only-pairing-secret",
});
assert.equal(paired.alias, "Original pond name");
assert.equal(paired.location, "North pond");
assert.equal(paired.capabilities.feedCapacityG, 20000);
assert.equal(paired.capabilities.nozzles["1"].maxDoseG, 20000);
assert.equal(labels.scopeRef.current.selectedDeviceId, null);
assert.deepEqual(
  Array.from(labels.devicesRef.current, (item) => item.deviceId),
  [providerDeviceA],
);
labels.failLabel();
assert.equal(paired.metadataRevision, 1);
assert.equal(paired.metadataConflict, false);
await assert.rejects(
  labels.value.updateDeviceLabels(
    providerDeviceA,
    "Renamed feeder",
    paired.location,
    paired.metadataRevision,
  ),
  (error) => error.code === "SERVICE_UNAVAILABLE",
);
assert.equal(labels.devicesRef.current[0].location, "North pond");
await labels.value.updateDeviceLabels(
  providerDeviceA,
  "Renamed feeder",
  paired.location,
  paired.metadataRevision,
);
assert.equal(labels.devicesRef.current[0].alias, "Renamed feeder");
assert.equal(labels.devicesRef.current[0].location, "North pond");
assert.equal(labels.requests.filter((item) => item.path === "/pair").length, 1);
assert.ok(
  labels.requests
    .filter((item) => item.path.endsWith("/alias"))
    .every((item) => item.body.location === "North pond"),
);

// ART-102: two installations share one name/location; a stale edit never overwrites.
const sharedServer = newServer();
const phoneA = providerHarness(providerInstallationA, [], sharedServer);
const phoneB = providerHarness(providerInstallationB, [], sharedServer);
const sharedPairing = {
  device_id: providerDeviceA,
  challenge_id: challengeId,
  pairing_secret: "test-only-pairing-secret",
};
const settle = () => new Promise((resolve) => setImmediate(resolve));
const pairedA = await phoneA.value.pairDevice(sharedPairing);
await settle();
assert.equal(
  await phoneA.value.updateDeviceLabels(
    providerDeviceA,
    "North pond feeder",
    "Pond 2",
    pairedA.metadataRevision,
  ),
  2,
);
await settle();
const pairedB = await phoneB.value.pairDevice(sharedPairing);
await settle();
assert.deepEqual(
  [pairedB.alias, pairedB.location, pairedB.metadataRevision],
  ["North pond feeder", "Pond 2", 2],
  "an additional phone loads the shared values instead of resetting them",
);
assert.equal(
  phoneB.requests.some((item) => item.method === "PATCH"),
  false,
  "pairing never writes labels",
);
assert.equal(
  await phoneB.value.updateDeviceLabels(
    providerDeviceA,
    "Renamed by B",
    null,
    2,
  ),
  3,
);
await settle();
const [refreshedA] = await phoneA.value.refreshDevices();
assert.deepEqual(
  [refreshedA.alias, refreshedA.location, refreshedA.metadataRevision],
  ["Renamed by B", null, 3],
  "phone A reads B's edit and ignores its legacy per-phone alias",
);
await assert.rejects(
  phoneA.value.updateDeviceLabels(providerDeviceA, "Stale A", "Pond 9", 2),
  (error) => error.code === "METADATA_CONFLICT" && error.metadataRevision === 3,
);
assert.equal(sharedServer.meta.get(providerDeviceA).alias, "Renamed by B");
assert.equal(phoneA.devicesRef.current[0].alias, "Renamed by B");
assert.equal(
  await phoneA.value.updateDeviceLabels(
    providerDeviceA,
    "Stale A",
    "Pond 9",
    3,
  ),
  4,
  "the edit is reapplied explicitly against the reloaded revision",
);
assert.equal(
  await phoneA.value.updateDeviceLabels(
    providerDeviceA,
    "Stale A",
    "Pond 9",
    3,
  ),
  4,
  "a retry of an edit that already landed converges instead of failing",
);
await settle();
await assert.rejects(
  phoneA.value.updateDeviceLabels(providerDeviceA, "🐟".repeat(101), null, 4),
  (error) => error.code === "INVALID_REQUEST",
);
await assert.rejects(
  phoneA.value.updateDeviceLabels(providerDeviceA, "x", "y".repeat(161), 4),
  (error) => error.code === "INVALID_REQUEST",
);
await phoneA.value.updateDeviceLabels(providerDeviceA, "  Padded  ", "   ", 4);
const padded = phoneA.requests.filter((item) => item.method === "PATCH").at(-1);
assert.deepEqual([padded.body.alias, padded.body.location], ["Padded", null]);
await settle();
sharedServer.meta.set(providerDeviceA, {
  alias: null,
  location: null,
  rev: 9,
  conflict: true,
});
const [conflicted] = await phoneB.value.refreshDevices();
assert.deepEqual(
  [conflicted.alias, conflicted.metadataConflict, conflicted.metadataRevision],
  [null, true, 9],
);
const outsider = providerHarness(
  "99999999-9999-4999-8999-999999999999",
  [],
  sharedServer,
);
await assert.rejects(
  outsider.value.updateDeviceLabels(providerDeviceA, "Hijack", null, 9),
  (error) => error.code === "DEVICE_NOT_FOUND",
);
assert.equal((await outsider.value.refreshDevices()).length, 0);

const grantRace = providerHarness(providerInstallationA);
const grantGate = deferred();
grantRace.gateFetch("/pair", grantGate.promise);
const pendingGrant = grantRace.value.pairDevice({
  device_id: providerDeviceA,
  challenge_id: challengeId,
  pairing_secret: "test-only-pairing-secret",
});
await new Promise((resolve) => setImmediate(resolve));
grantRace.scopeRef.current = {
  installationId: providerInstallationB,
  revision: 2,
  selectedDeviceId: null,
};
grantRace.devicesRef.current = [localRecord(providerDeviceB, "Other pond")];
grantGate.resolve();
await assert.rejects(
  pendingGrant,
  (error) => error.code === "PAIRING_UNCONFIRMED",
);
assert.deepEqual(
  Array.from(grantRace.devicesRef.current, (item) => item.deviceId),
  [providerDeviceB],
);

const labelRace = providerHarness(providerInstallationA, [
  localRecord(providerDeviceA, "Original", "North pond"),
]);
const labelGate = deferred();
labelRace.gateFetch(
  "/devices/" + providerDeviceA + "/alias",
  labelGate.promise,
);
const pendingLabels = labelRace.value.updateDeviceLabels(
  providerDeviceA,
  "Renamed",
  "North pond",
  1,
);
await new Promise((resolve) => setImmediate(resolve));
labelRace.scopeRef.current = {
  installationId: providerInstallationB,
  revision: 2,
  selectedDeviceId: null,
};
labelRace.devicesRef.current = [localRecord(providerDeviceB, "Other pond")];
labelGate.resolve();
await assert.rejects(
  pendingLabels,
  (error) => error.code === "SESSION_CHANGED",
);
assert.deepEqual(
  Array.from(labelRace.devicesRef.current, (item) => item.deviceId),
  [providerDeviceB],
);

const selectionRace = providerHarness(providerInstallationA, [
  localRecord(providerDeviceA, "Original"),
]);
const storageGate = deferred();
selectionRace.gateStorage(storageGate.promise);
const pendingSelection = selectionRace.value.selectDevice(providerDeviceA);
await new Promise((resolve) => setImmediate(resolve));
assert.equal(selectionRace.storageCalls.length, 1);
selectionRace.scopeRef.current = {
  installationId: providerInstallationB,
  revision: 2,
  selectedDeviceId: null,
};
selectionRace.devicesRef.current = [localRecord(providerDeviceB, "Other pond")];
storageGate.resolve();
await assert.rejects(
  pendingSelection,
  (error) => error.code === "SESSION_CHANGED",
);
assert.equal(selectionRace.scopeRef.current.selectedDeviceId, null);
assert.deepEqual(
  Array.from(selectionRace.devicesRef.current, (item) => item.deviceId),
  [providerDeviceB],
);

process.stdout.write(
  "Device access API callbacks, boundary, and race checks passed.\n",
);
