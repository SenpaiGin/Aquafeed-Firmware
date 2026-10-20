import { Lucide } from "@react-native-vector-icons/lucide";
import { CameraView, useCameraPermissions } from "expo-camera";
import { router, useFocusEffect } from "expo-router";
import { useCallback, useEffect, useRef, useState } from "react";
import { StyleSheet, Text, View } from "react-native";

import {
  AppPage,
  BentoCard,
  Button,
  KeyValue,
  ListRow,
  Notice,
  ScreenHeader,
  TextField,
} from "@/components/app-shell";
import { Colors, IconSize, Radii, Typography } from "@/constants/theme";
import { useDeviceAccess } from "@/lib/device-access";
import type { DeviceRecord } from "@/lib/device-access";
import {
  isPairingSecret,
  isUuid,
  pairingFailureNeedsNewWindow,
  parseDeviceIdentityQrPayload,
  parsePairingQrPayload,
  validatePairingLabels,
} from "@/lib/device-access-state";

type PairingStage = "choose" | "scan" | "manual" | "name" | "added";

function errorCode(error: unknown) {
  if (typeof error !== "object" || error === null || !("code" in error)) {
    return null;
  }
  const code = (error as { code?: unknown }).code;
  return typeof code === "string" ? code : null;
}

export default function AddDeviceScreen() {
  const { installationId } = useDeviceAccess();
  return (
    <PairingFlow
      key={installationId ?? "installation-unavailable"}
      installationId={installationId}
    />
  );
}

