import { Lucide, type LucideIconName } from "@react-native-vector-icons/lucide";
import { Link, type Href } from "expo-router";
import { useEffect, useId, useRef, useState, type ReactNode } from "react";
import {
  ActivityIndicator,
  Animated,
  Modal,
  PanResponder,
  Platform,
  Pressable,
  ScrollView,
  StyleSheet,
  Text,
  TextInput,
  useWindowDimensions,
  View,
  type DimensionValue,
  type StyleProp,
  type TextInputProps,
  type ViewStyle,
} from "react-native";
import { useSafeAreaInsets } from "react-native-safe-area-context";

import { resolveButtonState } from "./button-state";

import {
  Colors,
  ControlSize,
  IconSize,
  InterFamilies,
  Radii,
  Spacing,
  Typography,
} from "@/constants/theme";

type BentoCardProps = {
  children: ReactNode;
  tone?: "default" | "muted" | "inverse";
  gap?: number;
  flush?: boolean;
  style?: StyleProp<ViewStyle>;
};

export function BentoCard({
  children,
  tone = "default",
  gap = Spacing.cardGap,
  flush = false,
  style,
}: BentoCardProps) {
  return (
    <View
      style={[
        styles.card,
        cardTones[tone],
        { gap },
        flush && styles.cardFlush,
        style,
      ]}
    >
      {children}
    </View>
  );
}

export type ButtonVariant = "primary" | "secondary" | "text" | "inverse";

type ButtonSize = "default" | "compact";

type ButtonProps = {
  children: string;
  variant?: ButtonVariant;
  size?: ButtonSize;
  icon?: LucideIconName;
  onPress?: () => void;
  disabled?: boolean;
  loading?: boolean;
  accessibilityHint?: string;
  style?: StyleProp<ViewStyle>;
};

export function Button({
  children,
  variant = "primary",
  size = "default",
  icon,
  onPress,
  disabled = false,
  loading = false,
  accessibilityHint,
  style,
}: ButtonProps) {
  const [focused, setFocused] = useState(false);
  const state = resolveButtonState({
    disabled,
    loading,
    hasAction: onPress !== undefined,
  });
  // A loading button keeps its normal colours; only a button that cannot act looks disabled.
  const visuallyDisabled = disabled || onPress === undefined;
  const labelColor =
    buttonLabelColors[variant][visuallyDisabled ? "disabled" : "enabled"];

  return (
    <Pressable
      accessibilityRole="button"
      accessibilityHint={accessibilityHint}
      accessibilityState={state.accessibilityState}
      disabled={state.disabled}
      onPress={onPress}
      onFocus={() => setFocused(true)}
      onBlur={() => setFocused(false)}
      hitSlop={size === "compact" ? compactHitSlop : undefined}
      android_ripple={{
        color:
          variant === "primary"
            ? Colors.light.rippleOnInk
            : Colors.light.rippleOnSurface,
      }}
      style={({ pressed }) => [
        styles.button,
        buttonVariants[variant],
        size === "compact" && styles.buttonCompact,
        visuallyDisabled && buttonDisabledVariants[variant],
        focused && styles.buttonFocused,
        pressed && !state.disabled && styles.buttonPressed,
        style,
      ]}
    >
      {loading ? (
        <View
          accessibilityElementsHidden
          importantForAccessibility="no-hide-descendants"
        >
          <ActivityIndicator size="small" color={labelColor} />
        </View>
      ) : icon ? (
        <DecorativeIcon
          name={icon}
          color={labelColor}
          size={IconSize.default}
        />
      ) : null}
      <Text style={[styles.buttonText, { color: labelColor }]}>{children}</Text>
    </Pressable>
  );
}

type LinkButtonProps = {
  href: Href;
  children: string;
  variant?: ButtonVariant;
  size?: ButtonSize;
  icon?: LucideIconName;
  accessibilityHint?: string;
};

export function LinkButton({
  href,
  children,
  variant = "primary",
  size = "default",
  icon,
  accessibilityHint,
}: LinkButtonProps) {
  const [focused, setFocused] = useState(false);
  const linkStyle = StyleSheet.flatten([
    styles.button,
    buttonVariants[variant],
    size === "compact" && styles.buttonCompact,
    focused && styles.buttonFocused,
  ]);
  const labelColor = buttonLabelColors[variant].enabled;

  return (
    <Link href={href} asChild style={linkStyle}>
      <Pressable
        accessibilityRole="button"
        accessibilityHint={accessibilityHint}
        onFocus={() => setFocused(true)}
        onBlur={() => setFocused(false)}
        hitSlop={size === "compact" ? compactHitSlop : undefined}
        android_ripple={{
          color:
            variant === "primary"
              ? Colors.light.rippleOnInk
              : Colors.light.rippleOnSurface,
        }}
      >
        {icon ? (
          <DecorativeIcon
            name={icon}
            color={labelColor}
            size={IconSize.default}
          />
        ) : null}
        <Text style={[styles.buttonText, { color: labelColor }]}>
          {children}
        </Text>
      </Pressable>
    </Link>
  );
}

