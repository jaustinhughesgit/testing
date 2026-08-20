import test from "node:test";
import assert from "node:assert/strict";
import {
  publishDelta,
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

test("publication remaps authoritative relation IDs as well as entity IDs", async () => {
  let loaded = null;
  let receivedRelationMap = null;
  const actor = {
    client: {
      call: async () => ({
        data: {
          response: {
            ok: true,
            nodes: [
              { localId: "local_car", serverId: "ctx_car" },
              { localId: "local_clean", serverId: "ctx_clean" },
            ],
            relations: [{ localId: "local_condition", serverId: "rel_condition" }],
          },
        },
      }),
    },
    workspaceId: "test-workspace",
    graphStore: { loadSnapshot: (snapshot) => { loaded = snapshot; } },
  };
  const after = {
    entities: {
      local_car: { id: "local_car", lemmas: ["car"], names: [] },
      local_clean: { id: "local_clean", lemmas: ["clean"], names: [] },
    },
    relations: {
      local_condition: {
        id: "local_condition",
        subj: "local_car",
        prop: "local_condition_property",
        obj: "local_clean",
      },
    },
    mentions: {},
  };
  const contextPublication = {
    deltaEnvelope: () => ({ relations: [{ id: "local_condition" }] }),
    remapGraphSnapshotEntityIds: (snapshot, idMap, relationIdMap) => {
      receivedRelationMap = relationIdMap;
      return {
        ...snapshot,
        entities: {
          ctx_car: { ...snapshot.entities.local_car, id: idMap.local_car },
          ctx_clean: { ...snapshot.entities.local_clean, id: idMap.local_clean },
        },
        relations: {
          rel_condition: {
            ...snapshot.relations.local_condition,
            id: relationIdMap.local_condition,
            subj: idMap.local_car,
            obj: idMap.local_clean,
          },
        },
      };
    },
  };

  await publishDelta(actor, { entities: {}, relations: {}, mentions: {} }, after, {
    requestId: "publication-relation-remap",
    sentence: "My car is clean.",
  }, contextPublication);

  assert.deepEqual(receivedRelationMap, { local_condition: "rel_condition" });
  assert.equal(loaded.relations.rel_condition.id, "rel_condition");
  assert.equal(loaded.relations.rel_condition.subj, "ctx_car");
  assert.equal(loaded.relations.rel_condition.obj, "ctx_clean");
});
