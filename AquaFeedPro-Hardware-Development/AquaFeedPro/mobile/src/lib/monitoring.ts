import { requestAppApi } from "./device-access";
import { normalizeUtcTimestamp } from "./device-access-state";
import type { ConfigurationValues } from "./schedules";

export type SensorQuality = "valid" | "unavailable" | "uncalibrated" | "error";
export type Freshness = "fresh" | "stale" | "unknown";
export type GraphWindow = "1h" | "6h" | "24h";

export type CurrentTelemetry = {
  boot_id: string;
  sequence: number;
  live_sequence: number;
  measured_at: string | null;
  time_quality: "synced" | "rtc" | "uncertain" | "invalid";
  do_mg_l: number | null;
  do_quality: SensorQuality;
  feed_remaining_g: number | null;
  feed_percent: number | null;
  feed_quality: SensorQuality;
  calibration_revision: number | null;
  received_at: string;
  sample_age_seconds: number | null;
  ingestion_age_seconds: number;
  do_freshness: Freshness;
  feed_freshness: Freshness;
};

export type MonitoringSnapshot = {
  request_id: string;
  device_id: string;
  server_time: string;
  profile: {
    firmware_version: string;
    protocol_major: 2;
    capabilities_revision: number;
    capabilities: {
      do_monitoring: boolean;
      feed_remaining_monitoring: boolean;
      feed_capacity_g: number | null;
    };
    is_simulated: boolean;
  };
  contact: {
    authenticated_at: string | null;
    age_seconds: number | null;
    freshness: Freshness;
  };
  configuration: {
    desired_revision: number | null;
    applied_revision: number | null;
    pending_revision: number | null;
    last_attempt_status: "pending" | "applied" | "rejected" | null;
    error_code: string | null;
  };
  latest_sample: CurrentTelemetry | null;
  display_policy: {
    kind: "planning_display_policy";
    device_offline_after_seconds: 45;
    metric_outdated_after_seconds: 30;
    foreground_refresh_after_seconds: 15;
  };
};

export function feedCapacityForDisplay(
  snapshot: MonitoringSnapshot | null | undefined,
  cachedCapacityG: number | null,
): number | null {
  return snapshot
    ? snapshot.profile.capabilities.feed_capacity_g
    : cachedCapacityG;
}

export type DoGraphBucket = {
  bucket_start: string;
  bucket_end: string;
  measured_at: string | null;
  received_at: string | null;
  do_mg_l: number | null;
  do_quality: SensorQuality | null;
  gap_reason:
    | "no_sample"
    | "unsupported"
    | "untrusted_time"
    | "unavailable"
    | "uncalibrated"
    | "error"
    | null;
  sample_count: number;
};

export type DoGraph = {
  request_id: string;
  device_id: string;
  server_time: string;
  window: GraphWindow;
  window_start: string;
  window_end: string;
  requested_count: number;
  returned_count: number;
  sample_count: number;
  valid_sample_count: number;
  invalid_time_sample_count: number;
  gap_count: number;
  samples: DoGraphBucket[];
  display_policy: MonitoringSnapshot["display_policy"];
};

export function freshnessAfterElapsed(
  freshness: Freshness,
  ageSeconds: number | null,
  elapsedSeconds: number,
  staleAfterSeconds: number,
): Freshness {
  if (freshness !== "fresh") return freshness;
  if (ageSeconds === null) return "unknown";
  return ageSeconds + Math.max(0, elapsedSeconds) < staleAfterSeconds
    ? "fresh"
    : "stale";
}

export function graphForWindow(
  graph: DoGraph | null | undefined,
  window: GraphWindow,
) {
  return graph?.window === window ? graph : null;
}

export type DoGraphShape = {
  paths: string[];
  dots: { x: number; y: number }[];
};

