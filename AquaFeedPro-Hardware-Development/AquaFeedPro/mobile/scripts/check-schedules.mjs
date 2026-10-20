import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import vm from "node:vm";
import ts from "typescript";

const installationId = "11111111-1111-4111-8111-111111111111";
const deviceId = "22222222-2222-4222-8222-222222222222";
const scheduleId = "33333333-3333-4333-8333-333333333333";
const otherScheduleId = "44444444-4444-4444-8444-444444444444";
const uuids = Array.from(
  { length: 40 },
  (_, index) =>
    `50000000-0000-4000-8000-${String(index + 1).padStart(12, "0")}`,
);
const secure = new Map();
const calls = [];
let loseNextSave = false;
let holdNextSave = null;
let holdNextCheck = null;
let rejectNextSave = null;
let rejectStaleSave = false;
let mismatchNextSaveResponse = false;
let receiptStatus = null;
let desiredRevision = 0;
let nextOccurrenceTimezone = "Asia/Manila";
const values = {
  timezone: "Asia/Manila",
  monitoring_limits: { do_low_mg_l: 3, do_high_mg_l: 10 },
  low_feed_threshold_pct: 25,
  schedules: [
    {
      schedule_id: scheduleId,
      local_time: "08:00",
      weekdays: [1, 3],
      enabled: true,
      targets: [{ nozzle_number: 1, dose: { mode: "grams", amount_g: 12 } }],
    },
    {
      schedule_id: otherScheduleId,
      local_time: "08:00",
      weekdays: [1, 3],
      enabled: true,
      targets: [{ nozzle_number: 2, dose: { mode: "grams", amount_g: 19 } }],
    },
  ],
};

function configRead(requestId, status = receiptStatus) {
  const applied = { ...values, revision: 1, based_on_revision: 0 };
  return {
    request_id: requestId,
    receipt:
      status === null || status === "rejected"
        ? null
        : { revision: 2, based_on_revision: 1, snapshot: values },
    request_status: status,
    request_error_code: status === "rejected" ? "VALIDATION_FAILED" : null,
    current_state: {
      desired_revision: desiredRevision,
      applied_revision: 1,
      last_attempt_revision: desiredRevision || 1,
      last_attempt_status: desiredRevision > 1 ? "pending" : "applied",
      error_code: null,
    },
    desired_snapshot:
      status === "pending"
        ? { ...values, revision: 2, based_on_revision: 1 }
        : null,
    applied_snapshot: applied,
  };
}

async function requestAppApi(installation, path, method, body, headers = {}) {
  calls.push({ installation, path, method, body, headers });
  if (method === "GET" && path.includes("/configuration")) {
    if (holdNextCheck) {
      const release = holdNextCheck;
      holdNextCheck = null;
      await new Promise((resolve) => {
        release.resolve = resolve;
      });
    }
    const receiptId = new URLSearchParams(path.split("?")[1] ?? "").get(
      "request_id",
    );
    return configRead(
      headers["X-Request-Id"],
      receiptId ? receiptStatus : null,
    );
  }
  if (method === "GET" && path.includes("/next-occurrence")) {
    return {
      request_id: headers["X-Request-Id"],
      timezone: nextOccurrenceTimezone,
      occurrence: {
        occurrence_local_date: "2026-10-12",
        local_time: "08:00",
        timezone: nextOccurrenceTimezone,
        at: "2026-10-12T00:00:00Z",
        targets: [
          {
            schedule_id: scheduleId,
            nozzle_number: 1,
            dose: { mode: "grams", amount_g: 12 },
          },
          {
            schedule_id: otherScheduleId,
            nozzle_number: 2,
            dose: { mode: "grams", amount_g: 19 },
          },
        ],
      },
    };
  }
  if (method === "PUT") {
    const key = `device-schedule.pending.${installation}.${deviceId}`;
    const saved = JSON.parse(secure.get(key));
    assert.equal(
      saved.request_id,
      body.request_id,
      "the original request is durable before PUT",
    );
    if (holdNextSave) {
      const release = holdNextSave;
      holdNextSave = null;
      await new Promise((resolve) => {
        release.resolve = resolve;
      });
    }
    if (loseNextSave) {
      loseNextSave = false;
      receiptStatus = "pending";
      desiredRevision = body.based_on_revision + 1;
      throw new Error("response lost after save");
    }
    if (rejectNextSave) {
      const status = rejectNextSave;
      rejectNextSave = null;
      const error = new Error("confirmed configuration rejection");
      error.status = status;
      throw error;
    }
    if (rejectStaleSave && desiredRevision > body.based_on_revision) {
      rejectStaleSave = false;
      const error = new Error("confirmed configuration rejection");
      error.status = 409;
      throw error;
    }
    receiptStatus = "pending";
    desiredRevision = body.based_on_revision + 1;
    const revision = desiredRevision;
    const mismatch = mismatchNextSaveResponse;
    mismatchNextSaveResponse = false;
    return {
      request_id: body.request_id,
      receipt: {
        revision: mismatch ? revision + 1 : revision,
        based_on_revision: body.based_on_revision,
        snapshot: mismatch
          ? { ...body.snapshot, low_feed_threshold_pct: 30 }
          : body.snapshot,
      },
      current_state: {
        desired_revision: revision,
        applied_revision: 1,
        last_attempt_revision: revision,
        last_attempt_status: "pending",
        error_code: null,
      },
    };
  }
  throw new Error(`Unexpected API call: ${method} ${path}`);
}

