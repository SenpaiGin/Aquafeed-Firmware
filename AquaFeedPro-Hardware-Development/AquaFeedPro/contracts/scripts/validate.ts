import Ajv2020, { type ErrorObject } from "ajv/dist/2020.js";
import addFormats from "ajv-formats";
import { parse as parseYaml } from "yaml";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

type JsonObject = Record<string, unknown>;
type FixtureExpectation = {
  name: string;
  file: string;
  schema: string;
  expect: "valid" | "invalid";
  reason: string;
  failure?: { path: string; keyword: string };
};

const contractDir = dirname(dirname(fileURLToPath(import.meta.url)));
const schemaPath = resolve(contractDir, "schemas/v2.schema.json");
const manifestPath = resolve(contractDir, "fixtures/manifest.json");
const schema = JSON.parse(readFileSync(schemaPath, "utf8")) as JsonObject;
const manifest = JSON.parse(readFileSync(manifestPath, "utf8")) as {
  contract_version: string;
  schema: string;
  fixtures: FixtureExpectation[];
  behavior_cases: Array<{
    name: string;
    file: string;
    rule: string;
    expected: JsonObject;
  }>;
};

function pointerEscape(part: string): string {
  return part.replaceAll("~", "~0").replaceAll("/", "~1");
}

function appendPointer(base: string, part: string): string {
  return `${base}/${pointerEscape(part)}`;
}

function hasFiniteNumbers(value: unknown, path = ""): string | null {
  if (typeof value === "number") return Number.isFinite(value) ? null : path;
  if (Array.isArray(value)) {
    for (let i = 0; i < value.length; i += 1) {
      const bad = hasFiniteNumbers(value[i], appendPointer(path, String(i)));
      if (bad !== null) return bad;
    }
  } else if (value !== null && typeof value === "object") {
    for (const [key, child] of Object.entries(value as JsonObject)) {
      const bad = hasFiniteNumbers(child, appendPointer(path, key));
      if (bad !== null) return bad;
    }
  }
  return null;
}

function validDate(value: string): boolean {
  const match = /^(\d{4})-(\d{2})-(\d{2})$/.exec(value);
  if (!match) return false;
  const year = Number(match[1]);
  const month = Number(match[2]);
  const day = Number(match[3]);
  if (year < 1 || month < 1 || month > 12) return false;
  const leap = year % 4 === 0 && (year % 100 !== 0 || year % 400 === 0);
  const days = [31, leap ? 29 : 28, 31, 30, 31, 30, 31, 31, 30, 31, 30, 31];
  return day >= 1 && day <= days[month - 1];
}

function validUtcDateTime(value: string): boolean {
  const match =
    /^(\d{4}-\d{2}-\d{2})T([01]\d|2[0-3]):([0-5]\d):([0-5]\d)(?:\.\d+)?Z$/.exec(
      value,
    );
  return match !== null && validDate(match[1]);
}

function validLocalTime(value: string): boolean {
  return /^(?:[01]\d|2[0-3]):[0-5]\d$/.test(value);
}

function resolveIanaTimeZone(value: string): string | null {
  if (/^(?:(?:UTC|GMT))?[+-]\d{1,2}(?::?\d{2})?$/i.test(value)) return null;
  try {
    return new Intl.DateTimeFormat("en-US", {
      timeZone: value,
    }).resolvedOptions().timeZone;
  } catch {
    return null;
  }
}

function validIanaTimeZone(value: string): boolean {
  return resolveIanaTimeZone(value) !== null;
}

