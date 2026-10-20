import assert from "node:assert/strict";
import { registerHooks } from "node:module";

const deviceId = "22222222-2222-4222-8222-222222222222";
const installA = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
const installB = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb";
const revokedInstall = "cccccccc-cccc-4ccc-8ccc-cccccccccccc";
const requestId = "dddddddd-dddd-4ddd-8ddd-dddddddddddd";
const eventState = new Map();
const pushTokens = new Map();
const calls = [];
let malformedPage = false;
let malformedDetail = null;
let detailOverride = null;
let denyBulk = false;
let latestSequence = 51;
let serveHandler;

const sessions = new Map([
  ["verified-installation-a", installA],
  ["verified-installation-b", installB],
  ["revoked-installation", revokedInstall],
]);

function eventAt(sequence) {
  const micro = String(Math.min(999999, 999948 + sequence)).padStart(6, "0");
  return {
    event_id: `00000000-0000-4000-8000-${String(sequence).padStart(12, "0")}`,
    device_id: deviceId,
    kind: "do_low",
    value: 2.5,
    limit: 4,
    measured_at: "2026-10-14T10:00:00.000Z",
    raised_at: `2026-10-14T10:00:00.${micro}Z`,
    applied_revision: 3,
    boot_id: "eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee",
    sample_sequence: sequence,
    sequence_id: null,
    is_simulated: true,
    is_read: eventState.get(installA)?.read?.has(sequence) ?? false,
    is_dismissed: false,
  };
}

function orderedEvents(installation) {
  const dismissed = eventState.get(installation)?.dismissed ?? new Set();
  return Array.from({ length: latestSequence }, (_, index) => latestSequence - index)
    .filter((sequence) => !dismissed.has(sequence))
    .map((sequence) => {
      const event = eventAt(sequence);
      event.is_read = eventState.get(installation)?.read?.has(sequence) ?? false;
      return event;
    });
}

function compareCutoff(event, raisedAt, eventId) {
  const exactMicros = (value) => {
    const match = /^(.*:\d{2})(?:\.(\d{1,6}))?(?:Z|\+00:00)$/.exec(value);
    assert.ok(match, `valid UTC timestamp expected: ${value}`);
    return BigInt(Date.parse(`${match[1]}Z`)) * 1000n + BigInt((match[2] ?? "").padEnd(6, "0"));
  };
  const leftTime = exactMicros(event.raised_at);
  const rightTime = exactMicros(raisedAt);
  return leftTime < rightTime || (leftTime === rightTime && event.event_id <= eventId);
}

globalThis.__alertAdmin = {
  async rpc(name, args) {
    calls.push({ name, args });
    if (args.p_installation_id === revokedInstall)
      return { data: { status: "not_active" }, error: null };
    if (name === "art96_register_push_token") {
      const current = pushTokens.get(args.p_installation_id);
      if (current?.token === args.p_expo_push_token && current.project === args.p_eas_project_id)
        return { data: { status: "ok", generation: current.generation }, error: null };
      const next = { token: args.p_expo_push_token, project: args.p_eas_project_id, generation: (current?.generation ?? 0) + 1 };
      pushTokens.set(args.p_installation_id, next);
      return { data: { status: "ok", generation: next.generation }, error: null };
    }
    if (name === "art96_revoke_push_token") {
      pushTokens.delete(args.p_installation_id);
      return { data: { status: "ok" }, error: null };
    }
    if (name === "art96_read_alert_event") {
      if (malformedDetail === "null") return { data: null, error: null };
      if (malformedDetail === "array") return { data: [], error: null };
      if (detailOverride) return { data: { status: "ok", ...detailOverride }, error: null };
      const sequence = Number(args.p_event_id.slice(-12));
      return { data: { status: "ok", ...eventAt(sequence) }, error: null };
    }
    if (name === "art95_list_alert_events") {
      let events = orderedEvents(args.p_installation_id);
      if (args.p_before_raised_at) {
        events = events.filter((event) =>
          event.raised_at < args.p_before_raised_at ||
          (event.raised_at === args.p_before_raised_at && event.event_id < args.p_before_event_id));
      }
      if (malformedPage) events[0] = { ...events[0], private_read_at: "must-not-leak" };
      const page = events.slice(0, 51);
      const state = eventState.get(args.p_installation_id);
      const read = state?.read ?? new Set();
      const dismissed = state?.dismissed ?? new Set();
      const unread = orderedEvents(args.p_installation_id)
        .filter((event) => !read.has(event.sample_sequence) && !dismissed.has(event.sample_sequence)).length;
      return { data: { status: "ok", events: page, has_more: events.length > 50, unread_count: unread }, error: null };
    }
    if (name === "art95_set_alert_event_state") {
      const sequence = Number(args.p_event_id.slice(-12));
      const state = eventState.get(args.p_installation_id) ?? { read: new Set(), dismissed: new Set() };
      state.read.add(sequence);
      if (args.p_action === "dismiss") state.dismissed.add(sequence);
      eventState.set(args.p_installation_id, state);
      return { data: { status: "ok", event_id: args.p_event_id, is_read: true, is_dismissed: args.p_action === "dismiss" }, error: null };
    }
    if (name === "art95_bulk_alert_event_state") {
      if (denyBulk) return { data: { status: "not_active" }, error: null };
      const state = eventState.get(args.p_installation_id) ?? { read: new Set(), dismissed: new Set() };
      for (const event of orderedEvents(args.p_installation_id)) {
        if (compareCutoff(event, args.p_through_raised_at, args.p_through_event_id)) {
          state.read.add(event.sample_sequence);
          if (args.p_action === "dismiss") state.dismissed.add(event.sample_sequence);
        }
      }
      eventState.set(args.p_installation_id, state);
      return {
        data: {
          status: "ok",
          action: args.p_action,
          through_raised_at: args.p_through_raised_at.replace(".123450", ".12345"),
          through_event_id: args.p_through_event_id,
        },
        error: null,
      };
    }
    assert.fail(`unexpected RPC ${name}`);
  },
};

