import Constants from "expo-constants";
import * as Device from "expo-device";
import { router } from "expo-router";
import { useCallback, useEffect, useLayoutEffect, useRef } from "react";
import { AppState, Platform } from "react-native";

import {
  pinVerifiedAlert,
  refreshAlerts,
  setAlertScope,
  alertEntryFromEvent,
  type AlertEntry,
} from "@/lib/alerts";
import {
  requestAppApi,
  useDeviceAccess,
  type DeviceRecord,
} from "@/lib/device-access";
import { parseAlertPushPayload } from "@/lib/push-payload";
import { supabase } from "@/lib/supabase";

const EAS_PROJECT_ID = "1b3dc89f-3111-49d4-b91f-d5567e71d996";
const CHANNEL_ID = "feeder-alerts";
type NotificationResponse = import("expo-notifications").NotificationResponse;

function isPhysicalAndroidDevelopmentBuild() {
  return (
    Platform.OS === "android" &&
    Device.isDevice &&
    Constants.appOwnership !== "expo"
  );
}

function requestHeaders(requestId: string) {
  return { "X-Protocol-Major": "2", "X-Request-Id": requestId };
}

function responseKey(response: NotificationResponse, eventId: string) {
  return `${response.notification.request.identifier}:${eventId}`;
}

function onlyKeys(value: Record<string, unknown>, keys: string[]) {
  return (
    Object.keys(value).length === keys.length &&
    keys.every((key) => Object.prototype.hasOwnProperty.call(value, key))
  );
}

function registrationDto(
  value: unknown,
  requestId: string,
  registered: boolean,
) {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const response = value as Record<string, unknown>;
  return (
    onlyKeys(response, ["request_id", "registered"]) &&
    response.request_id === requestId &&
    response.registered === registered
  );
}

function retryableTapFailure(error: unknown) {
  const status =
    error &&
    typeof error === "object" &&
    "status" in error &&
    typeof error.status === "number"
      ? error.status
      : undefined;
  return (
    status === undefined || status === 401 || status === 429 || status >= 500
  );
}

function alertFromDetail(
  value: unknown,
  requestId: string,
  device: {
    deviceId: string;
    alias: string | null;
    model: string;
    isSimulated: boolean;
  },
): AlertEntry | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  const response = value as Record<string, unknown>;
  if (
    !onlyKeys(response, ["request_id", "device_id", "event"]) ||
    response.request_id !== requestId ||
    typeof response.device_id !== "string" ||
    response.device_id.toLowerCase() !== device.deviceId.toLowerCase()
  )
    return null;
  return alertEntryFromEvent(response.event, device);
}

