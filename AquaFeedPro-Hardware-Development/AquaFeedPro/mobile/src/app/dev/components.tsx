import { Redirect } from "expo-router";
import { useState } from "react";
import { StyleSheet, Text, View } from "react-native";

import {
  AppPage,
  BentoCard,
  Button,
  Chip,
  EmptyState,
  DropdownPill,
  ErrorState,
  Fab,
  IconButton,
  KeyValue,
  ListRow,
  Notice,
  ProgressBar,
  ScreenHeader,
  SectionHeader,
  Segmented,
  Sheet,
  Skeleton,
  Stat,
  StatusLabel,
  SwitchRow,
  TextField,
  Toggle,
} from "@/components/app-shell";
import type { ButtonVariant, StatusKind } from "@/components/bento-kit";
import { Colors, Spacing, Typography } from "@/constants/theme";

const buttonVariants: ButtonVariant[] = [
  "primary",
  "secondary",
  "text",
  "inverse",
];

const statusKinds: StatusKind[] = [
  "completed",
  "pending",
  "running",
  "warning",
  "failed",
  "online",
  "offline",
  "outdated",
  "unknown",
  "enabled",
  "paused",
  "selected",
  "simulator",
];

const nozzleOptions = [
  { value: "one", label: "Nozzle 1" },
  { value: "two", label: "Nozzle 2", disabled: true },
  { value: "both", label: "Both" },
] as const;

const days = ["Mon", "Tue", "Wed", "Sat", "Sun"];

export default function ComponentPreviewRoute() {
  if (!__DEV__) {
    return <Redirect href="/" />;
  }

  return <ComponentPreviewScreen />;
}

