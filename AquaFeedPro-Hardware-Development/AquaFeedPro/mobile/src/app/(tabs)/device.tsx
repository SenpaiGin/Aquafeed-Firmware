import Constants from "expo-constants";
import { router, useFocusEffect } from "expo-router";
import { useCallback, useEffect, useRef, useState } from "react";
import { StyleSheet, View } from "react-native";

import {
  AppPage,
  BentoCard,
  Button,
  EmptyState,
  KeyValue,
  ListRow,
  Notice,
  ScreenHeader,
  SectionHeader,
  Skeleton,
  StatusLabel,
} from "@/components/app-shell";
import { Spacing } from "@/constants/theme";
import { useDeviceAccess, type DeviceRecord } from "@/lib/device-access";
import { readConfiguration, type ConfigurationRead } from "@/lib/schedules";

function connection(device: DeviceRecord) {
  return device.contactFreshness === "fresh"
    ? ({ kind: "online", text: "Online" } as const)
    : device.contactFreshness === "stale"
      ? ({ kind: "offline", text: "Offline" } as const)
      : ({ kind: "outdated", text: "No contact yet" } as const);
}

function oxygenText(low: number | null, high: number | null) {
  if (low !== null && high !== null) return `${low} to ${high} mg/L`;
  if (low !== null) return `Below ${low} mg/L`;
  if (high !== null) return `Above ${high} mg/L`;
  return "Off";
}

