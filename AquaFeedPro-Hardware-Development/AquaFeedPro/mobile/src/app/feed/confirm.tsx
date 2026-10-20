import { useCallback, useLayoutEffect, useRef, useState } from "react";
import { StyleSheet, Text, View } from "react-native";
import { router, useFocusEffect } from "expo-router";

import {
  BentoCard,
  Button,
  Chip,
  KeyValue,
  ListRow,
  Notice,
  SectionHeader,
  Segmented,
  Sheet,
  statusIcons,
  StatusLabel,
  TextField,
} from "@/components/app-shell";
import { statusKind } from "@/components/feed-status";
import { Colors, Typography } from "@/constants/theme";
import { subscribeDeviceChanges } from "@/lib/device-changes";
import { useDeviceAccess, type NozzleCapability } from "@/lib/device-access";
import {
  loadPendingManualFeed,
  manualInventoryIssue,
  manualInventoryNotice,
  resolveSavedManualFeedNoAdmission,
  reconcileManualFeed,
  submitManualFeed,
  type ManualCommand,
  type PendingManualFeed,
  type ManualTarget,
} from "@/lib/manual-feed";
import { readMonitoringSnapshot } from "@/lib/monitoring";

type NozzleChoice = "1" | "2" | "both";
type LegDose =
  { mode: "grams"; amount: string } | { mode: "fixed_portion"; id: string };

function supported(nozzle: NozzleCapability) {
  if (nozzle.doseModes.includes("grams")) {
    return { mode: "grams" as const, amount: String(nozzle.minDoseG ?? "") };
  }
  return {
    mode: "fixed_portion" as const,
    id: nozzle.fixedPortionIds[0] ?? "",
  };
}

function makeTarget(
  nozzleNumber: 1 | 2,
  capability: NozzleCapability,
  dose: LegDose,
): ManualTarget | null {
  if (dose.mode === "fixed_portion") {
    return capability.doseModes.includes("fixed_portion") &&
      capability.fixedPortionIds.includes(dose.id)
      ? {
          nozzle_number: nozzleNumber,
          dose: { mode: "fixed_portion", fixed_portion_id: dose.id },
        }
      : null;
  }
  const amount = Number(dose.amount);
  const min = capability.minDoseG;
  const max = capability.maxDoseG;
  const step = capability.doseStepG;
  if (
    !capability.doseModes.includes("grams") ||
    !Number.isFinite(amount) ||
    min === null ||
    max === null ||
    step === null ||
    amount < min ||
    amount > max ||
    Math.abs((amount - min) / step - Math.round((amount - min) / step)) > 1e-7
  )
    return null;
  return {
    nozzle_number: nozzleNumber,
    dose: { mode: "grams", amount_g: amount },
  };
}

function resultStatus(value: string) {
  const labels: Record<string, string> = {
    queued: "Waiting for the simulator",
    accepted: "Accepted by the simulator",
    running: "In progress",
    completed: "Completed",
    failed: "Failed",
    rejected: "Rejected",
    expired: "Expired before starting",
    unknown: "Outcome unknown",
    not_started: "Not started",
  };
  return labels[value] ?? "Status unavailable";
}

function isTerminal(status: string) {
  return [
    "completed",
    "partial",
    "failed",
    "rejected",
    "expired",
    "unknown",
  ].includes(status);
}

function DoseControl({
  label,
  capability,
  value,
  onChange,
  disabled = false,
}: {
  label: string;
  capability: NozzleCapability;
  value: LegDose;
  onChange: (next: LegDose) => void;
  disabled?: boolean;
}) {
  if (capability.doseModes.includes("grams")) {
    return (
      <TextField
        label={`${label} amount`}
        suffix="g"
        value={
          value.mode === "grams"
            ? value.amount
            : String(capability.minDoseG ?? "")
        }
        onChangeText={(amount) => onChange({ mode: "grams", amount })}
        keyboardType="decimal-pad"
        inputMode="decimal"
        disabled={disabled}
        hint={`Supported range ${capability.minDoseG} to ${capability.maxDoseG} grams in ${capability.doseStepG} gram steps.`}
      />
    );
  }
  return (
    <View style={styles.doseField}>
      <Text style={Typography.label}>{label} portion</Text>
      {disabled ? (
        <Text style={Typography.supporting}>
          Saved portion: {value.mode === "fixed_portion" ? value.id : "unknown"}
        </Text>
      ) : (
        <View style={styles.choiceRow}>
          {capability.fixedPortionIds.map((id) => (
            <Chip
              key={id}
              role="radio"
              label={id}
              selected={value.mode === "fixed_portion" && value.id === id}
              onPress={() => onChange({ mode: "fixed_portion", id })}
            />
          ))}
        </View>
      )}
    </View>
  );
}