function canonicalJson(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(",")}]`;
  if (value !== null && typeof value === "object") {
    return `{${Object.entries(value as JsonObject)
      .sort(([left], [right]) => left.localeCompare(right))
      .map(([key, child]) => `${JSON.stringify(key)}:${canonicalJson(child)}`)
      .join(",")}}`;
  }
  return JSON.stringify(value);
}

function semanticDose(value: unknown): JsonObject {
  const dose = value as JsonObject;
  return dose.mode === "grams"
    ? { mode: dose.mode, amount_g: dose.amount_g }
    : { mode: dose.mode, fixed_portion_id: dose.fixed_portion_id };
}

function manualSemantic(request: JsonObject): string {
  return canonicalJson({
    targets: (request.targets as JsonObject[]).map((target) => ({
      nozzle_number: target.nozzle_number,
      dose: semanticDose(target.dose),
    })),
    capabilities_revision: request.capabilities_revision,
  });
}

function commandStatusConsistent(value: unknown): boolean {
  if (value === null || typeof value !== "object") return false;
  const command = value as JsonObject;
  if (
    !Array.isArray(command.targets) ||
    !Array.isArray(command.nozzle_results) ||
    command.targets.length !== command.nozzle_results.length
  )
    return false;
  const targets = command.targets as JsonObject[];
  const results = command.nozzle_results as JsonObject[];
  for (const [index, target] of targets.entries()) {
    const result = results[index];
    if (
      target.nozzle_number !== result.nozzle_number ||
      canonicalJson(semanticDose(target.dose)) !==
        canonicalJson(semanticDose(result.requested_dose))
    )
      return false;
  }

  const statuses = results.map((result) => result.status);
  if (
    command.status === "completed" &&
    statuses.some((status) => status !== "completed")
  )
    return false;
  if (
    command.status === "partial" &&
    !(
      statuses.length === 2 &&
      ((statuses[0] === "completed" &&
        ["failed", "unknown", "not_started"].includes(String(statuses[1]))) ||
        (statuses[0] === "failed" && statuses[1] === "completed"))
    )
  )
    return false;
  const hasUnknown = statuses.includes("unknown");
  if (command.status === "unknown" && !hasUnknown) return false;
  if (hasUnknown) {
    const resolution = command.lockout_resolution as JsonObject | null;
    if (
      command.safety_lockout === true
        ? resolution !== null
        : !resolution || resolution.source !== "device_maintenance"
    )
      return false;
  } else if (command.lockout_resolution !== null) return false;

  // Nozzle 2 may only act after nozzle 1 completed, or failed with a valid settled weighing
  // (the status DTO cannot carry the device proof; event histories check it).
  return !(
    statuses.length === 2 &&
    ["running", "completed", "failed", "unknown"].includes(String(statuses[1])) &&
    !(
      statuses[0] === "completed" ||
      (statuses[0] === "failed" && results[0].measurement_quality === "valid")
    )
  );
}

function configurationSemantic(
  basedOnRevision: unknown,
  value: unknown,
): string {
  const snapshot = value as JsonObject;
  const limits = snapshot.monitoring_limits as JsonObject;
  const schedules = (snapshot.schedules as JsonObject[])
    .map((schedule) => ({
      schedule_id: schedule.schedule_id,
      local_time: schedule.local_time,
      weekdays: [...(schedule.weekdays as number[])].sort((a, b) => a - b),
      enabled: schedule.enabled,
      targets: (schedule.targets as JsonObject[]).map((target) => ({
        nozzle_number: target.nozzle_number,
        dose: semanticDose(target.dose),
      })),
    }))
    .sort((a, b) => String(a.schedule_id).localeCompare(String(b.schedule_id)));
  return canonicalJson({
    based_on_revision: basedOnRevision,
    snapshot: {
      timezone: String(snapshot.timezone).toLowerCase(),
      monitoring_limits: {
        do_low_mg_l: limits.do_low_mg_l,
        do_high_mg_l: limits.do_high_mg_l,
      },
      low_feed_threshold_pct: snapshot.low_feed_threshold_pct,
      schedules,
    },
  });
}

function normalizeAjvError(error: ErrorObject): {
  path: string;
  keyword: string;
} {
  const params = error.params as {
    missingProperty?: string;
    additionalProperty?: string;
    minContains?: number;
    maxContains?: number;
  };
  let path = error.instancePath;
  let keyword = error.keyword;
  if (error.keyword === "required" && params.missingProperty) {
    path = appendPointer(path, params.missingProperty);
  } else if (
    error.keyword === "additionalProperties" &&
    params.additionalProperty
  ) {
    path = appendPointer(path, params.additionalProperty);
  }
  if (
    error.keyword === "contains" &&
    params.minContains === 0 &&
    params.maxContains === 0
  ) {
    keyword = "maxContains";
  }
  return { path, keyword };
}

const ajv = new Ajv2020({
  allErrors: true,
  strict: true,
  validateFormats: true,
});
addFormats(ajv);
ajv.addFormat("uuid", {
  type: "string",
  validate: (value: string) =>
    /^[0-9a-fA-F]{8}-(?:[0-9a-fA-F]{4}-){3}[0-9a-fA-F]{12}$/.test(value),
});
ajv.addFormat("date", { type: "string", validate: validDate });
ajv.addFormat("date-time", { type: "string", validate: validUtcDateTime });
ajv.addFormat("local-time", { type: "string", validate: validLocalTime });
ajv.addFormat("iana-time-zone", {
  type: "string",
  validate: validIanaTimeZone,
});

assert.equal(
  manifest.contract_version,
  "2.7.0",
  "fixture manifest must target current v2",
);
assert.equal(
  manifest.schema,
  "../schemas/v2.schema.json",
  "manifest must point at the canonical schema",
);
assert.equal(
  ((schema.$defs as JsonObject).ProtocolMajor as JsonObject).const,
  2,
  "v1 protocol messages must fail validation",
);
assert.equal(
  ajv.validateSchema(schema),
  true,
  "canonical schema must pass the JSON Schema meta-schema",
);

const validators = new Map<string, ReturnType<typeof ajv.compile>>();
for (const name of Object.keys(schema.$defs as JsonObject)) {
  const validator = ajv.compile({
    $schema: schema.$schema,
    $id: `${String(schema.$id)}/fixture/${name}`,
    $defs: schema.$defs,
    $ref: `#/$defs/${name}`,
  });
  validators.set(name, validator);
}

function resolvePointer(document: unknown, fragment: string): unknown {
  if (fragment === "" || fragment === "#") return document;
  assert.ok(fragment.startsWith("#/"), `unsupported JSON pointer: ${fragment}`);
  return fragment
    .slice(2)
    .split("/")
    .map((part) => part.replaceAll("~1", "/").replaceAll("~0", "~"))
    .reduce<unknown>((current, part) => {
      assert.ok(
        current !== null && typeof current === "object" && part in current,
        `unresolved JSON pointer ${fragment}`,
      );
      return (current as JsonObject)[part];
    }, document);
}

