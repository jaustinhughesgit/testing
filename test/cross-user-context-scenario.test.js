import test from "node:test";
import assert from "node:assert/strict";
import { retainProtectedEntityReferences } from "../src/cross-user-context-scenario.js";

test("named hydration retains opaque protected references outside the graph store", () => {
  const first = "protected_asset:pa_1234567890abcdef";
  const second = "protected_asset:pa_abcdef1234567890";
  const actor = {};
  const references = retainProtectedEntityReferences(actor, {
    protectedEntityReferences: { ctx_first: first },
    entities: {
      ctx_first: { id: "ctx_first", lemmas: ["protected_asset"] },
      ctx_second: {
        id: "ctx_second",
        lemmas: ["protected_asset"],
        protectedAssetReference: second,
      },
    },
  });
  assert.deepEqual([...references], [["ctx_first", first], ["ctx_second", second]]);
});