const source = await readFile(
  new URL("../src/lib/schedules.ts", import.meta.url),
  "utf8",
);
const code = ts.transpileModule(source, {
  compilerOptions: {
    module: ts.ModuleKind.CommonJS,
    target: ts.ScriptTarget.ES2022,
  },
}).outputText;
const module = { exports: {} };
const stateSource = await readFile(
  new URL("../src/lib/device-access-state.ts", import.meta.url),
  "utf8",
);
const stateCode = ts.transpileModule(stateSource, {
  compilerOptions: {
    module: ts.ModuleKind.CommonJS,
    target: ts.ScriptTarget.ES2022,
  },
}).outputText;
const stateModule = { exports: {} };
vm.runInNewContext(stateCode, {
  module: stateModule,
  exports: stateModule.exports,
});
const cryptoApi = {
  randomUUID: () => uuids.shift(),
  getRandomValues: (bytes) => bytes.fill(1),
};
vm.runInNewContext(code, {
  module,
  exports: module.exports,
  crypto: cryptoApi,
  require(name) {
    if (name === "expo-secure-store")
      return {
        getItemAsync: async (key) => secure.get(key) ?? null,
        setItemAsync: async (key, value) => secure.set(key, value),
        deleteItemAsync: async (key) => secure.delete(key),
      };
    if (name === "./device-access") return { requestAppApi };
    if (name === "./device-access-state") return stateModule.exports;
    throw new Error(`Unexpected import: ${name}`);
  },
});
const api = module.exports;

const capabilities = {
  localScheduleExecution: true,
  scheduledBoth: true,
  feedCapacityG: 20000,
  maxSchedules: 8,
  maxClockUncertaintyMs: 1000,
  maximumSettlingMs: 1000,
  schedulerWakeGraceMs: 30000,
  nozzles: {
    1: {
      enabled: true,
      doseModes: ["grams"],
      fixedPortionIds: [],
      minDoseG: 5,
      maxDoseG: 250,
      doseStepG: 1,
    },
    2: {
      enabled: true,
      doseModes: ["grams"],
      fixedPortionIds: [],
      minDoseG: 5,
      maxDoseG: 250,
      doseStepG: 1,
    },
  },
};
assert.equal(
  api.validateSchedule(
    values.schedules[0],
    values.schedules.slice(1),
    capabilities,
  ),
  null,
);
assert.equal(
  api.validateSchedule(
    {
      ...values.schedules[0],
      targets: [{ nozzle_number: 1, dose: { mode: "grams", amount_g: 120 } }],
    },
    [],
    capabilities,
  ),
  null,
  "a synthetic profile can authorize a dose above 100 g without using hopper capacity as the dose limit",
);
assert.match(
  api.validateSchedule(
    {
      ...values.schedules[0],
      targets: [{ nozzle_number: 1, dose: { mode: "grams", amount_g: 251 } }],
    },
    [],
    capabilities,
  ),
  /Nozzle 1: use 5 to 250 g/,
);
assert.match(
  api.validateSchedule(
    values.schedules[0],
    [{ ...values.schedules[0], schedule_id: otherScheduleId }],
    capabilities,
  ),
  /overlapping day/,
);

