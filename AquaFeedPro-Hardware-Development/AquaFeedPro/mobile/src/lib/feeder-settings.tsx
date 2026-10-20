import { useFocusEffect } from "expo-router";
import {
  useCallback,
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
} from "react";
import { Alert, Platform } from "react-native";

import { useDeviceAccess } from "@/lib/device-access";
import { sameDeviceRequestScope } from "@/lib/device-access-state";
import { subscribeDeviceChanges } from "@/lib/device-changes";
import {
  monitoringSettingsRecoveryStatus,
  withMonitoringLimits,
  type MonitoringSettingsRecoveryStatus,
} from "@/lib/monitoring";
import {
  checkPendingWrite,
  isValidTimezone,
  loadPendingWrite,
  readConfiguration,
  saveConfiguration,
  type ConfigurationRead,
} from "@/lib/schedules";

type SettingsView = {
  scopeKey: string;
  configuration: ConfigurationRead | null;
  pendingLocal: boolean;
  recoveryStatus: MonitoringSettingsRecoveryStatus;
  loading: boolean;
  busy: boolean;
  error: string | null;
  notice: string | null;
  timezone: string;
  doLow: string;
  doHigh: string;
  feedLow: string;
};

function numericLimit(
  value: string,
  maximum?: number,
): number | null | undefined {
  if (!value.trim()) return null;
  const parsed = Number(value);
  return Number.isFinite(parsed) &&
    parsed >= 0 &&
    (maximum === undefined || parsed <= maximum)
    ? parsed
    : undefined;
}

function limitText(value: number | null | undefined) {
  return value === null || value === undefined ? "" : String(value);
}

function settingsAfterRealtimeRead(
  current: SettingsView,
  configuration: ConfigurationRead,
  pendingLocal: boolean,
) {
  const applied = configuration.applied_snapshot;
  const previous = current.configuration?.applied_snapshot;
  const fieldsLocked =
    current.pendingLocal ||
    current.recoveryStatus === "pending" ||
    current.configuration?.current_state.last_attempt_status === "pending";
  const keepOrApply = (value: string, previousValue: string, next: string) =>
    fieldsLocked || value === previousValue ? next : value;

  return {
    ...current,
    configuration,
    pendingLocal,
    recoveryStatus: monitoringSettingsRecoveryStatus(
      true,
      true,
      pendingLocal,
      configuration.current_state.last_attempt_status,
    ),
    loading: false,
    timezone: keepOrApply(
      current.timezone,
      previous?.timezone ?? "",
      applied?.timezone ?? "",
    ),
    doLow: keepOrApply(
      current.doLow,
      limitText(previous?.monitoring_limits.do_low_mg_l),
      limitText(applied?.monitoring_limits.do_low_mg_l),
    ),
    doHigh: keepOrApply(
      current.doHigh,
      limitText(previous?.monitoring_limits.do_high_mg_l),
      limitText(applied?.monitoring_limits.do_high_mg_l),
    ),
    feedLow: keepOrApply(
      current.feedLow,
      limitText(previous?.low_feed_threshold_pct),
      limitText(applied?.low_feed_threshold_pct),
    ),
  };
}