globalThis.Deno = {
  serve(handler) { serveHandler = handler; },
};

const sharedMock = `
export const admin = globalThis.__alertAdmin;
export function apiError(requestId, status, code, message, retryable = false) {
  return Response.json({ error: { code, message, request_id: requestId, retryable } }, { status });
}
export function characterLength(value) { return Array.from(value).length; }
export async function installationId(request) {
  const token = request.headers.get("authorization")?.replace(/^Bearer\\s+/i, "");
  return globalThis.__alertSessions.get(token) ?? null;
}
export function isUuid(value) {
  return typeof value === "string" && /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(value);
}
export function json(value, status = 200) { return Response.json(value, { status, headers: { "cache-control": "no-store" } }); }
export function normalizeUtcTimestamp(value) { return normalizeUtcTimestampForResponse(value); }
export function normalizeUtcTimestampForResponse(value) {
  if (typeof value !== "string" || !/^\\d{4}-\\d{2}-\\d{2}T\\d{2}:\\d{2}:\\d{2}(?:\\.\\d{1,6})?(?:Z|\\+00:00)$/i.test(value)) return null;
  const date = new Date(value);
  if (Number.isNaN(date.valueOf())) return null;
  return value.replace(/\\+00:00$/i, "Z");
}
export function onlyKeys(value, keys) { return Object.keys(value).every((key) => keys.includes(key)); }
export function protocolMajor(request) { return request.headers.get("x-protocol-major") === "2" ? 2 : null; }
export async function readJson(request) {
  try { return { value: await request.json(), response: null }; }
  catch { return { value: null, response: json({ error: { code: "INVALID_INPUT" } }, 400) }; }
}
export function record(value) { return typeof value === "object" && value !== null && !Array.isArray(value) ? value : null; }
export function requestIdFrom(value) { return isUuid(value?.request_id) ? value.request_id.toLowerCase() : null; }
export function sha256Hex(value) { return value; }
export async function takeRateLimit() { return true; }
`;
globalThis.__alertSessions = sessions;

registerHooks({
  load(url, context, nextLoad) {
    if (url.endsWith("/supabase/functions/_shared/device-access.ts"))
      return { format: "module", shortCircuit: true, source: sharedMock };
    return nextLoad(url, context);
  },
});

await import("../functions/app-api/index.ts");
assert.equal(typeof serveHandler, "function", "the actual app-api handler is registered");

async function invoke(path, { method = "GET", token = "verified-installation-a", body, query = "" } = {}) {
  const headers = {
    authorization: `Bearer ${token}`,
    "x-protocol-major": "2",
    "x-request-id": requestId,
  };
  if (body !== undefined) headers["content-type"] = "application/json";
  return await serveHandler(new Request(`https://local/functions/v1/app-api/v2${path}${query}`, {
    method,
    headers,
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  }));
}

const historyPath = `/devices/${deviceId}/notifications`;
const eventId = "00000000-0000-4000-8000-000000000051";
let response = await invoke(historyPath);
assert.equal(response.status, 200, JSON.stringify(await response.clone().json()));
let page = await response.json();
assert.equal(page.events.length, 50);
assert.equal(page.has_more, true);
assert.equal(page.unread_count, 51);
assert.equal(Object.hasOwn(page.events[0], "private_read_at"), false);
assert.equal(calls.at(-1).args.p_installation_id, installA, "the verified session identity scopes RPCs");
assert.equal(calls.at(-1).args.p_before_raised_at, null);
const firstCursor = page.next_cursor;

