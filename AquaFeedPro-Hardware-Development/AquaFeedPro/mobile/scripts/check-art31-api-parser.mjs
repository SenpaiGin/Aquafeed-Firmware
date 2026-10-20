import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { createRequire } from "node:module";
import { randomUUID, webcrypto } from "node:crypto";
import vm from "node:vm";
import ts from "typescript";

const requireContracts = createRequire(
  new URL("../../contracts/package.json", import.meta.url),
);
const Ajv = requireContracts("ajv/dist/2020.js").default;
const addFormats = requireContracts("ajv-formats").default;
const schema = JSON.parse(
  await readFile(
    new URL("../../contracts/schemas/v2.schema.json", import.meta.url),
    "utf8",
  ),
);
const ajv = new Ajv({ strict: false });
addFormats(ajv);
ajv.addFormat("local-time", {
  type: "string",
  validate: (value) => /^(?:[01]\d|2[0-3]):[0-5]\d$/.test(value),
});
ajv.addFormat("iana-time-zone", {
  type: "string",
  validate: (value) => {
    if (/^(?:(?:UTC|GMT))?[+-]\d{1,2}(?::?\d{2})?$/i.test(value)) return false;
    try {
      return (
        new Intl.DateTimeFormat("en-US", { timeZone: value }).resolvedOptions()
          .timeZone !== ""
      );
    } catch {
      return false;
    }
  },
});
ajv.addSchema(schema, "v2");
const validateManualFeed = ajv.getSchema("v2#/$defs/ManualFeedRequest");

const deviceId = "11111111-1111-4111-8111-111111111111";
const installationId = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
const requestIds = [
  "33333333-3333-4333-8333-333333333333",
  "44444444-4444-4444-8444-444444444444",
  "55555555-5555-4555-8555-555555555555",
  "77777777-7777-4777-8777-777777777777",
];
const key = "66666666-6666-4666-8666-666666666666";
const feedCalls = [];
const rpcCalls = [];
let rpcOverride = null;
const uuid = (value) =>
  typeof value === "string" &&
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(
    value,
  );
const record = (value) =>
  typeof value === "object" && value !== null && !Array.isArray(value)
    ? value
    : null;
const shared = {
  admin: {
    async rpc(name, args) {
      if (rpcOverride) {
        rpcCalls.push({ name, args: JSON.parse(JSON.stringify(args)) });
        return rpcOverride(name, args);
      }
      feedCalls.push(JSON.parse(JSON.stringify(args)));
      const command = {
        command_id: key,
        sequence_id: key,
        device_id: args.p_device_id,
        request_id: args.p_request_id,
        idempotency_key: args.p_idempotency_key,
        targets: args.p_targets,
        status: "queued",
        status_sequence: 1,
        created_at: "2026-10-09T00:00:00Z",
        start_before: "2026-10-09T00:01:00Z",
        nozzle_results: args.p_targets.map((target) => ({
          nozzle_number: target.nozzle_number,
          status: "queued",
          requested_dose: target.dose,
          estimated_dispensed_g: null,
          measured_dispensed_g: null,
          measurement_quality: "unavailable",
        })),
        safety_lockout: false,
        lockout_resolution: null,
      };
      return { data: { status: "created", command }, error: null };
    },
  },
  apiError: (_requestId, status, code) =>
    Response.json({ error: { code } }, { status }),
  characterLength: (value) => Array.from(value).length,
  installationId: async () => installationId,
  isUuid: uuid,
  json: (value, status = 200) => Response.json(value, { status }),
  normalizeUtcTimestamp: (value) =>
    typeof value === "string" && Number.isFinite(Date.parse(value))
      ? value
      : null,
  protocolMajor: (value) => value?.protocol_major === 2,
  readJson: async (request) => ({
    value: await request.json(),
    response: null,
  }),
  record,
  requestIdFrom: (value) =>
    uuid(value?.request_id) ? value.request_id : randomUUID(),
  sha256Hex: async () => "fixture-verifier",
  takeRateLimit: async () => true,
};