function checkOpenApi(): void {
  const openapiPath = resolve(contractDir, "openapi.yaml");
  const openapi = parseYaml(readFileSync(openapiPath, "utf8")) as JsonObject;
  assert.equal(openapi.openapi, "3.1.1");
  assert.equal(
    openapi.servers && (openapi.servers as Array<JsonObject>)[0]?.url,
    "/functions/v1",
  );
  assert.deepEqual(
    openapi.security,
    [],
    "each route must declare its own caller credential",
  );
  const paths = openapi.paths as Record<string, JsonObject>;
  const expected: Record<
    string,
    {
      method: string;
      auth: string;
      request?: string;
      responses?: Record<string, string>;
    }
  > = {
    "/app-api/v2/pair": {
      method: "post",
      auth: "InstallationJwt",
      request: "PairRequest",
      responses: { "201": "PairResponse" },
    },
    "/app-api/v2/devices/{id}/feed": {
      method: "post",
      auth: "InstallationJwt",
      request: "ManualFeedRequest",
      responses: {
        "200": "CommandStatusResponse",
        "202": "CommandAcceptedResponse",
      },
    },
    "/app-api/v2/devices/{id}/feed-recovery/no-admission": {
      method: "post",
      auth: "InstallationJwt",
      request: "ManualFeedRequest",
      responses: { "200": "ManualFeedRecoveryResponse" },
    },
    "/app-api/v2/devices/{id}/commands/{commandId}": {
      method: "get",
      auth: "InstallationJwt",
      responses: { "200": "CommandStatusResponse" },
    },
    "/app-api/v2/devices/{id}/commands/by-key": {
      method: "get",
      auth: "InstallationJwt",
      responses: { "200": "CommandByKeyResponse" },
    },
    "/app-api/v2/devices/{id}/history": {
      method: "get",
      auth: "InstallationJwt",
      responses: { "200": "HistoryPageResponse" },
    },
    "/app-api/v2/devices/{id}/history/{sequenceId}": {
      method: "get",
      auth: "InstallationJwt",
      responses: { "200": "HistoryDetailResponse" },
    },
    "/app-api/v2/devices/{id}/configuration": {
      method: "put",
      auth: "InstallationJwt",
      request: "ConfigurationWriteRequest",
      responses: {
        "200": "ConfigurationWriteResponse",
        "202": "ConfigurationWriteResponse",
      },
    },
    "/app-api/v2/devices/{id}/next-occurrence": {
      method: "get",
      auth: "InstallationJwt",
      responses: { "200": "NextAppliedOccurrenceResponse" },
    },
    "/app-api/v2/devices/{id}/monitoring": {
      method: "get",
      auth: "InstallationJwt",
      responses: { "200": "MonitoringSnapshotResponse" },
    },
    "/app-api/v2/devices/{id}/monitoring/do": {
      method: "get",
      auth: "InstallationJwt",
      responses: { "200": "DoGraphResponse" },
    },
    "/app-api/v2/devices/{id}/notifications": {
      method: "get",
      auth: "InstallationJwt",
      responses: { "200": "NotificationsPageResponse" },
    },
    "/app-api/v2/devices/{id}/notifications/{eventId}": {
      method: "patch",
      auth: "InstallationJwt",
      request: "NotificationActionRequest",
      responses: { "200": "NotificationActionResponse" },
    },
    "/app-api/v2/devices/{id}/notifications/actions": {
      method: "post",
      auth: "InstallationJwt",
      request: "NotificationBulkActionRequest",
      responses: { "200": "NotificationBulkActionResponse" },
    },
    "/app-api/v2/push-token": {
      method: "post",
      auth: "InstallationJwt",
      request: "AndroidPushTokenRegistrationRequest",
      responses: { "200": "AndroidPushTokenRegistrationResponse" },
    },
    "/app-api/v2/devices/{id}/alias": {
      method: "patch",
      auth: "InstallationJwt",
      request: "AliasUpdateRequest",
      responses: { "200": "AliasUpdateResponse" },
    },
    "/app-api/v2/devices/{id}/access": {
      method: "delete",
      auth: "InstallationJwt",
      responses: { "200": "AccessRevokedResponse" },
    },
    "/device-api/v2/sync": {
      method: "post",
      auth: "DeviceCredential",
      request: "DeviceSyncRequest",
      responses: { "200": "DeviceSyncResponse" },
    },
    "/device-api/v2/wait": {
      method: "post",
      auth: "DeviceCredential",
      request: "DeviceWaitRequest",
      responses: { "200": "DeviceWaitResponse" },
    },
    "/device-api/v2/pairing-window": {
      method: "post",
      auth: "DeviceCredential",
      request: "PairingWindowRequest",
      responses: { "201": "PairingWindowResponse" },
    },
  };
  assert.deepEqual(
    Object.keys(paths).sort(),
    Object.keys(expected).sort(),
    "OpenAPI must contain the twenty implemented paths",
  );

  const componentSchemas = (openapi.components as JsonObject).schemas as Record<
    string,
    JsonObject
  >;
  for (const [name, component] of Object.entries(componentSchemas)) {
    assert.deepEqual(
      Object.keys(component),
      ["$ref"],
      `OpenAPI component schema ${name} must not duplicate the canonical DTO`,
    );
    assert.equal(
      component.$ref,
      `./schemas/v2.schema.json#/$defs/${name}`,
      `OpenAPI component ${name} must reference its canonical definition`,
    );
    assert.ok(
      name in (schema.$defs as JsonObject),
      `missing canonical DTO ${name}`,
    );
  }

  for (const [path, route] of Object.entries(expected)) {
    const item = paths[path];
    const operation = item[route.method] as JsonObject;
    assert.ok(operation, `missing ${route.method.toUpperCase()} ${path}`);
    assert.deepEqual(
      operation.security,
      [{ [route.auth]: [] }],
      `wrong caller credential on ${path}`,
    );
    if (route.request) {
      const requestBody = operation.requestBody as JsonObject;
      const content = requestBody.content as JsonObject;
      const applicationJson = content["application/json"] as JsonObject;
      assert.equal(
        (applicationJson.schema as JsonObject).$ref,
        `#/components/schemas/${route.request}`,
        `wrong request DTO for ${path}`,
      );
    }
    for (const [code, dto] of Object.entries(route.responses ?? {})) {
      const response = (operation.responses as JsonObject)[code] as JsonObject;
      const content = response.content as JsonObject;
      const applicationJson = content?.["application/json"] as JsonObject;
      assert.equal(
        applicationJson?.schema && (applicationJson.schema as JsonObject).$ref,
        `#/components/schemas/${dto}`,
        `wrong ${code} response DTO for ${path}`,
      );
    }
  }

  const configurationRead = paths["/app-api/v2/devices/{id}/configuration"]
    .get as JsonObject;
  assert.deepEqual(configurationRead.security, [{ InstallationJwt: [] }]);
  assert.equal(
    (
      ((configurationRead.responses as JsonObject)["200"] as JsonObject)
        .content as JsonObject
    )["application/json"] &&
      (
        (
          ((configurationRead.responses as JsonObject)["200"] as JsonObject)
            .content as JsonObject
        )["application/json"] as JsonObject
      ).schema &&
      (
        (
          (
            ((configurationRead.responses as JsonObject)["200"] as JsonObject)
              .content as JsonObject
          )["application/json"] as JsonObject
        ).schema as JsonObject
      ).$ref,
    "#/components/schemas/ConfigurationReadResponse",
  );
  assert.ok(
    ((configurationRead.parameters as JsonObject[]) ?? []).some(
      (parameter) =>
        parameter.name === "request_id" && parameter.in === "query",
    ),
  );

  for (const path of [
    "/app-api/v2/devices/{id}/commands/{commandId}",
    "/app-api/v2/devices/{id}/commands/by-key",
    "/app-api/v2/devices/{id}/history",
    "/app-api/v2/devices/{id}/history/{sequenceId}",
    "/app-api/v2/devices/{id}/configuration",
    "/app-api/v2/devices/{id}/next-occurrence",
    "/app-api/v2/devices/{id}/monitoring",
    "/app-api/v2/devices/{id}/monitoring/do",
    "/app-api/v2/devices/{id}/notifications",
    "/app-api/v2/devices/{id}/notifications/{eventId}",
    "/app-api/v2/devices/{id}/notifications/actions",
    "/app-api/v2/push-token",
    "/app-api/v2/devices/{id}/access",
  ]) {
    const item = paths[path];
    const operation = item[expected[path].method] as JsonObject;
    const parameters = [
      ...((item.parameters as JsonObject[]) ?? []),
      ...((operation.parameters as JsonObject[]) ?? []),
    ].map((parameter) =>
      parameter.$ref
        ? (resolvePointer(openapi, String(parameter.$ref)) as JsonObject)
        : parameter,
    );
    for (const header of ["X-Protocol-Major", "X-Request-Id"]) {
      assert.ok(
        parameters.some(
          (parameter) =>
            parameter.name === header &&
            parameter.in === "header" &&
            parameter.required === true,
        ),
        `${path} must require ${header}`,
      );
    }
  }
  const keyParams = (
    paths["/app-api/v2/devices/{id}/commands/by-key"].get as JsonObject
  ).parameters as JsonObject[];
  assert.ok(
    keyParams.some(
      (parameter) =>
        parameter.name === "key" &&
        parameter.in === "query" &&
        parameter.required === true,
    ),
    "by-key lookup must require its original key query parameter",
  );
  const historyParams = (
    paths["/app-api/v2/devices/{id}/history"].get as JsonObject
  ).parameters as JsonObject[];
  for (const name of ["from", "to", "source", "status", "cursor"]) {
    assert.ok(
      historyParams.some(
        (parameter) => parameter.name === name && parameter.in === "query",
      ),
      `history must define its ${name} filter`,
    );
  }

  const notificationListOperation = paths[
    "/app-api/v2/devices/{id}/notifications"
  ].get as JsonObject;
  const notificationParams = notificationListOperation.parameters as JsonObject[];
  const notificationCursor = notificationParams.find(
    (parameter) => parameter.name === "cursor" && parameter.in === "query",
  );
  assert.ok(notificationCursor, "notification list must define its cursor");
  assert.equal(notificationCursor.required, false);
  assert.equal(
    (notificationCursor.schema as JsonObject).maxLength,
    1024,
    "notification cursor input must be bounded",
  );
  const eventPathParams = paths[
    "/app-api/v2/devices/{id}/notifications/{eventId}"
  ].parameters as JsonObject[];
  assert.ok(
    eventPathParams.some(
      (parameter) =>
        parameter.$ref === "#/components/parameters/NotificationEventId",
    ),
    "notification action path must bind one event UUID",
  );

  const eventRead = paths[
    "/app-api/v2/devices/{id}/notifications/{eventId}"
  ].get as JsonObject;
  assert.deepEqual(eventRead.security, [{ InstallationJwt: [] }]);
  assert.equal(
    ((((eventRead.responses as JsonObject)["200"] as JsonObject).content as JsonObject)["application/json"] as JsonObject).schema &&
      (((((eventRead.responses as JsonObject)["200"] as JsonObject).content as JsonObject)["application/json"] as JsonObject).schema as JsonObject).$ref,
    "#/components/schemas/NotificationEventReadResponse",
    "notification tap reads must use the authorized event DTO",
  );
  const eventReadParams = eventRead.parameters as JsonObject[];
  for (const header of ["X-Protocol-Major", "X-Request-Id"]) {
    assert.ok(eventReadParams.some((parameter) => parameter.$ref === `#/components/parameters/${header === "X-Protocol-Major" ? "ProtocolMajorHeader" : "RequestIdHeader"}`));
  }

  const tokenPath = paths["/app-api/v2/push-token"];
  const tokenDelete = tokenPath.delete as JsonObject;
  assert.deepEqual(tokenDelete.security, [{ InstallationJwt: [] }]);
  for (const header of ["X-Protocol-Major", "X-Request-Id"]) {
    assert.ok((tokenDelete.parameters as JsonObject[]).some((parameter) => parameter.$ref === `#/components/parameters/${header === "X-Protocol-Major" ? "ProtocolMajorHeader" : "RequestIdHeader"}`));
  }
  const tokenDeleteBody = (((tokenDelete.requestBody as JsonObject).content as JsonObject)["application/json"] as JsonObject).schema as JsonObject;
  assert.equal(tokenDeleteBody.$ref, "#/components/schemas/AndroidPushTokenRevocationRequest");
  const tokenDeleteResponse = ((((tokenDelete.responses as JsonObject)["200"] as JsonObject).content as JsonObject)["application/json"] as JsonObject).schema as JsonObject;
  assert.equal(tokenDeleteResponse.$ref, "#/components/schemas/AndroidPushTokenRevocationResponse");

  function checkReferences(node: unknown, sourcePath: string): void {
    if (Array.isArray(node)) {
      for (const value of node) checkReferences(value, sourcePath);
    } else if (node !== null && typeof node === "object") {
      for (const [key, value] of Object.entries(node as JsonObject)) {
        if (key === "$ref" && typeof value === "string") {
          const [filePart, fragment = ""] = value.split("#", 2);
          if (filePart === "") resolvePointer(openapi, `#${fragment}`);
          else {
            assert.ok(
              !/^[a-z]+:/i.test(filePart),
              `network reference is forbidden: ${value}`,
            );
            const targetPath = resolve(dirname(openapiPath), filePart);
            assert.equal(
              targetPath,
              schemaPath,
              `external OpenAPI refs must target the canonical schema: ${value}`,
            );
            resolvePointer(schema, `#${fragment}`);
          }
        } else checkReferences(value, sourcePath);
      }
    }
  }
  checkReferences(openapi, openapiPath);
}