export function EmptyState({
  icon,
  title,
  description,
  action = "Add device",
  href = "/devices/add",
}: {
  icon: LucideIconName;
  title: string;
  description: string;
  action?: string | null;
  href?: Href;
}) {
  return (
    <BentoCard gap={0} style={styles.emptyState}>
      <View
        style={styles.emptyIcon}
        accessibilityElementsHidden
        importantForAccessibility="no-hide-descendants"
      >
        <Lucide name={icon} size={24} color={Colors.light.ink} />
      </View>
      <Text style={[Typography.title, styles.emptyTitle]}>{title}</Text>
      <Text style={[Typography.supporting, styles.emptyDescription]}>
        {description}
      </Text>
      {action === null ? null : (
        <View style={styles.emptyAction}>
          <LinkButton href={href} icon="plus">
            {action}
          </LinkButton>
        </View>
      )}
    </BentoCard>
  );
}

export function ErrorState({
  title,
  description,
  retryLabel = "Try again",
  onRetry,
}: {
  title: string;
  description: string;
  retryLabel?: string;
  onRetry: () => void;
}) {
  return (
    <BentoCard gap={0} style={styles.emptyState}>
      <View
        style={styles.emptyIcon}
        accessibilityElementsHidden
        importantForAccessibility="no-hide-descendants"
      >
        <Lucide name="triangle-alert" size={24} color={Colors.light.ink} />
      </View>
      <Text
        accessibilityRole="alert"
        style={[Typography.title, styles.emptyTitle]}
      >
        {title}
      </Text>
      <Text style={[Typography.supporting, styles.emptyDescription]}>
        {description}
      </Text>
      <View style={styles.emptyAction}>
        <Button variant="secondary" icon="rotate-ccw" onPress={onRetry}>
          {retryLabel}
        </Button>
      </View>
    </BentoCard>
  );
}

export type StatusKind =
  | "completed"
  | "pending"
  | "running"
  | "warning"
  | "failed"
  | "online"
  | "offline"
  | "outdated"
  | "unknown"
  | "enabled"
  | "paused"
  | "selected"
  | "simulator";

export const statusIcons: Record<StatusKind, LucideIconName> = {
  completed: "circle-check",
  pending: "clock",
  running: "loader",
  warning: "triangle-alert",
  failed: "circle-x",
  online: "wifi",
  offline: "wifi-off",
  outdated: "clock",
  unknown: "circle-help",
  enabled: "circle-play",
  paused: "circle-pause",
  selected: "check",
  simulator: "flask-conical",
};

export function StatusLabel({
  kind,
  children,
}: {
  kind: StatusKind;
  children: string;
}) {
  return (
    <View style={styles.statusLabel}>
      <DecorativeIcon
        name={statusIcons[kind]}
        color={Colors.light.ink}
        size={IconSize.small}
      />
      <Text style={styles.statusText}>{children}</Text>
    </View>
  );
}

export function StatusIcon({
  kind,
  accessibilityLabel,
}: {
  kind: StatusKind;
  accessibilityLabel: string;
}) {
  return (
    <View
      accessible
      accessibilityRole="image"
      accessibilityLabel={accessibilityLabel}
      style={styles.statusIcon}
    >
      <Lucide
        name={statusIcons[kind]}
        size={IconSize.default}
        color={Colors.light.ink}
      />
    </View>
  );
}

type TextFieldProps = Omit<
  TextInputProps,
  | "accessibilityHint"
  | "accessibilityLabel"
  | "accessibilityLabelledBy"
  | "accessibilityState"
  | "editable"
> & {
  label: string;
  hint?: string;
  error?: string;
  suffix?: string;
  disabled?: boolean;
};

export function TextField({
  label,
  hint,
  error,
  suffix,
  disabled = false,
  style,
  onFocus,
  onBlur,
  ...inputProps
}: TextFieldProps) {
  const [focused, setFocused] = useState(false);
  const id = useId();
  const handleFocus: NonNullable<TextInputProps["onFocus"]> = (event) => {
    setFocused(true);
    onFocus?.(event);
  };
  const handleBlur: NonNullable<TextInputProps["onBlur"]> = (event) => {
    setFocused(false);
    onBlur?.(event);
  };

  return (
    <View style={styles.field}>
      <Text
        nativeID={id}
        style={[styles.fieldLabel, disabled && styles.fieldLabelDisabled]}
      >
        {label}
      </Text>
      <View
        style={[
          styles.inputBox,
          (focused || error) && styles.inputBoxStrong,
          disabled && styles.inputBoxDisabled,
        ]}
      >
        <TextInput
          {...inputProps}
          accessibilityLabel={
            Platform.OS === "android"
              ? undefined
              : error
                ? label + ". Error: " + error
                : label
          }
          accessibilityLabelledBy={
            Platform.OS === "android"
              ? error
                ? [id, id + "-error"]
                : id
              : undefined
          }
          accessibilityHint={hint}
          accessibilityState={{ disabled }}
          editable={!disabled}
          onFocus={handleFocus}
          onBlur={handleBlur}
          placeholderTextColor={Colors.light.textTertiary}
          selectionColor={Colors.light.ink}
          style={[styles.input, disabled && styles.inputDisabled, style]}
        />
        {suffix ? <Text style={styles.inputSuffix}>{suffix}</Text> : null}
      </View>
      {hint ? (
        <Text style={[styles.fieldHint, disabled && styles.fieldHintDisabled]}>
          {hint}
        </Text>
      ) : null}
      {error ? (
        <View style={styles.fieldError}>
          <View style={styles.fieldErrorIcon}>
            <DecorativeIcon
              name="circle-x"
              color={Colors.light.ink}
              size={IconSize.small}
            />
          </View>
          <Text
            nativeID={id + "-error"}
            accessibilityLabel={"Error: " + error}
            style={styles.fieldErrorText}
          >
            {error}
          </Text>
        </View>
      ) : null}
    </View>
  );
}

