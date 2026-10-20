import { router, useFocusEffect } from "expo-router";
import { useCallback, useLayoutEffect, useMemo, useRef, useState } from "react";
import { Alert, StyleSheet, Text, View } from "react-native";

import {
  AppPage,
  BentoCard,
  Button,
  EmptyState,
  ErrorState,
  Fab,
  IconButton,
  ListRow,
  Notice,
  ScreenHeader,
  SectionHeader,
  Sheet,
  Skeleton,
  StatusLabel,
  Toggle,
} from "@/components/app-shell";
import {
  clockParts,
  displayTime,
  relativeDayLabel,
} from "@/components/feed-status";
import { Colors, Typography } from "@/constants/theme";
import { sameDeviceRequestScope } from "@/lib/device-access-state";
import { subscribeDeviceChanges } from "@/lib/device-changes";
import { useDeviceAccess } from "@/lib/device-access";
import { errorText } from "@/lib/error-text";
import {
  checkPendingWrite,
  isConfirmedScheduleRejection,
  loadPendingWrite,
  readConfiguration,
  readNextOccurrence,
  retryPendingWrite,
  saveConfiguration,
  type ConfigurationRead,
  type NextOccurrence,
  type Schedule,
} from "@/lib/schedules";

const dayNames = ["", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat", "Sun"];
function scheduleDays(schedule: Schedule) {
  return schedule.weekdays.length === 7
    ? "Every day"
    : schedule.weekdays.map((day) => dayNames[day]).join(", ");
}
function nozzleText(schedule: Schedule) {
  return schedule.targets.length === 2
    ? "Both nozzles"
    : `Nozzle ${schedule.targets[0].nozzle_number}`;
}
function doseText(schedule: Schedule) {
  return schedule.targets
    .map(
      ({ nozzle_number, dose }) =>
        (schedule.targets.length === 2 ? `N${nozzle_number} ` : "") +
        (dose.mode === "grams"
          ? `${dose.amount_g} g`
          : `Fixed portion ${dose.fixed_portion_id}`),
    )
    .join(" · ");
}
function messageFor(error: unknown) {
  return errorText(
    error,
    "The schedule update could not be confirmed. Check the connection and status.",
  );
}
function nextTime(at: string, timezone: string) {
  const { time, period } = clockParts(new Date(at), timezone);
  return period ? time + " " + period : time;
}

const phoneZone = Intl.DateTimeFormat().resolvedOptions().timeZone;

export default function ScheduleScreen() {
  const access = useDeviceAccess();
  const device = access.selectedDevice;
  const deviceId = device?.deviceId ?? null;
  const currentScope = useMemo(
    () => ({
      installationId: access.installationId,
      revision: access.scopeRevision,
      selectedDeviceId: access.selectedDeviceId,
    }),
    [access.installationId, access.scopeRevision, access.selectedDeviceId],
  );
  const scopeRef = useRef(currentScope);
  const focused = useRef(false);
  const focusGeneration = useRef(0);
  const readCurrentScopeRef = useRef<
    ((focusGeneration?: number) => void) | null
  >(null);
  useLayoutEffect(() => {
    scopeRef.current = currentScope;
  }, [currentScope]);
  const [configuration, setConfiguration] = useState<ConfigurationRead | null>(
    null,
  );
  const [nextOccurrence, setNextOccurrence] = useState<NextOccurrence | null>(
    null,
  );
  const [pendingLocal, setPendingLocal] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [reload, setReload] = useState(0);
  const [menuFor, setMenuFor] = useState<Schedule | null>(null);

  useLayoutEffect(() => {
    // Clear the previous device's state before paint to prevent cross-device schedule flashes.
    /* eslint-disable react-hooks/set-state-in-effect -- Reset device-scoped state before paint. */
    setConfiguration(null);
    setNextOccurrence(null);
    setPendingLocal(false);
    setError(null);
    setNotice(null);
    setBusy(false);
    const installationId = currentScope.installationId;
    if (!installationId || !deviceId) return;
    const scope = { ...currentScope };
    let active = true;
    let loading = false;
    let refreshQueued = false;
    let queuedFocusGeneration: number | undefined;
    const isCurrent = (requestedFocusGeneration?: number) =>
      active &&
      sameDeviceRequestScope(scope, scopeRef.current) &&
      (requestedFocusGeneration === undefined ||
        (focused.current &&
          focusGeneration.current === requestedFocusGeneration));
    const hasCurrentQueuedRefresh = () =>
      refreshQueued &&
      (queuedFocusGeneration === undefined ||
        (focused.current && focusGeneration.current === queuedFocusGeneration));
    const read = (requestedFocusGeneration?: number) => {
      if (!isCurrent(requestedFocusGeneration)) return;
      if (loading) {
        refreshQueued = true;
        queuedFocusGeneration = requestedFocusGeneration;
        return;
      }
      loading = true;
      void Promise.all([
        readConfiguration(installationId, deviceId),
        readNextOccurrence(installationId, deviceId),
        loadPendingWrite(installationId, deviceId),
      ])
        .then(([value, next, pending]) => {
          if (!isCurrent(requestedFocusGeneration) || hasCurrentQueuedRefresh())
            return;
          setConfiguration(value);
          setNextOccurrence(next.occurrence);
          setPendingLocal(pending !== null);
          setError(null);
        })
        .catch((reason: unknown) => {
          if (!isCurrent(requestedFocusGeneration) || hasCurrentQueuedRefresh())
            return;
          setError(
            errorText(
              reason,
              "The schedules could not be loaded. Check the connection and try again.",
            ),
          );
        })
        .finally(() => {
          loading = false;
          if (refreshQueued) {
            const nextFocusGeneration = queuedFocusGeneration;
            refreshQueued = false;
            queuedFocusGeneration = undefined;
            if (isCurrent(nextFocusGeneration)) read(nextFocusGeneration);
          }
        });
    };
    readCurrentScopeRef.current = read;
    read();
    return () => {
      active = false;
      if (readCurrentScopeRef.current === read)
        readCurrentScopeRef.current = null;
    };
    /* eslint-enable react-hooks/set-state-in-effect */
  }, [currentScope, deviceId, reload]);

  useFocusEffect(
    useCallback(() => {
      focused.current = true;
      const currentFocusGeneration = ++focusGeneration.current;
      if (!deviceId || !currentScope.installationId)
        return () => {
          focused.current = false;
          focusGeneration.current += 1;
        };
      const scope = { ...currentScope };
      const stopListening = subscribeDeviceChanges(
        "schedule-configuration-" +
          scope.installationId +
          "-" +
          scope.revision +
          "-" +
          (scope.selectedDeviceId ?? ""),
        deviceId,
        ["device_config_revisions"],
        () => {
          if (
            sameDeviceRequestScope(scope, scopeRef.current) &&
            focused.current &&
            focusGeneration.current === currentFocusGeneration
          )
            readCurrentScopeRef.current?.(currentFocusGeneration);
        },
      );
      return () => {
        focused.current = false;
        focusGeneration.current += 1;
        stopListening();
      };
    }, [currentScope, deviceId]),
  );

  const refresh = () => setReload((current) => current + 1);
  const applied = configuration?.applied_snapshot;
  const requested =
    configuration?.current_state.last_attempt_status === "pending"
      ? configuration.desired_snapshot
      : null;
  const locked =
    pendingLocal ||
    configuration?.current_state.last_attempt_status === "pending" ||
    busy ||
    !configuration;
  const supported = !!device?.capabilities.localScheduleExecution;
  const schedules = [...(applied?.schedules ?? [])].sort(
    (left, right) =>
      left.local_time.localeCompare(right.local_time) ||
      left.targets[0].nozzle_number - right.targets[0].nozzle_number,
  );

  async function updateSchedule(id: string, action: "toggle" | "delete") {
    const scope = { ...currentScope };
    const installationId = scope.installationId;
    if (
      !device ||
      !installationId ||
      !configuration ||
      locked ||
      !applied ||
      !sameDeviceRequestScope(scope, scopeRef.current) ||
      device.deviceId !== scope.selectedDeviceId
    )
      return;
    const requestedDeviceId = device.deviceId;
    const schedule = applied.schedules.find((item) => item.schedule_id === id);
    if (!schedule) return;
    const schedules = applied.schedules.flatMap((item) => {
      if (item.schedule_id !== id) return [item];
      return action === "delete" ? [] : [{ ...item, enabled: !item.enabled }];
    });
    setBusy(true);
    setError(null);
    setNotice(null);
    try {
      await saveConfiguration(
        installationId,
        requestedDeviceId,
        configuration.current_state.desired_revision ?? applied.revision,
        {
          timezone: applied.timezone,
          monitoring_limits: applied.monitoring_limits,
          low_feed_threshold_pct: applied.low_feed_threshold_pct,
          schedules,
        },
      );
      if (!sameDeviceRequestScope(scope, scopeRef.current)) return;
      setNotice(
        action === "delete"
          ? "Delete submitted. The applied schedule remains until the feeder acknowledges the revision."
          : "Change submitted. The applied schedule remains until the feeder acknowledges the revision.",
      );
      refresh();
    } catch (reason) {
      if (!sameDeviceRequestScope(scope, scopeRef.current)) return;
      setPendingLocal(!isConfirmedScheduleRejection(reason));
      setError(messageFor(reason));
    } finally {
      if (sameDeviceRequestScope(scope, scopeRef.current)) setBusy(false);
    }
  }

  function askDelete(schedule: Schedule) {
    Alert.alert(
      "Delete schedule?",
      `Remove the ${schedule.local_time} ${nozzleText(schedule)} schedule from ${device?.alias ?? device?.model ?? "this feeder"}?`,
      [
        { text: "Cancel", style: "cancel" },
        {
          text: "Delete",
          style: "destructive",
          onPress: () => void updateSchedule(schedule.schedule_id, "delete"),
        },
      ],
    );
  }

  async function resolvePending() {
    const scope = { ...currentScope };
    const installationId = scope.installationId;
    const requestedDeviceId = scope.selectedDeviceId;
    if (!installationId || !requestedDeviceId) return;
    setBusy(true);
    setError(null);
    setNotice(null);
    try {
      const result = await checkPendingWrite(installationId, requestedDeviceId);
      if (!sameDeviceRequestScope(scope, scopeRef.current)) return;
      setPendingLocal(
        result.state?.request_status === null && result.pending !== null,
      );
      if (result.conflict)
        setNotice(
          "The original change was not recorded because another revision moved ahead. Review the applied schedule before making a new change.",
        );
      else if (result.state?.request_status === "rejected")
        setNotice(
          `The feeder rejected the original change (${result.state.request_error_code ?? "configuration error"}). The applied schedules remain active.`,
        );
      else if (result.state?.request_status === "applied")
        setNotice("The feeder applied the original change.");
      else if (result.state?.request_status === "pending")
        setNotice(
          "The feeder has the original change and is still applying it.",
        );
      else
        setNotice(
          "No receipt is confirmed yet. Keep the original request and check again later.",
        );
      refresh();
    } catch (reason) {
      const pending = await loadPendingWrite(
        installationId,
        requestedDeviceId,
      ).catch(() => undefined);
      if (sameDeviceRequestScope(scope, scopeRef.current)) {
        setPendingLocal(pending !== null);
        setError(messageFor(reason));
      }
    } finally {
      if (sameDeviceRequestScope(scope, scopeRef.current)) setBusy(false);
    }
  }

  async function retryOriginal() {
    const scope = { ...currentScope };
    const installationId = scope.installationId;
    const requestedDeviceId = scope.selectedDeviceId;
    if (!installationId || !requestedDeviceId) return;
    setBusy(true);
    setError(null);
    try {
      await retryPendingWrite(installationId, requestedDeviceId);
      if (!sameDeviceRequestScope(scope, scopeRef.current)) return;
      setPendingLocal(false);
      setNotice(
        "The original save was received. Waiting for the feeder to apply it.",
      );
      refresh();
    } catch (reason) {
      const pending = await loadPendingWrite(
        installationId,
        requestedDeviceId,
      ).catch(() => undefined);
      if (sameDeviceRequestScope(scope, scopeRef.current)) {
        setPendingLocal(pending !== null);
        setError(messageFor(reason));
        if (pending === null) refresh();
      }
    } finally {
      if (sameDeviceRequestScope(scope, scopeRef.current)) setBusy(false);
    }
  }

  const attempt = configuration?.current_state;
  const hasNextNotice =
    !nextOccurrence && !!applied?.schedules.some((item) => item.enabled);
  const wrongZone = !!applied?.timezone && applied.timezone !== phoneZone;
  const hasNotices =
    wrongZone ||
    !applied?.timezone ||
    attempt?.last_attempt_status === "pending" ||
    attempt?.last_attempt_status === "rejected" ||
    pendingLocal ||
    !!error ||
    !!notice ||
    !!nextOccurrence ||
    hasNextNotice;
  // Only offer actions for a schedule that is still in the applied list.
  const menu =
    menuFor &&
    schedules.some((item) => item.schedule_id === menuFor.schedule_id)
      ? menuFor
      : null;
  const canAdd = !!device && supported && !!configuration;
  const addBlocked =
    locked ||
    (applied?.schedules.length ?? 0) >=
      (device?.capabilities.maxSchedules ?? 0);

  return (
    <AppPage
      edges={["top", "left", "right"]}
      header={
        <ScreenHeader
          title="Schedule"
          status={
            access.devices.length > 1 && device ? (
              <Text style={Typography.supporting}>
                {device.alias?.trim() || device.model}
              </Text>
            ) : undefined
          }
        />
      }
      floating={
        canAdd ? (
          <Fab
            icon="plus"
            accessibilityLabel="Add schedule"
            accessibilityHint={
              addBlocked
                ? "Resolve a pending save or remove a schedule before adding another."
                : undefined
            }
            disabled={addBlocked}
            onPress={() => router.push("/schedules/new")}
          />
        ) : undefined
      }
    >
      {!device ? (
        <EmptyState
          icon="calendar-clock"
          title="No feeder selected"
          description="Pair and select a feeder to manage its schedules."
          action="Pair a feeder"
          href="/devices/add"
        />
      ) : null}
      {device && !supported ? (
        <EmptyState
          icon="calendar-clock"
          title="Local schedules unavailable"
          description="This feeder has no validated local schedule capability."
          action="Open Settings"
          href="/device"
        />
      ) : null}
      {device && supported && error && !configuration ? (
        <ErrorState
          title="Schedules could not load"
          description={error}
          onRetry={refresh}
        />
      ) : null}
      {device && supported && !error && !configuration ? (
        <View style={styles.group}>
          <Skeleton height={112} />
          <Skeleton height={112} />
          <Skeleton height={112} />
        </View>
      ) : null}
      {device && supported && configuration ? (
        <>
          {hasNotices ? (
            <View style={styles.group}>
              {wrongZone ? (
                <Notice tone="info">
                  {"Times here use the feeder's time zone, " +
                    applied.timezone +
                    ". Change it in Settings."}
                </Notice>
              ) : null}
              {!applied?.timezone ? (
                <Notice tone="info">
                  Set the time zone when you add the first schedule.
                </Notice>
              ) : null}
              {attempt?.last_attempt_status === "pending" ? (
                <Notice tone="pending">
                  Waiting for the feeder to apply your change. The schedules
                  below are still the active ones.
                </Notice>
              ) : null}
              {attempt?.last_attempt_status === "rejected" ? (
                <Notice tone="warning">
                  {`The feeder rejected your last change (${attempt.error_code ?? "configuration error"}). The schedules below are still active.`}
                </Notice>
              ) : null}
              {pendingLocal ? (
                <Notice
                  tone="warning"
                  title="Save status uncertain"
                  actions={
                    <>
                      <Button
                        variant="secondary"
                        loading={busy}
                        onPress={() => void resolvePending()}
                      >
                        Check original save
                      </Button>
                      <Button
                        variant="text"
                        loading={busy}
                        onPress={() => void retryOriginal()}
                      >
                        Retry the same save
                      </Button>
                    </>
                  }
                >
                  Check the original request. An uncertain save is never
                  repeated automatically.
                </Notice>
              ) : null}
              {error ? (
                <Notice
                  tone="error"
                  title="Needs attention"
                  actions={
                    <Button variant="text" onPress={refresh}>
                      Refresh
                    </Button>
                  }
                >
                  {error}
                </Notice>
              ) : null}
              {notice ? <Notice tone="info">{notice}</Notice> : null}
              {nextOccurrence ? (
                <BentoCard tone="muted" gap={0}>
                  <Text
                    accessibilityRole="header"
                    style={[
                      Typography.overline,
                      { color: Colors.light.textSecondary },
                    ]}
                  >
                    Next feeding
                  </Text>
                  <Text style={[Typography.title, styles.tightTop]}>
                    {relativeDayLabel(
                      new Date(nextOccurrence.at),
                      nextOccurrence.timezone,
                    ) +
                      " at " +
                      nextTime(nextOccurrence.at, nextOccurrence.timezone)}
                  </Text>
                  {nextOccurrence.targets.map((target) => (
                    <Text
                      key={target.schedule_id}
                      style={[Typography.supporting, styles.tightTop]}
                    >
                      {`Nozzle ${target.nozzle_number} · ${
                        target.dose.mode === "grams"
                          ? `${target.dose.amount_g} g`
                          : `Fixed portion ${target.dose.fixed_portion_id}`
                      }`}
                    </Text>
                  ))}
                  {nextOccurrence.targets.length === 2 ? (
                    <Text style={[Typography.supporting, styles.tightTop]}>
                      Nozzle 1, then Nozzle 2.
                    </Text>
                  ) : null}
                </BentoCard>
              ) : null}
              {hasNextNotice ? (
                <Notice tone="info">
                  No upcoming feeding was found for the enabled schedules.
                </Notice>
              ) : null}
            </View>
          ) : null}
          {requested ? (
            <View style={styles.section}>
              <SectionHeader title="Waiting for the feeder" />
              <Text style={Typography.supporting}>
                Not active until the feeder confirms.
              </Text>
              <BentoCard flush style={styles.requestedCard}>
                {requested.schedules.map((schedule, index) => (
                  <ListRow
                    key={schedule.schedule_id}
                    icon="clock"
                    title={
                      displayTime(schedule.local_time) +
                      " · " +
                      nozzleText(schedule)
                    }
                    lines={[
                      doseText(schedule) +
                        " · " +
                        (schedule.enabled ? "Enabled" : "Paused"),
                    ]}
                    divider={index > 0}
                  />
                ))}
              </BentoCard>
            </View>
          ) : null}
          <View style={styles.section}>
            <SectionHeader title="Schedules" />
            {schedules.length === 0 ? (
              locked ? (
                <Text style={Typography.supporting}>No schedules yet.</Text>
              ) : (
                <EmptyState
                  icon="calendar-clock"
                  title="No feeding schedules"
                  description="Tap + to add a feeding time."
                  action={null}
                />
              )
            ) : (
              <View style={styles.group}>
                {schedules.map((schedule) => (
                  <BentoCard key={schedule.schedule_id} gap={0}>
                    <View style={styles.cardTop}>
                      <Text
                        accessibilityRole="header"
                        style={[
                          Typography.title,
                          !schedule.enabled && {
                            color: Colors.light.textSecondary,
                          },
                        ]}
                      >
                        {displayTime(schedule.local_time)}
                      </Text>
                      <View style={styles.toggleSlot}>
                        <Toggle
                          value={schedule.enabled}
                          disabled={locked}
                          onValueChange={() =>
                            void updateSchedule(schedule.schedule_id, "toggle")
                          }
                          accessibilityLabel={
                            (schedule.enabled ? "Pause" : "Enable") +
                            " " +
                            nozzleText(schedule) +
                            " schedule"
                          }
                        />
                      </View>
                    </View>
                    <Text style={[Typography.supporting, styles.tightTop]}>
                      {nozzleText(schedule) +
                        " · " +
                        scheduleDays(schedule) +
                        " · " +
                        doseText(schedule)}
                    </Text>
                    {schedule.targets.length === 1 &&
                    schedule.targets[0].nozzle_number === 2 &&
                    schedules.some(
                      (other) =>
                        other.targets.some(
                          (target) => target.nozzle_number === 1,
                        ) &&
                        other.local_time === schedule.local_time &&
                        other.weekdays.some((day) =>
                          schedule.weekdays.includes(day),
                        ),
                    ) ? (
                      <Text style={[Typography.metadata, styles.tightTop]}>
                        Runs after Nozzle 1
                      </Text>
                    ) : null}
                    <View style={styles.cardBottom}>
                      <StatusLabel
                        kind={schedule.enabled ? "enabled" : "paused"}
                      >
                        {schedule.enabled ? "Enabled" : "Paused"}
                      </StatusLabel>
                      <View style={styles.menuSlot}>
                        <IconButton
                          icon="ellipsis"
                          disabled={locked}
                          accessibilityLabel={
                            "More actions for " +
                            nozzleText(schedule) +
                            " schedule at " +
                            schedule.local_time
                          }
                          onPress={() => setMenuFor(schedule)}
                        />
                      </View>
                    </View>
                  </BentoCard>
                ))}
              </View>
            )}
          </View>
          <Sheet
            visible={menu !== null}
            onClose={() => setMenuFor(null)}
            title={
              menu
                ? displayTime(menu.local_time) + " · " + nozzleText(menu)
                : ""
            }
          >
            <BentoCard flush>
              <ListRow
                icon="pencil"
                title="Edit"
                trailing="chevron"
                accessibilityLabel={
                  menu
                    ? `Edit ${nozzleText(menu)} schedule at ${menu.local_time}`
                    : undefined
                }
                onPress={() => {
                  const target = menu;
                  setMenuFor(null);
                  if (target)
                    router.push({
                      pathname: "/schedules/[scheduleId]",
                      params: { scheduleId: target.schedule_id },
                    });
                }}
              />
              <ListRow
                divider
                icon="trash-2"
                title="Delete"
                accessibilityLabel={
                  menu ? `Delete ${nozzleText(menu)} schedule` : undefined
                }
                onPress={() => {
                  const target = menu;
                  setMenuFor(null);
                  if (target) askDelete(target);
                }}
              />
            </BentoCard>
          </Sheet>
        </>
      ) : null}
    </AppPage>
  );
}

const styles = StyleSheet.create({
  group: { gap: 12 },
  section: { gap: 8 },
  tightTop: { marginTop: 4 },
  requestedCard: {
    borderStyle: "dashed",
    borderColor: Colors.light.controlBorder,
  },
  cardTop: {
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "space-between",
    gap: 12,
    minHeight: 32,
  },
  toggleSlot: { marginVertical: -8 },
  cardBottom: {
    marginTop: 12,
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "space-between",
    gap: 12,
    minHeight: 28,
  },
  menuSlot: { marginVertical: -10, marginRight: -14 },
});
