import type { StatusKind } from "./bento-kit";

const labels: Record<string, string> = {
  queued: "Queued",
  accepted: "Accepted",
  not_started: "Not started",
  running: "In progress",
  completed: "Completed",
  partial: "Partial",
  failed: "Failed",
  rejected: "Rejected",
  expired: "Expired",
  unknown: "Unknown",
};
const kinds: Record<string, StatusKind> = {
  queued: "pending",
  accepted: "pending",
  running: "running",
  completed: "completed",
  partial: "warning",
  failed: "failed",
  rejected: "failed",
  expired: "failed",
  unknown: "unknown",
};

export function statusText(status: string) {
  return labels[status] ?? status;
}

export function statusKind(status: string): StatusKind {
  return kinds[status] ?? "unknown";
}

/** "just now", "42 seconds ago", "5 min ago", "3 h ago", "2 d ago". */
export function agoText(seconds: number | null) {
  if (seconds === null) return "age unavailable";
  if (seconds < 1) return "just now";
  if (seconds < 60) return Math.floor(seconds) + " seconds ago";
  if (seconds < 3600) return Math.floor(seconds / 60) + " min ago";
  if (seconds < 86400) return Math.floor(seconds / 3600) + " h ago";
  return Math.floor(seconds / 86400) + " d ago";
}

/** "Completed · 35 g measured": the status, plus the dispensed total only when every targeted nozzle has a valid measurement. */
export function feedingSummary(
  record: {
    status: string;
    targets: { nozzle_number: number }[];
    nozzle_results: {
      nozzle_number: number;
      measurement_quality: string;
      measured_dispensed_g: number | null;
    }[];
  },
  simulated: boolean,
) {
  let total: number | null = record.targets.length ? 0 : null;
  for (const target of record.targets) {
    const result = record.nozzle_results.find(
      (item) => item.nozzle_number === target.nozzle_number,
    );
    total =
      total !== null &&
      result?.measurement_quality === "valid" &&
      result.measured_dispensed_g !== null
        ? total + result.measured_dispensed_g
        : null;
  }
  return total === null
    ? statusText(record.status)
    : statusText(record.status) +
        " · " +
        Math.round(total * 10) / 10 +
        " g " +
        (simulated ? "simulated" : "measured");
}

function dayKey(date: Date, timeZone: string) {
  return new Intl.DateTimeFormat("en-CA", { timeZone }).format(date);
}

/** "Today", "Yesterday", "Tomorrow", or a medium date, judged in the given time zone. */
export function relativeDayLabel(
  date: Date,
  timeZone: string,
  now: Date = new Date(),
) {
  const key = dayKey(date, timeZone);
  if (key === dayKey(now, timeZone)) return "Today";
  if (key === dayKey(new Date(now.getTime() - 86_400_000), timeZone))
    return "Yesterday";
  if (key === dayKey(new Date(now.getTime() + 86_400_000), timeZone))
    return "Tomorrow";
  return new Intl.DateTimeFormat(undefined, {
    timeZone,
    dateStyle: "medium",
  }).format(date);
}

/** Splits a clock time into its digits and its AM/PM marker so they can be styled apart. */
export function clockParts(date: Date, timeZone: string) {
  const format = new Intl.DateTimeFormat(undefined, {
    timeZone,
    hour: "numeric",
    minute: "2-digit",
  });
  if (typeof format.formatToParts !== "function")
    return { time: format.format(date), period: "" };
  const parts = format.formatToParts(date);
  const hour = parts.findIndex((part) => part.type === "hour");
  const minute = parts.findIndex((part) => part.type === "minute");
  return {
    time: parts
      .slice(Math.min(hour, minute), Math.max(hour, minute) + 1)
      .map((part) => part.value)
      .join(""),
    period: parts.find((part) => part.type === "dayPeriod")?.value ?? "",
  };
}

/** A feeder-local "HH:mm" as the phone's clock style, e.g. "8:05 AM". No time zone is applied. */
export function displayTime(localTime: string) {
  const [hour, minute] = localTime.split(":").map(Number);
  if (!Number.isFinite(hour) || !Number.isFinite(minute)) return localTime;
  const parts = clockParts(new Date(Date.UTC(2000, 0, 1, hour, minute)), "UTC");
  return parts.period ? parts.time + " " + parts.period : parts.time;
}

/** The time picker works in the phone's calendar; a fixed winter date avoids DST gaps. */
export function pickerDate(localTime: string) {
  const [hour, minute] = localTime.split(":").map(Number);
  return new Date(2000, 0, 1, hour || 0, minute || 0);
}

/** The picked wall-clock hour and minute as canonical feeder-local "HH:mm". */
export function localTimeFromDate(date: Date) {
  const pad = (value: number) => String(value).padStart(2, "0");
  return pad(date.getHours()) + ":" + pad(date.getMinutes());
}

/** The zone's UTC offset at `at`, e.g. "UTC+08:00" or "UTC−03:30"; null if the runtime cannot tell. */
export function zoneOffsetLabel(timeZone: string, at: Date = new Date()) {
  try {
    const format = new Intl.DateTimeFormat("en-US", {
      timeZone,
      hourCycle: "h23",
      year: "numeric",
      month: "2-digit",
      day: "2-digit",
      hour: "2-digit",
      minute: "2-digit",
    });
    if (typeof format.formatToParts !== "function") return null;
    const part = (type: string) =>
      Number(
        format.formatToParts(at).find((item) => item.type === type)?.value,
      );
    const wall = Date.UTC(
      part("year"),
      part("month") - 1,
      part("day"),
      part("hour") % 24,
      part("minute"),
    );
    const minutes = Math.round(
      (wall - Math.floor(at.getTime() / 60000) * 60000) / 60000,
    );
    if (!Number.isFinite(minutes)) return null;
    const abs = Math.abs(minutes);
    return (
      "UTC" +
      (minutes < 0 ? "−" : "+") +
      String(Math.floor(abs / 60)).padStart(2, "0") +
      ":" +
      String(abs % 60).padStart(2, "0")
    );
  } catch {
    return null;
  }
}