export function IconButton({
  icon,
  accessibilityLabel,
  onPress,
  disabled = false,
  size = IconSize.default,
  radius = Radii.control,
  color = Colors.light.ink,
  badge = false,
}: {
  icon: LucideIconName;
  accessibilityLabel: string;
  onPress?: () => void;
  disabled?: boolean;
  size?: number;
  radius?: number;
  color?: string;
  badge?: boolean;
}) {
  return (
    <Pressable
      accessibilityRole="button"
      accessibilityLabel={accessibilityLabel}
      accessibilityState={{ disabled }}
      disabled={disabled}
      onPress={onPress}
      android_ripple={ripple}
      style={({ pressed }) => [
        styles.iconButton,
        { borderRadius: radius },
        disabled && styles.disabled,
        pressed && styles.buttonPressed,
      ]}
    >
      <DecorativeIcon name={icon} color={color} size={size} />
      {badge ? <View style={styles.iconButtonBadge} /> : null}
    </Pressable>
  );
}

export function Fab({
  icon,
  accessibilityLabel,
  accessibilityHint,
  onPress,
  disabled = false,
}: {
  icon: LucideIconName;
  accessibilityLabel: string;
  accessibilityHint?: string;
  onPress: () => void;
  disabled?: boolean;
}) {
  return (
    <Pressable
      accessibilityRole="button"
      accessibilityLabel={accessibilityLabel}
      accessibilityHint={accessibilityHint}
      accessibilityState={{ disabled }}
      disabled={disabled}
      onPress={onPress}
      android_ripple={{ color: Colors.light.rippleOnInk }}
      style={({ pressed }) => [
        styles.fab,
        disabled && styles.fabDisabled,
        pressed && !disabled && styles.buttonPressed,
      ]}
    >
      <DecorativeIcon
        name={icon}
        color={disabled ? Colors.light.disabledText : Colors.light.onInk}
        size={IconSize.nav}
      />
    </Pressable>
  );
}

export function DropdownPill({
  value,
  accessibilityLabel,
  onPress,
}: {
  value: string;
  accessibilityLabel: string;
  onPress: () => void;
}) {
  return (
    <Pressable
      accessibilityRole="button"
      accessibilityLabel={accessibilityLabel}
      onPress={onPress}
      hitSlop={10}
      android_ripple={ripple}
      style={({ pressed }) => [
        styles.dropdownPill,
        pressed && styles.buttonPressed,
      ]}
    >
      <Text style={Typography.pill}>{value}</Text>
      <DecorativeIcon
        name="chevron-down"
        color={Colors.light.ink}
        size={IconSize.small}
      />
    </Pressable>
  );
}

export function Segmented<T extends string>({
  options,
  value,
  onChange,
  accessibilityLabel,
}: {
  options: readonly { value: T; label: string; disabled?: boolean }[];
  value: T;
  onChange: (value: T) => void;
  accessibilityLabel: string;
}) {
  return (
    <View
      accessibilityRole="radiogroup"
      accessibilityLabel={accessibilityLabel}
      style={styles.segmentedTrack}
    >
      {options.map((option) => {
        const checked = option.value === value;
        const disabled = option.disabled === true;
        return (
          <Pressable
            key={option.value}
            accessibilityRole="radio"
            accessibilityState={{ checked, disabled }}
            disabled={disabled}
            onPress={() => onChange(option.value)}
            hitSlop={compactHitSlop}
            android_ripple={ripple}
            style={({ pressed }) => [
              styles.segment,
              checked && styles.segmentSelected,
              pressed && styles.buttonPressed,
            ]}
          >
            <Text
              style={[
                styles.segmentLabel,
                checked && styles.onInkText,
                disabled && styles.segmentLabelDisabled,
              ]}
            >
              {option.label}
            </Text>
          </Pressable>
        );
      })}
    </View>
  );
}

export function Chip({
  label,
  selected,
  onPress,
  role = "checkbox",
  accessibilityLabel,
  compact = false,
}: {
  label: string;
  selected: boolean;
  onPress: () => void;
  role?: "radio" | "checkbox";
  accessibilityLabel?: string;
  /** A 40 px circle for a one-letter label; selection is shown by fill only. */
  compact?: boolean;
}) {
  return (
    <Pressable
      accessibilityRole={role}
      accessibilityLabel={accessibilityLabel}
      accessibilityState={{ checked: selected }}
      onPress={onPress}
      hitSlop={compact ? 4 : compactHitSlop}
      android_ripple={ripple}
      style={({ pressed }) => [
        styles.chip,
        selected && styles.chipSelected,
        compact && styles.chipCompact,
        pressed && styles.buttonPressed,
      ]}
    >
      {selected && !compact ? (
        <DecorativeIcon
          name="check"
          color={Colors.light.onInk}
          size={IconSize.small}
        />
      ) : null}
      <Text style={[styles.chipLabel, selected && styles.onInkText]}>
        {label}
      </Text>
    </Pressable>
  );
}

type ToggleProps = {
  value: boolean;
  onValueChange: (next: boolean) => void;
  accessibilityLabel: string;
  disabled?: boolean;
};