function load(source, name, suffix = "", requireModule = () => shared) {
  const compiled = ts.transpileModule(source, {
    compilerOptions: {
      module: ts.ModuleKind.CommonJS,
      target: ts.ScriptTarget.ES2022,
    },
  }).outputText;
  const module = { exports: {} };
  let handler;
  const context = {
    module,
    exports: module.exports,
    require: (id) => requireModule(id),
    Deno: {
      serve: (value) => (handler = value),
      env: { get: () => "fixture-only" },
    },
    crypto: { randomUUID, subtle: webcrypto.subtle },
    Request,
    Response,
    URL,
    URLSearchParams,
    TextDecoder,
    TextEncoder,
    Uint8Array,
    atob,
    btoa,
  };
  vm.runInNewContext(`${compiled}\n${suffix}`, context, { filename: name });
  return { handler, context, module };
}

const deviceAccessSource = await readFile(
  new URL("../../supabase/functions/_shared/device-access.ts", import.meta.url),
  "utf8",
);
const deviceAccess = load(
  deviceAccessSource,
  "_shared/device-access.ts",
  "",
  () => ({ createClient: () => ({}) }),
).module.exports;
shared.normalizeUtcTimestamp = deviceAccess.normalizeUtcTimestamp;
shared.normalizeUtcTimestampForResponse =
  deviceAccess.normalizeUtcTimestampForResponse;

const base = {
  protocol_major: 2,
  request_id: requestIds[0],
  device_id: deviceId,
  idempotency_key: key,
  capabilities_revision: 1,
  targets: [
    { nozzle_number: 1, dose: { mode: "grams", amount_g: 50 } },
    {
      nozzle_number: 2,
      dose: { mode: "fixed_portion", fixed_portion_id: "portion_small" },
    },
  ],
};
const additive = {
  ...base,
  request_id: requestIds[1],
  tracking_hint: "ignored",
  targets: base.targets.map((target) => ({
    ...target,
    trace_id: "ignored",
    dose: { ...target.dose, label: "ignored" },
  })),
};
assert.equal(validateManualFeed(base), true);
assert.equal(validateManualFeed(additive), true);

const source = await readFile(
  new URL("../../supabase/functions/app-api/index.ts", import.meta.url),
  "utf8",
);
const { handler } = load(source, "app-api/index.ts");
const url = `https://fixture.invalid/functions/v1/app-api/v2/devices/${deviceId}/feed`;
const post = (body) =>
  handler(
    new Request(url, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(body),
    }),
  );
assert.equal((await post(base)).status, 202);
assert.equal((await post(additive)).status, 202);
assert.deepEqual(feedCalls[0].p_targets, feedCalls[1].p_targets);
assert.equal("trace_id" in feedCalls[1].p_targets[0], false);
assert.equal("label" in feedCalls[1].p_targets[1].dose, false);

const changedDose = {
  ...additive,
  request_id: requestIds[2],
  targets: [
    { ...additive.targets[0], dose: { mode: "grams", amount_g: 51 } },
    additive.targets[1],
  ],
};
assert.equal(validateManualFeed(changedDose), true);
assert.equal((await post(changedDose)).status, 202);
assert.notDeepEqual(feedCalls[0].p_targets, feedCalls[2].p_targets);
assert.equal(feedCalls[2].p_targets[0].dose.amount_g, 51);

const missingRequired = { ...base, request_id: requestIds[3] };
delete missingRequired.capabilities_revision;
assert.equal(validateManualFeed(missingRequired), false);
const callsBeforeInvalid = feedCalls.length;
const rejected = await post(missingRequired);
assert.equal(rejected.status, 422);
assert.equal(feedCalls.length, callsBeforeInvalid);

