import assert from "node:assert/strict";
import { registerHooks } from "node:module";

const projectId = "1b3dc89f-3111-49d4-b91f-d5567e71d996";
const installationId = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
const deviceId = "22222222-2222-4222-8222-222222222222";
const deliveries = [1, 2].map((number) => ({
  delivery_id: `11111111-1111-4111-8111-${String(number).padStart(12, "0")}`,
  event_id: `22222222-2222-4222-8222-${String(number).padStart(12, "0")}`,
  device_id: deviceId,
  installation_id: installationId,
  token_generation: 4,
  eas_project_id: projectId,
  lease_id: `33333333-3333-4333-8333-${String(number).padStart(12, "0")}`,
  // ART-100: one telemetry crossing and one feeding outcome, which has no reading or limit.
  kind: number === 1 ? "do_low" : "feeding_partial",
  value: number === 1 ? 2.5 : null,
  limit: number === 1 ? 4 : null,
  raised_at: "2026-10-14T10:00:00.123456Z",
  is_simulated: true,
  device_name: `Synthetic feeder ${number}`,
}));
const syntheticTokens = [
  "ExponentPushToken[synthetic_sender_token_001]",
  "ExponentPushToken[synthetic_sender_token_002]",
];
const calls = [];
const sendRecords = [];
const receiptRecords = [];
const env = new Map();
let scenario = "429";
let validationCount = 0;
let handler;

const admin = {
  async rpc(name, args = {}) {
    calls.push({ name, args });
    if (name === "art96_push_sender_status") return { data: { status: "ready", reason: null }, error: null };
    if (name === "art96_claim_push_deliveries") return { data: { status: "ok", project_id: projectId, deliveries }, error: null };
    if (name === "art96_validate_push_send_batch") {
      validationCount += 1;
      assert.ok(args.p_claims.length <= 100);
      if (scenario === "rotation-before-send" && validationCount === 1)
        return { data: { status: "ok", delivery_ids: [] }, error: null };
      return { data: { status: "ok", delivery_ids: args.p_claims.map((item) => item.delivery_id) }, error: null };
    }
    if (name === "art96_begin_push_send") {
      const index = deliveries.findIndex((item) => item.delivery_id === args.p_delivery_id);
      return { data: { status: "ok", ...deliveries[index], expo_push_token: syntheticTokens[index] }, error: null };
    }
    if (name === "art96_record_push_send") {
      if (scenario === "record-failure" && args.p_outcome === "accepted") throw new Error("synthetic persistence timeout");
      sendRecords.push(args);
      return { data: { status: "ok" }, error: null };
    }
    if (name === "art96_claim_push_receipts") {
      if (!new Set(["accepted", "receipt-transport", "receipt-invalid-credentials"]).has(scenario)) return { data: { status: "ok", receipts: [] }, error: null };
      return {
        data: {
          status: "ok",
          receipts: deliveries.map((item, index) => ({
            delivery_id: item.delivery_id,
            ticket_id: `synthetic-ticket-${index + 1}`,
            token_generation: item.token_generation,
            lease_id: item.lease_id,
            eas_project_id: item.eas_project_id,
          })),
        },
        error: null,
      };
    }
    if (name === "art96_record_push_receipt") {
      receiptRecords.push(args);
      return { data: { status: "ok" }, error: null };
    }
    assert.fail(`unexpected RPC ${name}`);
  },
};

globalThis.__senderAdmin = admin;
globalThis.Deno = {
  serve(value) { handler = value; },
  env: { get(name) { return env.get(name); } },
};

registerHooks({
  load(url, context, nextLoad) {
    if (url.endsWith("/supabase/functions/_shared/device-access.ts")) {
      return {
        format: "module",
        shortCircuit: true,
        source: `
          export const admin = globalThis.__senderAdmin;
          export function json(value, status = 200) {
            return Response.json(value, { status, headers: { "cache-control": "no-store" } });
          }
        `,
      };
    }
    return nextLoad(url, context);
  },
});

const { workerSecretMatches, runPushSender } = await import("../functions/_shared/push-sender.ts");
assert.equal(workerSecretMatches(undefined, "anything"), false);
assert.equal(workerSecretMatches("synthetic-secret", null), false);
assert.equal(workerSecretMatches("synthetic-secret", "wrong"), false);
assert.equal(workerSecretMatches("synthetic-secret", "synthetic-secret"), true);