export function Toggle({
  value,
  onValueChange,
  accessibilityLabel,
  disabled = false,
}: ToggleProps) {
  return (
    <Pressable
      accessibilityRole="switch"
      accessibilityLabel={accessibilityLabel}
      accessibilityState={{ checked: value, disabled }}
      disabled={disabled}
      onPress={() => onValueChange(!value)}
      style={[styles.toggle, disabled && styles.disabled]}
    >
      <View style={[styles.toggleTrack, value && styles.toggleTrackOn]}>
        <View style={styles.toggleThumb} />
      </View>
    </Pressable>
  );
}

export function SwitchRow({
  label,
  description,
  value,
  onValueChange,
  disabled,
}: Omit<ToggleProps, "accessibilityLabel"> & {
  label: string;
  description?: string;
}) {
  return (
    <View style={styles.switchRow}>
      <View style={styles.textColumn}>
        <Text style={Typography.listTitle}>{label}</Text>
        {description ? (
          <Text style={Typography.supporting}>{description}</Text>
        ) : null}
      </View>
      <Toggle
        value={value}
        onValueChange={onValueChange}
        accessibilityLabel={label}
        disabled={disabled}
      />
    </View>
  );
}

type NoticeTone = "info" | "pending" | "warning" | "error";

const noticeIcons: Record<NoticeTone, LucideIconName> = {
  info: "info",
  pending: "clock",
  warning: "triangle-alert",
  error: "circle-x",
};

export function Notice({
  tone,
  title,
  children,
  actions,
}: {
  tone: NoticeTone;
  title?: string;
  children: string;
  actions?: ReactNode;
}) {
  const strong = tone === "warning" || tone === "error";
  return (
    <View
      accessibilityRole={strong ? "alert" : undefined}
      style={styles.notice}
    >
      {/* Centres the 20 px icon on the 24 px title line. */}
      <View style={title ? styles.noticeIconTitled : undefined}>
        <DecorativeIcon
          name={noticeIcons[tone]}
          color={strong ? Colors.light.ink : Colors.light.textSecondary}
          size={IconSize.default}
        />
      </View>
      <View style={styles.noticeText}>
        {title ? <Text style={Typography.cardTitle}>{title}</Text> : null}
        <Text style={strong ? styles.noticeBodyStrong : styles.noticeBody}>
          {children}
        </Text>
        {actions ? <View style={styles.noticeActions}>{actions}</View> : null}
      </View>
    </View>
  );
}

type ListRowProps = {
  icon?: LucideIconName;
  title: string;
  meta?: string;
  lines?: (string | null | undefined | false)[];
  footer?: ReactNode;
  trailing?: "chevron" | ReactNode;
  align?: "start" | "center";
  divider?: boolean;
  onPress?: () => void;
  disabled?: boolean;
  accessibilityLabel?: string;
  accessibilityHint?: string;
};

export function ListRow({
  icon,
  title,
  meta,
  lines,
  footer,
  trailing,
  align = "start",
  divider = false,
  onPress,
  disabled = false,
  accessibilityLabel,
  accessibilityHint,
}: ListRowProps) {
  const rowStyle = [
    styles.listRow,
    align === "center" && styles.listRowCentered,
    divider && styles.divider,
    disabled && styles.disabled,
  ];
  const content = (
    <>
      {icon ? (
        <View style={styles.iconWell}>
          <DecorativeIcon
            name={icon}
            color={Colors.light.ink}
            size={IconSize.default}
          />
        </View>
      ) : null}
      <View style={styles.textColumn}>
        <View style={styles.listTitleRow}>
          <Text style={styles.listRowTitle}>{title}</Text>
          {meta ? <Text style={styles.listMeta}>{meta}</Text> : null}
        </View>
        {lines?.map((line, index) =>
          line ? (
            <Text key={index} style={Typography.supporting}>
              {line}
            </Text>
          ) : null,
        )}
        {footer ? <View style={styles.listFooter}>{footer}</View> : null}
      </View>
      {trailing === "chevron" ? (
        <View style={styles.selfCentered}>
          <DecorativeIcon
            name="chevron-right"
            color={Colors.light.textTertiary}
            size={IconSize.default}
          />
        </View>
      ) : (
        trailing
      )}
    </>
  );

  if (!onPress) {
    return (
      <View accessibilityLabel={accessibilityLabel} style={rowStyle}>
        {content}
      </View>
    );
  }
  return (
    <Pressable
      accessibilityRole="button"
      accessibilityLabel={accessibilityLabel}
      accessibilityHint={accessibilityHint}
      accessibilityState={{ disabled }}
      disabled={disabled}
      onPress={onPress}
      android_ripple={ripple}
      style={({ pressed }) => [rowStyle, pressed && styles.buttonPressed]}
    >
      {content}
    </Pressable>
  );
}

export function KeyValue({
  label,
  value,
  divider = false,
  stacked = false,
  selectable,
}: {
  label: string;
  value: string | ReactNode;
  divider?: boolean;
  stacked?: boolean;
  selectable?: boolean;
}) {
  const text = typeof value === "string";
  return (
    <View
      accessible={text}
      accessibilityLabel={text ? label + ", " + value : undefined}
      style={[
        styles.keyValue,
        !text && styles.keyValueNode,
        stacked && styles.keyValueStacked,
        divider && styles.divider,
      ]}
    >
      <Text style={Typography.supporting}>{label}</Text>
      {text ? (
        <Text
          selectable={selectable}
          style={[styles.keyValueText, stacked && styles.keyValueTextStacked]}
        >
          {value}
        </Text>
      ) : (
        value
      )}
    </View>
  );
}

