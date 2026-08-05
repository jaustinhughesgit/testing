import test from "node:test";
import assert from "node:assert/strict";
import { isSubset } from "../src/scenario.js";

test("scenario expectations match stable response subsets", () => {
  assert.equal(isSubset({ ok: true, response: { count: 16 } }, { ok: true, response: { count: 16, trace: "x" } }), true);
  assert.equal(isSubset({ response: { count: 15 } }, { response: { count: 16 } }), false);
});
