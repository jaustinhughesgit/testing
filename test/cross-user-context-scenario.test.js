import test from "node:test";
import assert from "node:assert/strict";
import {
  publicationRelationIds,
  retainProtectedEntityReferences,
} from "../src/context-publication.js";

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

test("cross-user publication carries alias-only entity changes on an incident relation", () => {
  const before = {
    entities: {
      usr_1: { id: "usr_1", names: [], lemmas: ["speaker"] },
      ctx_car: { id: "ctx_car", names: [], lemmas: ["car"] },
      term_have: { id: "term_have", names: [], lemmas: ["have"] },
    },
    relations: {
      rel_have: { id: "rel_have", subj: "usr_1", prop: "term_have", obj: "ctx_car" },
    },
  };
  const after = structuredClone(before);
  after.entities.ctx_car.names.push("toyota camry");

  assert.deepEqual(publicationRelationIds(before, after), {
    addedRelationIds: ["rel_have"],
    removedRelationIds: [],
  });
});

test("cross-user publication includes same-ID relation rewires", () => {
  const before = {
    entities: {},
    relations: {
      rel_condition: { id: "rel_condition", subj: "ctx_car", prop: "condition", obj: "dirty" },
    },
  };
  const after = structuredClone(before);
  after.relations.rel_condition.obj = "clean";

  assert.deepEqual(publicationRelationIds(before, after), {
    addedRelationIds: ["rel_condition"],
    removedRelationIds: [],
  });
});
