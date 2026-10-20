import assert from "node:assert/strict";

import { errorText } from "../src/lib/error-text.ts";

class OwnError extends Error {}

assert.equal(errorText(new Error("x"), "fallback"), "x");
assert.equal(errorText(new OwnError("own wording"), "fallback"), "own wording");

for (const Fault of [TypeError, ReferenceError, RangeError, SyntaxError]) {
  assert.equal(errorText(new Fault("engine text"), "fallback"), "fallback");
}

for (const value of ["a string", null, undefined]) {
  assert.equal(errorText(value, "fallback"), "fallback");
}

process.stdout.write("Error text checks passed.\n");