function PairingFlow({ installationId }: { installationId: string | null }) {
  const { devices, pairDevice, updateDeviceLabels, selectDevice } =
    useDeviceAccess();
  const [permission, requestPermission] = useCameraPermissions();
  const [stage, setStage] = useState<PairingStage>("choose");
  const [screenFocused, setScreenFocused] = useState(false);
  const [deviceId, setDeviceId] = useState("");
  const [challengeId, setChallengeId] = useState("");
  const [pairingSecret, setPairingSecret] = useState("");
  const [pairError, setPairError] = useState<string | null>(null);
  const [identityNotice, setIdentityNotice] = useState<string | null>(null);
  const [deviceIdError, setDeviceIdError] = useState<string | undefined>();
  const [challengeIdError, setChallengeIdError] = useState<
    string | undefined
  >();
  const [secretError, setSecretError] = useState<string | undefined>();
  const [busy, setBusy] = useState(false);
  const [scanIsLocked, setScanIsLocked] = useState(false);
  const [pairedDeviceId, setPairedDeviceId] = useState<string | null>(null);
  const [pairedRecord, setPairedRecord] = useState<DeviceRecord | null>(null);
  const [deviceName, setDeviceName] = useState("");
  const [deviceLocation, setDeviceLocation] = useState("");
  const [nameError, setNameError] = useState<string | undefined>();
  const [locationError, setLocationError] = useState<string | undefined>();
  const [saveError, setSaveError] = useState<string | null>(null);
  const [dashboardError, setDashboardError] = useState<string | null>(null);
  const [savedLabels, setSavedLabels] = useState<{
    alias: string;
    location: string;
  } | null>(null);
  const scanLocked = useRef(false);
  const busyRef = useRef(false);
  const labelsInitializedFor = useRef<string | null>(null);
  // The shared revision and values the naming form was loaded from.
  const labelsBase = useRef({ revision: 0, alias: "", location: "" });
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
      setScreenFocused(true);
      return () => {
        focused.current = false;
        focusGeneration.current += 1;
        setScreenFocused(false);
      };
    }, []),
  );

  const clearPairingFields = () => {
    setDeviceId("");
    setChallengeId("");
    setPairingSecret("");
    setDeviceIdError(undefined);
    setChallengeIdError(undefined);
    setSecretError(undefined);
    setIdentityNotice(null);
  };

  const startManual = () => {
    setPairError(null);
    setStage("manual");
  };

  const startScan = async () => {
    if (busyRef.current) return;
    const requestFocus = focusGeneration.current;
    setPairError(null);
    scanLocked.current = false;
    setScanIsLocked(false);
    try {
      const result = permission?.granted
        ? permission
        : await requestPermission();
      if (
        !mounted.current ||
        !focused.current ||
        focusGeneration.current !== requestFocus
      ) {
        return;
      }
      if (!result.granted) {
        setStage("manual");
        setPairError(
          "Camera access is off. Enter the pairing details instead.",
        );
        return;
      }
      setStage("scan");
    } catch {
      if (!mounted.current || focusGeneration.current !== requestFocus) return;
      setStage("manual");
      setPairError("Camera is unavailable. Enter the pairing details instead.");
    }
  };

  const handleQr = (value: string) => {
    if (!focused.current || scanLocked.current || busyRef.current) return;
    scanLocked.current = true;
    setScanIsLocked(true);
    const payload = parsePairingQrPayload(value);
    const identity = payload ? null : parseDeviceIdentityQrPayload(value);
    if (!payload && !identity) {
      setPairError(
        "That QR code isn't a valid feeder code. Rescan or enter the details manually.",
      );
      return;
    }
    setIdentityNotice(null);
    if (identity) {
      // The identity QR is public: it only names the feeder, so it never pairs by itself.
      if (devices.some((device) => device.deviceId === identity.device_id)) {
        void openDashboard(identity.device_id);
        return;
      }
      clearPairingFields();
      setDeviceId(identity.device_id);
      setIdentityNotice(
        "Feeder recognised. This phone isn't paired yet: enter the challenge ID and pairing secret from a fresh pairing window.",
      );
      setStage("manual");
      setPairError(null);
      return;
    }
    if (!payload) return;
    setDeviceId(payload.device_id);
    setChallengeId(payload.challenge_id);
    setPairingSecret(payload.pairing_secret);
    setDeviceIdError(undefined);
    setChallengeIdError(undefined);
    setSecretError(undefined);
    setStage("manual");
    setPairError(null);
  };

  const submitPairing = async () => {
    if (busyRef.current) return;
    const normalizedDeviceId = deviceId.trim().toLowerCase();
    const normalizedChallengeId = challengeId.trim().toLowerCase();
    const idInvalid = !isUuid(normalizedDeviceId);
    const challengeInvalid = !isUuid(normalizedChallengeId);
    const secretInvalid = !isPairingSecret(pairingSecret);
    setDeviceIdError(idInvalid ? "Enter a valid device ID." : undefined);
    setChallengeIdError(
      challengeInvalid ? "Enter a valid challenge ID." : undefined,
    );
    setSecretError(secretInvalid ? "Enter the pairing secret." : undefined);
    if (idInvalid || challengeInvalid || secretInvalid) {
      setPairError(null);
      return;
    }
    if (!installationId) {
      setPairError("This installation isn't ready. Wait and try again.");
      return;
    }

    const requestInstallation = installationId;
    busyRef.current = true;
    setBusy(true);
    setPairError(null);
    try {
      const record = await pairDevice({
        device_id: normalizedDeviceId,
        challenge_id: normalizedChallengeId,
        pairing_secret: pairingSecret,
      });
      if (!mounted.current || installationId !== requestInstallation) return;
      setPairedRecord(record);
      setPairedDeviceId(record.deviceId);
      setPairingSecret("");
      if (labelsInitializedFor.current !== record.deviceId) {
        labelsInitializedFor.current = record.deviceId;
        setDeviceName(record.alias ?? "");
        setDeviceLocation(record.location ?? "");
        labelsBase.current = {
          revision: record.metadataRevision,
          alias: record.alias ?? "",
          location: record.location ?? "",
        };
      }
      setNameError(undefined);
      setLocationError(undefined);
      setSaveError(null);
      setStage("name");
    } catch (reason) {
      if (!mounted.current || installationId !== requestInstallation) return;
      const message =
        reason instanceof Error
          ? reason.message
          : "The pairing result could not be confirmed. Check Device before using this code again.";
      if (pairingFailureNeedsNewWindow(errorCode(reason))) {
        clearPairingFields();
        setStage("choose");
      }
      setPairError(message);
    } finally {
      busyRef.current = false;
      if (mounted.current) setBusy(false);
    }
  };

  const saveLabels = async () => {
    if (busyRef.current || !pairedDeviceId || !installationId) return;
    const validation = validatePairingLabels(deviceName, deviceLocation);
    setNameError(validation.alias ?? undefined);
    setLocationError(validation.location ?? undefined);
    if (validation.alias || validation.location) {
      setSaveError(null);
      return;
    }
    const alias = deviceName.trim();
    const location = deviceLocation.trim();
    const requestInstallation = installationId;
    const requestDeviceId = pairedDeviceId;
    busyRef.current = true;
    setBusy(true);
    setSaveError(null);
    setDashboardError(null);
    try {
      // An additional phone keeps the shared values unless the user edited them.
      if (
        alias !== labelsBase.current.alias ||
        location !== labelsBase.current.location
      ) {
        const revision = await updateDeviceLabels(
          requestDeviceId,
          alias,
          location || null,
          labelsBase.current.revision,
        );
        labelsBase.current = { revision, alias, location };
      }
      if (
        !mounted.current ||
        installationId !== requestInstallation ||
        pairedDeviceId !== requestDeviceId
      )
        return;
      setDeviceName(alias);
      setDeviceLocation(location);
      setSavedLabels({ alias, location });
      setStage("added");
    } catch (reason) {
      if (
        !mounted.current ||
        installationId !== requestInstallation ||
        pairedDeviceId !== requestDeviceId
      )
        return;
      const current = (reason as { metadataRevision?: number } | null)
        ?.metadataRevision;
      if (current !== undefined)
        labelsBase.current = { ...labelsBase.current, revision: current };
      setSaveError(
        reason instanceof Error
          ? reason.message
          : "The name could not be saved. Your entries are still here; try again.",
      );
    } finally {
      busyRef.current = false;
      if (mounted.current) setBusy(false);
    }
  };

  const openDashboard = async (targetId = pairedDeviceId) => {
    if (busyRef.current || !targetId || !installationId) return;
    const navigationGeneration = focusGeneration.current;
    busyRef.current = true;
    setBusy(true);
    setDashboardError(null);
    try {
      await selectDevice(targetId);
      if (!mounted.current) return;
      if (focused.current && focusGeneration.current === navigationGeneration) {
        busyRef.current = false;
        setBusy(false);
        router.replace("/");
      }
    } catch (reason) {
      if (
        !mounted.current ||
        !focused.current ||
        focusGeneration.current !== navigationGeneration
      )
        return;
      const message =
        reason instanceof Error
          ? reason.message
          : "The dashboard could not be opened. Try again.";
      // Only the "added" card shows dashboardError; a scan opens from the scanner.
      if (stage === "added") setDashboardError(message);
      else setPairError(message);
    } finally {
      busyRef.current = false;
      if (mounted.current) setBusy(false);
    }
  };

  const pairedDevice =
    devices.find((device) => device.deviceId === pairedDeviceId) ??
    (pairedRecord?.deviceId === pairedDeviceId ? pairedRecord : null);

  const step =
    stage === "choose" || stage === "scan" ? 1 : stage === "manual" ? 2 : 3;
  const stepName = ["Connect", "Verify", "Name"][step - 1];

  return (
    <AppPage>
      <View style={styles.header}>
        <ScreenHeader
          title={stage === "added" ? "Device added" : "Pair a device"}
          back={{ label: "Back to Settings", fallback: "/device" }}
        />
        {stage !== "added" ? (
          <View
            accessible
            accessibilityRole="progressbar"
            accessibilityLabel={"Step " + step + " of 3, " + stepName}
            accessibilityValue={{ min: 1, max: 3, now: step }}
            style={styles.steps}
          >
            <Text style={Typography.metadata}>
              Step {step} of 3 · {stepName}
            </Text>
            <View style={styles.stepBars}>
              {[1, 2, 3].map((index) => (
                <View
                  key={index}
                  style={[styles.stepBar, index <= step && styles.stepBarOn]}
                />
              ))}
            </View>
          </View>
        ) : null}
        {pairError ? <Notice tone="error">{pairError}</Notice> : null}
      </View>

      {stage === "choose" ? (
        <BentoCard flush>
          <ListRow
            icon="qr-code"
            title="Scan QR code"
            lines={["Use the feeder's QR code."]}
            trailing="chevron"
            disabled={busy}
            onPress={() => void startScan()}
          />
          <ListRow
            divider
            icon="keyboard"
            title="Enter details manually"
            lines={["Type the device ID, challenge ID and pairing secret."]}
            trailing="chevron"
            disabled={busy}
            onPress={startManual}
          />
        </BentoCard>
      ) : null}

      {stage === "scan" ? (
        <BentoCard gap={12}>
          <Text accessibilityRole="header" style={Typography.cardTitle}>
            Scan the feeder QR code
          </Text>
          {screenFocused && permission?.granted ? (
            <View style={styles.camera}>
              <CameraView
                style={styles.cameraView}
                facing="back"
                barcodeScannerSettings={{ barcodeTypes: ["qr"] }}
                onBarcodeScanned={(result) => handleQr(result.data)}
                onMountError={() => {
                  setStage("manual");
                  setPairError(
                    "Camera could not start. Enter the pairing details instead.",
                  );
                }}
              />
            </View>
          ) : (
            <Text style={Typography.supporting}>Camera is waiting.</Text>
          )}
          <Text style={Typography.metadata}>
            Point the camera at the feeder QR code.
          </Text>
          {scanIsLocked && pairError ? (
            <Button
              variant="secondary"
              onPress={() => {
                scanLocked.current = false;
                setScanIsLocked(false);
                setPairError(null);
              }}
              disabled={busy}
            >
              Rescan QR code
            </Button>
          ) : null}
          <Button variant="text" onPress={startManual} disabled={busy}>
            Enter details manually
          </Button>
        </BentoCard>
      ) : null}

      {stage === "manual" ? (
        <View style={styles.form}>
          {identityNotice ? (
            <Notice tone="info">{identityNotice}</Notice>
          ) : null}
          <Text style={Typography.supporting}>
            Use the details from one active pairing window.
          </Text>
          <TextField
            label="Device ID"
            value={deviceId}
            onChangeText={(value) => {
              setDeviceId(value);
              setDeviceIdError(undefined);
            }}
            maxLength={36}
            autoCapitalize="none"
            autoCorrect={false}
            error={deviceIdError}
            disabled={busy}
          />
          <TextField
            label="Challenge ID"
            value={challengeId}
            onChangeText={(value) => {
              setChallengeId(value);
              setChallengeIdError(undefined);
            }}
            maxLength={36}
            autoCapitalize="none"
            autoCorrect={false}
            error={challengeIdError}
            disabled={busy}
          />
          <TextField
            label="Pairing secret"
            value={pairingSecret}
            onChangeText={(value) => {
              setPairingSecret(Array.from(value).slice(0, 512).join(""));
              setSecretError(undefined);
            }}
            maxLength={1024}
            autoCapitalize="none"
            autoCorrect={false}
            secureTextEntry
            error={secretError}
            disabled={busy}
          />
          <Button
            onPress={() => void submitPairing()}
            loading={busy}
            disabled={busy}
          >
            Verify and pair
          </Button>
          <Button
            variant="text"
            onPress={() => {
              clearPairingFields();
              setPairError(null);
              setStage("choose");
            }}
            disabled={busy}
          >
            Choose another method
          </Button>
        </View>
      ) : null}

      {stage === "name" ? (
        <View style={styles.form}>
          {pairedDevice ? (
            <BentoCard gap={0} style={styles.idCard}>
              <KeyValue
                label="ID"
                value={"…" + pairedDevice.deviceId.slice(-6).toUpperCase()}
              />
            </BentoCard>
          ) : null}
          <TextField
            label="Device name"
            hint="Required · up to 100 characters"
            value={deviceName}
            onChangeText={(value) => {
              setDeviceName(Array.from(value).slice(0, 100).join(""));
              setNameError(undefined);
            }}
            maxLength={200}
            autoCapitalize="words"
            error={nameError}
            disabled={busy}
          />
          <TextField
            label="Location (optional)"
            hint="Up to 160 characters"
            value={deviceLocation}
            onChangeText={(value) => {
              setDeviceLocation(Array.from(value).slice(0, 160).join(""));
              setLocationError(undefined);
            }}
            maxLength={320}
            autoCapitalize="words"
            error={locationError}
            disabled={busy}
          />
          {saveError ? <Notice tone="error">{saveError}</Notice> : null}
          <Button
            onPress={() => void saveLabels()}
            loading={busy}
            disabled={busy}
          >
            Save device name
          </Button>
        </View>
      ) : null}

      {stage === "added" ? (
        <BentoCard gap={0} style={styles.added}>
          <View
            accessibilityElementsHidden
            importantForAccessibility="no-hide-descendants"
            style={styles.successMark}
          >
            <Lucide
              name="check"
              size={IconSize.nav}
              color={Colors.light.onInk}
            />
          </View>
          <Text
            accessibilityRole="header"
            style={[Typography.title, styles.addedName]}
          >
            {savedLabels?.alias || pairedDevice?.alias || "Device added"}
          </Text>
          {savedLabels?.location || pairedDevice?.location ? (
            <Text style={[Typography.supporting, styles.addedLocation]}>
              {savedLabels?.location || pairedDevice?.location}
            </Text>
          ) : null}
          {pairedDeviceId ? (
            <Text style={[Typography.metadata, styles.addedId]}>
              {"ID · " + pairedDeviceId.slice(-6).toUpperCase()}
            </Text>
          ) : null}
          {dashboardError ? (
            <View style={styles.addedError}>
              <Notice tone="error">{dashboardError}</Notice>
            </View>
          ) : null}
          <View style={styles.addedPrimary}>
            <Button
              onPress={() => void openDashboard()}
              loading={busy}
              disabled={busy || !pairedDeviceId}
            >
              Open dashboard
            </Button>
          </View>
          <View style={styles.addedSecondary}>
            <Button
              variant="secondary"
              onPress={() => router.replace("/device")}
              disabled={busy}
            >
              Device list
            </Button>
          </View>
        </BentoCard>
      ) : null}
    </AppPage>
  );
}

const styles = StyleSheet.create({
  header: { gap: 12 },
  steps: { gap: 8 },
  stepBars: { flexDirection: "row", gap: 4 },
  stepBar: {
    flex: 1,
    height: 4,
    borderRadius: Radii.pill,
    backgroundColor: Colors.light.progressTrack,
  },
  stepBarOn: { backgroundColor: Colors.light.ink },
  camera: { height: 280, borderRadius: Radii.card, overflow: "hidden" },
  cameraView: { flex: 1 },
  form: { gap: 16 },
  idCard: { paddingVertical: 4 },
  added: {
    paddingVertical: 32,
    paddingHorizontal: 24,
    alignItems: "center",
  },
  successMark: {
    width: 56,
    height: 56,
    borderRadius: Radii.pill,
    backgroundColor: Colors.light.ink,
    alignItems: "center",
    justifyContent: "center",
  },
  addedName: { marginTop: 16, textAlign: "center" },
  addedLocation: { marginTop: 4, textAlign: "center" },
  addedId: { marginTop: 4 },
  addedError: { marginTop: 16, alignSelf: "stretch" },
  addedPrimary: { marginTop: 24, alignSelf: "stretch" },
  addedSecondary: { marginTop: 12, alignSelf: "stretch" },
});
