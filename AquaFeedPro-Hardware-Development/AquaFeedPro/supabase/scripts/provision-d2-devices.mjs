import { randomBytes, randomUUID, createHash } from "node:crypto";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

const DEV_HOST = "giilhohmrytpgyeyysir.supabase.co";
const DEVICE_IDS = [
  "22222222-2222-4222-8222-222222222222",
  "33333333-3333-4333-8333-333333333333",
];
const scriptDir = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(scriptDir, "../..");
const privateDir = path.join(repoRoot, ".device-secrets");

function requiredEnv(...names) {
  for (const name of names) {
    const value = process.env[name];
    if (value) return value;
  }
  throw new Error(
    "Set the development Supabase URL and server key in the environment.",
  );
}

function assertDevelopmentProject(url) {
  const parsed = new URL(url);
  if (parsed.protocol !== "https:" || parsed.hostname !== DEV_HOST) {
    throw new Error(
      "This provisioning tool only accepts the configured AquaFeed development project.",
    );
  }
  return parsed.origin;
}

const UUID =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

// Public and permanent: derived from device_id alone, so restarts, resume and credential
// rotation never change the printed bytes. Keep the shape in step with
// deviceIdentityQrPayload in mobile/src/lib/device-access-state.ts.
export function deviceIdentity(deviceId) {
  return {
    device_id: deviceId,
    label: `…${deviceId.slice(-6).toUpperCase()}`,
    qr_payload: JSON.stringify({
      protocol_major: 2,
      purpose: "device_identity",
      device_id: deviceId,
    }),
  };
}

function hash(value) {
  return createHash("sha256").update(value, "utf8").digest("hex");
}

function credentialPath(deviceId, directory = privateDir) {
  return path.join(directory, `device-${deviceId}-credential.json`);
}

function pairingPath(deviceId) {
  return path.join(privateDir, `pairing-${deviceId}-${randomUUID()}.json`);
}

function provisionedPath(deviceId, directory = privateDir) {
  return path.join(directory, `device-${deviceId}.provisioned.json`);
}

async function readCredential(deviceId, directory = privateDir) {
  try {
    const value = JSON.parse(
      await readFile(credentialPath(deviceId, directory), "utf8"),
    );
    if (
      value?.device_id !== deviceId ||
      typeof value.credential !== "string" ||
      !/^[A-Za-z0-9_-]{43}$/.test(value.credential)
    ) {
      throw new Error("A private simulator credential file is invalid.");
    }
    return value;
  } catch (error) {
    if (error.code === "ENOENT") return null;
    throw error;
  }
}

async function loadOrCreateCredential(
  deviceId,
  create = false,
  directory = privateDir,
) {
  const existing = await readCredential(deviceId, directory);
  if (existing) return existing;
  if (!create)
    throw new Error("A private simulator credential file is missing.");
  const value = {
    device_id: deviceId,
    credential: randomBytes(32).toString("base64url"),
  };
  try {
    await writeFile(
      credentialPath(deviceId, directory),
      JSON.stringify(value, null, 2),
      { flag: "wx", mode: 0o600 },
    );
  } catch (error) {
    if (error.code !== "EEXIST") throw error;
    const raced = await readCredential(deviceId, directory);
    if (raced) return raced;
    throw new Error("A private simulator credential could not be recovered.");
  }
  return value;
}

async function isProvisioned(deviceId, directory = privateDir) {
  try {
    const value = JSON.parse(
      await readFile(provisionedPath(deviceId, directory), "utf8"),
    );
    if (value?.device_id !== deviceId || value.provisioned !== true) {
      throw new Error("A private simulator provisioning marker is invalid.");
    }
    return true;
  } catch (error) {
    if (error.code === "ENOENT") return false;
    throw error;
  }
}

async function pathExists(filePath) {
  try {
    await readFile(filePath);
    return true;
  } catch (error) {
    if (error.code === "ENOENT") return false;
    throw error;
  }
}