function formatParts(
  formatter: Intl.DateTimeFormat,
  instant: Date,
): Record<string, string> {
  return Object.fromEntries(
    formatter
      .formatToParts(instant)
      .filter((part) => part.type !== "literal")
      .map((part) => [part.type, part.value]),
  );
}

function matchingUtcInstants(
  timeZone: string,
  date: string,
  localTime: string,
): number[] {
  const [year, month, day] = date.split("-").map(Number);
  const [hour, minute] = localTime.split(":").map(Number);
  const localAsUtc = Date.UTC(year, month - 1, day, hour, minute);
  const formatter = new Intl.DateTimeFormat("en-CA", {
    timeZone,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    hourCycle: "h23",
  });
  const instants: number[] = [];
  for (
    let candidate = localAsUtc - 18 * 60 * 60_000;
    candidate <= localAsUtc + 18 * 60 * 60_000;
    candidate += 60_000
  ) {
    const parts = formatParts(formatter, new Date(candidate));
    if (
      `${parts.year}-${parts.month}-${parts.day}` === date &&
      `${parts.hour}:${parts.minute}` === localTime
    )
      instants.push(candidate);
  }
  return instants;
}

function reduceCommand(fixture: JsonObject): JsonObject {
  let status = String(fixture.initial_status);
  let sequence = Number(fixture.initial_sequence);
  let safetyLockout = status === "unknown";
  const events = [...(fixture.events as JsonObject[])].sort(
    (a, b) => Number(a.event_sequence) - Number(b.event_sequence),
  );
  const transitions: Record<string, string[]> = {
    queued: ["accepted", "rejected", "expired"],
    accepted: ["running", "rejected", "expired", "unknown"],
    running: ["completed", "failed", "unknown"],
    unknown: ["completed", "failed"],
  };
  for (const event of events) {
    const eventSequence = Number(event.event_sequence);
    if (eventSequence <= sequence) continue;
    sequence = eventSequence;
    const incoming = String(event.status);
    if (["completed", "failed", "rejected", "expired"].includes(status))
      continue;
    if (event.reliable !== true) continue;
    if (incoming === "reboot") {
      if (status === "running" || status === "accepted") {
        status = "unknown";
        safetyLockout = true;
      }
      continue;
    }
    if (incoming === "maintenance_acknowledged") {
      if (
        status === "unknown" &&
        event.reliable === true &&
        event.device_authenticated === true
      )
        safetyLockout = false;
      continue;
    }
    if (incoming === "expired") {
      if (
        ["queued", "accepted"].includes(status) &&
        event.confirmed_not_started === true &&
        event.possible_movement !== true
      ) {
        status = "expired";
        safetyLockout = false;
      } else if (event.possible_movement === true || status === "running") {
        status = "unknown";
        safetyLockout = true;
      }
      continue;
    }
    if (
      status === "unknown" &&
      ["completed", "failed"].includes(incoming) &&
      event.reliable === true
    ) {
      status = incoming;
      safetyLockout = false;
      continue;
    }
    if ((transitions[status] ?? []).includes(incoming)) {
      status = incoming;
      safetyLockout = status === "unknown";
    }
  }
  const result: JsonObject = { status, safety_lockout: safetyLockout };
  if ("initial_measured_dispensed_g" in fixture)
    result.measured_dispensed_g = fixture.initial_measured_dispensed_g ?? null;
  return result;
}