/** Smooth line through the valid readings. A gap breaks the line; a reading with a gap on both sides is a dot. */
export function buildDoGraphShape(
  samples: DoGraphBucket[],
  width: number,
  height: number,
  maxValue: number,
): DoGraphShape {
  const shape: DoGraphShape = { paths: [], dots: [] };
  if (
    samples.length < 2 ||
    samples.length > 100 ||
    width <= 0 ||
    height <= 0 ||
    maxValue <= 0
  )
    return shape;
  const step = width / (samples.length - 1);
  const round = (value: number) => Math.round(value * 100) / 100;
  let run: { x: number; y: number }[] = [];
  const flush = () => {
    if (run.length === 1) shape.dots.push(run[0]);
    if (run.length > 1) {
      // Monotone cubic (Fritsch-Carlson): the curve never rises above or dips below the two readings it joins.
      const slope = run
        .slice(1)
        .map((point, index) => (point.y - run[index].y) / step);
      const tangent = run.map((_, index) => {
        const before = slope[index - 1];
        const after = slope[index];
        if (before === undefined) return after;
        if (after === undefined) return before;
        return before * after <= 0
          ? 0
          : (2 * before * after) / (before + after);
      });
      let d = `M${round(run[0].x)} ${round(run[0].y)}`;
      for (let index = 1; index < run.length; index += 1) {
        const from = run[index - 1];
        const to = run[index];
        d += ` C${round(from.x + step / 3)} ${round(from.y + (tangent[index - 1] * step) / 3)} ${round(to.x - step / 3)} ${round(to.y - (tangent[index] * step) / 3)} ${round(to.x)} ${round(to.y)}`;
      }
      shape.paths.push(d);
    }
    run = [];
  };
  samples.forEach((sample, index) => {
    if (sample.do_quality === "valid" && sample.do_mg_l !== null)
      run.push({
        x: index * step,
        y: height * (1 - Math.min(maxValue, sample.do_mg_l) / maxValue),
      });
    else flush();
  });
  flush();
  return shape;
}

const uuidPattern =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const timestampPattern = /^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d(?:\.\d+)?Z$/;
const qualities: SensorQuality[] = [
  "valid",
  "unavailable",
  "uncalibrated",
  "error",
];
const freshnesses: Freshness[] = ["fresh", "stale", "unknown"];

function object(value: unknown): Record<string, unknown> | null {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}

function onlyKeys(value: Record<string, unknown>, keys: string[]) {
  return Object.keys(value).every((key) => keys.includes(key));
}

function timestamp(value: unknown): value is string {
  return (
    typeof value === "string" &&
    timestampPattern.test(value) &&
    Number.isFinite(Date.parse(value))
  );
}

function count(value: unknown, max = Number.MAX_SAFE_INTEGER): value is number {
  return (
    typeof value === "number" &&
    Number.isSafeInteger(value) &&
    value >= 0 &&
    value <= max
  );
}

function nullableAge(value: unknown): value is number | null {
  return value === null || count(value);
}

function nullableNumber(value: unknown): value is number | null {
  return (
    value === null ||
    (typeof value === "number" && Number.isFinite(value) && value >= 0)
  );
}

function nullablePositiveNumber(value: unknown): value is number | null {
  return (
    value === null ||
    (typeof value === "number" && Number.isFinite(value) && value > 0)
  );
}

function validFreshness(value: unknown): value is Freshness {
  return freshnesses.includes(value as Freshness);
}

function validDisplayPolicy(
  value: unknown,
): value is MonitoringSnapshot["display_policy"] {
  const policy = object(value);
  return (
    !!policy &&
    onlyKeys(policy, [
      "kind",
      "device_offline_after_seconds",
      "metric_outdated_after_seconds",
      "foreground_refresh_after_seconds",
    ]) &&
    policy.kind === "planning_display_policy" &&
    policy.device_offline_after_seconds === 45 &&
    policy.metric_outdated_after_seconds === 30 &&
    policy.foreground_refresh_after_seconds === 15
  );
}