const deviceSource = await readFile(
  new URL("../../supabase/functions/device-api/index.ts", import.meta.url),
  "utf8",
);
const deviceModule = load(
  deviceSource,
  "device-api/index.ts",
  "globalThis.parser = { validDeviceSync, normalizedRunEvent };",
);
const event = {
  sequence_id: key,
  event_sequence: 1,
  event_type: "queued",
  outcome_status: "queued",
  source: "manual",
  device_at: "2026-10-09T00:00:00Z",
  time_quality: "synced",
  command_id: key,
  schedule_id: null,
  configuration_revision: null,
  occurrence_local_date: null,
  requested_dose: { mode: "grams", amount_g: 20, label: "ignored" },
  estimated_dispensed_g: null,
  measured_dispensed_g: null,
  measurement_quality: "unavailable",
  reason_code: null,
  maintenance_resolution: null,
  lockout_cleared: false,
  nozzle_number: 1,
  step_index: 1,
  tracking_hint: "ignored",
};
const sync = {
  protocol_major: 2,
  request_id: requestIds[0],
  boot_id: requestIds[1],
  live_sequence: 1,
  firmware_version: "test",
  capabilities_revision: 1,
  clock: { quality: "synced", uncertainty_ms: 0, tracking_hint: "ignored" },
  actuator: {
    state: "idle",
    active_sequence_id: null,
    fault_code: null,
    tracking_hint: "ignored",
  },
  configuration: {
    applied_revision: null,
    last_attempt_revision: null,
    last_attempt_status: null,
    error_code: null,
    tracking_hint: "ignored",
  },
  latest_sample: null,
  backlog_samples: [],
  events: [event],
  tracking_hint: "ignored",
};
assert.equal(deviceModule.context.parser.validDeviceSync(sync), true);
const normalized = deviceModule.context.parser.normalizedRunEvent(event);
assert.equal("tracking_hint" in normalized, false);
assert.equal("label" in normalized.requested_dose, false);
assert.equal(
  deviceModule.context.parser.validDeviceSync({
    ...sync,
    events: [{ ...event, event_sequence: 0 }],
  }),
  false,
);

const validateResponse = (name, value) => {
  const validate = ajv.getSchema(`v2#/$defs/${name}`);
  assert.ok(validate, `published response schema ${name} exists`);
  assert.equal(
    validate(value),
    true,
    `${name}: ${JSON.stringify(validate.errors)}`,
  );
};
const pgCreatedAt = "2026-10-09T12:34:56.123456+00:00";
const expectedCreatedAt = "2026-10-09T12:34:56.123456Z";
const pgStartBefore = "2026-10-09T12:35:56.987654+00:00";
const expectedStartBefore = "2026-10-09T12:35:56.987654Z";
const pgResolutionAt = "2026-10-09T12:40:00.001234+00:00";
const expectedResolutionAt = "2026-10-09T12:40:00.001234Z";
const operatorNote =
  "Operator note includes literal 2026-10-09T12:40:00.001234+00:00 text.";