// ART-98: one Both schedule carries a separate dose per nozzle, in nozzle order.
const bothSchedule = {
  schedule_id: "60000000-0000-4000-8000-000000000001",
  local_time: "09:00",
  weekdays: [1, 3],
  enabled: true,
  targets: [
    { nozzle_number: 1, dose: { mode: "grams", amount_g: 30 } },
    { nozzle_number: 2, dose: { mode: "grams", amount_g: 45 } },
  ],
};
assert.equal(
  api.validateSchedule(bothSchedule, values.schedules, capabilities),
  null,
);
assert.match(
  api.validateSchedule(bothSchedule, [], {
    ...capabilities,
    scheduledBoth: false,
  }),
  /cannot run both nozzles/,
);
assert.match(
  api.validateSchedule(
    {
      ...bothSchedule,
      targets: [
        bothSchedule.targets[0],
        { nozzle_number: 2, dose: { mode: "grams", amount_g: 251 } },
      ],
    },
    [],
    capabilities,
  ),
  /Nozzle 2: use/,
);
assert.match(
  api.validateSchedule(
    { ...bothSchedule, local_time: "08:00", weekdays: [3, 5] },
    values.schedules,
    capabilities,
  ),
  /Nozzle 1 already has a schedule/,
  "Both collides with a single schedule on either nozzle",
);
assert.equal(
  api.validateSchedule(
    { ...bothSchedule, local_time: "08:00", weekdays: [2] },
    values.schedules,
    capabilities,
  ),
  null,
  "Both at the same time on another day does not collide",
);

const next = await api.readNextOccurrence(installationId, deviceId);
assert.equal(
  next.occurrence.targets.map((item) => item.nozzle_number).join(","),
  "1,2",
);
nextOccurrenceTimezone = "Invalid/Timezone";
await assert.rejects(
  api.readNextOccurrence(installationId, deviceId),
  /invalid next feeding/,
);
nextOccurrenceTimezone = "Asia/Manila";
cryptoApi.randomUUID = undefined;
assert.equal(
  api.newScheduleId(),
  "01010101-0101-4101-8101-010101010101",
  "the Expo crypto fallback creates a v4 UUID",
);
cryptoApi.randomUUID = () => uuids.shift();

loseNextSave = true;
await assert.rejects(
  api.saveConfiguration(installationId, deviceId, 1, values),
  /response lost/,
);
const pendingKey = `device-schedule.pending.${installationId}.${deviceId}`;
const original = JSON.parse(secure.get(pendingKey));
receiptStatus = null;
desiredRevision = 1;
const check = await api.checkPendingWrite(installationId, deviceId);
assert.equal(check.conflict, false);
assert.equal(
  calls.at(-1).path,
  `/devices/${deviceId}/configuration?request_id=${original.request_id}`,
);
assert.equal(
  JSON.parse(secure.get(pendingKey)).request_id,
  original.request_id,
);
await api.retryPendingWrite(installationId, deviceId);
assert.equal(
  calls.at(-1).body.request_id,
  original.request_id,
  "retry sends the original request ID",
);
assert.equal(secure.has(pendingKey), false);

secure.set(
  pendingKey,
  JSON.stringify({
    request_id: "50000000-0000-4000-8000-000000000005",
    based_on_revision: 1,
    snapshot: values,
  }),
);
receiptStatus = "pending";
desiredRevision = 2;
const confirmed = await api.checkPendingWrite(installationId, deviceId);
assert.equal(confirmed.state.request_status, "pending");
assert.equal(
  secure.has(pendingKey),
  false,
  "a confirmed pending receipt is resolved from the server state",
);