export function SectionHeader({
  title,
  action,
}: {
  title: string;
  action?: { label: string; onPress: () => void };
}) {
  return (
    <View style={styles.sectionHeader}>
      <Text accessibilityRole="header" style={Typography.overline}>
        {title}
      </Text>
      {action ? (
        <Pressable
          accessibilityRole="button"
          onPress={action.onPress}
          android_ripple={ripple}
          style={({ pressed }) => [
            styles.sectionAction,
            pressed && styles.buttonPressed,
          ]}
        >
          <Text style={styles.sectionActionLabel}>{action.label}</Text>
        </Pressable>
      ) : null}
    </View>
  );
}

export function Stat({
  icon,
  label,
  value,
  unit,
  captions,
  children,
  onPress,
  accessibilityLabel,
  style,
}: {
  icon: LucideIconName;
  label: string;
  value: string;
  unit?: string;
  captions?: (string | null | undefined | false)[];
  children?: ReactNode;
  onPress?: () => void;
  accessibilityLabel?: string;
  style?: StyleProp<ViewStyle>;
}) {
  const content = (
    <>
      <View style={styles.statHeader}>
        <DecorativeIcon
          name={icon}
          color={Colors.light.textTertiary}
          size={IconSize.default}
        />
        <Text style={styles.statLabel}>{label}</Text>
      </View>
      <View style={styles.statValueRow}>
        <Text style={Typography.reading}>{value}</Text>
        {unit ? <Text style={Typography.unit}>{unit}</Text> : null}
      </View>
      {children ? <View style={styles.statSection}>{children}</View> : null}
      {captions
        ?.filter((caption) => Boolean(caption))
        .map((caption, index) => (
          <Text
            key={index}
            style={[
              Typography.metadata,
              index === 0 ? styles.statSection : styles.statCaptionNext,
            ]}
          >
            {caption}
          </Text>
        ))}
    </>
  );

  if (!onPress) {
    return (
      <View
        accessibilityLabel={accessibilityLabel}
        style={[styles.stat, style]}
      >
        {content}
      </View>
    );
  }
  return (
    <Pressable
      accessibilityRole="link"
      accessibilityLabel={accessibilityLabel}
      onPress={onPress}
      android_ripple={ripple}
      style={({ pressed }) => [
        styles.stat,
        style,
        pressed && styles.buttonPressed,
      ]}
    >
      {content}
    </Pressable>
  );
}

export function ProgressBar({
  value,
  accessibilityLabel,
  accessibilityText,
}: {
  value: number;
  accessibilityLabel: string;
  accessibilityText: string;
}) {
  return (
    <View
      accessible
      accessibilityRole="progressbar"
      accessibilityLabel={accessibilityLabel}
      accessibilityValue={{
        min: 0,
        max: 100,
        now: value,
        text: accessibilityText,
      }}
      style={styles.progressTrack}
    >
      <View style={[styles.progressFill, { width: `${value}%` }]} />
    </View>
  );
}

export function Skeleton({
  height,
  width = "100%",
}: {
  height: number;
  width?: DimensionValue;
}) {
  return (
    <View
      accessibilityElementsHidden
      importantForAccessibility="no-hide-descendants"
      style={[styles.skeleton, { height, width }]}
    />
  );
}

export function Sheet({
  visible,
  title,
  onClose,
  children,
  footer,
  bodyMaxHeight,
}: {
  visible: boolean;
  title: string;
  onClose: () => void;
  children: ReactNode;
  footer?: ReactNode;
  /** Caps the height of the content; the body scrolls beyond it. */
  bodyMaxHeight?: number;
}) {
  const insets = useSafeAreaInsets();
  const { height } = useWindowDimensions();
  const paddingTop = Math.max(16, insets.top + 8);
  const bodyPaddingBottom = footer ? 16 : 24 + insets.bottom;

  const [translateY] = useState(() => new Animated.Value(0));
  const onCloseRef = useRef(onClose);
  useEffect(() => {
    onCloseRef.current = onClose;
  });
  useEffect(() => {
    if (visible) translateY.setValue(0);
  }, [visible, translateY]);
  // Created once: replacing the responder during a drag would drop the gesture.
  /* eslint-disable react-hooks/refs -- onCloseRef is read only when a drag is released, never during render. */
  const [pan] = useState(() => {
    const springBack = () =>
      Animated.spring(translateY, {
        toValue: 0,
        useNativeDriver: Platform.OS !== "web",
      }).start();
    return PanResponder.create({
      onMoveShouldSetPanResponder: (_, { dx, dy }) =>
        dy > 6 && dy > Math.abs(dx),
      onPanResponderMove: (_, { dy }) => translateY.setValue(Math.max(0, dy)),
      onPanResponderRelease: (_, { dy, vy }) => {
        if (dy > 80 || vy > 0.5) onCloseRef.current();
        else springBack();
      },
      onPanResponderTerminate: springBack,
    });
  });
  /* eslint-enable react-hooks/refs */

  return (
    <Modal
      visible={visible}
      transparent
      animationType="fade"
      onRequestClose={onClose}
    >
      <View style={[styles.sheetScrim, { paddingTop }]}>
        <Pressable
          accessibilityElementsHidden
          importantForAccessibility="no-hide-descendants"
          onPress={onClose}
          style={StyleSheet.absoluteFill}
        />
        <Animated.View
          accessibilityViewIsModal
          style={[
            styles.sheet,
            {
              maxHeight: Math.max(1, height - paddingTop),
              transform: [{ translateY }],
            },
          ]}
        >
          <View {...pan.panHandlers}>
            <Pressable
              accessibilityRole="button"
              accessibilityLabel="Close"
              onPress={onClose}
              hitSlop={{ top: 8, bottom: 8 }}
              style={styles.sheetHandleArea}
            >
              <View style={styles.sheetHandle} />
            </Pressable>
            <View style={styles.sheetHeader}>
              <Text accessibilityRole="header" style={styles.sheetTitle}>
                {title}
              </Text>
            </View>
          </View>
          <ScrollView
            style={[
              styles.sheetScroll,
              bodyMaxHeight !== undefined && {
                maxHeight:
                  bodyMaxHeight +
                  styles.sheetBody.paddingTop +
                  bodyPaddingBottom,
              },
            ]}
            contentContainerStyle={[
              styles.sheetBody,
              { paddingBottom: bodyPaddingBottom },
            ]}
            keyboardShouldPersistTaps="handled"
          >
            {children}
          </ScrollView>
          {footer ? (
            <View
              style={[
                styles.sheetFooter,
                { paddingBottom: 24 + insets.bottom },
              ]}
            >
              {footer}
            </View>
          ) : null}
        </Animated.View>
      </View>
    </Modal>
  );
}