function checkBehavior(rule: string, fixture: JsonObject): JsonObject {
  if (rule === "command-history") return reduceCommand(fixture);
  if (rule === "command-progress") {
    return Object.fromEntries(
      Object.entries(fixture.cases as Record<string, JsonObject>).map(
        ([name, command]) => [name, commandStatusConsistent(command)],
      ),
    );
  }
  if (rule === "feed-idempotency") {
    const byKey = new Map<string, JsonObject>();
    const results: string[] = [];
    for (const request of fixture.requests as JsonObject[]) {
      const key = `${fixture.device_id}:${fixture.installation_id}:${request.idempotency_key}`;
      const previous = byKey.get(key);
      if (!previous) {
        byKey.set(key, request);
        results.push("new-command");
      } else if (manualSemantic(previous) === manualSemantic(request)) {
        results.push("same-command");
      } else results.push("IDEMPOTENCY_CONFLICT");
    }
    return {
      same_payload: results[1],
      changed_payload: results[2],
      request_id_only: results[3],
      changed_second_dose: results[5],
      changed_target: results[6],
    };
  }
  if (rule === "configuration-replay") {
    const original = configurationSemantic(
      fixture.based_on_revision,
      fixture.snapshot,
    );
    const same =
      original ===
      configurationSemantic(
        fixture.replay_based_on_revision ?? fixture.based_on_revision,
        fixture.replay_snapshot,
      );
    const changed =
      original !==
      configurationSemantic(
        fixture.based_on_revision,
        fixture.changed_snapshot,
      );
    const changedBase =
      original !==
      configurationSemantic(fixture.changed_base_revision, fixture.snapshot);
    return {
      same_snapshot: same ? "same-revision" : "CONFIG_CONFLICT",
      changed_snapshot: changed ? "CONFIG_CONFLICT" : "same-revision",
      changed_base_payload: changedBase ? "CONFIG_CONFLICT" : "same-revision",
      pending_second_edit:
        fixture.pending === true &&
        fixture.next_request_id !== fixture.request_id
          ? "CONFIG_PENDING"
          : "accepted",
    };
  }
  if (rule === "sync-dedup") {
    const identity = (record: JsonObject) =>
      record.type === "sample"
        ? `sample:${record.boot_id}:${record.sequence}`
        : `event:${record.sequence_id}:${record.event_sequence}`;
    const sampleKey = (record: JsonObject) =>
      `${record.boot_id}:${record.sequence}`;
    const eventKey = (record: JsonObject) =>
      `${record.sequence_id}:${record.event_sequence}`;
    const sampleKeys = new Set(
      (fixture.samples as JsonObject[]).map(sampleKey),
    );
    const eventKeys = new Set((fixture.events as JsonObject[]).map(eventKey));
    const acknowledgements = fixture.acknowledgements as JsonObject;
    const acknowledgedSamples = new Set(
      (acknowledgements.samples as JsonObject[]).map(sampleKey),
    );
    const acknowledgedEvents = new Set(
      (acknowledgements.events as JsonObject[]).map(eventKey),
    );
    const remaining = (fixture.outbox as JsonObject[])
      .filter((record) => {
        if (record.type === "sample")
          return !acknowledgedSamples.has(sampleKey(record));
        return !acknowledgedEvents.has(eventKey(record));
      })
      .map(identity)
      .sort();
    return {
      unique_sample_acks: acknowledgedSamples.size,
      unique_event_acks: acknowledgedEvents.size,
      effects: sampleKeys.size + eventKeys.size,
      outbox_remaining: remaining,
    };
  }
  if (rule === "schedule-ledger") {
    const first = fixture.first as JsonObject;
    const edited = fixture.edited as JsonObject;
    const key = (record: JsonObject) =>
      `${fixture.device_id}:${fixture.schedule_id}:${record.local_date}`;
    return {
      first: "execute",
      edited_timezone_same_date:
        key(first) === key(edited) ? "duplicate" : "execute",
    };
  }
  if (rule === "dst") {
    const repeated = fixture.repeated as JsonObject;
    const nonexistent = fixture.nonexistent as JsonObject;
    const repeatedCount = matchingUtcInstants(
      String(repeated.timezone),
      String(repeated.date),
      String(repeated.local_time),
    ).length;
    const nonexistentCount = matchingUtcInstants(
      String(nonexistent.timezone),
      String(nonexistent.date),
      String(nonexistent.local_time),
    ).length;
    return {
      repeated_wall_time_instants: repeatedCount,
      executions: repeatedCount > 0 ? 1 : 0,
      nonexistent_wall_time_instants: nonexistentCount,
      nonexistent_action: nonexistentCount === 0 ? "skip" : "execute",
    };
  }
  if (rule === "semantic-replay") {
    const feed = fixture.feed as JsonObject;
    const config = fixture.configuration as JsonObject;
    const firstFeed = feed.first as JsonObject;
    const replayFeed = feed.replay as JsonObject;
    return {
      feed_reordered_with_additive_fields:
        firstFeed.device_id === replayFeed.device_id &&
        firstFeed.installation_id === replayFeed.installation_id &&
        firstFeed.idempotency_key === replayFeed.idempotency_key &&
        manualSemantic(firstFeed) === manualSemantic(replayFeed)
          ? "same-command"
          : "IDEMPOTENCY_CONFLICT",
      feed_numeric_spelling_equal:
        canonicalJson(
          semanticDose((firstFeed.targets as JsonObject[])[0].dose),
        ) ===
        canonicalJson(
          semanticDose((replayFeed.targets as JsonObject[])[0].dose),
        ),
      feed_changed_second_dose:
        manualSemantic(firstFeed) === manualSemantic(feed.changed_dose)
          ? "same-command"
          : "IDEMPOTENCY_CONFLICT",
      feed_changed_nozzle:
        manualSemantic(firstFeed) === manualSemantic(feed.changed_nozzle)
          ? "same-command"
          : "IDEMPOTENCY_CONFLICT",
      config_reordered_with_additive_fields:
        config.request_id === config.replay_request_id &&
        configurationSemantic(config.based_on_revision, config.first) ===
          configurationSemantic(config.replay_based_on_revision, config.replay)
          ? "same-revision"
          : "CONFIG_CONFLICT",
      config_numeric_spelling_equal:
        (config.first as JsonObject).low_feed_threshold_pct ===
        (config.replay as JsonObject).low_feed_threshold_pct,
      config_distinct_alias_conflict:
        configurationSemantic(config.based_on_revision, config.first) !==
        configurationSemantic(config.based_on_revision, config.different_alias)
          ? "CONFIG_CONFLICT"
          : "same-revision",
      config_changed_base_revision:
        configurationSemantic(config.based_on_revision, config.first) ===
        configurationSemantic(config.changed_base_revision, config.first)
          ? "same-revision"
          : "CONFIG_CONFLICT",
    };
  }
  if (rule === "timezone-casing") {
    return {
      canonical: resolveIanaTimeZone(String(fixture.canonical)) !== null,
      lowercase_variant:
        resolveIanaTimeZone(String(fixture.lowercase_variant)) !== null,
      alias: resolveIanaTimeZone(String(fixture.alias)) !== null,
      second_alias: resolveIanaTimeZone(String(fixture.second_alias)) !== null,
      numeric_offset:
        resolveIanaTimeZone(String(fixture.numeric_offset)) !== null,
      nonexistent: resolveIanaTimeZone(String(fixture.nonexistent)) !== null,
    };
  }
  if (rule === "schedule-clock") {
    return {
      forward_after_reboot:
        fixture.rebooted_after_due_time === true ||
        fixture.forward_clock_jump_after_due_time === true
          ? "skip"
          : "execute",
      backward_with_ledger:
        fixture.backward_clock_has_ledger_entry === true
          ? "duplicate"
          : "execute",
      invalid_clock: fixture.clock_quality === "invalid" ? "pause" : "execute",
      actuator_collision:
        fixture.manual_and_schedule_overlap === true
          ? "DEVICE_BUSY"
          : "execute",
    };
  }
  if (rule === "schedule-group") {
    const due = Date.parse(String(fixture.due_at));
    const baseline = Date.parse(String(fixture.baseline_ready_at));
    const second = Date.parse(String(fixture.nozzle2_started));
    return {
      admitted_together:
        fixture.both_admitted === true &&
        (fixture.targets as number[]).length === 2,
      order: [...(fixture.targets as number[])].sort((a, b) => a - b),
      sequence_reserved_through_settling:
        Date.parse(String(fixture.reservation_released_at)) >= baseline,
      nozzle2_after_nozzle1_normal_completion:
        Date.parse(String(fixture.nozzle1_completed)) <= second &&
        second >= baseline
          ? "ready"
          : "blocked",
      nozzle2_start_deadline:
        baseline + Number(fixture.wake_grace_ms) >= second &&
        due + Number(fixture.wake_grace_ms) < second
          ? "baseline_ready_at_plus_wake_grace"
          : "first_deadline_reused",
    };
  }
  if (rule === "sequence-abort") {
    const gates = [
      "safe_stop",
      "settled_weighing",
      "device_healthy",
      "target_authorized",
      "capability",
      "inventory",
      "deadline",
    ];
    const summary = (item: JsonObject): string[] => {
      const first =
        item.failure === "uncertain_stop"
          ? "unknown"
          : item.first_completed === true
            ? "completed"
            : "failed";
      const proof = (item.gates ?? {}) as JsonObject;
      const continues =
        first === "completed"
          ? item.failure !== "invalid_weighing"
          : item.failure === "recoverable" &&
            gates.every((gate) => proof[gate] === true);
      const second = continues ? String(item.nozzle2_outcome) : "not_started";
      const completed = [first, second].filter((s) => s === "completed").length;
      return [
        first,
        second,
        first === "unknown" || second === "unknown"
          ? "unknown"
          : completed === 1
            ? "partial"
            : completed === 2
              ? "completed"
              : "failed",
      ];
    };
    return {
      ...Object.fromEntries(
        Object.entries(fixture.cases as Record<string, JsonObject>).map(
          ([name, item]) => [name, summary(item)],
        ),
      ),
      automatic_resume: false,
    };
  }
  if (rule === "notification-history") {
    const events = fixture.events as JsonObject[];
    const installations = fixture.installations as Record<string, JsonObject>;
    const timestampMicros = (value: unknown) => {
      const match =
        /^(\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2})(?:\.(\d{1,6}))?Z$/.exec(
          String(value),
        );
      assert.ok(match, "notification fixture timestamps preserve UTC microseconds");
      return (
        BigInt(Math.floor(Date.parse(match[1] + "Z") / 1000)) * 1_000_000n +
        BigInt((match[2] ?? "").padEnd(6, "0"))
      );
    };
    const compare = (left: JsonObject, right: JsonObject) => {
      const leftTime = timestampMicros(left.raised_at);
      const rightTime = timestampMicros(right.raised_at);
      if (leftTime !== rightTime) return leftTime < rightTime ? -1 : 1;
      return left.event_id === right.event_id
        ? 0
        : String(left.event_id) < String(right.event_id)
          ? -1
          : 1;
    };
    const ordered = [...events].sort((left, right) => -compare(left, right));
    const pageSize = Number(fixture.page_size);
    const eventIds = (items: JsonObject[]) =>
      items.map((event) => String(event.event_id));
    const isThrough = (event: JsonObject, value: unknown) => {
      const cutoff = value && typeof value === "object"
        ? (value as JsonObject)
        : null;
      return cutoff !== null && compare(event, cutoff) <= 0;
    };
    const stateFor = (name: string) => installations[name];
    const isDismissed = (event: JsonObject, state: JsonObject) =>
      (state.dismissed_event_ids as string[]).includes(String(event.event_id)) ||
      isThrough(event, state.dismissed_through);
    const isRead = (event: JsonObject, state: JsonObject) =>
      (state.read_event_ids as string[]).includes(String(event.event_id)) ||
      isDismissed(event, state) ||
      isThrough(event, state.read_through);
    const visibleFor = (state: JsonObject) =>
      ordered.filter((event) => !isDismissed(event, state));
    const pageAndNext = (state: JsonObject) => {
      const visible = visibleFor(state);
      const firstPage = visible.slice(0, pageSize);
      const cursor = firstPage.at(-1) ?? null;
      const secondPage = cursor
        ? visible.filter((event) => compare(event, cursor) < 0).slice(0, pageSize)
        : [];
      return { firstPage, cursor, secondPage };
    };
    const first = stateFor("first");
    const second = stateFor("second");
    const firstPages = pageAndNext(first);
    const secondPages = pageAndNext(second);
    return {
      shared_event_ids: eventIds(ordered),
      first_page_event_ids: eventIds(firstPages.firstPage),
      first_next_cursor: firstPages.cursor
        ? {
            raised_at: firstPages.cursor.raised_at,
            event_id: firstPages.cursor.event_id,
          }
        : null,
      first_second_page_event_ids: eventIds(firstPages.secondPage),
      first_unread_count: ordered.filter(
        (event) => !isDismissed(event, first) && !isRead(event, first),
      ).length,
      second_page_event_ids: eventIds(secondPages.firstPage),
      second_second_page_event_ids: eventIds(secondPages.secondPage),
      second_unread_count: ordered.filter(
        (event) => !isDismissed(event, second) && !isRead(event, second),
      ).length,
      newer_than_bulk_cutoff_unread:
        !isDismissed(ordered[0], second) && !isRead(ordered[0], second),
    };
  }
  if (rule === "schedule-collisions") {
    // Expand each schedule to its nozzle slots; a repeated nozzle slot is rejected,
    // otherwise the nozzles due together run in order.
    return Object.fromEntries(
      Object.entries(fixture.groups as Record<string, JsonObject[]>).map(
        ([name, schedules]) => {
          const due = new Map<string, number[]>();
          for (const schedule of schedules)
            for (const day of schedule.weekdays as number[])
              for (const nozzle of schedule.nozzles as number[]) {
                const key = `${schedule.local_time}:${day}`;
                due.set(key, [...(due.get(key) ?? []), nozzle]);
              }
          const groups = [...due.values()];
          return [
            name,
            groups.some((nozzles) => new Set(nozzles).size !== nozzles.length)
              ? "reject"
              : groups
                  .reduce((a, b) => (b.length > a.length ? b : a), [])
                  .sort((a, b) => a - b),
          ];
        },
      ),
    );
  }
  throw new Error(`unknown behavior rule ${rule}`);
}

