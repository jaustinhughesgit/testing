import test from "node:test";
import assert from "node:assert/strict";
import { isSubset, resolveTemplates } from "../src/scenario.js";

test("scenario expectations match stable response subsets", () => {
  assert.equal(isSubset({ ok: true, response: { count: 16 } }, { ok: true, response: { count: 16, trace: "x" } }), true);
  assert.equal(isSubset({ response: { count: 15 } }, { response: { count: 16 } }), false);
  assert.equal(isSubset({ pubEnc: { $type: "string" }, pubSig: { $present: true } }, { pubEnc: "abc", pubSig: "def" }), true);
});

test("scenario templates resolve profile state and environment values", () => {
  assert.deepEqual(
    resolveTemplates({ entity: "${state.subdomain}", label: "test-${env.RUN_ID}" }, { state: { subdomain: "1v4r-user" }, env: { RUN_ID: "42" } }),
    { entity: "1v4r-user", label: "test-42" }
  );
});
