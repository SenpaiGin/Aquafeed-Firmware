export type ButtonStateOptions = {
  disabled?: boolean;
  loading?: boolean;
  hasAction?: boolean;
};

export function resolveButtonState({
  disabled = false,
  loading = false,
  hasAction = true,
}: ButtonStateOptions) {
  const unavailable = disabled || loading || !hasAction;

  return {
    disabled: unavailable,
    accessibilityState: {
      disabled: unavailable,
      busy: loading,
    },
  };
}
