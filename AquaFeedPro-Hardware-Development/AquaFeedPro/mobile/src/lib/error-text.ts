// Engine faults (ReferenceError, TypeError…) carry developer text; never show it.
export function errorText(error: unknown, fallback: string) {
  return error instanceof Error &&
    !(
      error instanceof TypeError ||
      error instanceof ReferenceError ||
      error instanceof RangeError ||
      error instanceof SyntaxError
    )
    ? error.message
    : fallback;
}
