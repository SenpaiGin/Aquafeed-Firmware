type JsonRecord = Record<string, unknown>;
type RpcResult = { data: unknown; error: unknown };
export type PushSenderAdmin = { rpc(name: string, args?: Record<string, unknown>): Promise<RpcResult> };
type SenderOptions = {
  admin: PushSenderAdmin;
  fetcher?: typeof fetch;
  expoAccessToken?: string;
};

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const TOKEN = /^(Exponent|Expo)PushToken\[[A-Za-z0-9_-]{1,255}\]$/;
const EXPO_SEND_URL = "https://exp.host/--/api/v2/push/send";
const EXPO_RECEIPTS_URL = "https://exp.host/--/api/v2/push/getReceipts";

function record(value: unknown): JsonRecord | null {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? value as JsonRecord
    : null;
}

function dataRecord(result: unknown): JsonRecord | null {
  const item = record(result);
  return item && !item.error ? record(item.data) : null;
}

// Same titles and lines as mobile/src/lib/alerts.ts (contracts/README.md, "Alert presentation").
const TITLES: Record<string, string> = {
  do_low: "Oxygen below limit",
  do_high: "Oxygen above limit",
  feed_low: "Feed is low",
  feeding_failed: "Feeding failed",
  feeding_partial: "Feeding partly completed",
  feeding_unknown: "Feeding result unknown",
  feeding_unmeasured: "Feeding not measured",
};
const FEEDING_LINES: Record<string, string> = {
  feeding_failed: "No nozzle completed",
  feeding_partial: "Only one nozzle completed",
  feeding_unknown: "Not confirmed · check before feeding again",
  feeding_unmeasured: "Final weight unavailable",
};

function body(kind: string, value: number | null, limit: number | null, name: string, simulated: boolean) {
  const number = (value: number) => Number(value.toFixed(1));
  const line = value === null || limit === null
    ? FEEDING_LINES[kind]
    : kind === "feed_low"
    ? `${number(value)}% · alert below ${limit}%`
    : `${number(value)} mg/L · limit ${limit}`;
  return [line, name, simulated && "Simulator"].filter(Boolean).join(" · ");
}

function buildMessage(item: JsonRecord, token: string) {
  if (
    typeof item.event_id !== "string" || !UUID.test(item.event_id) ||
    typeof item.device_id !== "string" || !UUID.test(item.device_id) ||
    typeof item.kind !== "string" || !Object.hasOwn(TITLES, item.kind) ||
    // Telemetry kinds carry a finite reading and limit; feeding kinds carry neither.
    (Object.hasOwn(FEEDING_LINES, item.kind)
      ? item.value !== null || item.limit !== null
      : typeof item.value !== "number" || !Number.isFinite(item.value) ||
        typeof item.limit !== "number" || !Number.isFinite(item.limit)) ||
    typeof item.device_name !== "string" || item.device_name.length < 1 || item.device_name.length > 120 ||
    typeof item.is_simulated !== "boolean" || !TOKEN.test(token)
  ) return null;
  const eventId = item.event_id.toLowerCase();
  return {
    to: token,
    title: TITLES[item.kind],
    body: body(item.kind, item.value as number | null, item.limit as number | null, item.device_name, item.is_simulated),
    sound: null,
    priority: "high",
    channelId: "feeder-alerts",
    tag: eventId,
    collapseId: eventId,
    data: { event_id: eventId, device_id: item.device_id.toLowerCase(), route_hint: "notifications" },
  };
}

async function rpc(admin: PushSenderAdmin, name: string, args: Record<string, unknown> = {}) {
  const result = await admin.rpc(name, args);
  if (result.error) throw new Error("Push service operation failed.");
  const data = record(result.data);
  if (!data) throw new Error("Push service response was invalid.");
  return data;
}

