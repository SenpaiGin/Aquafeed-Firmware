import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { registerHooks } from "node:module";

registerHooks({
  resolve(specifier, context, nextResolve) {
    if (
      specifier === "./device-access" &&
      context.parentURL?.endsWith("/src/lib/alerts.ts")
    ) {
      return {
        url: "data:text/javascript,export%20const%20requestAppApi%20%3D%20async%20()%20%3D%3E%20undefined",
        shortCircuit: true,
      };
    }
    return nextResolve(specifier, context);
  },
});

const { alertEntryFromEvent, alertLine, alertTitle, detectAlerts } =
  await import("../src/lib/alerts.ts");

const limits = { doLow: 4, doHigh: 9, feedLow: 20 };
const reading = (doMgL, feedPercent) => ({ doMgL, feedPercent });

// Limit not set: that kind is false and never raised, even from an active state.
assert.deepEqual(
  detectAlerts(
    reading(1, 1),
    { doLow: null, doHigh: null, feedLow: null },
    { do_low: true, do_high: true, feed_low: true },
  ),
  { state: { do_low: false, do_high: false, feed_low: false }, raised: [] },
);

// Value outside, previously inactive: raised.
assert.deepEqual(detectAlerts(reading(3.8, 18), limits, {}), {
  state: { do_low: true, do_high: false, feed_low: true },
  raised: ["do_low", "feed_low"],
});
assert.deepEqual(detectAlerts(reading(9.5, 50), limits, {}).raised, [
  "do_high",
]);

// Value outside, already active: stays active, not raised again.
assert.deepEqual(
  detectAlerts(reading(3.8, 18), limits, { do_low: true, feed_low: true }),
  { state: { do_low: true, do_high: false, feed_low: true }, raised: [] },
);

// Value null (unknown, stale, invalid): keeps an active alert active and raises nothing.
assert.deepEqual(
  detectAlerts(reading(null, null), limits, { do_low: true, feed_low: true }),
  { state: { do_low: true, do_high: false, feed_low: true }, raised: [] },
);
// Value null never raises from an inactive state either.
assert.deepEqual(detectAlerts(reading(null, null), limits, {}), {
  state: { do_low: false, do_high: false, feed_low: false },
  raised: [],
});

// Value back inside: cleared, so the next crossing raises again.
const cleared = detectAlerts(reading(6, 60), limits, {
  do_low: true,
  feed_low: true,
});
assert.deepEqual(cleared, {
  state: { do_low: false, do_high: false, feed_low: false },
  raised: [],
});
assert.deepEqual(detectAlerts(reading(3, 10), limits, cleared.state).raised, [
  "do_low",
  "feed_low",
]);

// Equal to the limit is inside, for every kind.
assert.deepEqual(detectAlerts(reading(4, 20), limits, {}).raised, []);
assert.deepEqual(detectAlerts(reading(9, 20), limits, {}).raised, []);

const entry = (kind, value, limit, simulated) => ({
  id: "1",
  deviceId: "d",
  deviceName: "Device 1",
  kind,
  value,
  limit,
  simulated,
  at: "2026-10-14T00:00:00Z",
  read: false,
  sequenceId: null,
});
assert.equal(
  alertLine(entry("do_low", 3.8, 4, false)),
  "3.8 mg/L · limit 4 · Device 1",
);
assert.equal(
  alertLine(entry("feed_low", 18, 20, true)),
  "18% · alert below 20% · Device 1 · Simulator",
);

// ART-100: feeding outcomes share one strict parser and one presentation with the push sender.
const device = {
  deviceId: "22222222-2222-4222-8222-222222222222",
  alias: "Pond A",
  model: "AquaFeed",
  isSimulated: false,
};
const telemetryEvent = {
  event_id: "11111111-1111-4111-8111-111111111111",
  device_id: device.deviceId,
  kind: "do_low",
  value: 3.8,
  limit: 4,
  measured_at: "2026-10-14T00:00:00Z",
  raised_at: "2026-10-14T00:00:01Z",
  applied_revision: 2,
  boot_id: "33333333-3333-4333-8333-333333333333",
  sample_sequence: 9,
  sequence_id: null,
  is_simulated: false,
  is_read: false,
  is_dismissed: false,
};
const feedingEvent = {
  ...telemetryEvent,
  kind: "feeding_partial",
  value: null,
  limit: null,
  measured_at: null,
  applied_revision: null,
  boot_id: null,
  sample_sequence: null,
  sequence_id: "55555555-5555-4555-8555-555555555555",
};
assert.equal(alertEntryFromEvent(telemetryEvent, device)?.sequenceId, null);
const feeding = alertEntryFromEvent(feedingEvent, device);
assert.equal(feeding?.sequenceId, feedingEvent.sequence_id);
assert.equal(
  feeding?.value,
  null,
  "no reading is invented for a feeding outcome",
);
assert.equal(alertTitle("feeding_partial"), "Feeding partly completed");
assert.equal(alertLine(feeding), "Only one nozzle completed · Pond A");
assert.equal(alertTitle("feeding_unknown"), "Feeding result unknown");
for (const forged of [
  { ...feedingEvent, value: 0 },
  { ...feedingEvent, sequence_id: null },
  { ...feedingEvent, boot_id: telemetryEvent.boot_id },
  { ...feedingEvent, kind: "feeding_succeeded" },
  { ...telemetryEvent, sequence_id: feedingEvent.sequence_id },
  { ...feedingEvent, device_id: "44444444-4444-4444-8444-444444444444" },
])
  assert.equal(
    alertEntryFromEvent(forged, device),
    null,
    JSON.stringify(forged),
  );

const controller = readFileSync(
  new URL("../src/lib/notification-controller.tsx", import.meta.url),
  "utf8",
);
const responseHandlerStart = controller.indexOf(
  "const handleResponse = useCallback(",
);
const responseHandlerEnd = controller.indexOf(
  "responseHandlerRef.current = handleResponse;",
  responseHandlerStart,
);
const responseHandler =
  responseHandlerStart >= 0 && responseHandlerEnd > responseHandlerStart
    ? controller.slice(responseHandlerStart, responseHandlerEnd)
    : null;
assert.ok(responseHandler, "push response handler remains present");
const retryBranch = responseHandler.indexOf('if (result === "retry")');
const processedMark = responseHandler.indexOf(
  "processedResponseRef.current.add(key)",
);
const definitiveClearResponse = responseHandler.indexOf(
  "clearLastNotificationResponseAsync",
  processedMark,
);
assert.ok(
  retryBranch >= 0 && retryBranch < processedMark,
  "transient tap failures remain retryable",
);
assert.match(
  responseHandler.slice(retryBranch, processedMark),
  /pendingResponseRef\.current = response/,
);
assert.ok(
  processedMark < definitiveClearResponse,
  "the native last response is cleared only after definitive handling",
);
assert.match(
  controller,
  /if \(pending\) void responseHandlerRef\.current\(pending\)/,
  "pending taps retry on app resume and bounded foreground refresh",
);

process.stdout.write("Alert rule checks passed.\n");
