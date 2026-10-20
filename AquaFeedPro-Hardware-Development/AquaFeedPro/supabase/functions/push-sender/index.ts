import { admin, json } from "../_shared/device-access.ts";
import { runPushSender, workerSecretMatches } from "../_shared/push-sender.ts";

Deno.serve(async (request: Request) => {
  if (request.method !== "POST") return json({ error: "method_not_allowed" }, 405);
  const expected = Deno.env.get("PUSH_WORKER_SECRET");
  if (!expected) return json({ status: "disabled" }, 503);
  if (!workerSecretMatches(expected, request.headers.get("x-push-worker-secret")))
    return json({ error: "unauthorized" }, 401);
  try {
    const result = await runPushSender({
      admin,
      expoAccessToken: Deno.env.get("EXPO_ACCESS_TOKEN") || undefined,
    });
    return json(result, result.status === "unavailable" ? 503 : 200);
  } catch {
    // Provider responses, tokens, ticket bodies, and configuration values stay private.
    return json({ status: "unavailable" }, 503);
  }
});