async function recordSend(
  admin: PushSenderAdmin,
  item: JsonRecord,
  outcome: string,
  ticketId: string | null = null,
  error: string | null = null,
) {
  return rpc(admin, "art96_record_push_send", {
    p_delivery_id: item.delivery_id,
    p_lease_id: item.lease_id,
    p_generation: item.token_generation,
    p_outcome: outcome,
    p_ticket_id: ticketId,
    p_error: error,
  });
}

async function recordSendSafely(
  admin: PushSenderAdmin,
  item: JsonRecord,
  outcome: string,
  ticketId: string | null = null,
  error: string | null = null,
) {
  try {
    await recordSend(admin, item, outcome, ticketId, error);
  } catch {
    // A lost persistence result remains leased until expiry; do not rewrite a ticket as ambiguous.
  }
}

function expoHeaders(accessToken: string | undefined) {
  return {
    "Content-Type": "application/json",
    ...(accessToken ? { Authorization: `Bearer ${accessToken}` } : {}),
  };
}

async function fetchJson(fetcher: typeof fetch, url: string, accessToken: string | undefined, payload: unknown) {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 15_000);
  try {
    const response = await fetcher(url, {
      method: "POST",
      headers: expoHeaders(accessToken),
      body: JSON.stringify(payload),
      signal: controller.signal,
    });
    let value: unknown = null;
    try { value = await response.json(); } catch { /* malformed provider payload is handled below */ }
    return { response, value };
  } finally {
    clearTimeout(timeout);
  }
}

function validatedReceiptError(value: unknown): string {
  if (value === "DeviceNotRegistered" || value === "MessageRateExceeded" || value === "InvalidCredentials") return value;
  return "rejected";
}

async function recordReceiptSafely(admin: PushSenderAdmin, args: Record<string, unknown>) {
  try {
    await rpc(admin, "art96_record_push_receipt", args);
  } catch {
    // The receipt lease expires and is reclaimed a bounded number of times; tickets are never resent here.
  }
}

async function retryReceiptGroup(admin: PushSenderAdmin, group: JsonRecord[], reason: string) {
  await Promise.all(group.map((item) => recordReceiptSafely(admin, {
    p_delivery_id: item.delivery_id,
    p_lease_id: item.lease_id,
    p_status: "retry",
    p_error: reason,
  })));
}

async function processReceipts(admin: PushSenderAdmin, fetcher: typeof fetch, accessToken?: string) {
  const claim = await rpc(admin, "art96_claim_push_receipts", { p_limit: 100, p_lease_seconds: 120 });
  if (claim.status !== "ok" || !Array.isArray(claim.receipts) || claim.receipts.length > 100)
    return { checked: 0, retry: 0 };
  const groups = new Map<string, JsonRecord[]>();
  for (const value of claim.receipts) {
    const item = record(value);
    if (!item || typeof item.eas_project_id !== "string" || !UUID.test(item.eas_project_id) ||
      typeof item.delivery_id !== "string" || !UUID.test(item.delivery_id) ||
      typeof item.lease_id !== "string" || !UUID.test(item.lease_id) ||
      typeof item.ticket_id !== "string" || !/^[A-Za-z0-9-]{1,200}$/.test(item.ticket_id)) continue;
    const group = groups.get(item.eas_project_id) ?? [];
    group.push(item);
    groups.set(item.eas_project_id, group);
  }
  let checked = 0;
  let retry = 0;
  for (const group of groups.values()) {
    let result: Awaited<ReturnType<typeof fetchJson>>;
    try {
      result = await fetchJson(fetcher, EXPO_RECEIPTS_URL, accessToken, { ids: group.map((item) => item.ticket_id) });
    } catch {
      await retryReceiptGroup(admin, group, "transport_retry");
      retry += group.length;
      continue;
    }
    const data = record(result.value)?.data;
    if (!result.response.ok || !record(data)) {
      await retryReceiptGroup(admin, group, result.response.status === 401 || result.response.status === 403 ? "InvalidCredentials" : "transport_retry");
      retry += group.length;
      continue;
    }
    for (const item of group) {
      const receipt = record((data as JsonRecord)[item.ticket_id as string]);
      if (!receipt) {
        await recordReceiptSafely(admin, {
          p_delivery_id: item.delivery_id,
          p_lease_id: item.lease_id,
          p_status: "retry",
          p_error: "receipt_not_ready",
        });
        retry++;
        continue;
      }
      const error = validatedReceiptError(record(receipt.details)?.error);
      await recordReceiptSafely(admin, {
        p_delivery_id: item.delivery_id,
        p_lease_id: item.lease_id,
        p_status: receipt.status === "ok" ? "ok" : "error",
        p_error: receipt.status === "ok" ? null : error,
      });
      checked++;
    }
  }
  return { checked, retry };
}