response = await invoke(historyPath, { query: `?cursor=${encodeURIComponent(firstCursor)}` });
assert.equal(response.status, 200);
page = await response.json();
assert.equal(calls.at(-1).args.p_installation_id, installA);
assert.equal(calls.at(-1).args.p_before_raised_at, "2026-10-14T10:00:00.999950Z");
assert.equal(calls.at(-1).args.p_before_event_id, "00000000-0000-4000-8000-000000000002");

response = await invoke(historyPath, { token: "verified-installation-b" });
assert.equal(response.status, 200);
page = await response.json();
assert.equal(page.events[0].is_read, false, "another installation sees its own unread state");

const readBody = { protocol_major: 2, request_id: requestId, action: "read" };
response = await invoke(`${historyPath}/00000000-0000-4000-8000-000000000051`, { method: "PATCH", body: readBody });
assert.equal(response.status, 200);
assert.equal(calls.at(-1).args.p_installation_id, installA);
assert.equal(calls.at(-1).args.p_action, "read");
response = await invoke(historyPath);
page = await response.json();
assert.equal(page.events[0].is_read, true, "the action changes the same installation history");
response = await invoke(historyPath, { token: "verified-installation-b" });
page = await response.json();
assert.equal(page.events[0].is_read, false, "one installation cannot change another installation state");

const cutoff = {
  protocol_major: 2,
  request_id: requestId,
  action: "mark_read",
  through: { raised_at: "2026-10-14T10:00:00.123450Z", event_id: "00000000-0000-4000-8000-000000000010" },
};
response = await invoke(`${historyPath}/actions`, { method: "POST", body: cutoff });
assert.equal(response.status, 200, "equivalent timestamp precision is accepted");
assert.equal(calls.at(-1).args.p_through_raised_at, "2026-10-14T10:00:00.123450Z");
const capturedEventCutoff = {
  ...cutoff,
  through: { raised_at: "2026-10-14T10:00:00.999958Z", event_id: "00000000-0000-4000-8000-000000000010" },
};
response = await invoke(`${historyPath}/actions`, { method: "POST", body: capturedEventCutoff });
assert.equal(response.status, 200);
latestSequence = 52;
response = await invoke(historyPath);
page = await response.json();
assert.equal(page.unread_count, 41);
assert.equal(page.events[0].sample_sequence, 52);
assert.equal(page.events[0].is_read, false, "a newer event remains outside the captured bulk cutoff");

response = await invoke(historyPath, { query: "?limit=1" });
assert.equal(response.status, 400, "unknown query keys are rejected");
response = await invoke(`${historyPath}/${eventId}`);
assert.equal(response.status, 200, "authorized event detail is readable for tap verification");
let detail = await response.json();
assert.equal(detail.event.event_id, eventId);
assert.equal(calls.at(-1).name, "art96_read_alert_event");
assert.equal(calls.at(-1).args.p_installation_id, installA);
for (const kind of ["null", "array"]) {
  malformedDetail = kind;
  response = await invoke(`${historyPath}/${eventId}`);
  assert.equal(response.status, 503, `a ${kind} event detail RPC result is sanitized as unavailable`);
  assert.equal((await response.json()).error.retryable, true);
}
malformedDetail = null;

// ART-100: a feeding outcome references its sequence and carries no reading facts.
const feedingEvent = {
  ...(await (async () => (await invoke(`${historyPath}/${eventId}`)).json())()).event,
  kind: "feeding_unknown",
  value: null,
  limit: null,
  measured_at: null,
  applied_revision: null,
  boot_id: null,
  sample_sequence: null,
  sequence_id: "55555555-5555-4555-8555-555555555555",
};
detailOverride = feedingEvent;
response = await invoke(`${historyPath}/${eventId}`);
assert.equal(response.status, 200, "a feeding outcome event is readable");
detail = await response.json();
assert.equal(detail.event.kind, "feeding_unknown");
assert.equal(detail.event.sequence_id, "55555555-5555-4555-8555-555555555555");
assert.equal(detail.event.value, null, "no reading is invented for a feeding outcome");
for (const forged of [
  { ...feedingEvent, value: 0 },
  { ...feedingEvent, sequence_id: null },
  { ...feedingEvent, boot_id: "eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee" },
  { ...feedingEvent, kind: "do_low" },
  { ...feedingEvent, kind: "feeding_succeeded" },
]) {
  detailOverride = forged;
  response = await invoke(`${historyPath}/${eventId}`);
  assert.equal(response.status, 503, "an event mixing feeding and reading facts is rejected");
}
detailOverride = null;
response = await invoke(`${historyPath}/${eventId}`, { query: "?url=https://invalid.example" });
assert.equal(response.status, 400, "tap detail rejects query-controlled routing data");
response = await invoke(`${historyPath}/00000000-0000-4000-8000-000000000051`, {
  method: "PATCH",
  body: { ...readBody, installation_id: installB },
});
assert.equal(response.status, 400, "body-supplied installation identity is rejected");
const beforeInvalidCutoff = calls.length;
response = await invoke(`${historyPath}/actions`, {
  method: "POST",
  body: { ...cutoff, through: { ...cutoff.through, raised_at: "2026-10-14T10:00:00.1234567Z" } },
});
assert.equal(response.status, 400, "sub-microsecond cutoff input is rejected");
assert.equal(calls.length, beforeInvalidCutoff, "invalid input never reaches the service RPC");