async function requireFreshPrivateState(
  directory = privateDir,
  deviceIds = DEVICE_IDS,
) {
  const files = deviceIds.flatMap((deviceId) => [
    credentialPath(deviceId, directory),
    provisionedPath(deviceId, directory),
  ]);
  if (
    await Promise.all(files.map(pathExists)).then((exists) =>
      exists.some(Boolean),
    )
  ) {
    throw new Error(
      "Private simulator state already exists. Use `resume` to continue with the saved credentials.",
    );
  }
}

export async function ensureResumeCredentials(
  directory = privateDir,
  deviceIds = DEVICE_IDS,
) {
  await mkdir(directory, { recursive: true, mode: 0o700 });
  const state = await Promise.all(
    deviceIds.map(async (deviceId) => ({
      deviceId,
      provisioned: await isProvisioned(deviceId, directory),
      credential: await readCredential(deviceId, directory),
    })),
  );
  if (
    state.some((entry) => entry.provisioned) &&
    state.some((entry) => !entry.credential)
  ) {
    throw new Error(
      "A provisioned simulator set has a missing credential; refusing automatic rotation.",
    );
  }
  const credentials = [];
  for (const entry of state) {
    credentials.push(
      entry.credential ??
        (await loadOrCreateCredential(entry.deviceId, true, directory)),
    );
  }
  return credentials;
}

async function requestPairingWindow(origin, deviceId, credential) {
  const requestId = randomUUID();
  const response = await fetch(
    `${origin}/functions/v1/device-api/v2/pairing-window`,
    {
      method: "POST",
      headers: {
        Authorization: `Bearer ${credential}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({ protocol_major: 2, request_id: requestId }),
    },
  );
  if (!response.ok)
    throw new Error(
      `Pairing-window request failed with HTTP ${response.status}.`,
    );
  const body = await response.json();
  if (
    body?.request_id !== requestId ||
    typeof body.challenge_id !== "string" ||
    !/^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(
      body.challenge_id,
    ) ||
    typeof body.pairing_secret !== "string" ||
    Array.from(body.pairing_secret).length < 1 ||
    Array.from(body.pairing_secret).length > 512 ||
    typeof body.expires_at !== "string" ||
    !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?Z$/.test(body.expires_at) ||
    Number.isNaN(Date.parse(body.expires_at))
  ) {
    throw new Error("The device service returned an invalid pairing window.");
  }
  const pairingPayload = JSON.stringify({
    protocol_major: 2,
    device_id: deviceId,
    challenge_id: body.challenge_id,
    pairing_secret: body.pairing_secret,
  });
  await writeFile(
    pairingPath(deviceId),
    JSON.stringify(
      {
        device_id: deviceId,
        expires_at: body.expires_at,
        pairing_payload: pairingPayload,
      },
      null,
      2,
    ),
    { flag: "wx", mode: 0o600 },
  );
}

async function provision(origin, serverKey, initialize) {
  await mkdir(privateDir, { recursive: true, mode: 0o700 });
  const credentials = initialize
    ? await (async () => {
        await requireFreshPrivateState();
        return Promise.all(
          DEVICE_IDS.map((device_id) =>
            loadOrCreateCredential(device_id, true),
          ),
        );
      })()
    : await ensureResumeCredentials();
  for (const { device_id, credential } of credentials) {
    if (await isProvisioned(device_id)) continue;
    const response = await fetch(
      `${origin}/rest/v1/rpc/art38_provision_simulated_device`,
      {
        method: "POST",
        headers: {
          apikey: serverKey,
          Authorization: `Bearer ${serverKey}`,
          "Content-Type": "application/json",
        },
        body: JSON.stringify({
          p_device_id: device_id,
          p_credential_verifier_hex: hash(credential),
          p_allow_rotation: false,
        }),
      },
    );
    if (!response.ok)
      throw new Error(
        `Simulator provisioning failed with HTTP ${response.status}; credentials remain saved privately.`,
      );
    const body = await response.json();
    if (body?.status === "credential_conflict") {
      throw new Error(
        "The simulator already has a different or revoked credential. Restore its original private credential file before resuming; no credential was changed.",
      );
    }
    if (
      (body?.status !== "provisioned" &&
        body?.status !== "already_provisioned") ||
      body.device_id !== device_id ||
      body.simulated !== true
    ) {
      throw new Error(
        "Simulator provisioning returned an invalid result; credentials remain saved privately.",
      );
    }
    await writeFile(
      provisionedPath(device_id),
      JSON.stringify({ device_id, provisioned: true }),
      {
        flag: "wx",
        mode: 0o600,
      },
    );
  }
  for (const { device_id, credential } of credentials)
    await requestPairingWindow(origin, device_id, credential);
}

async function createPairingWindows(origin) {
  const credentials = await Promise.all(
    DEVICE_IDS.map(async (deviceId) => {
      if (!(await isProvisioned(deviceId)))
        throw new Error(
          "Provision both simulator devices before creating pairing windows.",
        );
      return loadOrCreateCredential(deviceId);
    }),
  );
  for (const { device_id, credential } of credentials) {
    await requestPairingWindow(origin, device_id, credential);
  }
}

// Loaded on demand so the other commands and the recovery check need no install.
export async function identityQrSvg(qrPayload) {
  const { default: QRCode } = await import("qrcode");
  return QRCode.toString(qrPayload, {
    type: "svg",
    errorCorrectionLevel: "M",
    margin: 4,
  });
}

// The identity files hold no secret: print the SVG with the label.
async function exportIdentities() {
  await mkdir(privateDir, { recursive: true, mode: 0o700 });
  for (const deviceId of DEVICE_IDS) {
    if (!(await isProvisioned(deviceId)))
      throw new Error(
        "Provision the simulator devices before exporting identities.",
      );
    await writeFile(
      path.join(privateDir, `identity-${deviceId}.json`),
      JSON.stringify(deviceIdentity(deviceId), null, 2),
    );
    await writeFile(
      path.join(privateDir, `identity-${deviceId}.svg`),
      await identityQrSvg(deviceIdentity(deviceId).qr_payload),
    );
  }
}

// Lost-phone recovery: ends one installation's access to one feeder. Other phones, the
// feeder's schedules and its history are untouched (art38_revoke_device_access).
async function revokeInstallation(origin, serverKey, deviceId, installationId) {
  if (!DEVICE_IDS.includes(deviceId) || !UUID.test(installationId))
    throw new Error("Use `revoke <simulator device id> <installation id>`.");
  const response = await fetch(
    `${origin}/rest/v1/rpc/art38_revoke_device_access`,
    {
      method: "POST",
      headers: {
        apikey: serverKey,
        Authorization: `Bearer ${serverKey}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        p_device_id: deviceId,
        p_installation_id: installationId.toLowerCase(),
      }),
    },
  );
  if (!response.ok)
    throw new Error(`Revocation failed with HTTP ${response.status}.`);
  const body = await response.json();
  process.stdout.write(`Revocation result: ${body?.status}.\n`);
}

