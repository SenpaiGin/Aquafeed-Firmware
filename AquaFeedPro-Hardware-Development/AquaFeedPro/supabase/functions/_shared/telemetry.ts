type TelemetryQuality = "valid" | "unavailable" | "uncalibrated" | "error";

const TELEMETRY_VALUE_KEYS = [
  "measured_at",
  "time_quality",
  "do_mg_l",
  "do_quality",
  "feed_remaining_g",
  "feed_percent",
  "feed_quality",
  "calibration_revision",
] as const;

function object(value: unknown): Record<string, unknown> | null {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}

function onlyKeys(value: Record<string, unknown>, allowed: readonly string[]) {
  return Object.keys(value).every((key) => allowed.includes(key));
}

function uuid(value: unknown): value is string {
  return (
    typeof value === "string" &&
    /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(
      value,
    )
  );
}

function utcTimestamp(value: unknown) {
  if (
    typeof value !== "string" ||
    !/^\d{4}-\d{2}-\d{2}T(?:[01]\d|2[0-3]):[0-5]\d:[0-5]\d(?:\.\d+)?Z$/.test(
      value,
    )
  )
    return false;
  const date = new Date(value);
  const parts =
    /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2}):(\d{2})/.exec(value);
  return (
    !!parts &&
    !Number.isNaN(date.valueOf()) &&
    date.getUTCFullYear() === Number(parts[1]) &&
    date.getUTCMonth() + 1 === Number(parts[2]) &&
    date.getUTCDate() === Number(parts[3]) &&
    date.getUTCHours() === Number(parts[4]) &&
    date.getUTCMinutes() === Number(parts[5]) &&
    date.getUTCSeconds() === Number(parts[6])
  );
}

function nullableFinite(value: unknown, maximum?: number) {
  return (
    value === null ||
    (typeof value === "number" &&
      Number.isFinite(value) &&
      value >= 0 &&
      (maximum === undefined || value <= maximum))
  );
}

function telemetryFields(sample: Record<string, unknown>) {
  return Object.fromEntries(TELEMETRY_VALUE_KEYS.map((key) => [key, sample[key]]));
}

function quality(value: unknown): value is TelemetryQuality {
  return (
    value === "valid" ||
    value === "unavailable" ||
    value === "uncalibrated" ||
    value === "error"
  );
}

export function validTelemetryValues(value: unknown): boolean {
  const sample = object(value);
  if (
    !sample ||
    !onlyKeys(sample, TELEMETRY_VALUE_KEYS) ||
    !(
      sample.time_quality === "synced" ||
      sample.time_quality === "rtc" ||
      sample.time_quality === "uncertain" ||
      sample.time_quality === "invalid"
    ) ||
    !quality(sample.do_quality) ||
    !quality(sample.feed_quality) ||
    !nullableFinite(sample.do_mg_l) ||
    !nullableFinite(sample.feed_remaining_g) ||
    !nullableFinite(sample.feed_percent, 100) ||
    !(
      sample.calibration_revision === null ||
      (typeof sample.calibration_revision === "number" &&
        Number.isSafeInteger(sample.calibration_revision) &&
        sample.calibration_revision > 0)
    )
  )
    return false;

  if (
    sample.time_quality === "invalid"
      ? sample.measured_at !== null
      : !utcTimestamp(sample.measured_at)
  )
    return false;
  if (
    sample.do_quality === "valid"
      ? typeof sample.do_mg_l !== "number"
      : sample.do_mg_l !== null
  )
    return false;
  if (
    sample.feed_quality === "valid"
      ? typeof sample.feed_remaining_g !== "number" ||
        typeof sample.feed_percent !== "number" ||
        typeof sample.calibration_revision !== "number"
      : sample.feed_remaining_g !== null ||
        sample.feed_percent !== null ||
        sample.calibration_revision !== null
  )
    return false;
  return true;
}

export function validLiveTelemetrySample(
  value: unknown,
  liveSequence: number,
): boolean {
  const sample = object(value);
  return (
    !!sample &&
    onlyKeys(sample, [...TELEMETRY_VALUE_KEYS, "sequence"]) &&
    Number.isSafeInteger(sample.sequence) &&
    sample.sequence === liveSequence &&
    validTelemetryValues(telemetryFields(sample))
  );
}

export function validHistoricalTelemetrySample(value: unknown): boolean {
  const sample = object(value);
  return (
    !!sample &&
    onlyKeys(sample, [...TELEMETRY_VALUE_KEYS, "boot_id", "sequence"]) &&
    uuid(sample.boot_id) &&
    Number.isSafeInteger(sample.sequence) &&
    Number(sample.sequence) >= 0 &&
    validTelemetryValues(telemetryFields(sample))
  );
}

export function validTelemetryBatch(
  bootId: unknown,
  liveSequence: number,
  latestSample: unknown,
  backlogSamples: unknown,
): boolean {
  if (
    !uuid(bootId) ||
    !Number.isSafeInteger(liveSequence) ||
    liveSequence < 0 ||
    (latestSample !== null &&
      !validLiveTelemetrySample(latestSample, liveSequence)) ||
    !Array.isArray(backlogSamples) ||
    backlogSamples.length > (latestSample === null ? 100 : 99) ||
    !backlogSamples.every(validHistoricalTelemetrySample)
  )
    return false;

  const identities = new Set<string>();
  if (latestSample !== null)
    identities.add(bootId.toLowerCase() + ":" + liveSequence);
  for (const value of backlogSamples) {
    const sample = object(value)!;
    const identity =
      String(sample.boot_id).toLowerCase() + ":" + String(sample.sequence);
    if (identities.has(identity)) return false;
    identities.add(identity);
  }
  return true;
}

export function telemetryRows(body: {
  boot_id: string;
  live_sequence: number;
  latest_sample: unknown;
  backlog_samples: unknown[];
}) {
  const rows: Record<string, unknown>[] = [];
  if (body.latest_sample !== null) {
    rows.push({
      ...object(body.latest_sample)!,
      boot_id: body.boot_id.toLowerCase(),
      live_sequence: body.live_sequence,
    });
  }
  for (const value of body.backlog_samples) {
    rows.push({ ...object(value)!, live_sequence: null });
  }
  return rows;
}