const command = {
  command_id: key,
  sequence_id: key,
  device_id: deviceId,
  request_id: requestIds[0],
  idempotency_key: key,
  status: "partial",
  status_sequence: 4,
  created_at: pgCreatedAt,
  start_before: pgStartBefore,
  targets: base.targets,
  nozzle_results: [
    {
      nozzle_number: 1,
      status: "completed",
      requested_dose: base.targets[0].dose,
      estimated_dispensed_g: null,
      measured_dispensed_g: 49.5,
      measurement_quality: "valid",
    },
    {
      nozzle_number: 2,
      status: "unknown",
      requested_dose: base.targets[1].dose,
      estimated_dispensed_g: null,
      measured_dispensed_g: null,
      measurement_quality: "error",
    },
  ],
  safety_lockout: false,
  lockout_resolution: {
    resolution_at: pgResolutionAt,
    resolution_reason: operatorNote,
    source: "device_maintenance",
  },
};
const acceptedCommand = {
  ...command,
  status: "queued",
  status_sequence: 1,
  nozzle_results: base.targets.map((target) => ({
    nozzle_number: target.nozzle_number,
    status: "queued",
    requested_dose: target.dose,
    estimated_dispensed_g: null,
    measured_dispensed_g: null,
    measurement_quality: "unavailable",
  })),
  safety_lockout: false,
  lockout_resolution: null,
};
const historyRecord = {
  sequence_id: key,
  command_id: key,
  device_id: deviceId,
  source: "manual",
  request_id: requestIds[0],
  idempotency_key: key,
  status: "unknown",
  status_sequence: 5,
  created_at: pgCreatedAt,
  start_before: pgStartBefore,
  started_at: pgStartBefore,
  completed_at: null,
  reason_code: "USER_TEXT+00:00",
  targets: base.targets,
  nozzle_results: command.nozzle_results,
  safety_lockout: true,
  lockout_resolution: null,
};
const detailRecord = {
  ...historyRecord,
  status: "partial",
  started_at: null,
  completed_at: pgResolutionAt,
  safety_lockout: false,
  lockout_resolution: { ...command.lockout_resolution, resolution_at: null },
};
let createRpcResult = {
  data: { status: "created", command: acceptedCommand },
  error: null,
};
let historyPageCount = 0;
const historyPageRpcArgs = [];
rpcOverride = (name, args) => {
  switch (name) {
    case "art31_create_manual_feed":
      return createRpcResult;
    case "art31_read_manual_command":
      return { data: { status: "found", command }, error: null };
    case "art31_history_page":
      historyPageRpcArgs.push(args);
      historyPageCount += 1;
      return {
        data: {
          status: "ok",
          from_date: "2026-10-08",
          to_date: "2026-10-09",
          timezone: "Asia/Manila",
          timezone_known: true,
          total: 1,
          completed_total: 0,
          needs_attention_total: 1,
          in_progress_total: 0,
          records: historyPageCount === 1 ? [historyRecord] : [],
          has_more: historyPageCount === 1,
          next:
            historyPageCount === 1
              ? { created_at: pgCreatedAt, sequence_id: key }
              : null,
        },
        error: null,
      };
    case "art31_history_detail":
      return {
        data: {
          status: "ok",
          timezone: "Asia/Manila",
          timezone_known: true,
          record: detailRecord,
        },
        error: null,
      };
    case "art38_authenticate_device":
      return { data: deviceId, error: null };
    case "art31_sync_manual_feed":
      return {
        data: {
          status: "ok",
          server_time: pgCreatedAt,
          acknowledged_events: [{ sequence_id: key, event_sequence: 1 }],
          command: {
            command_type: "feed",
            command_id: key,
            sequence_id: key,
            device_id: deviceId,
            request_id: requestIds[0],
            idempotency_key: key,
            targets: [
              { nozzle_number: 1, dose: { mode: "grams", amount_g: 50 } },
            ],
            capabilities_revision: 1,
            created_at: pgCreatedAt,
            start_before: pgStartBefore,
            scheduler_wake_grace_ms: null,
            status: "queued",
          },
          next_sync_after_ms: 1000,
        },
        error: null,
      };
    default:
      throw new Error(`Unexpected RPC: ${name}`);
  }
};

const appHeaders = (requestId = requestIds[0]) => ({
  "x-protocol-major": "2",
  "x-request-id": requestId,
});
const appRequest = (path, method = "GET", headers = appHeaders(), body) =>
  handler(
    new Request(
      `https://fixture.invalid/functions/v1/app-api/v2/devices/${deviceId}${path}`,
      {
        method,
        headers,
        ...(body === undefined ? {} : { body: JSON.stringify(body) }),
      },
    ),
  );
const acceptedResponse = await appRequest(
  "/feed",
  "POST",
  {
    ...appHeaders(),
    "content-type": "application/json",
  },
  base,
);
assert.equal(acceptedResponse.status, 202);
const acceptedBody = await acceptedResponse.json();
validateResponse("CommandAcceptedResponse", acceptedBody);
assert.equal(acceptedBody.created_at, expectedCreatedAt);
assert.equal(acceptedBody.start_before, expectedStartBefore);

