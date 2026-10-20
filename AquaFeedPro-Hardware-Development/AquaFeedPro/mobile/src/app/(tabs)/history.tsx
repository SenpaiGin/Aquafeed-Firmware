import { router, useFocusEffect } from "expo-router";
import { useCallback, useRef, useState } from "react";
import { StyleSheet, Text, useWindowDimensions, View } from "react-native";

import {
  AppPage,
  BentoCard,
  Button,
  Chip,
  EmptyState,
  ErrorState,
  IconButton,
  ListRow,
  Notice,
  ScreenHeader,
  SectionHeader,
  Segmented,
  Sheet,
  Skeleton,
  Stat,
  statusIcons,
  TextField,
} from "@/components/app-shell";
import {
  feedingSummary,
  relativeDayLabel,
  statusKind,
} from "@/components/feed-status";
import { Spacing, Typography } from "@/constants/theme";
import { useDeviceAccess } from "@/lib/device-access";
import { errorText } from "@/lib/error-text";
import {
  readHistoryPage,
  type HistoryPage,
  type HistoryRecord,
} from "@/lib/manual-feed";

type Filter = {
  from: string;
  to: string;
  source: "all" | "manual" | "scheduled";
  status: "all" | "completed" | "failed" | "in_progress" | "unknown";
};

// from_date and to_date are calendar dates, so UTC midnight prints the same day everywhere.
const shortDate = (value: string) =>
  new Intl.DateTimeFormat(undefined, {
    month: "short",
    day: "numeric",
    timeZone: "UTC",
  }).format(new Date(value + "T00:00:00Z"));

