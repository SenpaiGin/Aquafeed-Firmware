import { Lucide, type LucideIconName } from "@react-native-vector-icons/lucide";
import { router, useFocusEffect } from "expo-router";
import { useCallback, useLayoutEffect, useMemo, useRef, useState } from "react";
import {
  AccessibilityInfo,
  AppState,
  StyleSheet,
  Text,
  useWindowDimensions,
  View,
} from "react-native";
import Svg, { Circle, Path } from "react-native-svg";

import {
  AppPage,
  BentoCard,
  DropdownPill,
  EmptyState,
  Fab,
  IconButton,
  ListRow,
  Notice,
  ProgressBar,
  ScreenHeader,
  SectionHeader,
  Sheet,
  Skeleton,
  Stat,
  StatusIcon,
  StatusLabel,
  statusIcons,
} from "@/components/app-shell";
import {
  agoText,
  clockParts,
  feedingSummary,
  relativeDayLabel,
  statusKind,
} from "@/components/feed-status";
import { Colors, IconSize, Typography } from "@/constants/theme";
import { useUnreadCount } from "@/lib/alerts";
import { useDeviceAccess } from "@/lib/device-access";
import { sameDeviceRequestScope } from "@/lib/device-access-state";
import { errorText } from "@/lib/error-text";
import {
  buildDoGraphShape,
  feedCapacityForDisplay,
  freshnessAfterElapsed,
  graphForWindow,
  readDoGraph,
  readMonitoringSnapshot,
  type DoGraph,
  type GraphWindow,
  type MonitoringSnapshot,
} from "@/lib/monitoring";
import { readHistoryPage, type HistoryPage } from "@/lib/manual-feed";
import {
  readConfiguration,
  readNextOccurrence,
  type ConfigurationRead,
  type NextOccurrence,
} from "@/lib/schedules";
import { supabase } from "@/lib/supabase";

type HomeData = {
  scopeKey: string;
  snapshotFetchedAtMonotonicMs: number | null;
  snapshot: MonitoringSnapshot | null;
  snapshotError: string | null;
  graphRequestedWindow: GraphWindow;
  graph: DoGraph | null;
  graphError: string | null;
  configuration: ConfigurationRead | null;
  configurationError: string | null;
  next: { timezone: string | null; occurrence: NextOccurrence | null } | null;
  nextError: string | null;
  history: HistoryPage | null;
  historyError: string | null;
};

const windows: GraphWindow[] = ["1h", "6h", "24h"];
const rangeNames: Record<GraphWindow, string> = {
  "1h": "Last hour",
  "6h": "Last 6 hours",
  "24h": "Last 24 hours",
};

function message(error: unknown, fallback: string) {
  return errorText(error, fallback);
}

function sensorText(quality: string | undefined) {
  switch (quality) {
    case "uncalibrated":
      return "Sensor needs calibration";
    case "error":
      return "Sensor reported an error";
    case "unavailable":
      return "Reading unavailable";
    default:
      return "No reading yet";
  }
}

function gapText(reason: string | null | undefined) {
  switch (reason) {
    case "unsupported":
      return "DO sensor not supported";
    case "untrusted_time":
      return "Device time is untrusted";
    case "unavailable":
      return "Reading unavailable";
    case "uncalibrated":
      return "Calibration unavailable";
    case "error":
      return "Sensor error";
    default:
      return "No sample in this interval";
  }
}

function doseText(
  dose:
    | { mode: "grams"; amount_g: number }
    | { mode: "fixed_portion"; fixed_portion_id: string },
) {
  return dose.mode === "grams"
    ? String(dose.amount_g) + " g"
    : "Fixed portion " + dose.fixed_portion_id;
}

const phoneZone = Intl.DateTimeFormat().resolvedOptions().timeZone;

function graphTime(value: string) {
  const date = new Date(value);
  const time = new Intl.DateTimeFormat(undefined, {
    hour: "numeric",
    minute: "2-digit",
  }).format(date);
  const day = relativeDayLabel(date, phoneZone);
  return day === "Today" ? time : day + ", " + time;
}

function graphPointText(point: DoGraph["samples"][number]) {
  const at = graphTime(point.measured_at ?? point.bucket_start);
  return point.do_mg_l === null
    ? "Gap: " + gapText(point.gap_reason) + " · " + at
    : String(point.do_mg_l) + " mg/L · " + at;
}