export function NotificationController() {
  const access = useDeviceAccess();
  const { refreshDevices } = access;
  const accessRef = useRef(access);
  useLayoutEffect(() => {
    accessRef.current = access;
  }, [access]);
  const lifecycleRef = useRef(0);
  const lifecycleActiveRef = useRef(false);
  const alertScopeEpochRef = useRef(0);
  const deviceIds = access.devices
    .map((device) => device.deviceId.toLowerCase())
    .sort();
  const deviceScope = deviceIds.join(",");
  const currentNotificationsRef = useRef<
    typeof import("expo-notifications") | null
  >(null);
  const notificationLoadRef = useRef<Promise<
    typeof import("expo-notifications") | null
  > | null>(null);
  const registerQueueRef = useRef<Promise<void>>(Promise.resolve());
  const permissionPromptedRef = useRef(false);
  const pendingResponseRef = useRef<NotificationResponse | null>(null);
  const processedResponseRef = useRef(new Set<string>());
  const inFlightResponseRef = useRef(new Set<string>());
  const responseHandlerRef = useRef<
    (response: NotificationResponse) => Promise<void>
  >(async () => {});

  const getNotifications = useCallback(async () => {
    if (!isPhysicalAndroidDevelopmentBuild()) return null;
    if (currentNotificationsRef.current) return currentNotificationsRef.current;
    notificationLoadRef.current ??= import("expo-notifications")
      .then((Notifications) => {
        Notifications.setNotificationHandler({
          handleNotification: async () => ({
            shouldPlaySound: false,
            shouldSetBadge: false,
            shouldShowBanner: false,
            shouldShowList: false,
          }),
        });
        currentNotificationsRef.current = Notifications;
        return Notifications;
      })
      .catch(() => null);
    return notificationLoadRef.current;
  }, []);

  const isLifecycleCurrent = useCallback(
    (lifecycle: number, installationId: string) => {
      const current = accessRef.current;
      return (
        lifecycleActiveRef.current &&
        lifecycleRef.current === lifecycle &&
        current.phase === "ready" &&
        current.installationId?.toLowerCase() === installationId.toLowerCase()
      );
    },
    [],
  );

  const refreshCurrentAlerts = useCallback(
    async (
      installationId: string,
      devices: DeviceRecord[],
      lifecycle: number,
    ) => {
      if (!isLifecycleCurrent(lifecycle, installationId)) return;
      const revoked = await refreshAlerts(installationId, devices).catch(
        () => [],
      );
      if (revoked.length && isLifecycleCurrent(lifecycle, installationId)) {
        await refreshDevices().catch(() => []);
      }
    },
    [isLifecycleCurrent, refreshDevices],
  );

  const revokeToken = useCallback(
    async (installationId: string, lifecycle: number) => {
      if (!isLifecycleCurrent(lifecycle, installationId)) return false;
      const requestId = crypto.randomUUID();
      const response = await requestAppApi(
        installationId,
        "/push-token",
        "DELETE",
        {
          protocol_major: 2,
          request_id: requestId,
        },
        requestHeaders(requestId),
      );
      return (
        isLifecycleCurrent(lifecycle, installationId) &&
        registrationDto(response, requestId, false)
      );
    },
    [isLifecycleCurrent],
  );

  const registerToken = useCallback(
    (requestedLifecycle?: number) => {
      const lifecycle = requestedLifecycle ?? lifecycleRef.current;
      const installationId = accessRef.current.installationId;
      if (!installationId) return Promise.resolve();
      const queued = registerQueueRef.current.then(async () => {
        const current = accessRef.current;
        if (
          !isLifecycleCurrent(lifecycle, installationId) ||
          current.devices.length === 0
        )
          return;
        const Notifications = await getNotifications();
        if (!Notifications || !isLifecycleCurrent(lifecycle, installationId))
          return;
        try {
          await Notifications.setNotificationChannelAsync(CHANNEL_ID, {
            name: "Feeder alerts",
            importance: Notifications.AndroidImportance.HIGH,
          });
          if (!isLifecycleCurrent(lifecycle, installationId)) return;
          let permission = await Notifications.getPermissionsAsync();
          if (!isLifecycleCurrent(lifecycle, installationId)) return;
          if (
            !permission.granted &&
            permission.status === "undetermined" &&
            !permissionPromptedRef.current
          ) {
            permissionPromptedRef.current = true;
            permission = await Notifications.requestPermissionsAsync();
            if (!isLifecycleCurrent(lifecycle, installationId)) return;
          }
          if (!permission.granted) {
            await revokeToken(installationId, lifecycle).catch(() => false);
            return;
          }
          const token = await Notifications.getExpoPushTokenAsync({
            projectId: EAS_PROJECT_ID,
          });
          const latest = accessRef.current;
          if (
            !isLifecycleCurrent(lifecycle, installationId) ||
            latest.devices.length === 0
          )
            return;
          const requestId = crypto.randomUUID();
          const response = await requestAppApi(
            installationId,
            "/push-token",
            "POST",
            {
              protocol_major: 2,
              request_id: requestId,
              platform: "android",
              eas_project_id: EAS_PROJECT_ID,
              expo_push_token: token.data,
            },
            requestHeaders(requestId),
          );
          if (
            !isLifecycleCurrent(lifecycle, installationId) ||
            !registrationDto(response, requestId, true)
          )
            return;
        } catch {
          // Registration readiness is never inferred from a transient failure.
        }
      });
      registerQueueRef.current = queued.catch(() => undefined);
      return queued;
    },
    [getNotifications, isLifecycleCurrent, revokeToken],
  );

  const resolveTap = useCallback(
    async (
      response: NotificationResponse,
      lifecycle: number,
    ): Promise<"handled" | "ignored" | "retry"> => {
      const payload = parseAlertPushPayload(
        response.notification.request.content.data,
      );
      if (!payload) return "ignored";
      const initial = accessRef.current;
      if (initial.phase !== "ready" || !initial.installationId) return "retry";
      const installationId = initial.installationId.toLowerCase();
      if (!isLifecycleCurrent(lifecycle, installationId)) return "ignored";
      try {
        const requestId = crypto.randomUUID();
        const result = await requestAppApi(
          installationId,
          `/devices/${payload.device_id}/notifications/${payload.event_id}`,
          "GET",
          undefined,
          requestHeaders(requestId),
        );
        if (!isLifecycleCurrent(lifecycle, installationId)) return "ignored";
        const currentDevices = await accessRef.current
          .refreshDevices()
          .catch(() => null);
        if (!isLifecycleCurrent(lifecycle, installationId)) return "ignored";
        if (!currentDevices) return "retry";
        const device = currentDevices.find(
          (item) => item.deviceId.toLowerCase() === payload.device_id,
        );
        if (!device) return "retry";
        const entry = alertFromDetail(result, requestId, device);
        if (
          !entry ||
          entry.id !== payload.event_id ||
          entry.deviceId !== payload.device_id
        )
          return "ignored";
        await accessRef.current.selectDevice(payload.device_id);
        if (
          !isLifecycleCurrent(lifecycle, installationId) ||
          !accessRef.current.devices.some(
            (item) => item.deviceId.toLowerCase() === payload.device_id,
          )
        )
          return "ignored";
        await pinVerifiedAlert(
          entry,
          installationId,
          alertScopeEpochRef.current,
          () => isLifecycleCurrent(lifecycle, installationId),
        );
        if (!isLifecycleCurrent(lifecycle, installationId)) return "ignored";
        // A feeding outcome opens its history run; a reading crossing opens the list.
        if (entry.sequenceId)
          router.push({
            pathname: "/history/[runId]",
            params: { runId: entry.sequenceId, device_id: entry.deviceId },
          });
        else router.push("/notifications");
        return "handled";
      } catch (error) {
        return retryableTapFailure(error) ? "retry" : "ignored";
      }
    },
    [isLifecycleCurrent],
  );
  const handleResponse = useCallback(
    async (response: NotificationResponse) => {
      const payload = parseAlertPushPayload(
        response.notification.request.content.data,
      );
      if (!payload) {
        await currentNotificationsRef.current
          ?.clearLastNotificationResponseAsync()
          .catch(() => undefined);
        return;
      }
      const key = responseKey(response, payload.event_id);
      if (processedResponseRef.current.has(key)) {
        await currentNotificationsRef.current
          ?.clearLastNotificationResponseAsync()
          .catch(() => undefined);
        return;
      }
      if (inFlightResponseRef.current.has(key)) return;
      if (
        accessRef.current.phase !== "ready" ||
        !accessRef.current.installationId
      ) {
        pendingResponseRef.current = response;
        return;
      }
      const lifecycle = lifecycleRef.current;
      inFlightResponseRef.current.add(key);
      try {
        const result = await resolveTap(response, lifecycle);
        if (result === "retry") {
          pendingResponseRef.current = response;
          return;
        }
        processedResponseRef.current.add(key);
        pendingResponseRef.current = null;
        await currentNotificationsRef.current
          ?.clearLastNotificationResponseAsync()
          .catch(() => undefined);
      } finally {
        inFlightResponseRef.current.delete(key);
      }
    },
    [resolveTap],
  );
  useLayoutEffect(() => {
    responseHandlerRef.current = handleResponse;
  }, [handleResponse]);

  useEffect(() => {
    const scope = deviceScope;
    const installationId =
      access.phase === "ready" ? access.installationId : null;
    alertScopeEpochRef.current = setAlertScope(installationId, scope);
    if (!installationId) {
      lifecycleActiveRef.current = false;
      lifecycleRef.current += 1;
      return;
    }
    const lifecycle = ++lifecycleRef.current;
    lifecycleActiveRef.current = true;
    void refreshCurrentAlerts(installationId, access.devices, lifecycle);
    const channels = access.devices.map((device) =>
      supabase
        .channel(`alert-events-${access.installationId}-${device.deviceId}`)
        .on(
          "postgres_changes",
          {
            event: "INSERT",
            schema: "public",
            table: "alert_events",
            filter: `device_id=eq.${device.deviceId}`,
          },
          () => {
            // Realtime is only a wake-up hint; the authorized app-api read supplies facts.
            const current = accessRef.current;
            if (
              AppState.currentState === "active" &&
              isLifecycleCurrent(lifecycle, installationId)
            ) {
              void refreshCurrentAlerts(
                installationId,
                current.devices,
                lifecycle,
              );
            }
          },
        )
        .subscribe(),
    );
    let refreshTimer: ReturnType<typeof setInterval> | null = null;
    let appIsActive = AppState.currentState === "active";
    const startFallbackRefresh = () => {
      if (!appIsActive || !deviceScope || refreshTimer) return;
      refreshTimer = setInterval(() => {
        if (!isLifecycleCurrent(lifecycle, installationId)) return;
        const current = accessRef.current;
        void refreshCurrentAlerts(installationId, current.devices, lifecycle);
        const pending = pendingResponseRef.current;
        if (pending) void responseHandlerRef.current(pending);
      }, 60_000);
    };
    const stopFallbackRefresh = () => {
      if (refreshTimer) clearInterval(refreshTimer);
      refreshTimer = null;
    };
    startFallbackRefresh();
    const appState = AppState.addEventListener("change", (state) => {
      if (state !== "active") {
        appIsActive = false;
        stopFallbackRefresh();
        return;
      }
      appIsActive = true;
      const current = accessRef.current;
      if (!isLifecycleCurrent(lifecycle, installationId)) return;
      startFallbackRefresh();
      void current
        .refreshDevices()
        .then((nextDevices) => {
          if (!isLifecycleCurrent(lifecycle, installationId)) return;
          void refreshCurrentAlerts(installationId, nextDevices, lifecycle);
          void registerToken(lifecycle);
          const pending = pendingResponseRef.current;
          if (pending) void responseHandlerRef.current(pending);
        })
        .catch(() => undefined);
    });
    if (deviceScope) void registerToken(lifecycle);
    else if (isPhysicalAndroidDevelopmentBuild())
      void revokeToken(installationId, lifecycle).catch(() => false);
    return () => {
      if (lifecycleRef.current === lifecycle) {
        lifecycleActiveRef.current = false;
        lifecycleRef.current += 1;
      }
      stopFallbackRefresh();
      appState.remove();
      for (const channel of channels) void supabase.removeChannel(channel);
    };
  }, [
    access.devices,
    access.installationId,
    access.phase,
    deviceScope,
    isLifecycleCurrent,
    refreshCurrentAlerts,
    registerToken,
    revokeToken,
  ]);

  useEffect(() => {
    if (!isPhysicalAndroidDevelopmentBuild()) return;
    let active = true;
    let responseSubscription:
      import("expo-notifications").EventSubscription | null = null;
    let receivedSubscription:
      import("expo-notifications").EventSubscription | null = null;
    let tokenSubscription:
      import("expo-notifications").EventSubscription | null = null;
    void getNotifications().then(async (Notifications) => {
      if (!active || !Notifications) return;
      receivedSubscription = Notifications.addNotificationReceivedListener(
        () => {
          const current = accessRef.current;
          const lifecycle = lifecycleRef.current;
          if (
            current.installationId &&
            isLifecycleCurrent(lifecycle, current.installationId)
          ) {
            void refreshCurrentAlerts(
              current.installationId,
              current.devices,
              lifecycle,
            );
          }
        },
      );
      responseSubscription =
        Notifications.addNotificationResponseReceivedListener((response) => {
          void responseHandlerRef.current(response);
        });
      tokenSubscription = Notifications.addPushTokenListener(() => {
        if (active) void registerToken(lifecycleRef.current);
      });
      const last = await Notifications.getLastNotificationResponseAsync().catch(
        () => null,
      );
      if (active && last) void responseHandlerRef.current(last);
    });
    return () => {
      active = false;
      responseSubscription?.remove();
      receivedSubscription?.remove();
      tokenSubscription?.remove();
    };
  }, [
    deviceScope,
    getNotifications,
    isLifecycleCurrent,
    refreshCurrentAlerts,
    registerToken,
  ]);

  useEffect(() => {
    const pending = pendingResponseRef.current;
    if (!pending || access.phase !== "ready" || !access.installationId) return;
    pendingResponseRef.current = null;
    void responseHandlerRef.current(pending);
  }, [access.devices, access.installationId, access.phase, deviceScope]);

  return null;
}