createRpcResult = { data: { status: "existing", command }, error: null };
const duplicateResponse = await appRequest(
  "/feed",
  "POST",
  {
    ...appHeaders(requestIds[1]),
    "content-type": "application/json",
  },
  { ...base, request_id: requestIds[1] },
);
const duplicateBody = await duplicateResponse.json();
validateResponse("CommandStatusResponse", duplicateBody);
assert.equal(
  duplicateBody.command.lockout_resolution.resolution_at,
  expectedResolutionAt,
);
assert.equal(
  duplicateBody.command.lockout_resolution.resolution_reason,
  operatorNote,
);

const statusResponse = await appRequest(`/commands/${key}`);
validateResponse("CommandStatusResponse", await statusResponse.json());
const byKeyResponse = await appRequest(`/commands/by-key?key=${key}`);
validateResponse("CommandByKeyResponse", await byKeyResponse.json());
const byKeyCall = rpcCalls.findLast(
  ({ name }) => name === "art31_read_manual_command",
);
assert.equal(byKeyCall.args.p_by_key, true);
assert.equal(byKeyCall.args.p_lookup, key);

const historyPageUrl =
  "/history?from=2026-10-08&to=2026-10-09&source=all&status=all";
const historyPageResponse = await appRequest(historyPageUrl);
const historyPageBody = await historyPageResponse.json();
validateResponse("HistoryPageResponse", historyPageBody);
assert.equal(historyPageBody.records[0].created_at, expectedCreatedAt);
assert.equal(historyPageBody.records[0].start_before, expectedStartBefore);
assert.equal(historyPageBody.records[0].started_at, expectedStartBefore);
assert.equal(historyPageBody.records[0].completed_at, null);
assert.equal(historyPageBody.records[0].reason_code, "USER_TEXT+00:00");
const cursor = JSON.parse(
  Buffer.from(historyPageBody.next_cursor, "base64url").toString("utf8"),
);
assert.equal(cursor.created_at, expectedCreatedAt);
const nextPageResponse = await appRequest(
  `/history?cursor=${encodeURIComponent(historyPageBody.next_cursor)}`,
);
validateResponse("HistoryPageResponse", await nextPageResponse.json());
assert.equal(historyPageRpcArgs[1].p_before_created_at, expectedCreatedAt);

const historyDetailResponse = await appRequest(`/history/${key}`);
const historyDetailBody = await historyDetailResponse.json();
validateResponse("HistoryDetailResponse", historyDetailBody);
assert.equal(historyDetailBody.record.started_at, null);
assert.equal(historyDetailBody.record.completed_at, expectedResolutionAt);
assert.equal(historyDetailBody.record.lockout_resolution.resolution_at, null);
assert.equal(
  historyDetailBody.record.lockout_resolution.resolution_reason,
  operatorNote,
);

const deviceResponse = await deviceModule.handler(
  new Request("https://fixture.invalid/functions/v1/device-api/v2/sync", {
    method: "POST",
    headers: {
      authorization: "Bearer fixture-device-secret",
      "content-type": "application/json",
    },
    body: JSON.stringify(sync),
  }),
);
assert.deepEqual(
  rpcCalls.slice(-2).map(({ name }) => name),
  ["art38_authenticate_device", "art31_sync_manual_feed"],
);
assert.equal(deviceResponse.status, 200, await deviceResponse.clone().text());
const deviceResponseBody = await deviceResponse.json();
validateResponse("DeviceSyncResponse", deviceResponseBody);
assert.equal(deviceResponseBody.server_time, expectedCreatedAt);
assert.equal(deviceResponseBody.command.created_at, expectedCreatedAt);
assert.equal(deviceResponseBody.command.start_before, expectedStartBefore);

console.log(
  "Published-schema, PostgreSQL UTC response serialization, additive-field normalization, replay identity and malformed-field checks passed.",
);