function parseCurrentTelemetry(value: unknown): CurrentTelemetry | null {
  const sample = object(value);
  if (
    !sample ||
    !onlyKeys(sample, [
      "boot_id",
      "sequence",
      "live_sequence",
      "measured_at",
      "time_quality",
      "do_mg_l",
      "do_quality",
      "feed_remaining_g",
      "feed_percent",
      "feed_quality",
      "calibration_revision",
      "received_at",
      "sample_age_seconds",
      "ingestion_age_seconds",
      "do_freshness",
      "feed_freshness",
    ]) ||
    typeof sample.boot_id !== "string" ||
    !uuidPattern.test(sample.boot_id) ||
    !count(sample.sequence) ||
    !count(sample.live_sequence) ||
    sample.sequence !== sample.live_sequence ||
    !(sample.measured_at === null || timestamp(sample.measured_at)) ||
    !["synced", "rtc", "uncertain", "invalid"].includes(
      String(sample.time_quality),
    ) ||
    !(sample.time_quality === "invalid"
      ? sample.measured_at === null
      : sample.measured_at !== null) ||
    !qualities.includes(sample.do_quality as SensorQuality) ||
    !nullableNumber(sample.do_mg_l) ||
    (sample.do_quality === "valid"
      ? typeof sample.do_mg_l !== "number"
      : sample.do_mg_l !== null) ||
    !qualities.includes(sample.feed_quality as SensorQuality) ||
    !nullableNumber(sample.feed_remaining_g) ||
    !nullableNumber(sample.feed_percent) ||
    (sample.feed_percent !== null && sample.feed_percent > 100) ||
    (sample.feed_quality === "valid"
      ? typeof sample.feed_remaining_g !== "number" ||
        typeof sample.feed_percent !== "number" ||
        !count(sample.calibration_revision, 2147483647) ||
        sample.calibration_revision < 1
      : sample.feed_remaining_g !== null ||
        sample.feed_percent !== null ||
        sample.calibration_revision !== null) ||
    !timestamp(sample.received_at) ||
    !nullableAge(sample.sample_age_seconds) ||
    !count(sample.ingestion_age_seconds) ||
    !validFreshness(sample.do_freshness) ||
    !validFreshness(sample.feed_freshness)
  )
    return null;
  return sample as unknown as CurrentTelemetry;
}

export function parseMonitoringSnapshot(
  value: unknown,
  requestId: string,
  deviceId: string,
): MonitoringSnapshot | null {
  const snapshot = object(value);
  const profile = object(snapshot?.profile);
  const profileCapabilities = object(profile?.capabilities);
  const contact = object(snapshot?.contact);
  const configuration = object(snapshot?.configuration);
  const sample =
    snapshot?.latest_sample === null
      ? null
      : parseCurrentTelemetry(snapshot?.latest_sample);
  const rawFeedCapacityG = profileCapabilities?.feed_capacity_g;
  const invalidFeedCapacity =
    rawFeedCapacityG !== null &&
    rawFeedCapacityG !== undefined &&
    !nullablePositiveNumber(rawFeedCapacityG);
  const feedCapacityG = invalidFeedCapacity
    ? null
    : ((rawFeedCapacityG ?? null) as number | null);
  const invalidFeedSample =
    sample?.feed_quality === "valid" &&
    (invalidFeedCapacity ||
      (typeof feedCapacityG === "number" &&
        typeof sample.feed_remaining_g === "number" &&
        typeof sample.feed_percent === "number" &&
        (sample.feed_remaining_g > feedCapacityG ||
          Math.abs(
            sample.feed_percent -
              Math.round((sample.feed_remaining_g / feedCapacityG) * 10000) /
                100,
          ) > 0.05)));
  const normalizedSample = invalidFeedSample
    ? {
        ...sample,
        feed_remaining_g: null,
        feed_percent: null,
        feed_quality: "error" as const,
        calibration_revision: null,
        feed_freshness: "unknown" as const,
      }
    : sample;
  const validRevision = (item: unknown) => item === null || count(item);
  if (
    !snapshot ||
    !onlyKeys(snapshot, [
      "request_id",
      "device_id",
      "server_time",
      "profile",
      "contact",
      "configuration",
      "latest_sample",
      "display_policy",
    ]) ||
    snapshot.request_id !== requestId ||
    snapshot.device_id !== deviceId ||
    !timestamp(snapshot.server_time) ||
    !validDisplayPolicy(snapshot.display_policy) ||
    !profile ||
    typeof profile.firmware_version !== "string" ||
    profile.firmware_version.length < 1 ||
    profile.protocol_major !== 2 ||
    !count(profile.capabilities_revision) ||
    profile.capabilities_revision < 1 ||
    typeof profile.is_simulated !== "boolean" ||
    !profileCapabilities ||
    typeof profileCapabilities.do_monitoring !== "boolean" ||
    typeof profileCapabilities.feed_remaining_monitoring !== "boolean" ||
    profileCapabilities.feed_capacity_g === undefined ||
    !contact ||
    !(
      contact.authenticated_at === null || timestamp(contact.authenticated_at)
    ) ||
    !nullableAge(contact.age_seconds) ||
    !validFreshness(contact.freshness) ||
    !configuration ||
    !validRevision(configuration.desired_revision) ||
    !validRevision(configuration.applied_revision) ||
    !validRevision(configuration.pending_revision) ||
    !(
      configuration.last_attempt_status === null ||
      ["pending", "applied", "rejected"].includes(
        String(configuration.last_attempt_status),
      )
    ) ||
    !(
      configuration.error_code === null ||
      typeof configuration.error_code === "string"
    ) ||
    (snapshot.latest_sample !== null && !sample)
  )
    return null;
  return {
    ...snapshot,
    profile: {
      ...profile,
      capabilities: { ...profileCapabilities, feed_capacity_g: feedCapacityG },
    },
    latest_sample: normalizedSample,
  } as unknown as MonitoringSnapshot;
}

