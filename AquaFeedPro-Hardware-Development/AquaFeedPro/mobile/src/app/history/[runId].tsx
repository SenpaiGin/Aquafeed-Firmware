import { useLocalSearchParams } from "expo-router";
import { useEffect, useState } from "react";
import { StyleSheet, Text, View } from "react-native";

import {
  AppPage,
  BentoCard,
  KeyValue,
  ListRow,
  Notice,
  ScreenHeader,
  Skeleton,
  StatusLabel,
  statusIcons,
} from "@/components/app-shell";
import { statusKind, statusText } from "@/components/feed-status";
import { Colors, Typography } from "@/constants/theme";
import { useDeviceAccess } from "@/lib/device-access";
import { isUuid } from "@/lib/device-access-state";
import { readHistoryDetail } from "@/lib/manual-feed";

export default function FeedingDetailsScreen() {
  const { runId, device_id: rawDeviceId } = useLocalSearchParams<{
    runId?: string;
    device_id?: string;
  }>();
  const routeDeviceId = Array.isArray(rawDeviceId)
    ? rawDeviceId[0]
    : rawDeviceId;
  const canonicalRouteDeviceId = isUuid(routeDeviceId)
    ? routeDeviceId.toLowerCase()
    : null;
  const { installationId, selectedDevice, selectedDeviceId, scopeRevision } =
    useDeviceAccess();
  const [targetScope] = useState(() => ({
    deviceId: canonicalRouteDeviceId ?? selectedDevice?.deviceId ?? null,
    installationId,
    selectedDeviceId,
    scopeRevision,
    simulated:
      selectedDevice?.deviceId === canonicalRouteDeviceId
        ? selectedDevice.isSimulated
        : (selectedDevice?.isSimulated ?? false),
  }));
  const targetDeviceId = targetScope.deviceId;
  const targetSimulated = targetScope.simulated;
  const [loaded, setLoaded] = useState<{
    key: string;
    detail: Awaited<ReturnType<typeof readHistoryDetail>>;
  } | null>(null);
  const [failedKey, setFailedKey] = useState<string | null>(null);
  const validRoute = Boolean(
    installationId &&
    targetDeviceId &&
    installationId === targetScope.installationId &&
    selectedDeviceId === targetDeviceId &&
    scopeRevision === targetScope.scopeRevision &&
    (routeDeviceId === undefined ||
      canonicalRouteDeviceId === targetDeviceId) &&
    typeof runId === "string" &&
    /^[0-9a-f-]{36}$/i.test(runId),
  );
  const requestKey = `${installationId ?? ""}:${selectedDeviceId ?? ""}:${scopeRevision}:${String(runId ?? "")}`;

  useEffect(() => {
    let active = true;
    if (
      !validRoute ||
      !installationId ||
      !targetDeviceId ||
      typeof runId !== "string"
    )
      return () => {
        active = false;
      };
    void readHistoryDetail(installationId, targetDeviceId, runId)
      .then((detail) => {
        if (active) setLoaded({ key: requestKey, detail });
      })
      .catch(() => {
        if (active) setFailedKey(requestKey);
      });
    return () => {
      active = false;
    };
  }, [
    installationId,
    requestKey,
    runId,
    scopeRevision,
    selectedDeviceId,
    targetDeviceId,
    targetScope,
    validRoute,
  ]);

  const detail = loaded?.key === requestKey ? loaded.detail : null;
  const record = detail?.record ?? null;
  const timezone = detail?.timezone ?? "UTC";
  const timezoneKnown = detail?.timezone_known ?? false;
  const error =
    !validRoute || failedKey === requestKey
      ? "This feeding record is not available for the selected feeder."
      : null;

  return (
    <AppPage>
      <View style={styles.group}>
        <ScreenHeader
          title="Feeding details"
          back={{ label: "Back to History", fallback: "/history" }}
        />
        {error ? <Notice tone="error">{error}</Notice> : null}
        {record?.safety_lockout ? (
          <Notice tone="error">
            A safety lockout is active. The feeder needs an in-person safety
            check.
          </Notice>
        ) : null}
        {record?.lockout_resolution ? (
          <Notice tone="info">
            {`Maintenance recorded: ${record.lockout_resolution.resolution_reason}. This does not change the unknown feed outcome.`}
          </Notice>
        ) : null}
      </View>
      {!record && !error ? (
        <View style={styles.group}>
          <Skeleton height={148} />
          <Skeleton height={172} />
        </View>
      ) : null}
      {record ? (
        <>
          <BentoCard flush>
            <ListRow
              align="center"
              icon={statusIcons[statusKind(record.status)]}
              title={
                record.source === "manual"
                  ? "Manual feeding"
                  : "Scheduled feeding"
              }
              trailing={
                <StatusLabel kind={statusKind(record.status)}>
                  {statusText(record.status)}
                </StatusLabel>
              }
            />
            <View style={styles.summaryDetails}>
              <KeyValue
                label="Requested"
                value={new Date(record.created_at).toLocaleString(undefined, {
                  timeZone: timezone,
                })}
              />
              <KeyValue
                divider
                label="Time zone"
                value={
                  timezoneKnown
                    ? timezone
                    : `${timezone} · device timezone unavailable`
                }
              />
              {record.reason_code ? (
                <KeyValue divider label="Reason" value={record.reason_code} />
              ) : null}
            </View>
          </BentoCard>
          <View style={styles.group}>
            {record.nozzle_results.map((result) => {
              const requested =
                result.requested_dose.mode === "grams"
                  ? `${result.requested_dose.amount_g} g requested`
                  : `Portion ${result.requested_dose.fixed_portion_id} requested`;
              const measured =
                result.measurement_quality === "valid" &&
                result.measured_dispensed_g !== null
                  ? targetSimulated
                    ? `${result.measured_dispensed_g} g synthetic simulator reading`
                    : `${result.measured_dispensed_g} g measured`
                  : "Not measured";
              return (
                <BentoCard
                  key={result.nozzle_number}
                  gap={0}
                  style={styles.nozzleCard}
                >
                  <View style={styles.nozzleHeader}>
                    <Text
                      accessibilityRole="header"
                      style={Typography.cardTitle}
                    >
                      Nozzle {result.nozzle_number}
                    </Text>
                    <StatusLabel kind={statusKind(result.status)}>
                      {result.status === "not_started"
                        ? "Not started"
                        : statusText(result.status)}
                    </StatusLabel>
                  </View>
                  <KeyValue divider label="Requested" value={requested} />
                  <KeyValue divider label="Measured" value={measured} />
                  {result.estimated_dispensed_g !== null ? (
                    <KeyValue
                      divider
                      label="Estimated"
                      value={`${result.estimated_dispensed_g} g · simulator estimate`}
                    />
                  ) : null}
                </BentoCard>
              );
            })}
          </View>
          <Text style={Typography.metadata}>
            {targetSimulated
              ? "Simulator values are deterministic test data, not physical weighing. "
              : ""}
            This page only reads the saved result. Opening a link never starts a
            feed.
          </Text>
        </>
      ) : null}
    </AppPage>
  );
}

const styles = StyleSheet.create({
  group: { gap: 12 },
  summaryDetails: {
    paddingHorizontal: 16,
    borderTopWidth: 1,
    borderTopColor: Colors.light.border,
  },
  nozzleCard: { paddingVertical: 4 },
  nozzleHeader: {
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "space-between",
    gap: 12,
    paddingVertical: 12,
  },
});