function activityTime(value: string, timezone: string) {
  const date = new Date(value);
  const day = relativeDayLabel(date, timezone);
  return day === "Today"
    ? new Intl.DateTimeFormat(undefined, {
        timeZone: timezone,
        timeStyle: "short",
      }).format(date)
    : day;
}

function DecorativeIcon({
  name,
  color,
}: {
  name: LucideIconName;
  color: string;
}) {
  return (
    <View
      accessibilityElementsHidden
      importantForAccessibility="no-hide-descendants"
    >
      <Lucide name={name} size={IconSize.default} color={color} />
    </View>
  );
}

export default function HomeScreen() {
  const unread = useUnreadCount();
  const bell = (
    <IconButton
      icon="bell"
      badge={unread > 0}
      accessibilityLabel={
        unread ? `Notifications, ${unread} unread` : "Notifications"
      }
      onPress={() => router.push("/notifications")}
    />
  );
  const access = useDeviceAccess();
  const device = access.selectedDevice;
  const deviceId = access.selectedDeviceId;
  const installationId = access.installationId;
  const currentScope = useMemo(
    () => ({
      installationId,
      revision: access.scopeRevision,
      selectedDeviceId: deviceId,
    }),
    [access.scopeRevision, deviceId, installationId],
  );
  const scopeRef = useRef(currentScope);
  const requestedWindowRef = useRef<GraphWindow>("1h");
  const [window, setWindow] = useState<GraphWindow>("1h");
  const [inspected, setInspected] = useState(0);
  const [rangeOpen, setRangeOpen] = useState(false);
  const { fontScale, width } = useWindowDimensions();
  const stackTiles = fontScale > 1.3 || width < 360;
  const [plotWidth, setPlotWidth] = useState(0);
  const [monotonicNowMs, setMonotonicNowMs] = useState(() => performance.now());
  const [data, setData] = useState<HomeData | null>(null);
  const dataRef = useRef<HomeData | null>(null);
  useLayoutEffect(() => {
    scopeRef.current = currentScope;
    requestedWindowRef.current = window;
  }, [currentScope, window]);
  const scopeKey =
    String(installationId ?? "") +
    ":" +
    String(deviceId ?? "") +
    ":" +
    access.scopeRevision;
  const activeData = data?.scopeKey === scopeKey ? data : null;
  const sample = activeData?.snapshot?.latest_sample ?? null;
  const graph = graphForWindow(activeData?.graph, window);
  const graphError =
    activeData?.graphRequestedWindow === window ? activeData.graphError : null;
  const points = graph?.samples ?? [];
  const selectedIndex = Math.min(inspected, Math.max(0, points.length - 1));
  const selectedPoint = points[selectedIndex] ?? null;
  const validValues = points.flatMap((point) =>
    point.do_mg_l === null ? [] : [point.do_mg_l],
  );
  const applied = activeData?.configuration?.applied_snapshot;
  const limits = applied?.monitoring_limits;
  const axisMax = Math.max(
    10,
    Math.ceil(
      Math.max(
        0,
        ...validValues,
        limits?.do_low_mg_l ?? 0,
        limits?.do_high_mg_l ?? 0,
      ),
    ),
  );
  const elapsedSeconds =
    activeData?.snapshotFetchedAtMonotonicMs === null ||
    activeData?.snapshotFetchedAtMonotonicMs === undefined
      ? 0
      : Math.max(
          0,
          (monotonicNowMs - activeData.snapshotFetchedAtMonotonicMs) / 1000,
        );
  const contactAge =
    activeData?.snapshot?.contact.age_seconds === null ||
    activeData?.snapshot?.contact.age_seconds === undefined
      ? null
      : activeData.snapshot.contact.age_seconds + elapsedSeconds;
  const contactFreshness = activeData?.snapshot
    ? freshnessAfterElapsed(
        activeData.snapshot.contact.freshness,
        activeData.snapshot.contact.age_seconds,
        elapsedSeconds,
        activeData.snapshot.display_policy.device_offline_after_seconds,
      )
    : "unknown";
  const doFreshness =
    sample && activeData?.snapshot
      ? freshnessAfterElapsed(
          sample.do_freshness,
          sample.sample_age_seconds,
          elapsedSeconds,
          activeData.snapshot.display_policy.metric_outdated_after_seconds,
        )
      : "unknown";
  const feedFreshness =
    sample && activeData?.snapshot
      ? freshnessAfterElapsed(
          sample.feed_freshness,
          sample.sample_age_seconds,
          elapsedSeconds,
          activeData.snapshot.display_policy.metric_outdated_after_seconds,
        )
      : "unknown";
  const plotHeight = 144;
  const shape = buildDoGraphShape(points, plotWidth, plotHeight, axisMax);
  const graphLimits = [
    limits?.do_low_mg_l === null || limits?.do_low_mg_l === undefined
      ? null
      : "configured low limit " + limits.do_low_mg_l + " mg/L",
    limits?.do_high_mg_l === null || limits?.do_high_mg_l === undefined
      ? null
      : "configured high limit " + limits.do_high_mg_l + " mg/L",
  ]
    .filter((value): value is string => value !== null)
    .join(" and ");
  const hasDoLimits =
    limits !== undefined &&
    (limits.do_low_mg_l !== null || limits.do_high_mg_l !== null);
  const doValue = sample?.do_quality === "valid" ? sample.do_mg_l : null;
  const sampleAge =
    sample?.sample_age_seconds === null ||
    sample?.sample_age_seconds === undefined
      ? null
      : sample.sample_age_seconds + elapsedSeconds;
  const freshDo = doValue !== null && doFreshness === "fresh";
  const outsideLimits =
    freshDo &&
    hasDoLimits &&
    ((limits?.do_low_mg_l !== null &&
      limits?.do_low_mg_l !== undefined &&
      doValue < limits.do_low_mg_l) ||
      (limits?.do_high_mg_l !== null &&
        limits?.do_high_mg_l !== undefined &&
        doValue > limits.do_high_mg_l));
  const withinLimits = freshDo && hasDoLimits && !outsideLimits;

  useFocusEffect(
    useCallback(() => {
      if (!deviceId || !installationId || !device) return;
      const scope = { ...currentScope };
      const requestedWindow = window;
      let active = true;
      let loading = false;
      let debounce: ReturnType<typeof setTimeout> | undefined;
      const isCurrent = () =>
        active &&
        sameDeviceRequestScope(scope, scopeRef.current) &&
        requestedWindow === requestedWindowRef.current;
      setMonotonicNowMs(performance.now());
      const clock = setInterval(() => {
        if (isCurrent()) setMonotonicNowMs(performance.now());
      }, 5_000);
      const load = async () => {
        if (loading || !isCurrent()) return;
        loading = true;
        const prior =
          dataRef.current?.scopeKey === scopeKey ? dataRef.current : null;
        const snapshotRequestedAt = performance.now();
        const results = await Promise.allSettled([
          readMonitoringSnapshot(installationId, deviceId),
          readDoGraph(installationId, deviceId, window),
          readConfiguration(installationId, deviceId),
          readNextOccurrence(installationId, deviceId),
          readHistoryPage(installationId, deviceId, {
            source: "all",
            status: "all",
          }),
        ]);
        if (isCurrent()) {
          const next: HomeData = {
            scopeKey,
            snapshotFetchedAtMonotonicMs:
              results[0].status === "fulfilled"
                ? snapshotRequestedAt
                : (prior?.snapshotFetchedAtMonotonicMs ?? null),
            snapshot:
              results[0].status === "fulfilled"
                ? results[0].value
                : (prior?.snapshot ?? null),
            snapshotError:
              results[0].status === "rejected"
                ? message(results[0].reason, "Monitoring could not be loaded.")
                : null,
            graphRequestedWindow: requestedWindow,
            graph:
              results[1].status === "fulfilled"
                ? results[1].value
                : prior?.graph?.window === window
                  ? prior.graph
                  : null,
            graphError:
              results[1].status === "rejected"
                ? message(
                    results[1].reason,
                    "The oxygen graph could not be loaded.",
                  )
                : null,
            configuration:
              results[2].status === "fulfilled"
                ? results[2].value
                : (prior?.configuration ?? null),
            configurationError:
              results[2].status === "rejected"
                ? message(
                    results[2].reason,
                    "Applied settings could not be checked.",
                  )
                : null,
            next:
              results[3].status === "fulfilled"
                ? results[3].value
                : (prior?.next ?? null),
            nextError:
              results[3].status === "rejected"
                ? message(
                    results[3].reason,
                    "The next applied feeding could not be loaded.",
                  )
                : null,
            history:
              results[4].status === "fulfilled"
                ? results[4].value
                : (prior?.history ?? null),
            historyError:
              results[4].status === "rejected"
                ? message(
                    results[4].reason,
                    "Recent feeding outcomes could not be loaded.",
                  )
                : null,
          };
          dataRef.current = next;
          setData(next);
        }
        loading = false;
      };
      const scheduleLoad = () => {
        if (!isCurrent()) return;
        if (debounce) clearTimeout(debounce);
        debounce = setTimeout(() => {
          debounce = undefined;
          if (isCurrent()) void load();
        }, 250);
      };
      void load();
      const channel = supabase
        .channel(
          "home-monitoring-" +
            deviceId +
            "-" +
            scope.revision +
            "-" +
            requestedWindow,
        )
        .on(
          "postgres_changes",
          {
            event: "*",
            schema: "public",
            table: "device_telemetry",
            filter: "device_id=eq." + deviceId,
          },
          scheduleLoad,
        )
        .on(
          "postgres_changes",
          {
            event: "*",
            schema: "public",
            table: "device_state",
            filter: "device_id=eq." + deviceId,
          },
          scheduleLoad,
        )
        .on(
          "postgres_changes",
          {
            event: "*",
            schema: "public",
            table: "device_events",
            filter: "device_id=eq." + deviceId,
          },
          scheduleLoad,
        )
        .on(
          "postgres_changes",
          {
            event: "*",
            schema: "public",
            table: "device_config_revisions",
            filter: "device_id=eq." + deviceId,
          },
          scheduleLoad,
        )
        .subscribe();
      const poll = setInterval(() => {
        if (AppState.currentState === "active") void load();
      }, 15_000);
      const appState = AppState.addEventListener("change", (state) => {
        if (state === "active" && isCurrent()) {
          setMonotonicNowMs(performance.now());
          void load();
        }
      });
      return () => {
        active = false;
        if (debounce) clearTimeout(debounce);
        clearInterval(poll);
        clearInterval(clock);
        appState.remove();
        void supabase.removeChannel(channel);
      };
    }, [currentScope, device, deviceId, installationId, scopeKey, window]),
  );

  const chooseWindow = (next: GraphWindow) => {
    setWindow(next);
    setInspected(0);
  };

  if (!device) {
    return (
      <AppPage
        edges={["top", "left", "right"]}
        header={<ScreenHeader title="Home" action={bell} />}
      >
        <EmptyState
          icon="waves"
          title="Pair a feeder to get started"
          description="Add a feeder to connect it to this app."
        />
      </AppPage>
    );
  }

  const contact = activeData?.snapshot?.contact;
  const offline = contactFreshness === "stale";
  const contactText =
    contactFreshness === "fresh"
      ? "Online"
      : contactFreshness === "stale"
        ? "Offline · last contact " + agoText(contactAge)
        : !contact
          ? "Contact status unavailable"
          : contact.authenticated_at === null
            ? "Contact not recorded"
            : "Contact time unknown";
  const feedSensor =
    activeData?.snapshot?.profile.capabilities.feed_remaining_monitoring ??
    device.capabilities.feedRemainingMonitoring;
  const feedCapacityG = feedCapacityForDisplay(
    activeData?.snapshot,
    device.capabilities.feedCapacityG,
  );
  const feedQuantityText = (grams: number) => {
    const value = new Intl.NumberFormat(undefined, {
      maximumFractionDigits: 2,
    }).format(grams);
    if (typeof feedCapacityG !== "number") return value + " g";
    const capacity = new Intl.NumberFormat(undefined, {
      maximumFractionDigits: 2,
    }).format(feedCapacityG);
    const capacityKg = new Intl.NumberFormat(undefined, {
      maximumFractionDigits: 2,
    }).format(feedCapacityG / 1000);
    return value + " g of " + capacity + " g (" + capacityKg + " kg)";
  };
  const doSensor =
    activeData?.snapshot?.profile.capabilities.do_monitoring ??
    device.capabilities.doMonitoring;
  const feedStatus = !feedSensor
    ? "No shared-container sensor is declared"
    : !sample
      ? offline
        ? "Feeder offline; inventory is unknown"
        : "No inventory sample yet"
      : sample.feed_quality !== "valid"
        ? sensorText(sample.feed_quality)
        : typeof sample.feed_remaining_g !== "number" ||
            typeof sample.feed_percent !== "number"
          ? "Inventory reading unavailable"
          : feedFreshness === "fresh"
            ? feedQuantityText(sample.feed_remaining_g) + " remaining"
            : "Last measured " +
              feedQuantityText(sample.feed_remaining_g) +
              " · " +
              sample.feed_percent +
              "% · " +
              agoText(sampleAge) +
              (feedFreshness === "stale"
                ? " (outdated)"
                : " (freshness unknown)");
  const doStatus = !doSensor
    ? "This feeder has no DO sensor"
    : !sample
      ? offline
        ? "Feeder offline; oxygen reading is unknown"
        : "No oxygen sample yet"
      : sample.do_quality !== "valid"
        ? sensorText(sample.do_quality)
        : doFreshness === "fresh"
          ? null
          : "Last measured " +
            sample.do_mg_l +
            " mg/L · " +
            agoText(sampleAge) +
            (doFreshness === "stale" ? " (outdated)" : " (freshness unknown)");
  const nozzles = activeData?.next?.occurrence?.targets ?? [];
  const historyRows = activeData?.history?.records.slice(0, 3) ?? [];
  const historyTimezone = activeData?.history?.timezone ?? "UTC";
  const inspectPoint = (index: number, announce = true) => {
    const nextIndex = Math.min(Math.max(0, index), points.length - 1);
    setInspected(nextIndex);
    if (announce && points[nextIndex])
      AccessibilityInfo.announceForAccessibility(
        graphPointText(points[nextIndex]),
      );
  };
  const inspectAt = (x: number, announce = true) => {
    if (plotWidth <= 0 || points.length === 0) return;
    inspectPoint(
      Math.round(
        (Math.max(0, Math.min(plotWidth, x)) / plotWidth) * (points.length - 1),
      ),
      announce,
    );
  };

  const pointX = (index: number) =>
    points.length < 2
      ? plotWidth / 2
      : (index * plotWidth) / (points.length - 1);
  const limitLines = (
    [
      ["Low", limits?.do_low_mg_l],
      ["High", limits?.do_high_mg_l],
    ] as const
  ).flatMap(([name, value]) =>
    value === null || value === undefined
      ? []
      : [
          {
            name,
            value,
            top: Math.min(plotHeight - 1, plotHeight * (1 - value / axisMax)),
          },
        ],
  );
  const feedPercent =
    feedSensor &&
    sample?.feed_quality === "valid" &&
    typeof sample.feed_percent === "number"
      ? sample.feed_percent
      : null;
  const occurrence = activeData?.next?.occurrence ?? null;
  const nextZone = occurrence
    ? (activeData?.next?.timezone ?? occurrence.timezone)
    : null;
  const nextAt = occurrence ? new Date(occurrence.at) : null;
  const nextClock = nextAt && nextZone ? clockParts(nextAt, nextZone) : null;
  const lastAttempt = activeData?.configuration?.current_state;
  const deviceName = device.alias?.trim() || device.model;
  const loadError =
    activeData?.snapshotError ??
    activeData?.configurationError ??
    activeData?.nextError ??
    graphError ??
    activeData?.historyError ??
    null;
  const simulated =
    device.isSimulated || activeData?.snapshot?.profile.is_simulated === true;

  return (
    <AppPage
      edges={["top", "left", "right"]}
      header={
        <ScreenHeader
          title="Home"
          // Only a fresh contact is "online"; stale and unknown never show the plain icon.
          action={
            <>
              {bell}
              <StatusIcon
                kind={contactFreshness === "fresh" ? "online" : "offline"}
                accessibilityLabel={contactText}
              />
            </>
          }
          status={
            access.devices.length > 1 ? (
              <Text style={Typography.supporting}>{deviceName}</Text>
            ) : undefined
          }
        />
      }
      floating={
        <Fab
          icon="utensils"
          accessibilityLabel="Feed now"
          accessibilityHint={"Opens feeding for " + deviceName + "."}
          onPress={() => router.push("/feed/confirm")}
        />
      }
    >
      {loadError || lastAttempt?.last_attempt_status === "rejected" ? (
        <View style={styles.group}>
          {loadError ? (
            <Notice tone="error">{loadError}</Notice>
          ) : (
            <Notice tone="warning">
              The feeder rejected the last settings change. The previous
              settings are still active.
            </Notice>
          )}
        </View>
      ) : null}

      <View style={styles.group}>
        <BentoCard gap={0}>
          <View style={styles.doHeader}>
            <View style={styles.doTitle}>
              <DecorativeIcon name="waves" color={Colors.light.textTertiary} />
              <Text accessibilityRole="header" style={Typography.overline}>
                Dissolved oxygen
              </Text>
            </View>
            <DropdownPill
              value={window.toUpperCase()}
              accessibilityLabel={"Graph range, " + rangeNames[window]}
              onPress={() => setRangeOpen(true)}
            />
          </View>
          <View style={styles.readingRow}>
            <View
              accessible
              accessibilityRole="text"
              accessibilityLabel={
                doValue === null
                  ? "Dissolved oxygen unavailable"
                  : doValue + " milligrams per litre"
              }
              style={styles.reading}
            >
              <Text style={Typography.display}>
                {doValue === null ? "—" : String(doValue)}
              </Text>
              {doValue !== null ? (
                <Text style={Typography.unit}>mg/L</Text>
              ) : null}
            </View>
            {withinLimits ? (
              <StatusLabel kind="completed">Within limits</StatusLabel>
            ) : outsideLimits ? (
              <StatusLabel kind="warning">Outside limits</StatusLabel>
            ) : doValue !== null && doFreshness === "stale" ? (
              <StatusLabel kind="outdated">Outdated</StatusLabel>
            ) : null}
          </View>
          {doStatus ? (
            <Text style={[Typography.supporting, styles.doStatus]}>
              {doStatus}
            </Text>
          ) : null}
          {graph && points.length ? (
            <>
              <View style={styles.chart}>
                <View style={styles.graphRow}>
                  <View
                    style={[styles.axisLabels, { height: plotHeight + 16 }]}
                  >
                    <Text style={Typography.metadata}>{axisMax}</Text>
                    <Text style={Typography.metadata}>
                      {Math.round(axisMax / 2)}
                    </Text>
                    <Text style={Typography.metadata}>0</Text>
                  </View>
                  <View
                    accessible
                    accessibilityRole="image"
                    accessibilityLabel={`${window.toUpperCase()} dissolved oxygen graph, ${graph.valid_sample_count} valid samples, ${graph.gap_count} visible gaps, vertical scale from 0 to ${axisMax} mg/L, from ${graphTime(graph.window_start)} to ${graphTime(graph.window_end)}${graphLimits ? ". " + graphLimits : ""}. Use the previous and next point controls to inspect values.`}
                    onLayout={(event) =>
                      setPlotWidth(event.nativeEvent.layout.width)
                    }
                    onStartShouldSetResponder={() => true}
                    onResponderGrant={(event) =>
                      inspectAt(event.nativeEvent.locationX, false)
                    }
                    onResponderMove={(event) =>
                      inspectAt(event.nativeEvent.locationX, false)
                    }
                    onResponderRelease={(event) =>
                      inspectAt(event.nativeEvent.locationX)
                    }
                    style={[styles.plot, { height: plotHeight }]}
                  >
                    <View style={[styles.gridLine, { top: 0 }]} />
                    <View style={[styles.gridLine, { top: plotHeight / 2 }]} />
                    {limitLines.map((line) => (
                      <View
                        key={line.name}
                        accessibilityElementsHidden
                        importantForAccessibility="no-hide-descendants"
                        pointerEvents="none"
                        style={styles.limitMark}
                      >
                        <View style={[styles.limitLine, { top: line.top }]} />
                        <Text
                          style={[
                            styles.limitLabel,
                            {
                              top:
                                line.top + 20 > plotHeight
                                  ? line.top - 20
                                  : line.top + 4,
                            },
                          ]}
                        >
                          {line.name + " " + line.value}
                        </Text>
                      </View>
                    ))}
                    {plotWidth > 0 ? (
                      <Svg
                        width={plotWidth}
                        height={plotHeight}
                        style={StyleSheet.absoluteFill}
                        pointerEvents="none"
                      >
                        {shape.paths.map((d, index) => (
                          <Path
                            key={"line-" + index}
                            d={d}
                            stroke={Colors.light.chartLine}
                            strokeWidth={2}
                            strokeLinecap="round"
                            strokeLinejoin="round"
                            fill="none"
                          />
                        ))}
                        {shape.dots.map((dot, index) => (
                          <Circle
                            key={"dot-" + index}
                            cx={dot.x}
                            cy={dot.y}
                            r={2.5}
                            fill={Colors.light.chartLine}
                          />
                        ))}
                      </Svg>
                    ) : null}
                    {selectedPoint ? (
                      <View
                        pointerEvents="none"
                        style={[styles.cursor, { left: pointX(selectedIndex) }]}
                      />
                    ) : null}
                    {selectedPoint && selectedPoint.do_mg_l !== null ? (
                      <View
                        pointerEvents="none"
                        style={[
                          styles.marker,
                          {
                            left: pointX(selectedIndex) - 6,
                            top:
                              plotHeight *
                                (1 - selectedPoint.do_mg_l / axisMax) -
                              6,
                          },
                        ]}
                      />
                    ) : null}
                  </View>
                </View>
                <View style={styles.axisEnds}>
                  <Text style={[Typography.metadata, styles.axisStart]}>
                    {graphTime(graph.window_start)}
                  </Text>
                  <Text style={[Typography.metadata, styles.axisEnd]}>
                    {graphTime(graph.window_end)}
                  </Text>
                </View>
              </View>
              {selectedPoint ? (
                <View style={styles.inspection}>
                  <View style={styles.inspectText}>
                    <View style={styles.inspectValueRow}>
                      <Text style={styles.inspectValue}>
                        {selectedPoint.do_mg_l === null
                          ? "Gap: " + gapText(selectedPoint.gap_reason)
                          : String(selectedPoint.do_mg_l)}
                      </Text>
                      {selectedPoint.do_mg_l === null ? null : (
                        <Text style={styles.inspectUnit}>mg/L</Text>
                      )}
                    </View>
                    <Text style={styles.inspectTime}>
                      {graphTime(
                        selectedPoint.measured_at ?? selectedPoint.bucket_start,
                      ) + (selectedPoint.measured_at ? "" : " interval")}
                    </Text>
                  </View>
                  <View style={styles.inspectButtons}>
                    <IconButton
                      icon="chevron-left"
                      accessibilityLabel="Inspect previous graph point"
                      disabled={selectedIndex <= 0}
                      onPress={() => inspectPoint(selectedIndex - 1)}
                    />
                    <IconButton
                      icon="chevron-right"
                      accessibilityLabel="Inspect next graph point"
                      disabled={selectedIndex >= points.length - 1}
                      onPress={() => inspectPoint(selectedIndex + 1)}
                    />
                  </View>
                </View>
              ) : null}
            </>
          ) : graph ? (
            <Text style={[Typography.supporting, styles.graphNote]}>
              No readings in this range.
            </Text>
          ) : graphError ? (
            <Text style={[Typography.supporting, styles.graphNote]}>
              Graph unavailable.
            </Text>
          ) : (
            <View style={styles.graphNote}>
              <Skeleton height={168} />
            </View>
          )}
          {graph?.invalid_time_sample_count ? (
            <Text style={[Typography.metadata, styles.dataQuality]}>
              {graph.invalid_time_sample_count} sample(s) with invalid or
              uncertain device time were counted separately.
            </Text>
          ) : null}
        </BentoCard>

        <Sheet
          visible={rangeOpen}
          title="Graph range"
          onClose={() => setRangeOpen(false)}
        >
          <BentoCard flush>
            {windows.map((choice, index) => (
              <ListRow
                key={choice}
                divider={index > 0}
                title={rangeNames[choice]}
                trailing={
                  choice === window ? (
                    <DecorativeIcon name="check" color={Colors.light.ink} />
                  ) : undefined
                }
                accessibilityLabel={
                  rangeNames[choice] + (choice === window ? ", selected" : "")
                }
                onPress={() => {
                  chooseWindow(choice);
                  setRangeOpen(false);
                }}
              />
            ))}
          </BentoCard>
        </Sheet>

        <View style={[styles.tiles, stackTiles && styles.tilesStacked]}>
          <Stat
            icon="container"
            label="Feed"
            value={feedPercent === null ? "—" : String(feedPercent)}
            unit={feedPercent === null ? undefined : "%"}
            captions={[feedStatus]}
            accessibilityLabel={"Feed remaining. " + feedStatus}
            style={stackTiles ? undefined : styles.tile}
          >
            {feedPercent === null ? null : (
              <ProgressBar
                value={feedPercent}
                accessibilityLabel="Shared-container feed remaining"
                accessibilityText={
                  String(feedPercent) +
                  "% remaining, " +
                  (feedFreshness === "fresh"
                    ? "fresh"
                    : feedFreshness === "stale"
                      ? "outdated"
                      : "age unknown")
                }
              />
            )}
          </Stat>
          <Stat
            icon="calendar-clock"
            label="Next"
            value={nextClock ? nextClock.time : "—"}
            unit={nextClock?.period || undefined}
            captions={
              occurrence && nextAt && nextZone
                ? [
                    relativeDayLabel(nextAt, nextZone) +
                      (nextZone !== phoneZone ? " · " + nextZone : ""),
                    ...nozzles.map(
                      (target) =>
                        "Nozzle " +
                        target.nozzle_number +
                        " · " +
                        doseText(target.dose),
                    ),
                  ]
                : [activeData?.next ? "No upcoming feeding" : "Unavailable"]
            }
            onPress={() => router.push("/(tabs)/schedule")}
            accessibilityLabel="Next applied feeding. Opens Schedule."
            style={stackTiles ? undefined : styles.tile}
          />
        </View>
      </View>

      <View style={styles.recent}>
        <SectionHeader
          title="Recent activity"
          action={{
            label: "View all",
            onPress: () => router.push("/(tabs)/history"),
          }}
        />
        {historyRows.length ? (
          <BentoCard flush>
            {historyRows.map((record, index) => (
              <ListRow
                key={record.sequence_id}
                divider={index > 0}
                icon={statusIcons[statusKind(record.status)]}
                title={
                  record.source === "scheduled"
                    ? "Scheduled feeding"
                    : "Manual feeding"
                }
                meta={activityTime(record.created_at, historyTimezone)}
                lines={[feedingSummary(record, simulated)]}
                trailing="chevron"
                onPress={() =>
                  router.push({
                    pathname: "/history/[runId]",
                    params: {
                      runId: record.sequence_id,
                      device_id: device.deviceId,
                    },
                  })
                }
              />
            ))}
          </BentoCard>
        ) : activeData?.history ? (
          <Text style={Typography.supporting}>No feedings yet.</Text>
        ) : activeData?.historyError ? (
          <Text style={Typography.supporting}>
            Recent activity unavailable.
          </Text>
        ) : (
          <View style={styles.recent}>
            <Skeleton height={72} />
            <Skeleton height={72} />
            <Skeleton height={72} />
          </View>
        )}
      </View>
    </AppPage>
  );
}

