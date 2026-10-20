import assert from "node:assert/strict";

import {
  agoText,
  clockParts,
  displayTime,
  feedingSummary,
  localTimeFromDate,
  pickerDate,
  relativeDayLabel,
  statusKind,
  statusText,
  zoneOffsetLabel,
} from "../src/components/feed-status.ts";

assert.equal(statusText("running"), "In progress");
assert.equal(statusText("something_new"), "something_new");
assert.equal(statusText("not_started"), "Not started");

assert.equal(agoText(null), "age unavailable");
assert.equal(agoText(0.4), "just now");
assert.equal(agoText(59.9), "59 seconds ago");
assert.equal(agoText(60), "1 min ago");
assert.equal(agoText(3599), "59 min ago");
assert.equal(agoText(3600), "1 h ago");
assert.equal(agoText(90000), "1 d ago");

const nozzle = (
  nozzle_number,
  grams,
  quality = grams === null ? "unavailable" : "valid",
) => ({
  nozzle_number,
  measurement_quality: quality,
  measured_dispensed_g: grams,
});
const both = [{ nozzle_number: 1 }, { nozzle_number: 2 }];
const summary = (status, targets, nozzle_results, simulated = false) =>
  feedingSummary({ status, targets, nozzle_results }, simulated);
assert.equal(
  summary("completed", both, [nozzle(1, 20.1), nozzle(2, 14.9)]),
  "Completed · 35 g measured",
);
assert.equal(
  summary("completed", both, [nozzle(1, 20.1), nozzle(2, 14.9)], true),
  "Completed · 35 g simulated",
);
// One nozzle without a valid measurement: no total at all, never a partial one.
assert.equal(
  summary("completed", both, [nozzle(1, 20.1), nozzle(2, null)]),
  "Completed",
);
assert.equal(summary("failed", both, [nozzle(1, 20)]), "Failed");
assert.equal(
  summary("completed", [{ nozzle_number: 1 }], [nozzle(1, 12, "error")]),
  "Completed",
);
assert.equal(summary("not_started", [], []), "Not started");

assert.equal(statusKind("partial"), "warning");
assert.equal(statusKind("expired"), "failed");
assert.equal(statusKind("something_new"), "unknown");

const now = new Date("2026-10-12T10:00:00Z");
const day = (iso) => relativeDayLabel(new Date(iso), "Asia/Manila", now);
assert.equal(day("2026-10-12T04:00:00Z"), "Today");
// Midnight in Manila belongs to the new day; one minute earlier does not.
assert.equal(day("2026-10-11T16:00:00Z"), "Today");
assert.equal(day("2026-10-11T15:59:00Z"), "Yesterday");
assert.equal(day("2026-10-12T16:00:00Z"), "Tomorrow");

const { time } = clockParts(now, "Asia/Manila");
assert.ok(time.includes("6") && time.includes("00"), time);

// ART-99: the picker round-trips feeder-local HH:mm in the phone's own calendar, whatever its zone.
for (const time of [
  "00:00",
  "00:01",
  "11:59",
  "12:00",
  "12:30",
  "23:59",
  "08:05",
])
  assert.equal(localTimeFromDate(pickerDate(time)), time, time);
assert.equal(
  localTimeFromDate(new Date(2000, 0, 1, 0, 0)),
  "00:00",
  "12:00 AM",
);
assert.equal(
  localTimeFromDate(new Date(2000, 0, 1, 12, 0)),
  "12:00",
  "12:00 PM",
);
assert.equal(
  localTimeFromDate(new Date(2000, 0, 1, 23, 59)),
  "23:59",
  "11:59 PM",
);
assert.match(displayTime("00:00"), /^(12:00\sAM|00:00)$/u);
assert.match(displayTime("12:00"), /^(12:00\sPM|12:00)$/u);
assert.match(displayTime("23:59"), /^(11:59\sPM|23:59)$/u);
assert.equal(displayTime("bad"), "bad");

const january = new Date(Date.UTC(2026, 0, 15, 12));
const july = new Date(Date.UTC(2026, 6, 15, 12));
assert.equal(zoneOffsetLabel("Asia/Manila", july), "UTC+08:00");
assert.equal(zoneOffsetLabel("UTC", july), "UTC+00:00");
assert.equal(zoneOffsetLabel("Asia/Kathmandu", july), "UTC+05:45");
assert.equal(zoneOffsetLabel("Asia/Kolkata", january), "UTC+05:30");
assert.equal(zoneOffsetLabel("America/St_Johns", january), "UTC−03:30");
assert.equal(zoneOffsetLabel("America/St_Johns", july), "UTC−02:30");
assert.equal(zoneOffsetLabel("America/New_York", january), "UTC−05:00");
assert.equal(zoneOffsetLabel("America/New_York", july), "UTC−04:00");
assert.equal(zoneOffsetLabel("Australia/Adelaide", january), "UTC+10:30");
assert.equal(zoneOffsetLabel("Not/AZone", july), null);

process.stdout.write("Feed status label and day/clock checks passed.\n");