loseNextSave = true;
desiredRevision = 1;
await assert.rejects(
  api.saveConfiguration(installationId, deviceId, 1, values),
  /response lost/,
);
const uncertain = JSON.parse(secure.get(pendingKey));
rejectNextSave = 429;
await assert.rejects(
  api.retryPendingWrite(installationId, deviceId),
  /confirmed configuration rejection/,
);
assert.equal(
  JSON.parse(secure.get(pendingKey)).request_id,
  uncertain.request_id,
  "a rate-limited retry preserves the original uncertain request key",
);
const recoveredAfter429 = await api.checkPendingWrite(installationId, deviceId);
assert.equal(
  calls.at(-1).path,
  `/devices/${deviceId}/configuration?request_id=${uncertain.request_id}`,
  "lookup after a rate-limited retry still asks about the original request",
);
assert.equal(recoveredAfter429.state.request_status, "pending");
assert.equal(secure.has(pendingKey), false);

loseNextSave = true;
receiptStatus = null;
desiredRevision = 1;
await assert.rejects(
  api.saveConfiguration(installationId, deviceId, 1, values),
  /response lost/,
);
receiptStatus = null;
desiredRevision = 3;
const conflict = await api.checkPendingWrite(installationId, deviceId);
assert.equal(
  conflict.conflict,
  true,
  "a different current revision resolves the original as a conflict",
);
assert.equal(secure.has(pendingKey), false);

rejectNextSave = 422;
await assert.rejects(
  api.saveConfiguration(installationId, deviceId, 3, values),
  /confirmed configuration rejection/,
);
assert.equal(
  secure.has(pendingKey),
  false,
  "a confirmed server rejection clears only its local pending receipt",
);
assert.equal(api.isConfirmedScheduleRejection({ status: 422 }), true);
assert.equal(api.isConfirmedScheduleRejection({ status: 429 }), true);
assert.equal(api.isConfirmedScheduleRejection({ status: 408 }), false);
assert.equal(api.isConfirmedScheduleRejection(new Error("offline")), false);

mismatchNextSaveResponse = true;
await assert.rejects(
  api.saveConfiguration(installationId, deviceId, 3, values),
  /configuration save response could not be verified/,
);
assert.equal(
  JSON.parse(secure.get(pendingKey)).based_on_revision,
  3,
  "a response with a mismatched receipt cannot erase the durable request",
);
secure.delete(pendingKey);

secure.set(pendingKey, "{");
await assert.rejects(
  api.loadPendingWrite(installationId, deviceId),
  /unreadable/,
);
await assert.rejects(
  api.saveConfiguration(installationId, deviceId, 3, values),
  /unreadable/,
);
assert.equal(
  secure.get(pendingKey),
  "{",
  "corrupt pending data is preserved and blocks a fresh save",
);
secure.delete(pendingKey);

const firstRelease = {};
holdNextSave = firstRelease;
receiptStatus = null;
desiredRevision = 1;
const first = api.saveConfiguration(installationId, deviceId, 1, values);
await new Promise((resolve) => setTimeout(resolve, 0));
const firstRequest = JSON.parse(secure.get(pendingKey));
rejectStaleSave = true;
const second = api.saveConfiguration(installationId, deviceId, 1, values);
const secondRejection = assert.rejects(
  second,
  /confirmed configuration rejection/,
);
await new Promise((resolve) => setTimeout(resolve, 0));
assert.equal(
  calls.filter((call) => call.method === "PUT").at(-1).body.request_id,
  firstRequest.request_id,
  "same-device configuration writes are serialized before SecureStore can be overwritten",
);
assert.equal(
  typeof firstRelease.resolve,
  "function",
  "the first request reached the network gate",
);
firstRelease.resolve();
await first;
await secondRejection;
assert.notEqual(
  calls.filter((call) => call.method === "PUT").at(-1).body.request_id,
  firstRequest.request_id,
);
assert.equal(secure.has(pendingKey), false);

secure.set(
  pendingKey,
  JSON.stringify({
    request_id: "50000000-0000-4000-8000-000000000005",
    based_on_revision: 1,
    snapshot: values,
  }),
);
receiptStatus = "rejected";
desiredRevision = 3;
const rejected = await api.checkPendingWrite(installationId, deviceId);
assert.equal(
  rejected.state.request_status,
  "rejected",
  "an older rejected receipt is returned despite a later current revision",
);
assert.equal(rejected.state.current_state.desired_revision, 3);
assert.equal(rejected.conflict, false);
assert.equal(secure.has(pendingKey), false);

