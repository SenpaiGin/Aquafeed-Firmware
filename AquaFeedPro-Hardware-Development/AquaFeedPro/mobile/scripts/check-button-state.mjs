import assert from "node:assert/strict";

import { resolveButtonState } from "../src/components/button-state.ts";

assert.deepEqual(resolveButtonState({}), {
  disabled: false,
  accessibilityState: { disabled: false, busy: false },
});
assert.deepEqual(resolveButtonState({ disabled: true }), {
  disabled: true,
  accessibilityState: { disabled: true, busy: false },
});
assert.deepEqual(resolveButtonState({ loading: true }), {
  disabled: true,
  accessibilityState: { disabled: true, busy: true },
});
assert.deepEqual(resolveButtonState({ disabled: true, loading: true }), {
  disabled: true,
  accessibilityState: { disabled: true, busy: true },
});
assert.deepEqual(resolveButtonState({ hasAction: false }), {
  disabled: true,
  accessibilityState: { disabled: true, busy: false },
});

process.stdout.write(
  "Button enabled, disabled, and loading state checks passed.\n",
);