function claimFor(item: JsonRecord) {
  if (
    typeof item.delivery_id !== "string" || !UUID.test(item.delivery_id) ||
    typeof item.lease_id !== "string" || !UUID.test(item.lease_id) ||
    typeof item.token_generation !== "number" || !Number.isSafeInteger(item.token_generation) || item.token_generation < 1
  ) return null;
  return {
    delivery_id: item.delivery_id.toLowerCase(),
    lease_id: item.lease_id.toLowerCase(),
    token_generation: item.token_generation,
  };
}

async function validatePrepared(admin: PushSenderAdmin, prepared: Array<{ item: JsonRecord; message: JsonRecord }>) {
  if (!prepared.length) return [];
  const result = await rpc(admin, "art96_validate_push_send_batch", {
    p_claims: prepared.map(({ item }) => claimFor(item)).filter(Boolean),
  });
  if (result.status !== "ok" || !Array.isArray(result.delivery_ids)) return [];
  const valid = new Set<string>();
  for (const value of result.delivery_ids) {
    if (typeof value === "string" && UUID.test(value)) valid.add(value.toLowerCase());
  }
  return prepared.filter(({ item }) => valid.has(String(item.delivery_id).toLowerCase()));
}

async function recordBatchOutcome(
  admin: PushSenderAdmin,
  prepared: Array<{ item: JsonRecord; message: JsonRecord }>,
  outcome: string,
  error: string,
) {
  await Promise.all(prepared.map(({ item }) => recordSendSafely(admin, item, outcome, null, error)));
}