secure.set(
  pendingKey,
  JSON.stringify({
    request_id: "50000000-0000-4000-8000-000000000006",
    based_on_revision: 3,
    snapshot: values,
  }),
);
receiptStatus = "rejected";
desiredRevision = 3;
const firstCheckGate = {};
holdNextCheck = firstCheckGate;
const configurationReads = calls.filter(
  (call) => call.method === "GET" && call.path.includes("/configuration"),
).length;
const firstCheck = api.checkPendingWrite(installationId, deviceId);
await new Promise((resolve) => setTimeout(resolve, 0));
assert.equal(typeof firstCheckGate.resolve, "function");
const secondCheckGate = {};
holdNextCheck = secondCheckGate;
const secondCheck = api.checkPendingWrite(installationId, deviceId);
await new Promise((resolve) => setTimeout(resolve, 0));
assert.equal(
  calls.filter(
    (call) => call.method === "GET" && call.path.includes("/configuration"),
  ).length,
  configurationReads + 1,
  "a second pending lookup waits behind the first per-device lookup",
);
firstCheckGate.resolve();
const firstResolution = await firstCheck;
assert.equal(firstResolution.state.request_status, "rejected");
const secondResolution = await secondCheck;
assert.equal(secondResolution.pending, null);
assert.equal(secondResolution.state, null);
assert.equal(typeof secondCheckGate.resolve, "undefined");
holdNextCheck = null;

const writeGate = {};
holdNextSave = writeGate;
loseNextSave = true;
const queuedWrite = api.saveConfiguration(installationId, deviceId, 3, values);
const queuedWriteLost = assert.rejects(queuedWrite, /response lost after save/);
await new Promise((resolve) => setTimeout(resolve, 0));
assert.equal(typeof writeGate.resolve, "function");
const newerPending = JSON.parse(secure.get(pendingKey));
assert.notEqual(
  newerPending.request_id,
  "50000000-0000-4000-8000-000000000006",
);
writeGate.resolve();
await queuedWriteLost;
assert.equal(
  JSON.parse(secure.get(pendingKey)).request_id,
  newerPending.request_id,
  "the queued lookups cannot delete a newer recovery key during a held save",
);

// ART-99: the searchable zone catalog pins Philippines and reaches beyond Manila, phone and UTC.
assert.equal(api.searchTimezones("")[0].zone, "Asia/Manila");
for (const query of ["Philippines", "manila", "Asia/Manila", "  asia/MANILA "])
  assert.equal(api.searchTimezones(query)[0].zone, "Asia/Manila", query);
assert.equal(api.searchTimezones("new york")[0].zone, "America/New_York");
assert.equal(api.searchTimezones("nepal")[0].zone, "Asia/Kathmandu");
assert.equal(api.searchTimezones("zzz-no-zone").length, 0);
assert.ok(api.searchTimezones("").length >= 50);
const catalogZones = api.timezoneCatalog.map((item) => item.zone);
assert.equal(
  new Set(catalogZones).size,
  catalogZones.length,
  "catalog has no duplicate zones",
);
for (const zone of [
  "America/New_York",
  "Europe/London",
  "Australia/Sydney",
  "Asia/Kathmandu",
  "America/St_Johns",
  "Asia/Kolkata",
])
  assert.ok(catalogZones.includes(zone), zone);

// A pending write saved by an older app keeps its scalar shape and loads as one target.
secure.set(
  pendingKey,
  JSON.stringify({
    request_id: "70000000-0000-4000-8000-000000000001",
    based_on_revision: 3,
    snapshot: {
      ...values,
      schedules: [
        {
          schedule_id: scheduleId,
          local_time: "08:00",
          weekdays: [1, 3],
          enabled: true,
          dose: { mode: "grams", amount_g: 12 },
          nozzle_number: 1,
        },
      ],
    },
  }),
);
const legacyPending = await api.loadPendingWrite(installationId, deviceId);
assert.equal(
  JSON.stringify(legacyPending.snapshot.schedules[0].targets),
  JSON.stringify([{ nozzle_number: 1, dose: { mode: "grams", amount_g: 12 } }]),
);
secure.delete(pendingKey);

console.log(
  "Schedule validation, next-occurrence parsing, secure pending writes, and original-request recovery checks passed.",
);
