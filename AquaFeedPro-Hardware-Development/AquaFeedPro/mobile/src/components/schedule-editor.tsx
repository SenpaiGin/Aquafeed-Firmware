import { DateTimePicker } from "@expo/ui/community/datetime-picker";
import { router } from "expo-router";
import { useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";
import { StyleSheet, Text, View } from "react-native";

import {
  BentoCard,
  Button,
  Chip,
  EmptyState,
  Notice,
  SectionHeader,
  Segmented,
  Sheet,
  SwitchRow,
  ListRow,
  TextField,
} from "@/components/app-shell";
import {
  displayTime,
  localTimeFromDate,
  pickerDate,
  zoneOffsetLabel,
} from "@/components/feed-status";
import { Spacing, Typography } from "@/constants/theme";
import { sameDeviceRequestScope } from "@/lib/device-access-state";
import { useDeviceAccess } from "@/lib/device-access";
import {
  checkPendingWrite,
  isConfirmedScheduleRejection,
  loadPendingWrite,
  newScheduleId,
  readConfiguration,
  retryPendingWrite,
  saveConfiguration,
  validateSchedule,
  type ConfigurationRead,
  type Schedule,
} from "@/lib/schedules";

const weekdays = [
  [1, "Mon", "Monday"],
  [2, "Tue", "Tuesday"],
  [3, "Wed", "Wednesday"],
  [4, "Thu", "Thursday"],
  [5, "Fri", "Friday"],
  [6, "Sat", "Saturday"],
  [7, "Sun", "Sunday"],
] as const;

const phoneZone = Intl.DateTimeFormat().resolvedOptions().timeZone;
// Follow the phone's 12/24-hour clock style in the time dialog.
const is24Hour = !new Intl.DateTimeFormat(undefined, {
  hour: "numeric",
}).resolvedOptions().hour12;

type NozzleKey = "1" | "2";
type DoseDraft = {
  mode: "grams" | "fixed_portion";
  amount: string;
  portion: string;
};
const emptyDrafts: Record<NozzleKey, DoseDraft> = {
  "1": { mode: "grams", amount: "", portion: "" },
  "2": { mode: "grams", amount: "", portion: "" },
};

function errorMessage(error: unknown) {
  return error instanceof Error
    ? error.message
    : "The schedule could not be saved. Check the connection and try again.";
}

export function ScheduleEditor({ scheduleId }: { scheduleId?: string }) {
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
  useLayoutEffect(() => {
    scopeRef.current = currentScope;
  }, [currentScope]);
  const [reload, setReload] = useState(0);
  const [configuration, setConfiguration] = useState<ConfigurationRead | null>(
    null,
  );
  const [loadError, setLoadError] = useState<string | null>(null);
  const [pendingLocal, setPendingLocal] = useState(false);
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState<string | null>(null);
  const [scheduleKey, setScheduleKey] = useState("");
  const [choice, setChoice] = useState<NozzleKey | "both">("1");
  const [localTime, setLocalTime] = useState("08:00");
  const [pickingTime, setPickingTime] = useState(false);
  const [days, setDays] = useState<number[]>([1, 2, 3, 4, 5, 6, 7]);
  const [drafts, setDrafts] = useState(emptyDrafts);
  const [timezone, setTimezone] = useState("");
  const [enabled, setEnabled] = useState(true);
  const [initializedKey, setInitializedKey] = useState("");
  const key = `${currentScope.installationId ?? ""}:${currentScope.revision}:${deviceId ?? ""}:${scheduleId ?? "new"}`;
  const selected: NozzleKey[] = choice === "both" ? ["1", "2"] : [choice];
  const formSchedule = useMemo<Schedule>(
    () => ({
      schedule_id: scheduleKey,
      local_time: localTime,
      weekdays: days,
      enabled,
      targets: (choice === "both" ? (["1", "2"] as const) : [choice]).map(
        (number) => ({
          nozzle_number: Number(number) as 1 | 2,
          dose:
            drafts[number].mode === "grams"
              ? { mode: "grams", amount_g: Number(drafts[number].amount) }
              : {
                  mode: "fixed_portion",
                  fixed_portion_id: drafts[number].portion.trim(),
                },
        }),
      ),
    }),
    [scheduleKey, choice, localTime, days, enabled, drafts],
  );
  const updateDraft = (number: NozzleKey, change: Partial<DoseDraft>) =>
    setDrafts((current) => ({
      ...current,
      [number]: { ...current[number], ...change },
    }));

  useLayoutEffect(() => {
    /* eslint-disable react-hooks/set-state-in-effect -- Clear device-scoped draft state before paint. */
    setConfiguration(null);
    setLoadError(null);
    setMessage(null);
    setPendingLocal(false);
    setBusy(false);
    setScheduleKey("");
    setChoice("1");
    setLocalTime("08:00");
    setDays([1, 2, 3, 4, 5, 6, 7]);
    setDrafts(emptyDrafts);
    setTimezone("");
    setEnabled(true);
    setInitializedKey("");
    /* eslint-enable react-hooks/set-state-in-effect */
  }, [key]);

  useEffect(() => {
    const scope = currentScope;
    const installationId = scope.installationId;
    if (!installationId || !deviceId || scope.selectedDeviceId !== deviceId)
      return;
    let active = true;
    void Promise.all([
      readConfiguration(installationId, deviceId),
      loadPendingWrite(installationId, deviceId),
    ])
      .then(([value, pending]) => {
        if (!active || !sameDeviceRequestScope(scope, scopeRef.current)) return;
        setConfiguration(value);
        setPendingLocal(pending !== null);
      })
      .catch((error: unknown) => {
        if (active && sameDeviceRequestScope(scope, scopeRef.current))
          setLoadError(errorMessage(error));
      });
    return () => {
      active = false;
    };
  }, [currentScope, deviceId, reload]);

  useLayoutEffect(() => {
    if (!configuration || initializedKey === key) return;
    /* eslint-disable react-hooks/set-state-in-effect -- Initialize the scoped form from its applied snapshot. */
    const values = configuration.applied_snapshot;
    const found = scheduleId
      ? values?.schedules.find((item) => item.schedule_id === scheduleId)
      : null;
    const id = found?.schedule_id ?? newScheduleId();
    setScheduleKey(id);
    const targets = found?.targets ?? [];
    setChoice(
      targets.length === 2
        ? "both"
        : (String(targets[0]?.nozzle_number ?? 1) as NozzleKey),
    );
    setLocalTime(found?.local_time ?? "08:00");
    setDays(found?.weekdays ?? [1, 2, 3, 4, 5, 6, 7]);
    const nextDrafts = { ...emptyDrafts };
    for (const { nozzle_number, dose } of targets)
      nextDrafts[String(nozzle_number) as NozzleKey] =
        dose.mode === "grams"
          ? { mode: "grams", amount: String(dose.amount_g), portion: "" }
          : {
              mode: "fixed_portion",
              amount: "",
              portion: dose.fixed_portion_id,
            };
    setDrafts(nextDrafts);
    setTimezone(values?.timezone || phoneZone);
    setEnabled(found?.enabled ?? true);
    setInitializedKey(key);
    /* eslint-enable react-hooks/set-state-in-effect */
  }, [configuration, initializedKey, key, scheduleId]);

  const refresh = () => setReload((value) => value + 1);
  const canEdit =
    !!configuration &&
    !pendingLocal &&
    configuration.current_state.last_attempt_status !== "pending";

  async function resolvePending() {
    const scope = { ...currentScope };
    const installationId = scope.installationId;
    const requestedDeviceId = scope.selectedDeviceId;
    if (!installationId || !requestedDeviceId) return;
    setBusy(true);
    setMessage(null);
    try {
      const result = await checkPendingWrite(installationId, requestedDeviceId);
      if (!sameDeviceRequestScope(scope, scopeRef.current)) return;
      if (result.conflict) {
        setPendingLocal(false);
        setMessage(
          "The original change was not recorded because another revision moved ahead. Your form values are still here; review the applied schedule before saving again.",
        );
      } else if (result.state?.request_status) {
        setPendingLocal(false);
        setMessage(
          result.state.request_status === "rejected"
            ? `The device rejected this save (${result.state.request_error_code ?? "configuration error"}). The applied schedule is still active.`
            : result.state.request_status === "applied"
              ? "The device applied this save."
              : "The original save is pending on the device.",
        );
      } else {
        setMessage(
          "The original save has no confirmed receipt yet. Retry only this original request or check again later.",
        );
      }
      refresh();
    } catch (error) {
      const pending = await loadPendingWrite(
        installationId,
        requestedDeviceId,
      ).catch(() => undefined);
      if (sameDeviceRequestScope(scope, scopeRef.current)) {
        setPendingLocal(pending !== null);
        setMessage(errorMessage(error));
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
    setMessage(null);
    try {
      await retryPendingWrite(installationId, requestedDeviceId);
      if (!sameDeviceRequestScope(scope, scopeRef.current)) return;
      setPendingLocal(false);
      setMessage(
        "The original save was received. It remains pending until the feeder applies it.",
      );
      refresh();
    } catch (error) {
      const pending = await loadPendingWrite(
        installationId,
        requestedDeviceId,
      ).catch(() => undefined);
      if (sameDeviceRequestScope(scope, scopeRef.current)) {
        setPendingLocal(pending !== null);
        setMessage(errorMessage(error));
        if (pending === null) refresh();
      }
    } finally {
      if (sameDeviceRequestScope(scope, scopeRef.current)) setBusy(false);
    }
  }

  async function submit() {
    const scope = currentScope;
    const installationId = scope.installationId;
    if (
      !installationId ||
      !device ||
      device.deviceId !== scope.selectedDeviceId ||
      !configuration ||
      !canEdit
    )
      return;
    setMessage(null);
    const nextTimezone = timezone.trim();
    try {
      new Intl.DateTimeFormat("en", { timeZone: nextTimezone });
    } catch {
      setMessage("This feeder's time zone is not valid. Set it in Settings.");
      return;
    }
    if (days.length === 0) {
      setMessage("Choose at least one repeat day.");
      return;
    }
    const activeSchedules = configuration.applied_snapshot?.schedules ?? [];
    const rest = activeSchedules.filter(
      (item) => item.schedule_id !== scheduleId,
    );
    const scheduleError = validateSchedule(
      formSchedule,
      rest,
      device.capabilities,
    );
    if (scheduleError) {
      setMessage(scheduleError);
      return;
    }
    if (
      !scheduleId &&
      activeSchedules.length >= (device.capabilities.maxSchedules ?? 0)
    ) {
      setMessage("This feeder has reached its approved schedule limit.");
      return;
    }
    const values = {
      timezone: nextTimezone,
      monitoring_limits: configuration.applied_snapshot?.monitoring_limits ?? {
        do_low_mg_l: null,
        do_high_mg_l: null,
      },
      low_feed_threshold_pct:
        configuration.applied_snapshot?.low_feed_threshold_pct ?? null,
      schedules: [...rest, formSchedule],
    };
    if (values.schedules.length > (device.capabilities.maxSchedules ?? 0)) {
      setMessage("This feeder has reached its approved schedule limit.");
      return;
    }
    setBusy(true);
    try {
      await saveConfiguration(
        installationId,
        device.deviceId,
        configuration.current_state.desired_revision ?? 0,
        values,
      );
      if (!sameDeviceRequestScope(scope, scopeRef.current)) return;
      setMessage(
        "Saved. Waiting for the feeder to apply the complete schedule configuration.",
      );
      router.replace("/schedule");
    } catch (error) {
      if (!sameDeviceRequestScope(scope, scopeRef.current)) return;
      setPendingLocal(!isConfirmedScheduleRejection(error));
      setMessage(errorMessage(error));
    } finally {
      if (sameDeviceRequestScope(scope, scopeRef.current)) setBusy(false);
    }
  }

  const close = () =>
    router.canGoBack() ? router.back() : router.replace("/schedule");

  if (!device)
    return (
      <Sheet
        visible
        title={scheduleId ? "Edit schedule" : "Add schedule"}
        onClose={close}
      >
        <EmptyState
          icon="calendar-clock"
          title="Choose a feeder"
          description="Pair and select a feeder before changing its schedules."
          action="Pair a feeder"
          href="/devices/add"
        />
      </Sheet>
    );
  if (!device.capabilities.localScheduleExecution)
    return (
      <Sheet visible title="Schedules unavailable" onClose={close}>
        <EmptyState
          icon="calendar-clock"
          title="Local scheduling is not supported"
          description="This feeder has no validated local schedule capability."
          action="Back to Schedule"
          href="/schedule"
        />
      </Sheet>
    );
  if (
    scheduleId &&
    configuration &&
    !configuration.applied_snapshot?.schedules.some(
      (item) => item.schedule_id === scheduleId,
    )
  ) {
    return (
      <Sheet visible title="Schedule unavailable" onClose={close}>
        <EmptyState
          icon="calendar-clock"
          title="This schedule is not applied"
          description="Only schedules in the feeder's applied configuration can be edited."
          action="Back to Schedule"
          href="/schedule"
        />
      </Sheet>
    );
  }

  const editing = !!scheduleId;
  const messageIsError =
    !!message &&
    /invalid|rejected|could not|cannot|already|limit|does not|unavailable|pending request|retry only/i.test(
      message,
    );
  const status = configuration?.current_state.last_attempt_status;
  const zoneOffset = timezone ? zoneOffsetLabel(timezone) : null;
  const timezoneLine = timezone
    ? "Feeder time · " + timezone + (zoneOffset ? " · " + zoneOffset : "")
    : "Feeder time zone unknown";
  const nozzles = device.capabilities.nozzles;
  const doseFields = (number: NozzleKey) => {
    const capability = nozzles[number];
    const draft = drafts[number];
    const prefix = choice === "both" ? `Nozzle ${number} ` : "";
    const doseOptions = (["grams", "fixed_portion"] as const)
      .filter((mode) => capability.doseModes.includes(mode))
      .map((value) => ({
        value,
        label: value === "grams" ? "Grams" : "Fixed portion",
      }));
    return (
      <View key={number} style={styles.block8}>
        {doseOptions.length > 1 ? (
          <Segmented
            accessibilityLabel={`${prefix}dose mode`}
            value={draft.mode}
            onChange={(mode) => updateDraft(number, { mode })}
            options={doseOptions}
          />
        ) : null}
        {draft.mode === "grams" ? (
          <TextField
            label={prefix ? `${prefix}amount` : "Amount"}
            suffix="g"
            value={draft.amount}
            onChangeText={(amount) => updateDraft(number, { amount })}
            keyboardType="decimal-pad"
            placeholder={
              capability.minDoseG === null
                ? "Amount"
                : String(capability.minDoseG)
            }
            hint={
              capability.minDoseG === null || capability.maxDoseG === null
                ? undefined
                : `${capability.minDoseG} to ${capability.maxDoseG} g`
            }
          />
        ) : (
          <View style={styles.chips}>
            {capability.fixedPortionIds.map((id) => (
              <Chip
                key={id}
                role="radio"
                label={id}
                accessibilityLabel={`${prefix}${id}`}
                selected={draft.portion === id}
                onPress={() => updateDraft(number, { portion: id })}
              />
            ))}
            {capability.fixedPortionIds.length === 0 ? (
              <Text style={Typography.supporting}>
                No fixed portions are approved for this nozzle.
              </Text>
            ) : null}
          </View>
        )}
      </View>
    );
  };
  return (
    <Sheet
      visible
      title={editing ? "Edit schedule" : "Add schedule"}
      onClose={close}
      footer={
        configuration ? (
          <Button
            loading={busy}
            disabled={!canEdit || !scheduleKey}
            onPress={() => void submit()}
          >
            {editing ? "Save schedule" : "Add schedule"}
          </Button>
        ) : undefined
      }
    >
      {loadError ? (
        <Notice
          tone="error"
          title="Unavailable"
          actions={
            <Button variant="secondary" onPress={refresh}>
              Try again
            </Button>
          }
        >
          {loadError}
        </Notice>
      ) : null}
      {status === "pending" ? (
        <Notice tone="pending">
          The feeder has not resolved the complete configuration yet. Your
          previously applied schedule remains active.
        </Notice>
      ) : null}
      {status === "rejected" ? (
        <Notice tone="warning">
          {`The feeder rejected revision ${configuration?.current_state.last_attempt_revision}. The previous applied schedule remains active.`}
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
          Check the original request first. The app will not create a new
          schedule revision automatically.
        </Notice>
      ) : null}
      {!configuration && !loadError ? (
        <Notice tone="info">
          Loading this feeder&apos;s applied configuration…
        </Notice>
      ) : null}
      <Segmented
        accessibilityLabel="Nozzle"
        value={choice}
        onChange={setChoice}
        options={[
          { value: "1", label: "Nozzle 1", disabled: !nozzles["1"].enabled },
          { value: "2", label: "Nozzle 2", disabled: !nozzles["2"].enabled },
          {
            value: "both",
            label: "Both",
            disabled:
              !device.capabilities.scheduledBoth ||
              !nozzles["1"].enabled ||
              !nozzles["2"].enabled,
          },
        ]}
      />
      <BentoCard flush>
        <ListRow
          icon="clock"
          title={displayTime(localTime)}
          lines={[timezoneLine]}
          trailing="chevron"
          disabled={!canEdit}
          accessibilityLabel={
            "Time, " + displayTime(localTime) + ", " + timezoneLine
          }
          accessibilityHint="Opens a time picker"
          onPress={() => setPickingTime(true)}
        />
      </BentoCard>
      {pickingTime ? (
        <DateTimePicker
          mode="time"
          value={pickerDate(localTime)}
          is24Hour={is24Hour}
          onChange={(event, date) => {
            setPickingTime(false);
            // Cancel and back keep the previous time.
            if (event.type === "set" && date)
              setLocalTime(localTimeFromDate(date));
          }}
        />
      ) : null}
      <View style={styles.block8}>
        <SectionHeader
          title="Repeat"
          action={{
            label: days.length === 7 ? "Clear" : "Every day",
            onPress: () =>
              setDays(days.length === 7 ? [] : [1, 2, 3, 4, 5, 6, 7]),
          }}
        />
        <View style={styles.days}>
          {weekdays.map(([day, , fullName]) => {
            const selected = days.includes(day);
            return (
              <Chip
                key={day}
                compact
                label={fullName.charAt(0)}
                selected={selected}
                accessibilityLabel={`Repeat on ${fullName}`}
                onPress={() =>
                  setDays((current) =>
                    selected
                      ? current.filter((item) => item !== day)
                      : [...current, day].sort(),
                  )
                }
              />
            );
          })}
        </View>
      </View>
      {selected.map(doseFields)}
      {choice === "both" ? (
        <Notice tone="info">Nozzle 1 feeds first, then Nozzle 2.</Notice>
      ) : null}
      {editing ? (
        <SwitchRow label="Enabled" value={enabled} onValueChange={setEnabled} />
      ) : null}
      {message ? (
        <Notice
          tone={messageIsError ? "warning" : "info"}
          title={messageIsError ? "Needs attention" : "Save status"}
        >
          {message}
        </Notice>
      ) : null}
    </Sheet>
  );
}

const styles = StyleSheet.create({
  block8: { gap: Spacing.two },
  days: { flexDirection: "row", justifyContent: "space-between" },
  chips: { flexDirection: "row", flexWrap: "wrap", gap: Spacing.two },
});
