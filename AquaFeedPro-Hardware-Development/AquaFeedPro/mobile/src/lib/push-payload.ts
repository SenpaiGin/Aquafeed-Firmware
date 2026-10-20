const UUID =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

export type AlertPushPayload = {
  event_id: string;
  device_id: string;
  route_hint: "notifications";
};

/** Push data is untrusted input. Only the fixed notification route is accepted. */
export function parseAlertPushPayload(value: unknown): AlertPushPayload | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  const item = value as Record<string, unknown>;
  if (Object.keys(item).sort().join(",") !== "device_id,event_id,route_hint")
    return null;
  if (
    typeof item.event_id !== "string" ||
    !UUID.test(item.event_id) ||
    typeof item.device_id !== "string" ||
    !UUID.test(item.device_id) ||
    item.route_hint !== "notifications"
  )
    return null;
  return {
    event_id: item.event_id.toLowerCase(),
    device_id: item.device_id.toLowerCase(),
    route_hint: "notifications",
  };
}
