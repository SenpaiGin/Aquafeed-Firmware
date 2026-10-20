/** Mono Ink design tokens shared by app screens and reusable components. */

import type { TextStyle } from "react-native";

const monoInk = {
  background: "#FAFAFA",
  surface: "#FFFFFF",
  surfaceMuted: "#F4F4F5",
  ink: "#18181B",
  primary: "#18181B",
  text: "#18181B",
  textSecondary: "#52525B",
  textTertiary: "#71717A",
  border: "#E4E4E7",
  controlBorder: "#8A8A93",
  onInk: "#FAFAFA",
  onInkSecondary: "#A1A1AA",
  progressTrack: "#E4E4E7",
  chartLine: "#18181B",
  chartGrid: "#E4E4E7",
  disabledBackground: "#E4E4E7",
  disabledText: "#71717A",
  inverseDisabledBackground: "#52525B",
  scrim: "rgba(24, 24, 27, 0.4)",
  rippleOnInk: "rgba(250, 250, 250, 0.16)",
  rippleOnSurface: "rgba(24, 24, 27, 0.12)",
} as const;

// DESIGN.md defines one Mono Ink palette; a dark palette needs separate approval.
export const Colors = { light: monoInk } as const;

export const InterFamilies = {
  regular: "Inter_400Regular",
  medium: "Inter_500Medium",
  semibold: "Inter_600SemiBold",
  bold: "Inter_700Bold",
} as const;

export const Typography = {
  display: {
    fontFamily: InterFamilies.semibold,
    fontSize: 56,
    lineHeight: 60,
    letterSpacing: -1,
    fontVariant: ["tabular-nums"],
    color: monoInk.ink,
  },
  pageTitle: {
    fontFamily: InterFamilies.semibold,
    fontSize: 28,
    lineHeight: 34,
    color: monoInk.ink,
  },
  reading: {
    fontFamily: InterFamilies.semibold,
    fontSize: 32,
    lineHeight: 40,
    fontVariant: ["tabular-nums"],
    color: monoInk.ink,
  },
  title: {
    fontFamily: InterFamilies.semibold,
    fontSize: 20,
    lineHeight: 28,
    fontVariant: ["tabular-nums"],
    color: monoInk.ink,
  },
  cardTitle: {
    fontFamily: InterFamilies.semibold,
    fontSize: 16,
    lineHeight: 24,
    color: monoInk.ink,
  },
  listTitle: {
    fontFamily: InterFamilies.medium,
    fontSize: 16,
    lineHeight: 24,
    color: monoInk.ink,
  },
  body: {
    fontFamily: InterFamilies.regular,
    fontSize: 16,
    lineHeight: 24,
    color: monoInk.ink,
  },
  unit: {
    fontFamily: InterFamilies.medium,
    fontSize: 16,
    lineHeight: 24,
    color: monoInk.textSecondary,
  },
  button: {
    fontFamily: InterFamilies.semibold,
    fontSize: 15,
    lineHeight: 20,
  },
  label: {
    fontFamily: InterFamilies.medium,
    fontSize: 14,
    lineHeight: 20,
    color: monoInk.ink,
  },
  supporting: {
    fontFamily: InterFamilies.regular,
    fontSize: 14,
    lineHeight: 20,
    color: monoInk.textSecondary,
  },
  metadata: {
    fontFamily: InterFamilies.medium,
    fontSize: 12,
    lineHeight: 16,
    fontVariant: ["tabular-nums"],
    color: monoInk.textTertiary,
  },
  overline: {
    fontFamily: InterFamilies.semibold,
    fontSize: 12,
    lineHeight: 16,
    letterSpacing: 0.8,
    textTransform: "uppercase",
    color: monoInk.textTertiary,
  },
  pill: {
    fontFamily: InterFamilies.semibold,
    fontSize: 12,
    lineHeight: 16,
    color: monoInk.ink,
  },
} satisfies Record<string, TextStyle>;

export const Spacing = {
  half: 2,
  one: 4,
  two: 8,
  three: 16,
  four: 24,
  five: 32,
  six: 64,
  page: 20,
  cardGap: 12,
  card: 16,
} as const;

export const Radii = {
  card: 16,
  control: 12,
  segment: 8,
  pill: 999,
  bottomSheetTop: 24,
} as const;

export const ControlSize = {
  minimumTarget: 48,
  compact: 40,
  iconWell: 40,
  pill: 28,
} as const;

export const IconSize = { nav: 24, default: 20, small: 16 } as const;

export const MaxContentWidth = 760;