function parseGraphBucket(value: unknown): DoGraphBucket | null {
  const bucket = object(value);
  if (
    !bucket ||
    !onlyKeys(bucket, [
      "bucket_start",
      "bucket_end",
      "measured_at",
      "received_at",
      "do_mg_l",
      "do_quality",
      "gap_reason",
      "sample_count",
    ]) ||
    !timestamp(bucket.bucket_start) ||
    !timestamp(bucket.bucket_end) ||
    !(bucket.measured_at === null || timestamp(bucket.measured_at)) ||
    !(bucket.received_at === null || timestamp(bucket.received_at)) ||
    !nullableNumber(bucket.do_mg_l) ||
    !(
      bucket.do_quality === null ||
      qualities.includes(bucket.do_quality as SensorQuality)
    ) ||
    !count(bucket.sample_count) ||
    (bucket.do_quality === "valid"
      ? typeof bucket.do_mg_l !== "number" || bucket.gap_reason !== null
      : bucket.do_mg_l !== null || typeof bucket.gap_reason !== "string")
  )
    return null;
  if (
    bucket.gap_reason !== null &&
    ![
      "no_sample",
      "unsupported",
      "untrusted_time",
      "unavailable",
      "uncalibrated",
      "error",
    ].includes(String(bucket.gap_reason))
  )
    return null;
  return bucket as unknown as DoGraphBucket;
}

export function parseDoGraph(
  value: unknown,
  requestId: string,
  deviceId: string,
  window: GraphWindow,
): DoGraph | null {
  const graph = object(value);
  const samples = Array.isArray(graph?.samples)
    ? graph.samples.map(parseGraphBucket)
    : null;
  if (
    !graph ||
    !onlyKeys(graph, [
      "request_id",
      "device_id",
      "server_time",
      "window",
      "window_start",
      "window_end",
      "requested_count",
      "returned_count",
      "sample_count",
      "valid_sample_count",
      "invalid_time_sample_count",
      "gap_count",
      "samples",
      "display_policy",
    ]) ||
    graph.request_id !== requestId ||
    graph.device_id !== deviceId ||
    graph.window !== window ||
    !timestamp(graph.server_time) ||
    !timestamp(graph.window_start) ||
    !timestamp(graph.window_end) ||
    !count(graph.requested_count, 100) ||
    graph.requested_count < 1 ||
    !count(graph.returned_count, 100) ||
    !count(graph.sample_count) ||
    !count(graph.valid_sample_count) ||
    !count(graph.invalid_time_sample_count) ||
    !count(graph.gap_count, 100) ||
    !Array.isArray(samples) ||
    samples.length !== graph.returned_count ||
    samples.length !== graph.requested_count ||
    samples.length > 100 ||
    samples.some((item) => item === null) ||
    !validDisplayPolicy(graph.display_policy) ||
    graph.valid_sample_count > graph.sample_count ||
    Date.parse(graph.window_end) <= Date.parse(graph.window_start) ||
    samples.filter((item) => item!.gap_reason !== null).length !==
      graph.gap_count
  )
    return null;
  return graph as unknown as DoGraph;
}

function normalizedTimestamp(
  value: unknown,
  nullable: boolean,
): string | null | undefined {
  if (value === null && nullable) return null;
  return normalizeUtcTimestamp(value) ?? undefined;
}