function runBehaviorChecks(): number {
  let passed = 0;
  for (const test of manifest.behavior_cases) {
    const fixture = JSON.parse(
      readFileSync(resolve(contractDir, "fixtures", test.file), "utf8"),
    ) as JsonObject;
    const actual = checkBehavior(test.rule, fixture);
    assert.deepEqual(
      actual,
      test.expected,
      `${test.name}: behavioral expectation mismatch`,
    );
    console.log(`PASS behavior ${test.name}`);
    passed += 1;
  }
  return passed;
}

checkOpenApi();
console.log(
  "PASS OpenAPI 3.1.1 routes, auth separation, canonical DTO refs, and local reference resolution",
);
let passed = 0;
for (const fixture of manifest.fixtures) {
  const validator = validators.get(fixture.schema);
  assert.ok(validator, `${fixture.name}: unknown schema ${fixture.schema}`);
  const dataPath = resolve(contractDir, "fixtures", fixture.file);
  const value = JSON.parse(readFileSync(dataPath, "utf8")) as unknown;
  const nonFinitePath = hasFiniteNumbers(value);
  const errors =
    nonFinitePath === null
      ? validator(value)
        ? []
        : (validator.errors ?? []).map(normalizeAjvError)
      : [{ path: nonFinitePath, keyword: "finite-number" }];
  if (fixture.expect === "valid") {
    assert.equal(
      errors.length,
      0,
      `${fixture.name}: expected valid (${fixture.reason}), got ${JSON.stringify(errors[0])}`,
    );
  } else {
    assert.ok(
      fixture.failure,
      `${fixture.name}: invalid fixture must name a failure`,
    );
    assert.ok(
      errors.some(
        (error) =>
          error.path === fixture.failure?.path &&
          error.keyword === fixture.failure?.keyword,
      ),
      `${fixture.name}: expected ${JSON.stringify(fixture.failure)} (${fixture.reason}), got ${JSON.stringify(errors)}`,
    );
  }
  if (fixture.schema === "CommandStatusDTO") {
    assert.equal(
      commandStatusConsistent(value),
      fixture.expect === "valid",
      `${fixture.name}: command intent and nozzle results do not agree`,
    );
  }
  if (fixture.schema === "HistoryPageResponse" && fixture.expect === "valid") {
    const page = value as JsonObject;
    const records = page.records as unknown[];
    assert.ok(
      records.length > 0,
      `${fixture.name}: page-size boundary fixture needs one valid record`,
    );
    const oversized = {
      ...page,
      records: Array.from({ length: 51 }, () => records[0]),
    };
    assert.equal(
      validator(oversized),
      false,
      "history responses above 50 rows must fail the contract",
    );
    assert.ok(
      validator.errors?.some(
        (error) =>
          error.keyword === "maxItems" && error.instancePath === "/records",
      ),
      "the 50-row history page limit must be enforced at records",
    );
  }
  if (
    fixture.schema === "NotificationsPageResponse" &&
    fixture.expect === "valid"
  ) {
    const page = value as JsonObject;
    const events = page.events as unknown[];
    const oversized = {
      ...page,
      events: Array.from({ length: 51 }, () => events[0]),
    };
    assert.equal(
      validator(oversized),
      false,
      "notification responses above 50 visible events must fail the contract",
    );
    assert.ok(
      validator.errors?.some(
        (error) =>
          error.keyword === "maxItems" && error.instancePath === "/events",
      ),
      "the 50-event notification page limit must be enforced at events",
    );
  }
  console.log(
    `PASS fixture ${fixture.name}: ${fixture.expect} — ${fixture.reason}`,
  );
  passed += 1;
}
const deviceDescriptorValidator = validators.get("DeviceDescriptor");
assert.ok(deviceDescriptorValidator, "device descriptor schema is available");
const simulatorFixture = manifest.fixtures.find(
  (fixture) => fixture.name === "simulator-capabilities-valid",
);
assert.ok(simulatorFixture, "synthetic profile fixture is available");
const simulatorDescriptor = JSON.parse(
  readFileSync(
    resolve(contractDir, "fixtures", simulatorFixture.file),
    "utf8",
  ),
) as JsonObject;
const syntheticDescriptor = JSON.parse(
  JSON.stringify(simulatorDescriptor),
) as JsonObject;
const syntheticCapabilities = syntheticDescriptor.capabilities as JsonObject;
const syntheticNozzles = syntheticCapabilities.nozzles as JsonObject;
const syntheticNozzle1 = syntheticNozzles["1"] as JsonObject;
syntheticNozzle1.max_dose_g = 250;
assert.equal(
  deviceDescriptorValidator(syntheticDescriptor),
  true,
  "synthetic per-nozzle dose bounds above 100 g remain profile-valid",
);
const invalidCapacityDescriptor = JSON.parse(
  JSON.stringify(simulatorDescriptor),
) as JsonObject;
((invalidCapacityDescriptor.capabilities as JsonObject)
  .feed_capacity_g) = 0;
assert.equal(deviceDescriptorValidator(invalidCapacityDescriptor), false);
assert.ok(
  deviceDescriptorValidator.errors?.some(
    (error) =>
      error.instancePath === "/capabilities/feed_capacity_g" &&
      error.keyword === "exclusiveMinimum",
  ),
  "shared capacity must be positive and separate from nozzle dose bounds",
);
const failedEventFixture = manifest.fixtures.find(
  (fixture) => fixture.name === "run-event-failed-valid",
);
assert.ok(failedEventFixture, "failed event fixture is available");
const failedEvent = JSON.parse(
  readFileSync(
    resolve(contractDir, "fixtures", failedEventFixture.file),
    "utf8",
  ),
) as JsonObject;
failedEvent.measurement_quality = "valid";
failedEvent.measured_dispensed_g = 12.5;
assert.equal(
  validators.get("RunEvent")?.(failedEvent),
  true,
  "a failed operation may retain known measured depletion",
);
const behaviorPassed = runBehaviorChecks();
console.log(
  `Validated ${passed} schema fixtures and ${behaviorPassed} behavior fixtures with Ajv and Draft 2020-12.`,
);