function ComponentPreviewScreen() {
  const [pressCount, setPressCount] = useState(0);
  const [deviceName, setDeviceName] = useState("");
  const [amount, setAmount] = useState("50");
  const [nozzle, setNozzle] =
    useState<(typeof nozzleOptions)[number]["value"]>("one");
  const [selectedDays, setSelectedDays] = useState(["Mon", "Tue", "Wed"]);
  const [toggleOn, setToggleOn] = useState(true);
  const [toggleOff, setToggleOff] = useState(false);
  const [switchRow, setSwitchRow] = useState(true);
  const [sheetVisible, setSheetVisible] = useState(false);

  const countPress = () => setPressCount((count) => count + 1);

  return (
    <AppPage>
      <ScreenHeader title="Mono Ink preview" />
      <Text style={Typography.supporting}>
        Development-only component previews. Actions update local state; nothing
        contacts the network or a feeder.
      </Text>
      <Text style={Typography.metadata}>Local presses: {pressCount}</Text>

      <SectionHeader title="Buttons" />
      {buttonVariants.map((variant) => (
        <BentoCard
          key={variant}
          tone={variant === "inverse" ? "inverse" : "default"}
        >
          <Button variant={variant} icon="utensils" onPress={countPress}>
            {variant + " default"}
          </Button>
          <Button variant={variant} disabled>
            {variant + " disabled"}
          </Button>
          <Button variant={variant} loading onPress={countPress}>
            {variant + " loading"}
          </Button>
        </BentoCard>
      ))}
      <Button
        variant="secondary"
        size="compact"
        icon="plus"
        onPress={countPress}
      >
        Add
      </Button>

      <SectionHeader title="Icon button" />
      <View style={styles.row}>
        <IconButton
          icon="ellipsis"
          accessibilityLabel="Example menu"
          onPress={countPress}
        />
        <IconButton icon="x" accessibilityLabel="Example close" disabled />
        <IconButton
          icon="list-filter"
          accessibilityLabel="Example filters, 2 active"
          badge
          onPress={countPress}
        />
      </View>

      <SectionHeader title="Round button" />
      <View style={styles.row}>
        <Fab
          icon="utensils"
          accessibilityLabel="Example round button"
          onPress={countPress}
        />
        <Fab
          icon="plus"
          accessibilityLabel="Example round button, disabled"
          disabled
          onPress={countPress}
        />
      </View>

      <SectionHeader title="Dropdown pill" />
      <View style={styles.row}>
        <DropdownPill
          value="24 h"
          accessibilityLabel="Example range, 24 hours"
          onPress={countPress}
        />
      </View>

      <SectionHeader title="Text field" />
      <TextField
        label="Device name"
        value={deviceName}
        onChangeText={setDeviceName}
        placeholder="Name this feeder"
        hint="Shown in the device picker."
      />
      <TextField
        label="Nozzle 1 amount"
        value={amount}
        onChangeText={setAmount}
        suffix="g"
        hint="Supported range 5 to 200 grams in 5 gram steps."
        keyboardType="number-pad"
      />
      <TextField
        label="Nozzle 1 amount"
        value="7"
        suffix="g"
        error="Enter 5 to 200 grams in 5 gram steps."
        keyboardType="number-pad"
      />
      <TextField
        label="Nozzle 2 amount"
        value="30"
        suffix="g"
        hint="Unavailable while Feeder B is offline."
        disabled
      />

      <SectionHeader title="Segmented" />
      <Segmented
        accessibilityLabel="Nozzles"
        options={nozzleOptions}
        value={nozzle}
        onChange={setNozzle}
      />

      <SectionHeader title="Chips" />
      <View style={styles.wrap}>
        {days.map((day) => (
          <Chip
            key={day}
            label={day}
            selected={selectedDays.includes(day)}
            onPress={() =>
              setSelectedDays((current) =>
                current.includes(day)
                  ? current.filter((item) => item !== day)
                  : [...current, day],
              )
            }
          />
        ))}
      </View>

      <SectionHeader title="Switch" />
      <View style={styles.row}>
        <Toggle
          value={toggleOn}
          onValueChange={setToggleOn}
          accessibilityLabel="Example switch, starts on"
        />
        <Toggle
          value={toggleOff}
          onValueChange={setToggleOff}
          accessibilityLabel="Example switch, starts off"
        />
        <Toggle
          value
          onValueChange={setToggleOn}
          accessibilityLabel="Example disabled switch"
          disabled
        />
      </View>
      <SwitchRow
        label="Schedule enabled"
        description="Paused schedules stay saved and do not run."
        value={switchRow}
        onValueChange={setSwitchRow}
      />

      <SectionHeader title="Status pill" />
      <View style={styles.wrap}>
        {statusKinds.map((kind) => (
          <StatusLabel key={kind} kind={kind}>
            {kind}
          </StatusLabel>
        ))}
      </View>

      <SectionHeader title="Notice" />
      <Notice tone="info">
        Nozzle 1 will feed first, then Nozzle 2. Only one nozzle dispenses at a
        time.
      </Notice>
      <Notice tone="pending">
        Revision 12 is waiting for the feeder. The schedule below remains the
        last applied version.
      </Notice>
      <Notice
        tone="warning"
        title="Low feed"
        actions={
          <Button variant="secondary" onPress={countPress}>
            Local action
          </Button>
        }
      >
        Refill the container before the next scheduled feeding.
      </Notice>
      <Notice tone="error" title="Feed not sent">
        Feeder B is offline. Nothing was dispensed.
      </Notice>

      <SectionHeader
        title="List rows"
        action={{ label: "View all", onPress: countPress }}
      />
      <BentoCard flush>
        <ListRow
          icon="cpu"
          title="Feeder A"
          lines={["Pond 01"]}
          trailing="chevron"
          onPress={countPress}
        />
        <ListRow
          divider
          icon="circle-check"
          title="Scheduled feeding"
          lines={["Completed · Today, 12:00 PM", "Nozzle 1: measured 49 g"]}
          trailing="chevron"
          onPress={countPress}
        />
        <ListRow
          divider
          icon="circle-check"
          title="Scheduled feeding"
          meta="12:00 PM"
          lines={["Nozzle 1: 50 g requested", "Nozzle 1: 49 g measured"]}
          footer={<StatusLabel kind="completed">Completed</StatusLabel>}
          trailing="chevron"
          onPress={countPress}
        />
        <ListRow
          divider
          align="center"
          icon="cpu"
          title="Feeder A"
          lines={["Paired feeder"]}
          trailing={<StatusLabel kind="online">Contact recent</StatusLabel>}
        />
      </BentoCard>

      <SectionHeader title="Key/value rows" />
      <BentoCard gap={0} style={styles.keyValueCard}>
        <KeyValue label="ID" value="…A42F9C" />
        <KeyValue divider label="Location" value="Pond 01" />
        <KeyValue
          divider
          label="Connection"
          value={<StatusLabel kind="online">Online</StatusLabel>}
        />
        <KeyValue
          divider
          stacked
          selectable
          label="Device ID"
          value="00000000-0000-4000-8000-000000a42f9c"
        />
      </BentoCard>

      <SectionHeader title="Stat tiles" />
      <View style={styles.statRow}>
        <Stat
          icon="container"
          label="Feed"
          value="72"
          unit="%"
          captions={["1440 g remaining", "shared by both nozzles"]}
          style={styles.statTile}
        >
          <ProgressBar
            value={72}
            accessibilityLabel="Feed remaining"
            accessibilityText="72 percent"
          />
        </Stat>
        <Stat
          icon="circle-check"
          label="Completed"
          value="18"
          captions={["Caption, 12/16 medium"]}
          onPress={countPress}
          style={styles.statTile}
        />
      </View>

      <SectionHeader title="Progress bar" />
      <ProgressBar
        value={72}
        accessibilityLabel="Example progress"
        accessibilityText="72 percent"
      />
      <ProgressBar
        value={15}
        accessibilityLabel="Example progress"
        accessibilityText="15 percent"
      />

      <SectionHeader title="Skeleton" />
      <Skeleton height={24} width="60%" />
      <Skeleton height={72} />

      <SectionHeader title="Card tones" />
      <BentoCard gap={Spacing.one}>
        <Text style={Typography.cardTitle}>White card</Text>
        <Text style={Typography.supporting}>Default container.</Text>
      </BentoCard>
      <BentoCard tone="muted" gap={Spacing.one}>
        <Text style={Typography.cardTitle}>Muted card</Text>
        <Text style={Typography.supporting}>Summaries and compact facts.</Text>
      </BentoCard>
      <BentoCard tone="inverse" gap={Spacing.one}>
        <Text style={[Typography.cardTitle, styles.onInk]}>Black block</Text>
        <Text style={[Typography.supporting, styles.onInkSecondary]}>
          One per screen, only for that screen’s main action.
        </Text>
        <Button
          variant="inverse"
          onPress={countPress}
          style={styles.inverseAction}
        >
          Local action
        </Button>
      </BentoCard>

      <SectionHeader title="Empty state" />
      <EmptyState
        icon="history"
        title="No feedings yet"
        description="Preview only. The action returns to the existing Device screen."
        action="Return to Device"
        href="/device"
      />
      <EmptyState
        icon="history"
        title="No button"
        description="A screen with a round add button passes action null."
        action={null}
      />

      <SectionHeader title="Error state" />
      <ErrorState
        title="Error state preview"
        description="A local error example. Retry only updates the press counter."
        retryLabel="Retry local example"
        onRetry={countPress}
      />

      <SectionHeader title="Sheet" />
      <Button variant="secondary" onPress={() => setSheetVisible(true)}>
        Open sheet
      </Button>
      <Sheet
        visible={sheetVisible}
        title="Sheet preview"
        onClose={() => setSheetVisible(false)}
        footer={
          <Button variant="secondary" onPress={() => setSheetVisible(false)}>
            Done
          </Button>
        }
      >
        <Text style={Typography.body}>
          Sheet body. Drag the handle down, tap it, tap outside, Done or the
          system back button to dismiss.
        </Text>
        <SwitchRow
          label="Local switch"
          value={switchRow}
          onValueChange={setSwitchRow}
        />
      </Sheet>
    </AppPage>
  );
}

const styles = StyleSheet.create({
  row: {
    flexDirection: "row",
    alignItems: "center",
    gap: Spacing.three,
  },
  wrap: {
    flexDirection: "row",
    flexWrap: "wrap",
    gap: Spacing.two,
  },
  keyValueCard: {
    paddingVertical: Spacing.one,
  },
  statRow: {
    flexDirection: "row",
    gap: Spacing.cardGap,
  },
  statTile: {
    flex: 1,
    minWidth: 0,
  },
  onInk: {
    color: Colors.light.onInk,
  },
  onInkSecondary: {
    color: Colors.light.onInkSecondary,
  },
  inverseAction: {
    marginTop: Spacing.cardGap,
  },
});