response = await invoke(historyPath, { token: "unknown-token" });
assert.equal(response.status, 401, "an unverified installation receives no history");
response = await invoke(historyPath, { token: "revoked-installation" });
assert.equal(response.status, 403, "the service rechecks active access on read");
response = await invoke(`${historyPath}/${eventId}`, { token: "revoked-installation" });
assert.equal(response.status, 403, "the service rechecks active access for a tap read");
denyBulk = true;
response = await invoke(`${historyPath}/actions`, { method: "POST", token: "revoked-installation", body: cutoff });
assert.equal(response.status, 403, "the service rechecks active access on action");
denyBulk = false;

malformedPage = true;
response = await invoke(historyPath);
assert.equal(response.status, 503, "malformed backend DTOs are rejected");
malformedPage = false;

const pushPath = "/push-token";
const syntheticToken = "ExponentPushToken[synthetic_android_token_001]";
const registerBody = {
  protocol_major: 2,
  request_id: requestId,
  platform: "android",
  eas_project_id: "1b3dc89f-3111-49d4-b91f-d5567e71d996",
  expo_push_token: syntheticToken,
};
response = await invoke(pushPath, { method: "POST", body: registerBody });
assert.equal(response.status, 200, "strict synthetic Android token registration succeeds");
let tokenResponse = await response.json();
assert.equal(tokenResponse.registered, true);
assert.equal(JSON.stringify(tokenResponse).includes(syntheticToken), false, "registration response never echoes the token");
assert.equal(calls.at(-1).name, "art96_register_push_token");
assert.equal(calls.at(-1).args.p_installation_id, installA, "registration identity comes only from the verified JWT");
assert.equal(calls.at(-1).args.p_expo_push_token, syntheticToken);
const firstGeneration = pushTokens.get(installA).generation;
response = await invoke(pushPath, { method: "POST", body: registerBody });
assert.equal(response.status, 200);
assert.equal(pushTokens.get(installA).generation, firstGeneration, "repeated registration of the same token remains idempotent");
const registerCallCount = calls.length;
response = await invoke(pushPath, { method: "POST", body: { ...registerBody, platform: "ios" } });
assert.equal(response.status, 400, "iOS token registration is rejected by the Android-only route");
response = await invoke(pushPath, { method: "POST", body: { ...registerBody, eas_project_id: installB } });
assert.equal(response.status, 400, "another EAS project token is rejected");
response = await invoke(pushPath, { method: "POST", body: { ...registerBody, expo_push_token: "ExponentPushToken[bad token]" } });
assert.equal(response.status, 400, "malformed tokens are rejected before RPC");
response = await invoke(pushPath, { method: "POST", body: { ...registerBody, installation_id: installB } });
assert.equal(response.status, 400, "caller-supplied installation identity is rejected");
assert.equal(calls.length, registerCallCount, "invalid token bodies never reach the service RPC");
response = await invoke(pushPath, { method: "POST", token: "revoked-installation", body: registerBody });
assert.equal(response.status, 403, "registration requires at least one active feeder");
response = await invoke(pushPath, { method: "DELETE", body: { protocol_major: 2, request_id: requestId } });
assert.equal(response.status, 200);
tokenResponse = await response.json();
assert.equal(tokenResponse.registered, false);
assert.equal(JSON.stringify(tokenResponse).includes(syntheticToken), false, "revocation response never echoes the token");
assert.equal(calls.at(-1).name, "art96_revoke_push_token");
assert.equal(calls.at(-1).args.p_installation_id, installA, "revocation identity comes only from the verified JWT");

console.log("ART-95/96 app-api mocked route checks passed (history, tap reads, token registration/revocation, strict input, installation state, access, malformed DTO).");