const originalFetch = globalThis.fetch;
const transportCalls = [];
globalThis.fetch = async (url, options) => {
  transportCalls.push({ url: String(url), options });
  if (String(url).endsWith("/push/send")) {
    const messages = JSON.parse(options.body);
    assert.equal(messages.length, 2, "the transport request stays within one project batch");
    for (const [index, message] of messages.entries()) {
      assert.equal(message.to, syntheticTokens[index]);
      assert.equal(message.channelId, "feeder-alerts");
      assert.equal(message.tag, deliveries[index].event_id);
      assert.equal(message.collapseId, deliveries[index].event_id);
      assert.deepEqual(Object.keys(message.data).sort(), ["device_id", "event_id", "route_hint"]);
      assert.equal(message.data.route_hint, "notifications");
      assert.equal(message.title, ["Oxygen below limit", "Feeding partly completed"][index]);
      assert.equal(
        message.body,
        ["2.5 mg/L · limit 4", "Only one nozzle completed"][index] + ` · Synthetic feeder ${index + 1} · Simulator`,
      );
    }
    if (scenario === "ambiguous") throw new Error("synthetic timeout");
    if (scenario === "429") return new Response("{}", { status: 429 });
      if (scenario === "401") return new Response("{}", { status: 401 });
      if (scenario === "400") return new Response("{}", { status: 400 });
      if (scenario === "503") return new Response("{}", { status: 503 });
      if (scenario === "malicious-ticket-error") {
        return Response.json({ data: [
          { status: "error", details: { error: "synthetic-secret-value" }, message: syntheticTokens[0] },
          { status: "error", details: { error: "synthetic-secret-value" }, message: syntheticTokens[1] },
        ] });
      }
    if (scenario === "ticket-error") {
      return Response.json({ data: [
        { status: "error", details: { error: "DeviceNotRegistered" } },
        { status: "error", details: { error: "MessageRateExceeded" } },
      ] });
    }
    return Response.json({ data: [
      { status: "ok", id: "synthetic-ticket-1" },
      { status: "ok", id: "synthetic-ticket-2" },
    ] });
  }
  assert.ok(String(url).endsWith("/push/getReceipts"));
  if (scenario === "receipt-transport") throw new Error("synthetic receipt timeout");
  if (scenario === "receipt-invalid-credentials") return new Response("{}", { status: 401 });
  return Response.json({ data: {
    "synthetic-ticket-1": { status: "ok" },
    "synthetic-ticket-2": { status: "error", details: { error: "DeviceNotRegistered" } },
  } });
};

await import("../functions/push-sender/index.ts");
assert.equal(typeof handler, "function", "the actual push-sender Edge handler is registered");
async function invoke(secret, authorization) {
  return handler(new Request("https://local/functions/v1/push-sender", {
    method: "POST",
    headers: {
      ...(secret ? { "x-push-worker-secret": secret } : {}),
      ...(authorization ? { authorization } : {}),
    },
  }));
}

let response = await invoke(undefined);
assert.equal(response.status, 503, "missing owner secret keeps the sender disabled");
assert.deepEqual(await response.json(), { status: "disabled" });
env.set("PUSH_WORKER_SECRET", "synthetic-owner-only-worker-secret");
response = await invoke(undefined, "Bearer ordinary-app-jwt-only");
assert.equal(response.status, 401, "ordinary app JWT cannot invoke the sender");
response = await invoke("wrong-secret");
assert.equal(response.status, 401, "wrong worker secret is rejected");
assert.equal(calls.length, 0);

scenario = "429";
response = await invoke("synthetic-owner-only-worker-secret");
assert.equal(response.status, 200);
let result = await response.json();
assert.equal(result.status, "ready");
assert.equal(result.sent, 0);
assert.equal(JSON.stringify(result).includes(syntheticTokens[0]), false, "handler output never includes a token");
assert.deepEqual(sendRecords.slice(-2).map((item) => item.p_outcome), ["retry", "retry"]);
assert.deepEqual(sendRecords.slice(-2).map((item) => item.p_error), ["message_rate_exceeded", "message_rate_exceeded"]);
assert.equal(validationCount, 1, "active access and token generation are rechecked after all preparation and immediately before send");

scenario = "accepted";
response = await invoke("synthetic-owner-only-worker-secret");
result = await response.json();
assert.equal(result.sent, 2);
assert.equal(result.receipts, 2);
assert.deepEqual(sendRecords.slice(-2).map((item) => item.p_outcome), ["accepted", "accepted"]);
assert.deepEqual(receiptRecords.map((item) => item.p_status), ["ok", "error"]);
assert.equal(receiptRecords[1].p_error, "DeviceNotRegistered");
assert.equal(transportCalls.filter((item) => item.url.endsWith("/push/send")).length, 2);
assert.equal(transportCalls.filter((item) => item.url.endsWith("/push/getReceipts")).length, 1);