/** One authenticated invocation sends one bounded project batch and polls one bounded receipt batch. */
export async function runPushSender({ admin, fetcher = fetch, expoAccessToken }: SenderOptions) {
  const status = await rpc(admin, "art96_push_sender_status");
  if (status.status === "paused") return { status: "paused", reason: status.reason === "invalid_credentials" ? "invalid_credentials" : "invalid_payload", sent: 0, receipts: 0 };
  if (status.status !== "ready") return { status: "unavailable", sent: 0, receipts: 0 };

  const claim = await rpc(admin, "art96_claim_push_deliveries", { p_limit: 100, p_lease_seconds: 120 });
  if (claim.status === "paused") return { status: "paused", reason: "owner_action_required", sent: 0, receipts: 0 };
  if (claim.status !== "ok" || !Array.isArray(claim.deliveries) || claim.deliveries.length > 100)
    return { status: "unavailable", sent: 0, receipts: 0 };
  const projectId = typeof claim.project_id === "string" && UUID.test(claim.project_id) ? claim.project_id.toLowerCase() : null;
  if (!projectId) return { status: "unavailable", sent: 0, receipts: 0 };

  const prepared: Array<{ item: JsonRecord; message: JsonRecord }> = [];
  for (const value of claim.deliveries) {
    const item = record(value);
    if (!item || typeof item.eas_project_id !== "string" || item.eas_project_id.toLowerCase() !== projectId) continue;
    const identity = claimFor(item);
    if (!identity) continue;
    const begin = await rpc(admin, "art96_begin_push_send", {
      p_delivery_id: identity.delivery_id,
      p_lease_id: identity.lease_id,
      p_generation: identity.token_generation,
    });
    if (begin.status === "stale") continue;
    const message = begin.status === "ok" && typeof begin.expo_push_token === "string"
      ? buildMessage(begin, begin.expo_push_token)
      : null;
    if (!message) {
      await recordSendSafely(admin, item, "invalid_payload", null, "invalid_payload");
      continue;
    }
    prepared.push({ item, message });
  }

  let sent = 0;
  if (prepared.length) {
    let eligible: typeof prepared;
    try {
      // This is the final active-access and token-generation check after all preparation RPCs.
      eligible = await validatePrepared(admin, prepared);
    } catch {
      eligible = [];
    }
    if (eligible.length) {
      let result: Awaited<ReturnType<typeof fetchJson>> | null = null;
      try {
        result = await fetchJson(fetcher, EXPO_SEND_URL, expoAccessToken, eligible.map((entry) => entry.message));
      } catch {
        await recordBatchOutcome(admin, eligible, "ambiguous", "transport_retry");
      }
      if (result) {
        if (result.response.status === 429) {
          await recordBatchOutcome(admin, eligible, "retry", "message_rate_exceeded");
        } else if (result.response.status === 401 || result.response.status === 403) {
          await recordBatchOutcome(admin, eligible, "invalid_credentials", "invalid_credentials");
        } else if (result.response.status >= 500) {
          await recordBatchOutcome(admin, eligible, "retry", "transport_retry");
        } else if (result.response.status === 400) {
          await recordBatchOutcome(admin, eligible, "invalid_payload", "invalid_payload");
        } else if (!result.response.ok) {
          await recordBatchOutcome(admin, eligible, "invalid_payload", "invalid_payload");
        } else {
          const tickets = record(result.value)?.data;
          if (!Array.isArray(tickets) || tickets.length !== eligible.length) {
            await recordBatchOutcome(admin, eligible, "ambiguous", "transport_retry");
          } else {
            for (const [index, ticketValue] of tickets.entries()) {
              const ticket = record(ticketValue);
              const { item } = eligible[index];
              if (ticket?.status === "ok" && typeof ticket.id === "string" && /^[A-Za-z0-9-]{1,200}$/.test(ticket.id)) {
                await recordSendSafely(admin, item, "accepted", ticket.id);
                sent++;
                continue;
              }
              const code = validatedReceiptError(record(ticket?.details)?.error);
              const outcome = code === "DeviceNotRegistered"
                ? "device_not_registered"
                : code === "MessageRateExceeded"
                ? "retry"
                : code === "InvalidCredentials"
                ? "invalid_credentials"
                : "invalid_payload";
              const error = code === "DeviceNotRegistered"
                ? "device_not_registered"
                : code === "MessageRateExceeded"
                ? "message_rate_exceeded"
                : code === "InvalidCredentials"
                ? "invalid_credentials"
                : "invalid_payload";
              await recordSendSafely(admin, item, outcome, null, error);
            }
          }
        }
      }
    }
  }

  let receiptCount = 0;
  try {
    const receipts = await processReceipts(admin, fetcher, expoAccessToken);
    receiptCount = receipts.checked;
  } catch {
    // Receipt leases expire and are retried a bounded number of times.
  }
  return { status: "ready", sent, receipts: receiptCount };
}

/** Authentication fails closed when no owner-configured invocation secret exists. */
export function workerSecretMatches(expected: string | undefined, provided: string | null) {
  if (!expected || !provided) return false;
  const left = new TextEncoder().encode(expected);
  const right = new TextEncoder().encode(provided);
  let difference = left.length ^ right.length;
  const length = Math.max(left.length, right.length);
  for (let index = 0; index < length; index += 1) difference |= (left[index] ?? 0) ^ (right[index] ?? 0);
  return difference === 0;
}