export function useFeederSettings(deviceId: string | undefined) {
  const { devices, installationId, selectedDeviceId, scopeRevision } =
    useDeviceAccess();
  const device = useMemo(
    () => devices.find((candidate) => candidate.deviceId === deviceId) ?? null,
    [deviceId, devices],
  );
  const [settings, setSettings] = useState<SettingsView | null>(null);
  const settingsRef = useRef(settings);
  const mounted = useRef(true);
  const focused = useRef(false);
  const currentScope = useRef({ installationId, deviceId });
  const settingsScope = useMemo(
    () => ({ installationId, revision: scopeRevision, selectedDeviceId }),
    [installationId, scopeRevision, selectedDeviceId],
  );
  const settingsScopeRef = useRef(settingsScope);
  const settingsKey = [
    installationId ?? "",
    selectedDeviceId ?? "",
    scopeRevision,
    deviceId ?? "",
  ].join(":");
  const activeSettings = settings?.scopeKey === settingsKey ? settings : null;

  useLayoutEffect(() => {
    settingsRef.current = settings;
  }, [settings]);

  useEffect(() => {
    mounted.current = true;
    return () => {
      mounted.current = false;
    };
  }, []);

  useEffect(() => {
    currentScope.current = { installationId, deviceId };
  }, [installationId, deviceId]);

  useEffect(() => {
    settingsScopeRef.current = settingsScope;
  }, [settingsScope]);

  // The scope guards below read `focused`; the feeder page set it in its own focus effect.
  useFocusEffect(
    useCallback(() => {
      focused.current = true;
      return () => {
        focused.current = false;
      };
    }, []),
  );

  useFocusEffect(
    useCallback(() => {
      if (!device || !installationId || !deviceId) return;
      const scope = { ...settingsScope };
      const requestDeviceId = device.deviceId;
      let active = true;
      let loading = false;
      let firstRead = true;
      let initialReadInProgress = false;
      let refreshQueued = false;
      const isCurrent = () =>
        active &&
        mounted.current &&
        focused.current &&
        currentScope.current.installationId === installationId &&
        currentScope.current.deviceId === deviceId &&
        sameDeviceRequestScope(scope, settingsScopeRef.current);
      setSettings({
        scopeKey: settingsKey,
        configuration: null,
        pendingLocal: false,
        recoveryStatus: "unverified",
        loading: true,
        busy: false,
        error: null,
        notice: null,
        timezone: "",
        doLow: "",
        doHigh: "",
        feedLow: "",
      });
      const read = async (fromRealtime = false) => {
        if (!isCurrent()) return;
        if (loading) {
          if (
            initialReadInProgress ||
            (settingsRef.current?.scopeKey === settingsKey &&
              !settingsRef.current.busy)
          )
            refreshQueued = true;
          return;
        }
        if (
          fromRealtime &&
          settingsRef.current?.scopeKey === settingsKey &&
          settingsRef.current.busy
        )
          return;
        loading = true;
        const initial = firstRead && !fromRealtime;
        firstRead = false;
        initialReadInProgress = initial;
        try {
          const [configuration, pending] = await Promise.all([
            readConfiguration(installationId, requestDeviceId),
            loadPendingWrite(installationId, requestDeviceId),
          ]);
          if (!isCurrent() || refreshQueued) return;
          if (initial) {
            const applied = configuration.applied_snapshot;
            setSettings({
              scopeKey: settingsKey,
              configuration,
              pendingLocal: pending !== null,
              recoveryStatus: monitoringSettingsRecoveryStatus(
                true,
                true,
                pending !== null,
                configuration.current_state.last_attempt_status,
              ),
              loading: false,
              busy: false,
              error: null,
              notice: null,
              timezone: applied?.timezone ?? "",
              doLow: limitText(applied?.monitoring_limits.do_low_mg_l),
              doHigh: limitText(applied?.monitoring_limits.do_high_mg_l),
              feedLow: limitText(applied?.low_feed_threshold_pct),
            });
          } else {
            setSettings((current) =>
              current?.scopeKey === settingsKey && !current.busy
                ? settingsAfterRealtimeRead(
                    current,
                    configuration,
                    pending !== null,
                  )
                : current,
            );
          }
        } catch (reason: unknown) {
          if (!isCurrent() || refreshQueued) return;
          if (initial) {
            setSettings({
              scopeKey: settingsKey,
              configuration: null,
              pendingLocal: false,
              recoveryStatus: "unverified",
              loading: false,
              busy: false,
              error:
                reason instanceof Error
                  ? reason.message
                  : "Monitoring settings could not be loaded.",
              notice: null,
              timezone: "",
              doLow: "",
              doHigh: "",
              feedLow: "",
            });
          } else {
            setSettings((current) =>
              current?.scopeKey === settingsKey && !current.busy
                ? {
                    ...current,
                    loading: false,
                    recoveryStatus: monitoringSettingsRecoveryStatus(
                      false,
                      false,
                      current.pendingLocal,
                      current.configuration?.current_state.last_attempt_status,
                    ),
                    error:
                      reason instanceof Error
                        ? reason.message
                        : "Monitoring settings could not be loaded.",
                  }
                : current,
            );
          }
        } finally {
          loading = false;
          initialReadInProgress = false;
          if (refreshQueued && isCurrent()) {
            refreshQueued = false;
            void read(true);
          }
        }
      };
      const stopListening = subscribeDeviceChanges(
        "monitoring-settings-" +
          installationId +
          "-" +
          scope.revision +
          "-" +
          (scope.selectedDeviceId ?? ""),
        requestDeviceId,
        ["device_config_revisions"],
        () => {
          if (!isCurrent()) return;
          if (
            settingsRef.current?.scopeKey === settingsKey &&
            settingsRef.current.busy
          )
            return;
          void read(true);
        },
      );
      void read();
      return () => {
        active = false;
        stopListening();
      };
    }, [device, deviceId, installationId, settingsKey, settingsScope]),
  );

  const updateSettingsField = (
    field: "timezone" | "doLow" | "doHigh" | "feedLow",
    value: string,
  ) => {
    setSettings((current) =>
      current?.scopeKey === settingsKey
        ? { ...current, [field]: value, error: null, notice: null }
        : current,
    );
  };

  const saveMonitoringSettings = async () => {
    const state = activeSettings;
    const applied = state?.configuration?.applied_snapshot;
    if (
      !device ||
      !installationId ||
      !state ||
      !applied ||
      state.loading ||
      state.busy ||
      state.recoveryStatus !== "resolved"
    )
      return;
    const low = numericLimit(state.doLow);
    const high = numericLimit(state.doHigh);
    const feed = numericLimit(state.feedLow, 100);
    const badOrder =
      low !== undefined &&
      high !== undefined &&
      low !== null &&
      high !== null &&
      low > high;
    if (
      low === undefined ||
      high === undefined ||
      feed === undefined ||
      badOrder
    ) {
      setSettings({
        ...state,
        error: badOrder
          ? "The low oxygen limit must not exceed the high limit."
          : "Enter non-negative numeric limits; feed threshold must be 0 to 100 percent.",
        notice: null,
      });
      return;
    }
    const timezone = state.timezone.trim();
    if (!timezone || timezone.length > 100 || !isValidTimezone(timezone)) {
      setSettings({
        ...state,
        error: "Enter a valid time zone, such as Asia/Manila.",
        notice: null,
      });
      return;
    }
    const scope = { ...settingsScopeRef.current };
    const targetDeviceId = device.deviceId;
    const current = () =>
      mounted.current &&
      focused.current &&
      currentScope.current.installationId === installationId &&
      currentScope.current.deviceId === deviceId &&
      sameDeviceRequestScope(scope, settingsScopeRef.current);
    setSettings({ ...state, busy: true, error: null, notice: null });
    try {
      await saveConfiguration(
        installationId,
        targetDeviceId,
        state.configuration?.current_state.desired_revision ?? applied.revision,
        withMonitoringLimits(applied, low, high, feed, timezone),
      );
      if (!current()) return;
      const refreshed = await readConfiguration(
        installationId,
        targetDeviceId,
      ).catch(() => null);
      if (!current()) return;
      setSettings((latest) =>
        latest?.scopeKey === settingsKey
          ? {
              ...latest,
              configuration: refreshed ?? latest.configuration,
              pendingLocal: false,
              recoveryStatus: monitoringSettingsRecoveryStatus(
                refreshed !== null,
                true,
                refreshed?.request_status === "pending",
                refreshed?.current_state.last_attempt_status,
              ),
              busy: false,
              error: refreshed
                ? null
                : "The settings request was recorded, but its current status could not be refreshed. Refresh status before editing.",
              notice: refreshed
                ? refreshed.current_state.last_attempt_status === "pending"
                  ? "Settings request was recorded. The applied values remain active until the feeder acknowledges the revision."
                  : "Settings request was recorded. Current applied values were refreshed."
                : null,
            }
          : latest,
      );
    } catch (reason) {
      if (!current()) return;
      let pending: Awaited<ReturnType<typeof loadPendingWrite>> = null;
      let pendingStatusKnown = true;
      try {
        pending = await loadPendingWrite(installationId, targetDeviceId);
      } catch {
        pendingStatusKnown = false;
      }
      if (!current()) return;
      setSettings((latest) =>
        latest?.scopeKey === settingsKey
          ? {
              ...latest,
              pendingLocal: pending !== null,
              recoveryStatus: monitoringSettingsRecoveryStatus(
                false,
                pendingStatusKnown,
                pending !== null,
                null,
              ),
              busy: false,
              error: !pendingStatusKnown
                ? "The save failed and its saved request status could not be verified. Refresh status before editing."
                : reason instanceof Error
                  ? reason.message
                  : "Settings could not be confirmed. Check the original request before editing again.",
            }
          : latest,
      );
    }
  };

  const checkMonitoringSettings = async () => {
    const state = activeSettings;
    if (
      !device ||
      !installationId ||
      !state ||
      state.busy ||
      state.loading ||
      state.recoveryStatus === "resolved"
    )
      return;
    const scope = { ...settingsScopeRef.current };
    const targetDeviceId = device.deviceId;
    const current = () =>
      mounted.current &&
      focused.current &&
      currentScope.current.installationId === installationId &&
      currentScope.current.deviceId === deviceId &&
      sameDeviceRequestScope(scope, settingsScopeRef.current);
    setSettings({ ...state, busy: true, error: null, notice: null });
    let result: Awaited<ReturnType<typeof checkPendingWrite>> | undefined;
    let refreshed: ConfigurationRead | null = null;
    try {
      const checked = await checkPendingWrite(installationId, targetDeviceId);
      result = checked;
      if (!current()) return;
      const refreshedCurrent =
        checked.state ??
        (await readConfiguration(installationId, targetDeviceId));
      if (!current()) return;
      const status = checked.state?.request_status;
      const notice =
        status === "applied"
          ? "The original settings request was applied."
          : status === "rejected"
            ? "The feeder rejected the original settings request; previous applied values remain active."
            : status === "pending"
              ? "The original settings request is still pending."
              : refreshedCurrent.current_state.last_attempt_status === "pending"
                ? "The latest settings revision is still pending."
                : checked.conflict
                  ? "The original request conflicted with a newer revision. Review the current applied values before editing."
                  : checked.pending !== null
                    ? "No receipt is confirmed yet. Keep the original request and check again later."
                    : "Current applied settings were refreshed.";
      const recoveryStatus = monitoringSettingsRecoveryStatus(
        true,
        true,
        checked.pending !== null || checked.state?.request_status === "pending",
        refreshedCurrent.current_state.last_attempt_status,
      );
      setSettings((latest) =>
        latest?.scopeKey === settingsKey
          ? {
              ...latest,
              configuration: refreshedCurrent,
              pendingLocal: checked.pending !== null,
              recoveryStatus,
              busy: false,
              error: null,
              notice,
              timezone:
                recoveryStatus === "resolved"
                  ? (refreshedCurrent.applied_snapshot?.timezone ??
                    latest.timezone)
                  : latest.timezone,
              doLow:
                recoveryStatus === "resolved"
                  ? limitText(
                      refreshedCurrent.applied_snapshot?.monitoring_limits
                        .do_low_mg_l,
                    )
                  : latest.doLow,
              doHigh:
                recoveryStatus === "resolved"
                  ? limitText(
                      refreshedCurrent.applied_snapshot?.monitoring_limits
                        .do_high_mg_l,
                    )
                  : latest.doHigh,
              feedLow:
                recoveryStatus === "resolved"
                  ? limitText(
                      refreshedCurrent.applied_snapshot?.low_feed_threshold_pct,
                    )
                  : latest.feedLow,
            }
          : latest,
      );
    } catch (reason) {
      if (!current()) return;
      if (!result)
        refreshed = await readConfiguration(
          installationId,
          targetDeviceId,
        ).catch(() => null);
      if (!current()) return;
      setSettings((latest) =>
        latest?.scopeKey === settingsKey
          ? {
              ...latest,
              configuration: refreshed ?? latest.configuration,
              recoveryStatus: monitoringSettingsRecoveryStatus(
                refreshed !== null,
                false,
                latest.pendingLocal,
                refreshed?.current_state.last_attempt_status,
              ),
              busy: false,
              error:
                reason instanceof Error
                  ? reason.message
                  : "The original settings request could not be checked.",
            }
          : latest,
      );
    }
  };

  const requestSaveSettings = () => {
    const applied = activeSettings?.configuration?.applied_snapshot;
    const timezone = activeSettings?.timezone.trim();
    if (
      !applied ||
      !timezone ||
      timezone === applied.timezone ||
      applied.schedules.length === 0 ||
      !isValidTimezone(timezone)
    ) {
      void saveMonitoringSettings();
      return;
    }
    const title = "Change the time zone?";
    const description = `Schedules keep their clock times and will run on ${timezone} time.`;
    if (Platform.OS === "web") {
      if (globalThis.confirm(title + " " + description))
        void saveMonitoringSettings();
      return;
    }
    Alert.alert(title, description, [
      { text: "Cancel", style: "cancel" },
      { text: "Change", onPress: () => void saveMonitoringSettings() },
    ]);
  };

  const monitoringDisabled =
    !activeSettings ||
    activeSettings.loading ||
    activeSettings.busy ||
    activeSettings.recoveryStatus !== "resolved";

  return {
    activeSettings,
    disabled: monitoringDisabled,
    updateSettingsField,
    requestSaveSettings,
    checkMonitoringSettings,
  };
}