if (
  process.argv[1] &&
  path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)
) {
  try {
    const origin = assertDevelopmentProject(requiredEnv("SUPABASE_URL"));
    const command = process.argv[2] ?? "provision";
    if (command === "provision") {
      await provision(
        origin,
        requiredEnv("SUPABASE_SECRET_KEY", "SUPABASE_SERVICE_ROLE_KEY"),
        true,
      );
    } else if (command === "resume") {
      await provision(
        origin,
        requiredEnv("SUPABASE_SECRET_KEY", "SUPABASE_SERVICE_ROLE_KEY"),
        false,
      );
    } else if (command === "pair") {
      await createPairingWindows(origin);
    } else if (command === "identity") {
      await exportIdentities();
    } else if (command === "revoke") {
      await revokeInstallation(
        origin,
        requiredEnv("SUPABASE_SECRET_KEY", "SUPABASE_SERVICE_ROLE_KEY"),
        process.argv[3] ?? "",
        process.argv[4] ?? "",
      );
    } else {
      throw new Error(
        "Use `provision`, `resume`, `pair`, `identity`, or `revoke`.",
      );
    }
    if (command !== "revoke")
      process.stdout.write(
        `D2 simulator output saved in ${path.relative(repoRoot, privateDir)}.\n`,
      );
  } catch (error) {
    process.stderr.write(
      `${error instanceof Error ? error.message : "D2 simulator setup failed."}\n`,
    );
    process.exitCode = 1;
  }
}