export function normalizeMonitoringRpcTimestamps(
  value: unknown,
  kind: "snapshot" | "graph",
): unknown | null {
  const source = object(value);
  if (!source) return null;
  const serverTime = normalizedTimestamp(source.server_time, false);
  if (serverTime === undefined) return null;
  if (kind === "snapshot") {
    const contact = object(source.contact);
    if (!contact) return null;
    const authenticatedAt = normalizedTimestamp(contact.authenticated_at, true);
    if (authenticatedAt === undefined) return null;
    const latest =
      source.latest_sample === null ? null : object(source.latest_sample);
    if (source.latest_sample !== null && !latest) return null;
    const measuredAt = latest
      ? normalizedTimestamp(latest.measured_at, true)
      : null;
    const receivedAt = latest
      ? normalizedTimestamp(latest.received_at, false)
      : null;
    if (measuredAt === undefined || receivedAt === undefined) return null;
    return {
      ...source,
      server_time: serverTime,
      contact: { ...contact, authenticated_at: authenticatedAt },
      latest_sample: latest
        ? { ...latest, measured_at: measuredAt, received_at: receivedAt }
        : null,
    };
  }
  if (!Array.isArray(source.samples) || source.samples.length > 100)
    return null;
  const samples = source.samples.map((item) => {
    const bucket = object(item);
    if (!bucket) return null;
    const bucketStart = normalizedTimestamp(bucket.bucket_start, false);
    const bucketEnd = normalizedTimestamp(bucket.bucket_end, false);
    const measuredAt = normalizedTimestamp(bucket.measured_at, true);
    const receivedAt = normalizedTimestamp(bucket.received_at, true);
    if (
      bucketStart === undefined ||
      bucketEnd === undefined ||
      measuredAt === undefined ||
      receivedAt === undefined
    )
      return null;
    return {
      ...bucket,
      bucket_start: bucketStart,
      bucket_end: bucketEnd,
      measured_at: measuredAt,
      received_at: receivedAt,
    };
  });
  if (samples.some((item) => item === null)) return null;
  const windowStart = normalizedTimestamp(source.window_start, false);
  const windowEnd = normalizedTimestamp(source.window_end, false);
  if (windowStart === undefined || windowEnd === undefined) return null;
  return {
    ...source,
    server_time: serverTime,
    window_start: windowStart,
    window_end: windowEnd,
    samples,
  };
}

function headers(requestId: string) {
  return { "X-Protocol-Major": "2", "X-Request-Id": requestId };
}

export async function readMonitoringSnapshot(
  installationId: string,
  deviceId: string,
) {
  const requestId = crypto.randomUUID();
  const value = await requestAppApi(
    installationId,
    `/devices/${deviceId}/monitoring`,
    "GET",
    undefined,
    headers(requestId),
  );
  const normalized = normalizeMonitoringRpcTimestamps(value, "snapshot");
  const snapshot = parseMonitoringSnapshot(normalized, requestId, deviceId);
  if (!snapshot)
    throw new Error("The feeder returned invalid monitoring data.");
  return snapshot;
}

export async function readDoGraph(
  installationId: string,
  deviceId: string,
  window: GraphWindow,
) {
  const requestId = crypto.randomUUID();
  const value = await requestAppApi(
    installationId,
    `/devices/${deviceId}/monitoring/do?window=${window}`,
    "GET",
    undefined,
    headers(requestId),
  );
  const normalized = normalizeMonitoringRpcTimestamps(value, "graph");
  const graph = parseDoGraph(normalized, requestId, deviceId, window);
  if (!graph) throw new Error("The feeder returned an invalid oxygen graph.");
  return graph;
}

export function withMonitoringLimits(
  applied: ConfigurationValues,
  doLow: number | null,
  doHigh: number | null,
  feedLow: number | null,
  timezone: string = applied.timezone,
): ConfigurationValues {
  return {
    timezone,
    monitoring_limits: { do_low_mg_l: doLow, do_high_mg_l: doHigh },
    low_feed_threshold_pct: feedLow,
    schedules: applied.schedules,
  };
}

export type MonitoringSettingsRecoveryStatus =
  "unverified" | "pending" | "resolved";

export function monitoringSettingsRecoveryStatus(
  hasCurrentConfiguration: boolean,
  pendingStatusKnown: boolean,
  hasPendingRequest: boolean,
  lastAttemptStatus: string | null | undefined,
): MonitoringSettingsRecoveryStatus {
  if (!hasCurrentConfiguration || !pendingStatusKnown) return "unverified";
  return hasPendingRequest || lastAttemptStatus === "pending"
    ? "pending"
    : "resolved";
}