function DecorativeIcon({
  name,
  color,
  size,
}: {
  name: LucideIconName;
  color: string;
  size: number;
}) {
  return (
    <View
      accessibilityElementsHidden
      importantForAccessibility="no-hide-descendants"
    >
      <Lucide name={name} color={color} size={size} />
    </View>
  );
}

const cardTones = StyleSheet.create({
  default: {
    backgroundColor: Colors.light.surface,
    borderColor: Colors.light.border,
    borderWidth: 1,
  },
  muted: {
    backgroundColor: Colors.light.surfaceMuted,
  },
  inverse: {
    backgroundColor: Colors.light.ink,
  },
});

const compactHitSlop = { top: 4, bottom: 4 };

const ripple = { color: Colors.light.rippleOnSurface };

const buttonLabelColors = {
  primary: { enabled: Colors.light.onInk, disabled: Colors.light.disabledText },
  secondary: { enabled: Colors.light.ink, disabled: Colors.light.disabledText },
  text: { enabled: Colors.light.ink, disabled: Colors.light.disabledText },
  inverse: {
    enabled: Colors.light.ink,
    disabled: Colors.light.onInkSecondary,
  },
} as const;

const buttonVariants = StyleSheet.create({
  primary: {
    backgroundColor: Colors.light.ink,
    paddingVertical: 14,
    paddingHorizontal: Spacing.three,
  },
  secondary: {
    backgroundColor: Colors.light.surface,
    borderColor: Colors.light.controlBorder,
    borderWidth: 1,
    paddingVertical: 13,
    paddingHorizontal: Spacing.three,
  },
  text: {
    backgroundColor: "transparent",
    paddingVertical: 14,
    paddingHorizontal: 12,
    width: "auto",
    alignSelf: "flex-start",
  },
  inverse: {
    backgroundColor: Colors.light.surface,
    paddingVertical: 14,
    paddingHorizontal: Spacing.three,
  },
});

const buttonDisabledVariants = StyleSheet.create({
  primary: {
    backgroundColor: Colors.light.disabledBackground,
  },
  secondary: {
    borderColor: Colors.light.border,
  },
  text: {},
  inverse: {
    backgroundColor: Colors.light.inverseDisabledBackground,
  },
});