const styles = StyleSheet.create({
  group: { gap: 12 },
  recent: { gap: 8 },
  doHeader: {
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "space-between",
    gap: 12,
    minHeight: 28,
  },
  doTitle: {
    flexDirection: "row",
    alignItems: "center",
    gap: 8,
    flexShrink: 1,
  },
  readingRow: {
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "space-between",
    flexWrap: "wrap",
    gap: 8,
    marginTop: 12,
  },
  reading: {
    flexDirection: "row",
    alignItems: "baseline",
    gap: 6,
  },
  doStatus: { marginTop: 4 },
  graphNote: { marginTop: 16 },
  dataQuality: { marginTop: 8 },
  chart: { marginTop: 16, paddingTop: 8 },
  graphRow: { flexDirection: "row", gap: 8 },
  axisLabels: {
    width: 24,
    marginVertical: -8,
    justifyContent: "space-between",
    alignItems: "flex-end",
  },
  plot: {
    flex: 1,
    borderBottomWidth: 1,
    borderBottomColor: Colors.light.chartGrid,
    overflow: "visible",
  },
  gridLine: {
    position: "absolute",
    left: 0,
    right: 0,
    borderBottomWidth: 1,
    borderBottomColor: Colors.light.chartGrid,
  },
  limitMark: { position: "absolute", top: 0, right: 0, bottom: 0, left: 0 },
  limitLine: {
    position: "absolute",
    left: 0,
    right: 0,
    borderBottomWidth: 1,
    borderStyle: "dashed",
    borderBottomColor: Colors.light.textSecondary,
  },
  limitLabel: {
    ...Typography.metadata,
    position: "absolute",
    left: 4,
    color: Colors.light.textSecondary,
  },
  cursor: {
    position: "absolute",
    top: 0,
    bottom: 0,
    width: 1,
    backgroundColor: Colors.light.ink,
  },
  marker: {
    position: "absolute",
    width: 12,
    height: 12,
    borderRadius: 6,
    backgroundColor: Colors.light.surface,
    borderWidth: 2,
    borderColor: Colors.light.ink,
  },
  axisEnds: { flexDirection: "row", marginTop: 8, paddingLeft: 32 },
  axisStart: { flex: 1, textAlign: "left" },
  axisEnd: { flex: 1, textAlign: "right" },
  inspection: {
    marginTop: 4,
    flexDirection: "row",
    alignItems: "center",
    gap: 4,
  },
  inspectText: { flex: 1, minWidth: 0 },
  inspectButtons: { flexDirection: "row", marginRight: -12 },
  inspectValueRow: { flexDirection: "row", alignItems: "baseline", gap: 4 },
  inspectValue: {
    ...Typography.cardTitle,
    fontVariant: ["tabular-nums"],
    flexShrink: 1,
  },
  inspectUnit: { ...Typography.label, color: Colors.light.textSecondary },
  inspectTime: {
    ...Typography.metadata,
    color: Colors.light.textSecondary,
  },
  tiles: { flexDirection: "row", gap: 12 },
  tilesStacked: { flexDirection: "column" },
  tile: { flex: 1, minWidth: 0 },
});