export default function FeedConfirmationScreen() {
  const {
    installationId,
    scopeRevision,
    selectedDevice,
    selectedDeviceId,
    devices,
    refreshDevices,
  } = useDeviceAccess();
  const [targetScope] = useState(() => ({
    deviceId: selectedDevice?.deviceId ?? null,
    installationId,
    scopeRevision,
    selectedDeviceId,
  }));
  const targetDeviceId = targetScope.deviceId;
  const currentScope = useRef({
    installationId,
    scopeRevision,
    selectedDeviceId,
  });
  useLayoutEffect(() => {
    currentScope.current = { installationId, scopeRevision, selectedDeviceId };
  }, [installationId, scopeRevision, selectedDeviceId]);
  const device =
    devices.find((candidate) => candidate.deviceId === targetDeviceId) ?? null;
  const targetChanged =
    !targetDeviceId ||
    targetDeviceId !== selectedDeviceId ||
    targetScope.installationId !== installationId ||
    targetScope.scopeRevision !== scopeRevision ||
    targetScope.selectedDeviceId !== selectedDeviceId;
  const [choice, setChoice] = useState<NozzleChoice>("1");
  const [dose1, setDose1] = useState<LegDose>(() =>
    device
      ? supported(device.capabilities.nozzles["1"])
      : { mode: "grams", amount: "" },
  );
  const [dose2, setDose2] = useState<LegDose>(() =>
    device
      ? supported(device.capabilities.nozzles["2"])
      : { mode: "grams", amount: "" },
  );
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState<string | null>(null);
  const [command, setCommand] = useState<ManualCommand | null>(null);
  const [pendingReceipt, setPendingReceipt] =
    useState<PendingManualFeed | null>(null);
  const [bodyHeight, setBodyHeight] = useState<number>();
  const submitting = useRef(false);
  const requestGeneration = useRef(0);
  const wakeRef = useRef<(() => void) | null>(null);
  const focused = useRef(false);
  const focusGeneration = useRef(0);
  const pendingRefresh = useRef<Promise<void> | null>(null);
  const queuedRefresh = useRef<{
    focusGeneration: number;
    requestGeneration: number;
  } | null>(null);
  useLayoutEffect(() => {
    focusGeneration.current += 1;
    wakeRef.current?.();
  }, [installationId, scopeRevision, selectedDeviceId, targetDeviceId]);
  const scopeIsCurrent = useCallback(
    () =>
      currentScope.current.installationId === targetScope.installationId &&
      currentScope.current.scopeRevision === targetScope.scopeRevision &&
      currentScope.current.selectedDeviceId === targetDeviceId,
    [targetDeviceId, targetScope],
  );

  useFocusEffect(
    useCallback(() => {
      focused.current = true;
      focusGeneration.current += 1;
      return () => {
        focused.current = false;
        focusGeneration.current += 1;
        wakeRef.current?.();
      };
    }, []),
  );

  const refreshPending = useCallback(() => {
    if (
      !installationId ||
      !targetDeviceId ||
      targetChanged ||
      !focused.current ||
      submitting.current
    )
      return;
    let currentFocusGeneration = focusGeneration.current;
    let currentRequestGeneration = requestGeneration.current;
    if (pendingRefresh.current) {
      queuedRefresh.current = {
        focusGeneration: currentFocusGeneration,
        requestGeneration: currentRequestGeneration,
      };
      return;
    }
    const isCurrent = () =>
      focused.current &&
      focusGeneration.current === currentFocusGeneration &&
      requestGeneration.current === currentRequestGeneration &&
      scopeIsCurrent();
    const work = Promise.resolve()
      .then(async () => {
        while (true) {
          try {
            const saved = await loadPendingManualFeed(
              installationId,
              targetDeviceId,
            );
            if (!saved || !isCurrent() || queuedRefresh.current) {
              // A queued notification gets one fresh read below.
            } else {
              setPendingReceipt(saved);
              const restored = await reconcileManualFeed(
                installationId,
                targetDeviceId,
                saved.idempotency_key,
              );
              if (isCurrent() && !queuedRefresh.current) {
                setCommand(restored);
                setPendingReceipt(
                  await loadPendingManualFeed(installationId, targetDeviceId),
                );
              }
            }
            if (!saved && isCurrent() && !queuedRefresh.current) {
              setPendingReceipt(null);
            }
          } catch {
            if (isCurrent() && !queuedRefresh.current)
              setMessage(
                "A saved feed needs a status check. No new feed was sent.",
              );
          }
          const queued = queuedRefresh.current;
          queuedRefresh.current = null;
          if (
            !queued ||
            !focused.current ||
            focusGeneration.current !== queued.focusGeneration ||
            requestGeneration.current !== queued.requestGeneration ||
            submitting.current ||
            !scopeIsCurrent()
          )
            break;
          currentFocusGeneration = queued.focusGeneration;
          currentRequestGeneration = queued.requestGeneration;
        }
      })
      .finally(() => {
        pendingRefresh.current = null;
        queuedRefresh.current = null;
      });
    pendingRefresh.current = work;
  }, [installationId, scopeIsCurrent, targetChanged, targetDeviceId]);

  useFocusEffect(
    useCallback(() => {
      void refreshPending();
      void refreshDevices().catch(() => {});
    }, [refreshDevices, refreshPending]),
  );

  const commandInProgress = !!command && !isTerminal(command.status);
  useFocusEffect(
    useCallback(() => {
      if (
        !commandInProgress ||
        !installationId ||
        !targetDeviceId ||
        targetChanged
      )
        return;
      return subscribeDeviceChanges(
        "feed-progress-" + installationId + "-" + scopeRevision,
        targetDeviceId,
        ["feed_sequences", "feed_steps"],
        () => {
          if (!focused.current || !scopeIsCurrent()) return;
          if (submitting.current) {
            wakeRef.current?.();
            return;
          }
          void refreshPending();
        },
      );
    }, [
      commandInProgress,
      installationId,
      refreshPending,
      scopeIsCurrent,
      scopeRevision,
      targetChanged,
      targetDeviceId,
    ]),
  );

  const targetRows: ManualTarget[] = [];
  const nozzle1 = device?.capabilities.nozzles["1"];
  const nozzle2 = device?.capabilities.nozzles["2"];
  const firstTarget = nozzle1 ? makeTarget(1, nozzle1, dose1) : null;
  const secondTarget = nozzle2 ? makeTarget(2, nozzle2, dose2) : null;
  if ((choice === "1" || choice === "both") && firstTarget)
    targetRows.push(firstTarget);
  if ((choice === "2" || choice === "both") && secondTarget)
    targetRows.push(secondTarget);

  const online = device?.contactFreshness === "fresh";
  const lockout = command?.safety_lockout === true;
  const valid = targetRows.length === (choice === "both" ? 2 : 1);
  const inventoryNotice = manualInventoryNotice(targetRows);

  const checkStatus = async () => {
    if (
      !installationId ||
      !device ||
      busy ||
      targetChanged ||
      submitting.current
    )
      return;
    submitting.current = true;
    const generation = ++requestGeneration.current;
    const currentFocusGeneration = focusGeneration.current;
    const isCurrent = () =>
      focused.current &&
      focusGeneration.current === currentFocusGeneration &&
      generation === requestGeneration.current &&
      scopeIsCurrent();
    setBusy(true);
    setMessage(null);
    try {
      const saved = await loadPendingManualFeed(
        installationId,
        device.deviceId,
      );
      if (!isCurrent()) return;
      if (!saved) {
        setPendingReceipt(null);
        setMessage("There is no saved request to check.");
        return;
      }
      setPendingReceipt(saved);
      const result = await reconcileManualFeed(
        installationId,
        device.deviceId,
        saved.idempotency_key,
      );
      if (isCurrent()) {
        setCommand(result);
        setPendingReceipt(
          await loadPendingManualFeed(installationId, device.deviceId),
        );
      }
    } catch (reason) {
      if (isCurrent())
        setMessage(
          reason instanceof Error
            ? reason.message
            : "Feed status is not available yet.",
        );
    } finally {
      submitting.current = false;
      if (generation === requestGeneration.current) setBusy(false);
    }
  };

  const resolveNoAdmission = async () => {
    if (
      !installationId ||
      !device ||
      !pendingReceipt ||
      busy ||
      targetChanged ||
      submitting.current
    )
      return;
    submitting.current = true;
    const generation = ++requestGeneration.current;
    const currentFocusGeneration = focusGeneration.current;
    const isCurrent = () =>
      focused.current &&
      focusGeneration.current === currentFocusGeneration &&
      generation === requestGeneration.current &&
      scopeIsCurrent();
    setBusy(true);
    setMessage(null);
    try {
      const resolution = await resolveSavedManualFeedNoAdmission(
        installationId,
        device.deviceId,
        scopeIsCurrent,
      );
      if (isCurrent()) {
        setCommand(resolution.command);
        setPendingReceipt(
          await loadPendingManualFeed(installationId, device.deviceId),
        );
        setMessage(
          resolution.noAdmissionRecorded
            ? "The saved feed was safely closed without starting a feed. No new feed was sent."
            : "A feed record already exists for this saved request. Its current status is shown below. No new feed was started.",
        );
      }
    } catch (reason) {
      if (isCurrent())
        setMessage(
          reason instanceof Error
            ? reason.message
            : "The saved feed could not be safely resolved.",
        );
    } finally {
      submitting.current = false;
      if (generation === requestGeneration.current) setBusy(false);
    }
  };

  const confirmFeed = async () => {
    if (
      !installationId ||
      !device ||
      !valid ||
      !online ||
      targetChanged ||
      lockout ||
      pendingReceipt ||
      submitting.current
    )
      return;
    submitting.current = true;
    const generation = ++requestGeneration.current;
    const currentFocusGeneration = focusGeneration.current;
    const isCurrent = () =>
      focused.current &&
      focusGeneration.current === currentFocusGeneration &&
      generation === requestGeneration.current &&
      scopeIsCurrent();
    const scopeDeviceId = device.deviceId;
    const scopeInstallationId = installationId;
    const targets = targetRows;
    setBusy(true);
    setMessage(null);
    try {
      const snapshot = await readMonitoringSnapshot(
        scopeInstallationId,
        scopeDeviceId,
      );
      if (!isCurrent()) return;
      const inventoryIssue = manualInventoryIssue(snapshot, targets);
      if (inventoryIssue) {
        setMessage(inventoryIssue);
        return;
      }
      let result = await submitManualFeed(
        scopeInstallationId,
        scopeDeviceId,
        device.capabilitiesRevision,
        targets,
        scopeIsCurrent,
      );
      if (isCurrent()) {
        setCommand(result);
        setPendingReceipt(
          await loadPendingManualFeed(scopeInstallationId, scopeDeviceId),
        );
      }
      for (
        let attempt = 0;
        attempt < 12 && !isTerminal(result.status);
        attempt += 1
      ) {
        if (!isCurrent()) return;
        await new Promise<void>((resolve) => {
          let timer: ReturnType<typeof setTimeout>;
          const wake = () => {
            if (wakeRef.current === wake) wakeRef.current = null;
            clearTimeout(timer);
            resolve();
          };
          wakeRef.current = wake;
          timer = setTimeout(wake, 1500);
        });
        if (!isCurrent()) return;
        result = await checkSavedStatus(scopeInstallationId, scopeDeviceId);
        if (!isCurrent()) return;
        setCommand(result);
        setPendingReceipt(
          await loadPendingManualFeed(scopeInstallationId, scopeDeviceId),
        );
      }
    } catch (reason) {
      if (isCurrent()) {
        setPendingReceipt(
          await loadPendingManualFeed(scopeInstallationId, scopeDeviceId).catch(
            () => null,
          ),
        );
        setMessage(
          reason instanceof Error
            ? reason.message
            : "Feed status could not be confirmed.",
        );
      }
    } finally {
      submitting.current = false;
      if (generation === requestGeneration.current) setBusy(false);
    }
  };

  const close = () =>
    router.canGoBack() ? router.back() : router.replace("/");

  if (!device || !installationId) {
    return (
      <Sheet visible title="Feed now" onClose={close}>
        <Notice tone="info">
          Select a paired feeder before choosing a feed.
        </Notice>
      </Sheet>
    );
  }

  const showNozzle1 = (choice === "1" || choice === "both") && nozzle1;
  const showNozzle2 = (choice === "2" || choice === "both") && nozzle2;
  const confirming = !command?.status || isTerminal(command.status);

  return (
    <Sheet
      visible
      title="Feed now"
      onClose={close}
      footer={
        confirming && !pendingReceipt ? (
          <Button
            icon="utensils"
            onPress={() => void confirmFeed()}
            loading={busy}
            disabled={!valid || !online || targetChanged || lockout || busy}
            accessibilityHint="Submits the displayed nozzles and doses to the displayed feeder once."
          >
            Confirm feed
          </Button>
        ) : undefined
      }
      bodyMaxHeight={bodyHeight}
    >
      <View
        onLayout={(event) => {
          if (bodyHeight === undefined)
            setBodyHeight(event.nativeEvent.layout.height);
        }}
      >
        {!online ? (
          <View style={styles.top12}>
            <Notice tone="warning">
              A recent authenticated device contact is required before a new
              feed can be confirmed.
            </Notice>
          </View>
        ) : null}
        {targetChanged ? (
          <View style={styles.top12}>
            <Notice tone="error">
              The selected feeder changed. Close and reopen Feed now to choose a
              new target.
            </Notice>
          </View>
        ) : null}
        <View style={styles.nozzles}>
          <SectionHeader title="Nozzles" />
          <Segmented
            accessibilityLabel="Nozzles"
            value={choice}
            onChange={setChoice}
            options={[
              {
                value: "1",
                label: "Nozzle 1",
                disabled:
                  pendingReceipt !== null ||
                  busy ||
                  !device.capabilities.nozzles["1"].enabled,
              },
              {
                value: "2",
                label: "Nozzle 2",
                disabled:
                  pendingReceipt !== null ||
                  busy ||
                  !device.capabilities.nozzles["2"].enabled,
              },
              {
                value: "both",
                label: "Both",
                disabled:
                  pendingReceipt !== null ||
                  busy ||
                  !(
                    nozzle1?.enabled &&
                    nozzle2?.enabled &&
                    device.capabilities.schedulerWakeGraceMs !== null
                  ),
              },
            ]}
          />
        </View>
        {showNozzle1 ? (
          <View style={styles.top24}>
            <DoseControl
              label="Nozzle 1"
              capability={nozzle1}
              value={dose1}
              onChange={setDose1}
              disabled={pendingReceipt !== null || busy}
            />
          </View>
        ) : null}
        {showNozzle2 ? (
          <View style={showNozzle1 ? styles.top16 : styles.top24}>
            <DoseControl
              label="Nozzle 2"
              capability={nozzle2}
              value={dose2}
              onChange={setDose2}
              disabled={pendingReceipt !== null || busy}
            />
          </View>
        ) : null}
        {choice === "both" ? (
          <View style={styles.top16}>
            <Notice tone="info">
              Nozzle 1 will feed first, then Nozzle 2. Only one nozzle dispenses
              at a time.
            </Notice>
          </View>
        ) : null}
        {confirming && !pendingReceipt ? (
          <View style={styles.top16}>
            {inventoryNotice ? (
              <View>
                <Notice tone="warning">{inventoryNotice}</Notice>
              </View>
            ) : null}
            <BentoCard tone="muted" gap={0}>
              <Text
                accessibilityRole="header"
                style={[
                  Typography.overline,
                  { color: Colors.light.textSecondary },
                ]}
              >
                You are about to send
              </Text>
              <View style={styles.summaryRows}>
                <KeyValue
                  label="Device"
                  value={
                    (device.alias || device.model) +
                    (device.isSimulated ? " · Simulator" : "")
                  }
                />
                {valid ? (
                  targetRows.map((target) => (
                    <KeyValue
                      key={target.nozzle_number}
                      divider
                      label={`Nozzle ${target.nozzle_number}`}
                      value={
                        target.dose.mode === "grams"
                          ? `${target.dose.amount_g} g`
                          : `Portion ${target.dose.fixed_portion_id}`
                      }
                    />
                  ))
                ) : (
                  <Text style={styles.summaryInvalid}>
                    Enter a supported amount for each selected nozzle.
                  </Text>
                )}
              </View>
            </BentoCard>
          </View>
        ) : null}
        {message ? (
          <View style={styles.top16}>
            <Notice tone="warning">{message}</Notice>
          </View>
        ) : null}
        {pendingReceipt && !command ? (
          <View style={styles.top24}>
            <BentoCard>
              <Text accessibilityRole="header" style={Typography.cardTitle}>
                Saved feed needs recovery
              </Text>
              <View style={styles.summaryRows}>
                <KeyValue
                  label="Saved feeder"
                  value={device.alias || device.model}
                />
                {pendingReceipt.targets.map((target) => (
                  <KeyValue
                    key={target.nozzle_number}
                    divider
                    label={`Nozzle ${target.nozzle_number}`}
                    value={
                      target.dose.mode === "grams"
                        ? `${target.dose.amount_g} g saved`
                        : `Portion ${target.dose.fixed_portion_id} saved`
                    }
                  />
                ))}
              </View>
              <View style={styles.top12}>
                <Notice tone="warning">
                  This saved feed has no confirmed result. Check its status, or
                  resolve it safely without starting another feed.
                </Notice>
              </View>
              <View style={styles.progressFooter}>
                <Button
                  variant="secondary"
                  icon="refresh-cw"
                  onPress={() => void checkStatus()}
                  loading={busy}
                >
                  Check status
                </Button>
                <Button
                  variant="secondary"
                  icon="shield-check"
                  onPress={() => void resolveNoAdmission()}
                  loading={busy}
                >
                  Resolve safely
                </Button>
              </View>
            </BentoCard>
          </View>
        ) : null}
        {command ? (
          <View style={styles.top24}>
            <BentoCard flush>
              <View style={styles.progressHeader}>
                <Text accessibilityRole="header" style={Typography.cardTitle}>
                  Feed progress
                </Text>
                <StatusLabel kind={statusKind(command.status)}>
                  {resultStatus(command.status)}
                </StatusLabel>
              </View>
              {command.nozzle_results.map((result) => {
                const measured =
                  result.measurement_quality === "valid" &&
                  typeof result.measured_dispensed_g === "number"
                    ? device.isSimulated
                      ? `${result.measured_dispensed_g} g synthetic simulator reading`
                      : `${result.measured_dispensed_g} g measured`
                    : "Amount not measured";
                const requested =
                  result.requested_dose.mode === "grams"
                    ? `${result.requested_dose.amount_g} g requested`
                    : `Portion ${result.requested_dose.fixed_portion_id} requested`;
                return (
                  <ListRow
                    key={result.nozzle_number}
                    divider
                    icon={
                      result.status === "not_started"
                        ? "circle-dashed"
                        : statusIcons[statusKind(result.status)]
                    }
                    title={`Nozzle ${result.nozzle_number} · ${resultStatus(result.status)}`}
                    lines={[`${requested} · ${measured}`]}
                  />
                );
              })}
              {!isTerminal(command.status) ||
              command.safety_lockout ||
              pendingReceipt ? (
                <View style={styles.progressFooter}>
                  <Button
                    variant="secondary"
                    icon="refresh-cw"
                    onPress={() => void checkStatus()}
                    loading={busy}
                  >
                    Check status
                  </Button>
                </View>
              ) : null}
            </BentoCard>
          </View>
        ) : null}
        {command?.safety_lockout ? (
          <View style={styles.top12}>
            <Notice tone="error">
              The feeder needs an in-person safety check before another feed.
            </Notice>
          </View>
        ) : null}
        {command && !isTerminal(command.status) ? (
          <View style={styles.top12}>
            <Notice tone="info">
              This feed is saved. Status checks only read the original request;
              they do not send another feed.
            </Notice>
          </View>
        ) : null}
      </View>
    </Sheet>
  );
}

async function checkSavedStatus(installationId: string, deviceId: string) {
  const saved = await loadPendingManualFeed(installationId, deviceId);
  if (!saved) throw new Error("The saved feed request is no longer available.");
  return reconcileManualFeed(installationId, deviceId, saved.idempotency_key);
}

const styles = StyleSheet.create({
  top12: { marginTop: 12 },
  top16: { marginTop: 16 },
  top24: { marginTop: 24 },
  nozzles: { marginTop: 24, gap: 8 },
  doseField: { gap: 8 },
  choiceRow: { flexDirection: "row", flexWrap: "wrap", gap: 8 },
  summaryRows: { marginTop: 4 },
  summaryInvalid: {
    ...Typography.supporting,
    color: Colors.light.ink,
    paddingVertical: 12,
  },
  progressHeader: {
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "space-between",
    gap: 12,
    paddingTop: 16,
    paddingHorizontal: 16,
    paddingBottom: 12,
  },
  progressFooter: {
    padding: 16,
    borderTopWidth: 1,
    borderTopColor: Colors.light.border,
  },
});