const styles = StyleSheet.create({
  card: {
    width: "100%",
    borderRadius: Radii.card,
    padding: Spacing.card,
  },
  cardFlush: {
    padding: 0,
    gap: 0,
    overflow: "hidden",
  },
  button: {
    width: "100%",
    minHeight: ControlSize.minimumTarget,
    minWidth: ControlSize.minimumTarget,
    alignItems: "center",
    justifyContent: "center",
    flexDirection: "row",
    gap: Spacing.two,
    borderRadius: Radii.control,
  },
  buttonCompact: {
    minHeight: ControlSize.compact,
    paddingVertical: 9,
    paddingLeft: 12,
    paddingRight: 14,
    gap: 6,
    width: "auto",
    alignSelf: "flex-start",
  },
  buttonFocused: {
    borderColor: Colors.light.ink,
    borderWidth: 2,
  },
  buttonPressed: {
    opacity: 0.72,
  },
  buttonText: {
    ...Typography.button,
    textAlign: "center",
    flexShrink: 1,
  },
  emptyState: {
    paddingVertical: Spacing.five,
    paddingHorizontal: Spacing.four,
    alignItems: "center",
  },
  emptyIcon: {
    width: 56,
    height: 56,
    alignItems: "center",
    justifyContent: "center",
    backgroundColor: Colors.light.surfaceMuted,
    borderRadius: Radii.pill,
  },
  emptyTitle: {
    textAlign: "center",
    marginTop: Spacing.three,
  },
  emptyDescription: {
    textAlign: "center",
    marginTop: Spacing.one,
  },
  emptyAction: {
    alignSelf: "stretch",
    marginTop: Spacing.four,
  },
  disabled: {
    opacity: 0.5,
  },
  divider: {
    borderTopWidth: 1,
    borderTopColor: Colors.light.border,
  },
  onInkText: {
    color: Colors.light.onInk,
  },
  textColumn: {
    flex: 1,
    minWidth: 0,
  },
  selfCentered: {
    alignSelf: "center",
  },
  iconButton: {
    width: ControlSize.minimumTarget,
    height: ControlSize.minimumTarget,
    alignItems: "center",
    justifyContent: "center",
  },
  iconButtonBadge: {
    position: "absolute",
    top: 8,
    right: 8,
    width: 12,
    height: 12,
    borderRadius: Radii.pill,
    borderWidth: 2,
    borderColor: Colors.light.background,
    backgroundColor: Colors.light.ink,
  },
  fab: {
    width: 56,
    height: 56,
    borderRadius: Radii.pill,
    overflow: "hidden",
    alignItems: "center",
    justifyContent: "center",
    backgroundColor: Colors.light.ink,
  },
  fabDisabled: {
    backgroundColor: Colors.light.disabledBackground,
  },
  dropdownPill: {
    flexDirection: "row",
    alignItems: "center",
    gap: Spacing.one,
    minHeight: ControlSize.pill,
    paddingVertical: 6,
    paddingLeft: 12,
    paddingRight: Spacing.two,
    borderRadius: Radii.pill,
    backgroundColor: Colors.light.surfaceMuted,
  },
  segmentedTrack: {
    flexDirection: "row",
    padding: 4,
    backgroundColor: Colors.light.surfaceMuted,
    borderRadius: Radii.control,
  },
  segment: {
    flex: 1,
    minWidth: 0,
    minHeight: ControlSize.compact,
    paddingVertical: 10,
    paddingHorizontal: 8,
    borderRadius: Radii.segment,
    alignItems: "center",
    justifyContent: "center",
  },
  segmentSelected: {
    backgroundColor: Colors.light.ink,
  },
  segmentLabel: {
    ...Typography.button,
    textAlign: "center",
    color: Colors.light.textSecondary,
  },
  segmentLabelDisabled: {
    color: Colors.light.controlBorder,
  },
  chip: {
    minHeight: ControlSize.compact,
    paddingVertical: 9,
    paddingHorizontal: 16,
    borderRadius: Radii.pill,
    backgroundColor: Colors.light.surface,
    borderWidth: 1,
    borderColor: Colors.light.controlBorder,
    alignItems: "center",
    justifyContent: "center",
  },
  chipSelected: {
    paddingVertical: 10,
    paddingLeft: 12,
    paddingRight: 16,
    backgroundColor: Colors.light.ink,
    borderWidth: 0,
    flexDirection: "row",
    gap: 6,
  },
  chipCompact: {
    width: ControlSize.compact,
    height: ControlSize.compact,
    paddingVertical: 0,
    paddingHorizontal: 0,
    paddingLeft: 0,
    paddingRight: 0,
  },
  chipLabel: {
    fontFamily: InterFamilies.semibold,
    fontSize: 14,
    lineHeight: 20,
    color: Colors.light.ink,
  },
  toggle: {
    width: 52,
    height: ControlSize.minimumTarget,
    justifyContent: "center",
  },
  toggleTrack: {
    width: 52,
    height: 32,
    padding: 4,
    borderRadius: Radii.pill,
    flexDirection: "row",
    justifyContent: "flex-start",
    backgroundColor: Colors.light.controlBorder,
  },
  toggleTrackOn: {
    justifyContent: "flex-end",
    backgroundColor: Colors.light.ink,
  },
  toggleThumb: {
    width: 24,
    height: 24,
    borderRadius: Radii.pill,
    backgroundColor: Colors.light.surface,
  },
  switchRow: {
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "space-between",
    gap: 12,
    minHeight: 56,
  },
  notice: {
    flexDirection: "row",
    alignItems: "flex-start",
    gap: 12,
    paddingVertical: 12,
    paddingHorizontal: 16,
    borderRadius: Radii.control,
    backgroundColor: Colors.light.surfaceMuted,
  },
  noticeIconTitled: {
    marginTop: Spacing.half,
  },
  noticeText: {
    flex: 1,
    minWidth: 0,
    gap: 4,
  },
  noticeBody: {
    ...Typography.supporting,
    color: Colors.light.textSecondary,
  },
  noticeBodyStrong: {
    ...Typography.label,
    color: Colors.light.ink,
  },
  noticeActions: {
    marginTop: 8,
    gap: 8,
  },
  listRow: {
    flexDirection: "row",
    alignItems: "flex-start",
    gap: 12,
    padding: 16,
  },
  listRowCentered: {
    alignItems: "center",
  },
  iconWell: {
    width: ControlSize.iconWell,
    height: ControlSize.iconWell,
    borderRadius: Radii.pill,
    backgroundColor: Colors.light.surfaceMuted,
    alignItems: "center",
    justifyContent: "center",
    flexShrink: 0,
  },
  listTitleRow: {
    flexDirection: "row",
    alignItems: "baseline",
    justifyContent: "space-between",
    gap: 8,
  },
  listRowTitle: {
    ...Typography.listTitle,
    flexShrink: 1,
  },
  listMeta: {
    fontFamily: InterFamilies.medium,
    fontSize: 14,
    lineHeight: 20,
    color: Colors.light.textSecondary,
    fontVariant: ["tabular-nums"],
    flexShrink: 0,
  },
  listFooter: {
    marginTop: 8,
  },
  keyValue: {
    flexDirection: "row",
    alignItems: "baseline",
    justifyContent: "space-between",
    gap: 16,
    paddingVertical: 12,
  },
  keyValueNode: {
    alignItems: "center",
  },
  keyValueStacked: {
    flexDirection: "column",
    alignItems: "stretch",
    gap: 4,
  },
  keyValueText: {
    ...Typography.listTitle,
    textAlign: "right",
    flexShrink: 1,
    fontVariant: ["tabular-nums"],
  },
  keyValueTextStacked: {
    textAlign: "left",
  },
  sectionHeader: {
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "space-between",
    gap: 12,
    minHeight: 32,
  },
  sectionAction: {
    minHeight: ControlSize.minimumTarget,
    paddingVertical: 14,
    paddingHorizontal: 12,
    marginVertical: -8,
    marginHorizontal: -12,
    borderRadius: Radii.control,
  },
  sectionActionLabel: {
    ...Typography.button,
    color: Colors.light.ink,
  },
  stat: {
    padding: 16,
    backgroundColor: Colors.light.surface,
    borderWidth: 1,
    borderColor: Colors.light.border,
    borderRadius: Radii.card,
  },
  statHeader: {
    flexDirection: "row",
    alignItems: "flex-start",
    gap: 8,
  },
  // Centres the 16 px overline on the 20 px icon.
  statLabel: {
    ...Typography.overline,
    flex: 1,
    marginTop: Spacing.half,
  },
  statValueRow: {
    marginTop: 8,
    flexDirection: "row",
    alignItems: "baseline",
    gap: 4,
  },
  statSection: {
    marginTop: 8,
  },
  statCaptionNext: {
    marginTop: Spacing.half,
  },
  progressTrack: {
    height: 8,
    borderRadius: Radii.pill,
    backgroundColor: Colors.light.progressTrack,
    overflow: "hidden",
  },
  progressFill: {
    height: 8,
    borderRadius: Radii.pill,
    backgroundColor: Colors.light.ink,
  },
  skeleton: {
    backgroundColor: Colors.light.surfaceMuted,
    borderRadius: Radii.control,
  },
  sheetScrim: {
    flex: 1,
    justifyContent: "flex-end",
    backgroundColor: Colors.light.scrim,
  },
  sheet: {
    backgroundColor: Colors.light.surface,
    borderTopLeftRadius: Radii.bottomSheetTop,
    borderTopRightRadius: Radii.bottomSheetTop,
  },
  sheetHandleArea: {
    height: 32,
    alignItems: "center",
    justifyContent: "center",
  },
  sheetHandle: {
    width: 36,
    height: 4,
    borderRadius: Radii.pill,
    backgroundColor: Colors.light.controlBorder,
  },
  sheetHeader: {
    flexDirection: "row",
    alignItems: "center",
    paddingHorizontal: 24,
  },
  sheetTitle: {
    ...Typography.title,
    flex: 1,
  },
  // Lets the body shrink and scroll once the sheet reaches its max height.
  sheetScroll: {
    flexShrink: 1,
  },
  sheetBody: {
    paddingHorizontal: 24,
    paddingTop: 8,
    gap: 12,
  },
  sheetFooter: {
    paddingHorizontal: 24,
    paddingTop: 12,
    borderTopWidth: 1,
    borderTopColor: Colors.light.border,
    gap: 8,
  },
  statusIcon: {
    width: ControlSize.compact,
    height: ControlSize.compact,
    alignItems: "center",
    justifyContent: "center",
  },
  statusLabel: {
    alignSelf: "flex-start",
    maxWidth: "100%",
    flexDirection: "row",
    alignItems: "center",
    gap: 6,
    minHeight: ControlSize.pill,
    paddingVertical: 6,
    paddingLeft: Spacing.two,
    paddingRight: 10,
    borderRadius: Radii.pill,
    backgroundColor: Colors.light.surfaceMuted,
  },
  statusText: {
    ...Typography.pill,
    flexShrink: 1,
  },
  field: {
    width: "100%",
    gap: Spacing.two,
  },
  fieldLabel: {
    ...Typography.label,
  },
  fieldLabelDisabled: {
    color: Colors.light.textTertiary,
  },
  inputBox: {
    flexDirection: "row",
    alignItems: "center",
    gap: Spacing.two,
    minHeight: ControlSize.minimumTarget,
    paddingHorizontal: 15,
    backgroundColor: Colors.light.surface,
    borderColor: Colors.light.controlBorder,
    borderWidth: 1,
    borderRadius: Radii.control,
  },
  // 2 px border, so 1 px less padding keeps the text where it was.
  inputBoxStrong: {
    borderColor: Colors.light.ink,
    borderWidth: 2,
    paddingHorizontal: 14,
  },
  inputBoxDisabled: {
    backgroundColor: Colors.light.surfaceMuted,
    borderColor: Colors.light.border,
  },
  input: {
    flex: 1,
    minWidth: 0,
    minHeight: 44,
    padding: 0,
    ...Typography.body,
  },
  inputDisabled: {
    color: Colors.light.textSecondary,
  },
  inputSuffix: {
    ...Typography.body,
    color: Colors.light.textSecondary,
  },
  fieldHint: {
    ...Typography.supporting,
  },
  fieldHintDisabled: {
    color: Colors.light.textTertiary,
  },
  fieldError: {
    flexDirection: "row",
    alignItems: "flex-start",
    gap: 6,
  },
  // Centres the 16 px icon on the 20 px first line of the message.
  fieldErrorIcon: {
    marginTop: Spacing.half,
  },
  fieldErrorText: {
    fontFamily: InterFamilies.semibold,
    fontSize: 14,
    lineHeight: 20,
    color: Colors.light.ink,
    flex: 1,
  },
});
