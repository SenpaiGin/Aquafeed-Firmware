import { Lucide } from "@react-native-vector-icons/lucide";
import { router, useLocalSearchParams } from "expo-router";
import { useState } from "react";
import { StyleSheet, Text, View } from "react-native";

import {
  BentoCard,
  Button,
  ListRow,
  Notice,
  Sheet,
  StatusLabel,
  TextField,
} from "@/components/app-shell";
import { zoneOffsetLabel } from "@/components/feed-status";
import { Colors, IconSize, Spacing, Typography } from "@/constants/theme";
import { useDeviceAccess } from "@/lib/device-access";
import { useFeederSettings } from "@/lib/feeder-settings";
import { searchTimezones } from "@/lib/schedules";

const titles: Record<string, string> = {
  timezone: "Time zone",
  oxygen: "Oxygen limits",
  feed: "Low-feed alert",
};

export default function FeederSettingScreen() {
  const { field: rawField } = useLocalSearchParams<{ field: string }>();
  const field = Array.isArray(rawField) ? rawField[0] : rawField;
  const { selectedDeviceId } = useDeviceAccess();
  const {
    activeSettings,
    disabled,
    updateSettingsField,
    requestSaveSettings,
    checkMonitoringSettings,
  } = useFeederSettings(selectedDeviceId ?? undefined);
  const [query, setQuery] = useState("");

  const close = () =>
    router.canGoBack() ? router.back() : router.replace("/device");

  const title = titles[field];
  if (!title || !selectedDeviceId) {
    return (
      <Sheet visible title={title ?? "Settings"} onClose={close}>
        <Notice tone="info">Select a feeder in Settings first.</Notice>
      </Sheet>
    );
  }

  const applied = activeSettings?.configuration?.applied_snapshot;
  const hits = searchTimezones(query);
  const zoneRows: { zone: string; label: string }[] = [...hits];
  // The active and the chosen zone stay visible even when a search or the catalog misses them.
  for (const zone of [applied?.timezone, activeSettings?.timezone])
    if (zone && !zoneRows.some((row) => row.zone === zone))
      zoneRows.unshift({
        zone,
        label: zone === applied?.timezone ? "Current" : "Selected",
      });

  return (
    <Sheet
      visible
      title={title}
      onClose={close}
      footer={
        activeSettings && applied ? (
          <Button
            onPress={requestSaveSettings}
            loading={activeSettings.busy}
            disabled={disabled}
          >
            Save
          </Button>
        ) : undefined
      }
    >
      <View style={styles.body}>
        {activeSettings?.configuration
          ?.applied_snapshot ? null : activeSettings?.configuration ? (
          <Notice tone="info">
            No applied configuration is available to preserve yet. Add or apply
            a schedule first.
          </Notice>
        ) : activeSettings && !activeSettings.loading ? (
          <Notice tone="info">
            The current applied configuration could not be verified. Refresh
            status before editing.
          </Notice>
        ) : null}
        {activeSettings?.configuration?.current_state.last_attempt_status ===
        "pending" ? (
          <StatusLabel kind="pending">
            {"Revision " +
              String(
                activeSettings.configuration.current_state
                  .last_attempt_revision,
              ) +
              " is pending"}
          </StatusLabel>
        ) : null}
        {activeSettings?.configuration?.current_state.last_attempt_status ===
        "rejected" ? (
          <StatusLabel kind="warning">
            Latest revision rejected; the prior applied settings remain active
          </StatusLabel>
        ) : null}
        {activeSettings &&
        !activeSettings.loading &&
        activeSettings.recoveryStatus !== "resolved" ? (
          <Notice
            tone="warning"
            actions={
              <Button
                variant="secondary"
                onPress={() => void checkMonitoringSettings()}
                loading={activeSettings.busy}
                disabled={activeSettings.busy || activeSettings.loading}
              >
                {activeSettings.pendingLocal
                  ? "Check original request"
                  : "Refresh settings status"}
              </Button>
            }
          >
            {activeSettings.pendingLocal
              ? "The original settings request may be unresolved. Check its status before editing or submitting another revision."
              : activeSettings.recoveryStatus === "unverified"
                ? "Settings status is unverified. Refresh it before editing."
                : "The latest settings revision is pending. Refresh its status before editing."}
          </Notice>
        ) : null}
        {!activeSettings || activeSettings.loading ? (
          <Notice tone="info">Loading current applied settings…</Notice>
        ) : null}
        {activeSettings?.error ? (
          <Notice tone="error">{activeSettings.error}</Notice>
        ) : null}
        {activeSettings?.notice ? (
          <Notice tone="info">{activeSettings.notice}</Notice>
        ) : null}
        {activeSettings && applied ? (
          field === "timezone" ? (
            <>
              <TextField
                label="Search"
                placeholder="Country, city or zone"
                value={query}
                onChangeText={setQuery}
                autoCorrect={false}
                autoCapitalize="none"
              />
              {query.trim() && !hits.length ? (
                <Text style={Typography.supporting}>
                  {"No supported time zone matches “" +
                    query.trim() +
                    "”. Try a country or city, such as Manila."}
                </Text>
              ) : null}
              <BentoCard flush>
                {zoneRows.map(({ zone, label }, index) => {
                  const selected = zone === activeSettings.timezone;
                  const offset = zoneOffsetLabel(zone);
                  const active = zone === applied.timezone;
                  return (
                    <ListRow
                      key={zone}
                      divider={index > 0}
                      title={label}
                      meta={active ? "Active" : undefined}
                      lines={[offset ? zone + " · " + offset : zone]}
                      trailing={
                        selected ? (
                          <Lucide
                            name="check"
                            size={IconSize.default}
                            color={Colors.light.ink}
                          />
                        ) : undefined
                      }
                      accessibilityLabel={
                        label +
                        ", " +
                        zone +
                        (offset ? ", " + offset : "") +
                        (active ? ", active" : "") +
                        (selected ? ", selected" : "")
                      }
                      disabled={disabled}
                      onPress={() => updateSettingsField("timezone", zone)}
                    />
                  );
                })}
              </BentoCard>
            </>
          ) : field === "oxygen" ? (
            <>
              <TextField
                label="Oxygen low limit"
                suffix="mg/L"
                hint="Leave blank to turn off."
                value={activeSettings.doLow}
                onChangeText={(value) => updateSettingsField("doLow", value)}
                keyboardType="decimal-pad"
                disabled={disabled}
              />
              <TextField
                label="Oxygen high limit"
                suffix="mg/L"
                hint="Leave blank to turn off."
                value={activeSettings.doHigh}
                onChangeText={(value) => updateSettingsField("doHigh", value)}
                keyboardType="decimal-pad"
                disabled={disabled}
              />
            </>
          ) : (
            <TextField
              label="Low-feed alert"
              suffix="%"
              hint="0 to 100. Leave blank to turn off."
              value={activeSettings.feedLow}
              onChangeText={(value) => updateSettingsField("feedLow", value)}
              keyboardType="decimal-pad"
              disabled={disabled}
            />
          )
        ) : null}
      </View>
    </Sheet>
  );
}

const styles = StyleSheet.create({
  body: { gap: Spacing.three },
});
