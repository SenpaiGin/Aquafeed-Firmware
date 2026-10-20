import { router, useFocusEffect } from "expo-router";
import { Alert, Platform, Text } from "react-native";
import { useCallback, useEffect, useState } from "react";

import {
  BentoCard,
  Button,
  IconButton,
  ListRow,
  Sheet,
} from "@/components/app-shell";
import { relativeDayLabel } from "@/components/feed-status";
import { Typography } from "@/constants/theme";
import {
  alertLine,
  alertTitle,
  clear,
  markAllRead,
  markRead,
  remove,
  refreshAlerts,
  useAlerts,
  useUnreadCount,
} from "@/lib/alerts";
import { useDeviceAccess } from "@/lib/device-access";
import { readConfiguration } from "@/lib/schedules";

const phoneZone = Intl.DateTimeFormat().resolvedOptions().timeZone;

/** The alert time in the feeder's applied zone; marked as phone time until that zone is known. */
function timeLabel(at: string, feederZone: string | null | undefined) {
  const date = new Date(at);
  const timeZone = feederZone ?? phoneZone;
  const day = relativeDayLabel(date, timeZone);
  const label =
    day === "Today"
      ? new Intl.DateTimeFormat(undefined, {
          timeZone,
          timeStyle: "short",
        }).format(date)
      : day;
  return feederZone ? label : label + " · phone time";
}

function confirmClear() {
  const title = "Delete all notifications?";
  const description = "This hides notifications for this installation.";
  if (Platform.OS === "web") {
    if (globalThis.confirm(`${title} ${description}`)) clear();
    return;
  }
  Alert.alert(title, description, [
    { text: "Cancel", style: "cancel" },
    { text: "Delete all", style: "destructive", onPress: clear },
  ]);
}

export default function NotificationsScreen() {
  const alerts = useAlerts();
  const unread = useUnreadCount();
  const { installationId, devices, refreshDevices, selectDevice } =
    useDeviceAccess();
  const [zones, setZones] = useState<Record<string, string | null>>({});
  const deviceKey = [...new Set(alerts.map((entry) => entry.deviceId))]
    .sort()
    .join(",");
  useEffect(() => {
    if (!installationId || !deviceKey) return;
    let active = true;
    for (const deviceId of deviceKey.split(","))
      void readConfiguration(installationId, deviceId)
        .then((value) => value.applied_snapshot?.timezone ?? null)
        .catch(() => null)
        .then((zone) => {
          if (active) setZones((current) => ({ ...current, [deviceId]: zone }));
        });
    return () => {
      active = false;
    };
  }, [installationId, deviceKey]);
  useFocusEffect(
    useCallback(() => {
      if (!installationId) return;
      let active = true;
      void refreshAlerts(installationId, devices).then((revoked) => {
        if (active && revoked.length) void refreshDevices().catch(() => []);
      });
      return () => {
        active = false;
      };
    }, [installationId, devices, refreshDevices]),
  );
  const close = () =>
    router.canGoBack() ? router.back() : router.replace("/");

  return (
    <Sheet
      visible
      title="Notifications"
      onClose={close}
      footer={
        alerts.length ? (
          <>
            <Button
              variant="secondary"
              onPress={markAllRead}
              disabled={unread === 0}
            >
              Mark all as read
            </Button>
            <Button variant="text" onPress={confirmClear}>
              Delete all
            </Button>
          </>
        ) : undefined
      }
    >
      {alerts.length ? (
        <BentoCard flush>
          {alerts.map((entry, index) => {
            const title = alertTitle(entry.kind);
            const line = alertLine(entry);
            const time = timeLabel(entry.at, zones[entry.deviceId]);
            return (
              <ListRow
                key={entry.id}
                divider={index > 0}
                icon={entry.read ? "bell" : "bell-dot"}
                title={title}
                meta={time}
                lines={[line]}
                trailing={
                  <IconButton
                    icon="trash-2"
                    accessibilityLabel="Delete notification"
                    onPress={() => remove(entry.id)}
                  />
                }
                onPress={() => {
                  markRead(entry.id);
                  // A feeding outcome opens its history run for that feeder.
                  const runId = entry.sequenceId;
                  if (runId)
                    void selectDevice(entry.deviceId)
                      .then(() =>
                        router.push({
                          pathname: "/history/[runId]",
                          params: { runId, device_id: entry.deviceId },
                        }),
                      )
                      .catch(() => undefined);
                }}
                accessibilityLabel={`${title}, ${line}, ${time}${entry.read ? "" : ", unread"}`}
                accessibilityHint={
                  entry.sequenceId ? "Opens the feeding details" : undefined
                }
              />
            );
          })}
        </BentoCard>
      ) : (
        <Text style={Typography.supporting}>No notifications yet.</Text>
      )}
    </Sheet>
  );
}