export default function HistoryScreen() {
  const {
    devices,
    selectedDevice,
    selectedDeviceId,
    installationId,
    scopeRevision,
  } = useDeviceAccess();
  const [draftFilters, setDraftFilters] = useState<Filter>({
    from: "",
    to: "",
    source: "all",
    status: "all",
  });
  const [filters, setFilters] = useState<Filter>({
    from: "",
    to: "",
    source: "all",
    status: "all",
  });
  const [page, setPage] = useState<HistoryPage | null>(null);
  const [rows, setRows] = useState<HistoryRecord[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [pageScope, setPageScope] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);
  const [filterOpen, setFilterOpen] = useState(false);
  const { fontScale, width } = useWindowDimensions();
  const stackTiles = fontScale > 1.3 || width < 360;
  const run = useRef(0);
  const deviceId = selectedDeviceId;
  const scopeKey = `${installationId ?? ""}:${deviceId ?? ""}:${scopeRevision}`;
  const activePage = pageScope === scopeKey ? page : null;
  const activeError = pageScope === scopeKey ? error : null;

  const load = useCallback(
    async (cursor?: string | null, append = false) => {
      if (!deviceId || !installationId) return;
      const generation = ++run.current;
      setLoading(true);
      setError(null);
      try {
        const next = await readHistoryPage(installationId, deviceId, {
          from: filters.from || undefined,
          to: filters.to || undefined,
          source: filters.source,
          status: filters.status,
          cursor,
        });
        if (generation !== run.current || deviceId !== selectedDeviceId) return;
        setPageScope(scopeKey);
        setPage(next);
        setRows((current) =>
          append
            ? [
                ...current,
                ...next.records.filter(
                  (record) =>
                    !current.some(
                      (item) => item.sequence_id === record.sequence_id,
                    ),
                ),
              ]
            : next.records,
        );
      } catch (reason) {
        if (generation === run.current) {
          setPageScope(scopeKey);
          setError(errorText(reason, "Feeding history could not be loaded."));
        }
      } finally {
        if (generation === run.current) setLoading(false);
      }
    },
    [deviceId, filters, installationId, scopeKey, selectedDeviceId],
  );

  useFocusEffect(
    useCallback(() => {
      if (deviceId && installationId) void load(null, false);
      return () => {
        run.current += 1;
      };
    }, [deviceId, installationId, load]),
  );

  const setFilter = <K extends keyof Filter>(key: K, value: Filter[K]) => {
    setDraftFilters((current) => ({ ...current, [key]: value }));
  };

  const applyFilters = () => {
    setPage(null);
    setRows([]);
    setFilters(draftFilters);
  };

  const emptyFilter: Filter = {
    from: "",
    to: "",
    source: "all",
    status: "all",
  };
  const clearFilters = () => {
    setDraftFilters(emptyFilter);
    setPage(null);
    setRows([]);
    setFilters(emptyFilter);
  };

  const activeFilterCount =
    (filters.from ? 1 : 0) +
    (filters.to ? 1 : 0) +
    (filters.source !== "all" ? 1 : 0) +
    (filters.status !== "all" ? 1 : 0);

  // rows are newest first, so consecutive grouping is enough.
  const groups: { label: string; records: HistoryRecord[] }[] = [];
  if (activePage) {
    for (const record of rows) {
      const label = relativeDayLabel(
        new Date(record.created_at),
        activePage.timezone,
      );
      const last = groups[groups.length - 1];
      if (last && last.label === label) last.records.push(record);
      else groups.push({ label, records: [record] });
    }
  }

  const openRecord = (record: HistoryRecord) => {
    router.push({
      pathname: "/history/[runId]",
      params: {
        runId: record.sequence_id,
        device_id: selectedDevice?.deviceId ?? "",
      },
    });
  };

  return (
    <AppPage
      edges={["top", "left", "right"]}
      header={
        <ScreenHeader
          title="History"
          status={
            devices.length > 1 && selectedDevice ? (
              <Text style={Typography.supporting}>
                {selectedDevice.alias?.trim() || selectedDevice.model}
              </Text>
            ) : undefined
          }
          action={
            selectedDevice ? (
              <IconButton
                icon="sliders-horizontal"
                badge={activeFilterCount > 0}
                accessibilityLabel={
                  activeFilterCount
                    ? "Filters, " + activeFilterCount + " active"
                    : "Filters"
                }
                onPress={() => setFilterOpen(true)}
              />
            ) : undefined
          }
        />
      }
    >
      {!selectedDevice ? (
        <EmptyState
          icon="history"
          title="No feeder selected"
          description="Pair a feeder, then select it to view its history."
          action="Pair a device"
          href="/devices/add"
        />
      ) : activeError && !activePage ? (
        <ErrorState
          title="Couldn't load history"
          description={activeError}
          onRetry={() => void load(null, false)}
        />
      ) : !activePage ? (
        <View style={styles.loading}>
          <View style={styles.tiles}>
            <View style={styles.tile}>
              <Skeleton height={104} />
            </View>
            <View style={styles.tile}>
              <Skeleton height={104} />
            </View>
          </View>
          <Skeleton height={120} />
          <Skeleton height={120} />
          <Skeleton height={120} />
        </View>
      ) : (
        <>
          {activeError ? (
            <Notice
              tone="error"
              title="Couldn't load history"
              actions={
                <Button variant="text" onPress={() => void load(null, false)}>
                  Try again
                </Button>
              }
            >
              {activeError + " Records below may be outdated."}
            </Notice>
          ) : null}
          <View style={styles.stats}>
            <SectionHeader
              title={
                filters.from || filters.to
                  ? shortDate(activePage.from_date) +
                    " – " +
                    shortDate(activePage.to_date)
                  : "Last 7 days"
              }
            />
            <View style={stackTiles ? styles.stackedTiles : styles.tiles}>
              <Stat
                icon="circle-check"
                label="Completed"
                value={String(activePage.totals.completed)}
                style={stackTiles ? undefined : styles.tile}
              />
              <Stat
                icon="triangle-alert"
                label="Unsuccessful feedings"
                value={String(activePage.totals.needs_attention)}
                style={stackTiles ? undefined : styles.tile}
              />
            </View>
            {activePage.timezone_known ? null : (
              <Text style={Typography.metadata}>
                Times are in UTC because the feeder&apos;s time zone is not set.
              </Text>
            )}
          </View>
          {groups.map((group) => (
            <View key={group.label} style={styles.stats}>
              <SectionHeader title={group.label} />
              <BentoCard flush>
                {group.records.map((record, index) => (
                  <ListRow
                    key={record.sequence_id}
                    divider={index > 0}
                    icon={statusIcons[statusKind(record.status)]}
                    title={
                      record.source === "manual"
                        ? "Manual feeding"
                        : "Scheduled feeding"
                    }
                    meta={new Intl.DateTimeFormat(undefined, {
                      timeZone: activePage.timezone,
                      timeStyle: "short",
                    }).format(new Date(record.created_at))}
                    lines={[feedingSummary(record, selectedDevice.isSimulated)]}
                    trailing="chevron"
                    onPress={() => openRecord(record)}
                  />
                ))}
              </BentoCard>
            </View>
          ))}
          {rows.length === 0 ? (
            activeFilterCount === 0 ? (
              <Text style={Typography.cardTitle}>No feeding history yet</Text>
            ) : (
              <View style={styles.stats}>
                <Text style={Typography.supporting}>
                  No records match these filters.
                </Text>
                <Button variant="text" onPress={clearFilters}>
                  Clear filters
                </Button>
              </View>
            )
          ) : null}
          {activePage.next_cursor ? (
            <Button
              variant="secondary"
              onPress={() => void load(activePage.next_cursor, true)}
              loading={loading}
            >
              Load more
            </Button>
          ) : null}
        </>
      )}
      <Sheet
        visible={filterOpen}
        title="Filters"
        onClose={() => setFilterOpen(false)}
        footer={
          <>
            <Button
              loading={loading}
              onPress={() => {
                applyFilters();
                setFilterOpen(false);
              }}
            >
              Apply filters
            </Button>
            <Button
              variant="text"
              onPress={() => {
                clearFilters();
                setFilterOpen(false);
              }}
            >
              Clear filters
            </Button>
          </>
        }
      >
        <TextField
          label="From date"
          placeholder="YYYY-MM-DD"
          value={draftFilters.from}
          onChangeText={(value) => setFilter("from", value)}
          autoCapitalize="none"
        />
        <TextField
          label="To date"
          placeholder="YYYY-MM-DD"
          value={draftFilters.to}
          onChangeText={(value) => setFilter("to", value)}
          autoCapitalize="none"
        />
        <SectionHeader title="Source" />
        <Segmented
          accessibilityLabel="Source"
          value={draftFilters.source}
          onChange={(value) => setFilter("source", value)}
          options={[
            { value: "all", label: "All" },
            { value: "manual", label: "Manual" },
            { value: "scheduled", label: "Scheduled" },
          ]}
        />
        <SectionHeader title="Status" />
        <View style={styles.chips}>
          {(
            [
              ["all", "All"],
              ["completed", "Completed"],
              ["failed", "Failed"],
              ["in_progress", "In progress"],
              ["unknown", "Partial / unknown"],
            ] as const
          ).map(([value, label]) => (
            <Chip
              key={value}
              role="radio"
              label={label}
              selected={draftFilters.status === value}
              onPress={() => setFilter("status", value)}
            />
          ))}
        </View>
      </Sheet>
    </AppPage>
  );
}

const styles = StyleSheet.create({
  stats: { gap: Spacing.two },
  tiles: { flexDirection: "row", gap: Spacing.cardGap },
  stackedTiles: { gap: Spacing.cardGap },
  tile: { flex: 1, minWidth: 0 },
  loading: { gap: Spacing.cardGap },
  chips: { flexDirection: "row", flexWrap: "wrap", gap: Spacing.two },
});