export default function DeviceScreen() {
  const [actionErrors, setActionErrors] = useState<Record<string, string>>({});
  const [refreshError, setRefreshError] = useState<string | null>(null);
  const {
    installationId,
    devices,
    selectedDeviceId,
    selectedDevice,
    scopeRevision,
    deviceError,
    refreshing,
    refreshDevices,
  } = useDeviceAccess();
  const mounted = useRef(true);
  const focused = useRef(false);
  const focusGeneration = useRef(0);

  useEffect(() => {
    mounted.current = true;
    return () => {
      mounted.current = false;
    };
  }, []);

  useFocusEffect(
    useCallback(() => {
      focused.current = true;
      focusGeneration.current += 1;
      const generation = focusGeneration.current;
      void refreshDevices().catch((reason) => {
        if (mounted.current && focusGeneration.current === generation) {
          setRefreshError(
            reason instanceof Error
              ? reason.message
              : "Paired devices could not be refreshed.",
          );
        }
      });
      return () => {
        focused.current = false;
        focusGeneration.current += 1;
      };
    }, [refreshDevices]),
  );

  const scopeKey = `${installationId ?? ""}:${selectedDeviceId ?? ""}:${scopeRevision}`;
  const [applied, setApplied] = useState<{
    key: string;
    values: ConfigurationRead["applied_snapshot"];
  } | null>(null);

  useFocusEffect(
    useCallback(() => {
      if (!installationId || !selectedDeviceId) return;
      let active = true;
      void readConfiguration(installationId, selectedDeviceId)
        .then((configuration) => {
          if (active)
            setApplied({
              key: scopeKey,
              values: configuration.applied_snapshot,
            });
        })
        // The rows then show no value; the feeder's page reports the real error.
        .catch(() => {
          if (active) setApplied(null);
        });
      return () => {
        active = false;
      };
    }, [installationId, scopeKey, selectedDeviceId]),
  );
  const values = applied?.key === scopeKey ? applied.values : null;

  const manageDevice = (device: DeviceRecord) => {
    try {
      router.push({
        pathname: "/devices/[deviceId]",
        params: { deviceId: device.deviceId },
      });
    } catch {
      setActionErrors((current) => ({
        ...current,
        [device.deviceId]: "Device details could not be opened. Try again.",
      }));
    }
  };

  const retryRefresh = () => {
    setRefreshError(null);
    void refreshDevices().catch((reason) =>
      setRefreshError(
        reason instanceof Error
          ? reason.message
          : "Paired devices could not be refreshed.",
      ),
    );
  };

  const refreshMessage = deviceError || refreshError;
  const actionError = Object.values(actionErrors).find(Boolean);
  const selectedName = selectedDevice
    ? selectedDevice.alias?.trim() || selectedDevice.model
    : "";

  return (
    <AppPage
      edges={["top", "left", "right"]}
      header={<ScreenHeader title="Settings" />}
    >
      {refreshMessage ? (
        <Notice
          tone="error"
          actions={
            <Button variant="text" onPress={retryRefresh} disabled={refreshing}>
              Refresh devices
            </Button>
          }
        >
          {refreshMessage}
        </Notice>
      ) : null}

      <View style={styles.section}>
        <SectionHeader
          title="Feeders"
          action={{ label: "Add", onPress: () => router.push("/devices/add") }}
        />
        {devices.length === 0 && refreshing ? (
          <>
            <Skeleton height={72} />
            <Skeleton height={72} />
          </>
        ) : devices.length === 0 ? (
          <EmptyState
            icon="cpu"
            title="No feeders yet"
            description="Add a feeder to connect it to this app."
            action="Add a feeder"
            href="/devices/add"
          />
        ) : (
          <BentoCard flush>
            {devices.map((device, index) => {
              const selected = selectedDeviceId === device.deviceId;
              const name = device.alias?.trim() || device.model;
              const status = connection(device);
              return (
                <ListRow
                  key={device.deviceId}
                  divider={index > 0}
                  icon="cpu"
                  title={name}
                  lines={[
                    [device.location, device.isSimulated && "Simulator"]
                      .filter(Boolean)
                      .join(" · "),
                  ]}
                  footer={
                    <View style={styles.pills}>
                      <StatusLabel kind={status.kind}>
                        {status.text}
                      </StatusLabel>
                      {selected ? (
                        <StatusLabel kind="selected">Selected</StatusLabel>
                      ) : null}
                    </View>
                  }
                  trailing="chevron"
                  onPress={() => manageDevice(device)}
                  accessibilityLabel={`${name}${device.location ? `, ${device.location}` : ""}, ${status.text}${selected ? ", selected" : ""}${device.isSimulated ? ", simulator" : ""}`}
                  accessibilityHint="Opens this feeder."
                />
              );
            })}
          </BentoCard>
        )}
        {actionError ? <Notice tone="error">{actionError}</Notice> : null}
      </View>

      {selectedDevice ? (
        <View style={styles.section}>
          <SectionHeader
            title={
              "Feeder settings" +
              (devices.length > 1 ? " · " + selectedName : "")
            }
          />
          <BentoCard flush>
            <ListRow
              icon="globe"
              title="Time zone"
              lines={values ? [values.timezone] : undefined}
              trailing="chevron"
              onPress={() => router.push("/settings/timezone")}
            />
            <ListRow
              divider
              icon="waves"
              title="Oxygen limits"
              lines={
                values
                  ? [
                      oxygenText(
                        values.monitoring_limits.do_low_mg_l,
                        values.monitoring_limits.do_high_mg_l,
                      ),
                    ]
                  : undefined
              }
              trailing="chevron"
              onPress={() => router.push("/settings/oxygen")}
            />
            <ListRow
              divider
              icon="container"
              title="Low-feed alert"
              lines={
                values
                  ? [
                      values.low_feed_threshold_pct === null
                        ? "Off"
                        : `Below ${values.low_feed_threshold_pct}%`,
                    ]
                  : undefined
              }
              trailing="chevron"
              onPress={() => router.push("/settings/feed")}
            />
          </BentoCard>
        </View>
      ) : null}

      <View style={styles.section}>
        <SectionHeader title="About" />
        <BentoCard gap={0}>
          <KeyValue
            label="Version"
            value={Constants.expoConfig?.version ?? "—"}
          />
        </BentoCard>
      </View>
    </AppPage>
  );
}

const styles = StyleSheet.create({
  section: { gap: Spacing.two },
  pills: { flexDirection: "row", flexWrap: "wrap", gap: Spacing.two },
});
