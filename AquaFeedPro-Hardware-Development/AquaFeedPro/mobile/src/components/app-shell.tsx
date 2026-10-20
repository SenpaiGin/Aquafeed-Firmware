import { router, type Href } from "expo-router";
import type { ReactNode } from "react";
import { Image, ScrollView, StyleSheet, Text, View } from "react-native";
import { SafeAreaView, type Edge } from "react-native-safe-area-context";

import { IconButton } from "./bento-kit";

import {
  Colors,
  ControlSize,
  IconSize,
  MaxContentWidth,
  Spacing,
  Typography,
} from "@/constants/theme";

export {
  BentoCard,
  Button,
  Chip,
  DropdownPill,
  EmptyState,
  ErrorState,
  Fab,
  IconButton,
  KeyValue,
  LinkButton,
  ListRow,
  Notice,
  ProgressBar,
  SectionHeader,
  Segmented,
  Sheet,
  Skeleton,
  Stat,
  StatusIcon,
  StatusLabel,
  statusIcons,
  SwitchRow,
  TextField,
  Toggle,
} from "./bento-kit";

export function AppIcon({
  size,
  decorative = false,
}: {
  size: number;
  decorative?: boolean;
}) {
  return (
    <Image
      // shortcut: ships the full-size source PNG; resize to 288 px if bundle size matters.
      source={require("@/assets/images/aquafeed-app-icon.png")}
      accessible={!decorative}
      accessibilityRole={decorative ? undefined : "image"}
      accessibilityLabel={decorative ? undefined : "AquaFeed Pro"}
      style={{
        width: size,
        height: size,
        borderRadius: Math.round(size * 0.22),
      }}
    />
  );
}

export function AppPage({
  children,
  edges = ["top", "left", "right", "bottom"],
  gap = Spacing.four,
  floating,
  header,
}: {
  children: React.ReactNode;
  edges?: Edge[];
  gap?: number;
  floating?: ReactNode;
  header?: ReactNode;
}) {
  return (
    <SafeAreaView edges={edges} style={styles.safeArea}>
      {header ? (
        <View style={styles.headerBar}>
          <View style={styles.headerInner}>{header}</View>
        </View>
      ) : null}
      <ScrollView
        style={styles.scroll}
        contentContainerStyle={[
          styles.scrollContent,
          floating ? styles.scrollContentFloating : null,
        ]}
        keyboardShouldPersistTaps="handled"
      >
        <View style={[styles.page, { gap }]}>{children}</View>
      </ScrollView>
      {floating ? (
        <View style={styles.floatingLayer}>
          <View style={styles.floatingSlot}>{floating}</View>
        </View>
      ) : null}
    </SafeAreaView>
  );
}

export function ScreenHeader({
  title,
  action,
  back,
  status,
}: {
  title: string;
  action?: ReactNode;
  back?: { label: string; fallback: Href; icon?: "arrow-left" | "x" };
  status?: ReactNode;
}) {
  if (!back) {
    return (
      <View>
        <View style={styles.tabHeader}>
          <Text accessibilityRole="header" style={styles.tabHeaderTitle}>
            {title}
          </Text>
          <View style={styles.headerAction}>
            {action}
            <AppIcon size={32} />
          </View>
        </View>
        {status ? <View style={styles.tabHeaderStatus}>{status}</View> : null}
      </View>
    );
  }
  return (
    <View style={styles.stackHeader}>
      <IconButton
        icon={back.icon ?? "arrow-left"}
        size={IconSize.nav}
        accessibilityLabel={back.label}
        onPress={() =>
          router.canGoBack() ? router.back() : router.replace(back.fallback)
        }
      />
      <Text accessibilityRole="header" style={styles.stackHeaderTitle}>
        {title}
      </Text>
      {action}
    </View>
  );
}

const styles = StyleSheet.create({
  safeArea: { flex: 1, backgroundColor: Colors.light.background },
  // Same 64 px, surface and 1 px border as the tab bar footer.
  headerBar: {
    minHeight: 64,
    justifyContent: "center",
    alignItems: "center",
    paddingHorizontal: Spacing.page,
    paddingVertical: Spacing.two,
    backgroundColor: Colors.light.surface,
    borderBottomWidth: 1,
    borderBottomColor: Colors.light.border,
  },
  headerInner: { width: "100%", maxWidth: MaxContentWidth },
  scroll: { flex: 1 },
  scrollContent: {
    flexGrow: 1,
    alignItems: "center",
    paddingHorizontal: Spacing.page,
    paddingVertical: Spacing.four,
  },
  // Lets the last row scroll clear of the 56 px button and its 16 px margin.
  scrollContentFloating: { paddingBottom: Spacing.four + 56 + Spacing.three },
  floatingLayer: {
    position: "absolute",
    left: 0,
    right: 0,
    bottom: Spacing.three,
    paddingHorizontal: Spacing.page,
    alignItems: "center",
    pointerEvents: "box-none",
  },
  floatingSlot: {
    width: "100%",
    maxWidth: MaxContentWidth,
    alignItems: "flex-end",
    pointerEvents: "box-none",
  },
  page: { width: "100%", maxWidth: MaxContentWidth },
  tabHeader: {
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "space-between",
    gap: 12,
    minHeight: ControlSize.minimumTarget,
  },
  tabHeaderTitle: { ...Typography.pageTitle, flexShrink: 1 },
  headerAction: {
    flexShrink: 0,
    flexDirection: "row",
    alignItems: "center",
    gap: Spacing.one,
  },
  tabHeaderStatus: {
    flexDirection: "row",
    flexWrap: "wrap",
    alignItems: "center",
    gap: Spacing.two,
  },
  stackHeader: {
    flexDirection: "row",
    alignItems: "center",
    gap: Spacing.one,
    minHeight: ControlSize.minimumTarget,
    marginLeft: -12,
  },
  stackHeaderTitle: { ...Typography.title, flex: 1 },
});