scenario = "ambiguous";
const beforeAmbiguous = sendRecords.length;
const ambiguous = await runPushSender({ admin, fetcher: globalThis.fetch });
assert.equal(ambiguous.status, "ready");
assert.deepEqual(sendRecords.slice(beforeAmbiguous).map((item) => item.p_outcome), ["ambiguous", "ambiguous"]);

scenario = "ticket-error";
const beforeErrors = sendRecords.length;
const ticketErrors = await runPushSender({ admin, fetcher: globalThis.fetch });
assert.equal(ticketErrors.status, "ready");
assert.deepEqual(sendRecords.slice(beforeErrors).map((item) => item.p_outcome), ["device_not_registered", "retry"]);
assert.deepEqual(sendRecords.slice(beforeErrors).map((item) => item.p_error), ["device_not_registered", "message_rate_exceeded"]);

scenario = "rotation-before-send";
const beforeRotation = transportCalls.length;
validationCount = 0;
const rotated = await runPushSender({ admin, fetcher: globalThis.fetch });
assert.equal(rotated.status, "ready");
assert.equal(validationCount, 1);
assert.equal(transportCalls.length, beforeRotation, "a token generation changed during preparation so no stale batch reached Expo");

scenario = "401";
const beforeCredentials = sendRecords.length;
await runPushSender({ admin, fetcher: globalThis.fetch });
assert.deepEqual(sendRecords.slice(beforeCredentials).map((item) => [item.p_outcome, item.p_error]), [
  ["invalid_credentials", "invalid_credentials"],
  ["invalid_credentials", "invalid_credentials"],
]);

scenario = "503";
const beforeServerError = sendRecords.length;
await runPushSender({ admin, fetcher: globalThis.fetch });
assert.deepEqual(sendRecords.slice(beforeServerError).map((item) => [item.p_outcome, item.p_error]), [
  ["retry", "transport_retry"],
  ["retry", "transport_retry"],
]);

scenario = "400";
const beforeBadRequest = sendRecords.length;
await runPushSender({ admin, fetcher: globalThis.fetch });
assert.deepEqual(sendRecords.slice(beforeBadRequest).map((item) => [item.p_outcome, item.p_error]), [
  ["invalid_payload", "invalid_payload"],
  ["invalid_payload", "invalid_payload"],
]);

scenario = "malicious-ticket-error";
const beforeSanitized = sendRecords.length;
await runPushSender({ admin, fetcher: globalThis.fetch });
assert.deepEqual(sendRecords.slice(beforeSanitized).map((item) => [item.p_outcome, item.p_error]), [
  ["invalid_payload", "invalid_payload"],
  ["invalid_payload", "invalid_payload"],
]);
assert.equal(JSON.stringify(sendRecords.slice(beforeSanitized)).includes(syntheticTokens[0]), false, "provider error text cannot leak token strings into persistence");

scenario = "record-failure";
const beforeRecordFailure = sendRecords.length;
const beforeRecordFailureCalls = transportCalls.length;
const persistedUnknown = await runPushSender({ admin, fetcher: globalThis.fetch });
assert.equal(persistedUnknown.sent, 2, "Expo ticket acceptance stays distinct from a database write failure");
assert.equal(transportCalls.length, beforeRecordFailureCalls + 1);
assert.equal(sendRecords.slice(beforeRecordFailure).some((item) => item.p_outcome === "ambiguous"), false, "a failed accepted-ticket write is not overwritten as an ambiguous transport response");

scenario = "receipt-transport";
const beforeReceiptRetry = receiptRecords.length;
const receiptRetry = await runPushSender({ admin, fetcher: globalThis.fetch });
assert.equal(receiptRetry.status, "ready");
assert.deepEqual(receiptRecords.slice(beforeReceiptRetry).map((item) => [item.p_status, item.p_error]), [
  ["retry", "transport_retry"],
  ["retry", "transport_retry"],
]);
assert.equal(sendRecords.slice(-2).every((item) => item.p_outcome === "accepted"), true, "receipt polling failure does not rewrite accepted sends");

scenario = "receipt-invalid-credentials";
const beforeReceiptCredentials = receiptRecords.length;
await runPushSender({ admin, fetcher: globalThis.fetch });
assert.deepEqual(receiptRecords.slice(beforeReceiptCredentials).map((item) => [item.p_status, item.p_error]), [
  ["retry", "InvalidCredentials"],
  ["retry", "InvalidCredentials"],
]);

assert.ok(transportCalls.every((item) => item.url === "https://exp.host/--/api/v2/push/send" || item.url === "https://exp.host/--/api/v2/push/getReceipts"), "all network transport is intercepted at the synthetic Expo mock");

globalThis.fetch = originalFetch;
console.log("ART-96 push sender checks passed (secret gate, final access/generation recheck, one-project batching, sanitized errors, retries, ambiguous sends, ticket persistence and bounded receipt retries).");
