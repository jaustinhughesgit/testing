import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import {
  loadPublishedSemanticPathRuntime,
  isRetryableDiscoveryFailure,
  selectCapabilityManifest,
  selectReusableCapabilityManifest,
} from "../src/compute-scenario.js";
import { loadPublishedGraphStore } from "../src/message-scenario.js";

const awsPublic = path.resolve(import.meta.dirname, "../../aws/app/public");
const sources = new Map([
  ["https://public.1var.com/compromise.js", "modules/_analyzer/compromise.js"],
  ["https://public.1var.com/compromise-numbers.js", "modules/_analyzer/compromise-numbers.js"],
  ["https://website.example/workers/pathBindingWorkerLib.js", "workers/pathBindingWorkerLib.js"],
  ["https://website.example/workers/pathResponseWorkerLib.js", "workers/pathResponseWorkerLib.js"],
  ["https://website.example/workers/graphWorkerLib.js", "workers/graphWorkerLib.js"],
  ["https://website.example/workers/semanticEntityCompilerWorkerLib.js", "workers/semanticEntityCompilerWorkerLib.js"],
  ["https://website.example/workers/patternWorkerLib.js", "workers/patternWorkerLib.js"],
  ["https://website.example/modules/_pathbuilder/semantic-graph-path-dataset.json", "modules/_pathbuilder/semantic-graph-path-dataset.json"],
]);

test("compute scenarios prefer the authoritative registered manifest over an internal pending build artifact", () => {
  const operation = {
    operationId: "format",
    inputs: [],
    outputs: [{ name: "formatted", type: "string", required: true }],
  };
  const manifest = selectCapabilityManifest({
    parseResults: {
      capabilityManifest: {
        schemaVersion: 1,
        capabilityId: "formatter",
        entityId: "pending-capability-entity",
        operations: [operation],
      },
    },
    capabilityManifest: {
      schemaVersion: 1,
      capabilityId: "formatter",
      entityId: "1v4r-registered",
      operations: [operation],
    },
  });
  assert.equal(manifest.entityId, "1v4r-registered");
});

test("compute create/reuse scenarios fail explicitly when discovery requires Edit", () => {
  assert.throws(
    () => selectReusableCapabilityManifest({}, "CAPABILITY_EXTENSION_REQUIRED"),
    /requires an entity extension/
  );
});

test("compute scenarios recognize bounded-replacement discovery failures", () => {
  assert.equal(isRetryableDiscoveryFailure({
    errorDetails: {
      code: "ANSWER_PLAN_SOURCE_MISSING",
      stage: "compute_discovery",
      retryable: true,
    },
  }), true);
  assert.equal(isRetryableDiscoveryFailure({
    errorDetails: { stage: "compute_build", retryable: true },
  }), false);
});

test("a command scenario executes the published composed self-property Path", async () => {
  const fetchImpl = async (url) => {
    const relative = sources.get(String(url));
    if (!relative) return new Response("missing", { status: 404 });
    const body = fs.readFileSync(path.join(awsPublic, relative));
    return new Response(body, {
      status: 200,
      headers: { "content-type": relative.endsWith(".json") ? "application/json" : "text/javascript" },
    });
  };
  const runtime = await loadPublishedSemanticPathRuntime("https://website.example", fetchImpl);
  const ingested = [];
  const result = runtime.execute(
    "self_property_composed_statement",
    "My register status is closed.",
    { ingestEssenceRows: (rows) => ingested.push(...rows) },
  );

  assert.equal(result.execution, "published-semantic-path");
  assert.equal(result.bindings.subject, "speaker");
  assert.equal(result.bindings.property, "register status");
  assert.equal(result.bindings.value, "closed");
  assert.deepEqual(Array.from(ingested.at(-1)), ["present", "speaker", "register status", "closed"]);
});

test("a command scenario executes the published composed possession Path", async () => {
  const fetchImpl = async (url) => {
    const relative = sources.get(String(url));
    if (!relative) return new Response("missing", { status: 404 });
    const body = fs.readFileSync(path.join(awsPublic, relative));
    return new Response(body, {
      status: 200,
      headers: { "content-type": relative.endsWith(".json") ? "application/json" : "text/javascript" },
    });
  };
  const runtime = await loadPublishedSemanticPathRuntime("https://website.example", fetchImpl);
  const graphStore = await loadPublishedGraphStore("https://website.example", fetchImpl);
  const result = runtime.execute(
    "activity_possession_composed_statement",
    "I have a car.",
    graphStore,
  );

  assert.equal(result.execution, "published-semantic-path");
  assert.equal(result.bindings.actor, "speaker");
  assert.equal(result.bindings.activity, "have");
  assert.equal(result.bindings.object, "car");
  assert.equal(result.bindings.object_owner, "speaker");
  const snapshot = graphStore.getSnapshot();
  const hasPredicates = Object.values(snapshot.entities)
    .filter((entity) => entity.lemmas?.includes("have"));
  const speaker = Object.values(snapshot.entities)
    .find((entity) => entity.names?.includes("speaker") || entity.lemmas?.includes("speaker"));
  const car = Object.values(snapshot.entities)
    .find((entity) => entity.lemmas?.includes("car"));
  assert.ok(hasPredicates.length);
  assert.ok(speaker);
  assert.ok(car);
  assert.equal(
    Object.values(snapshot.relations).some((relation) =>
      relation.subj === speaker.id
      && hasPredicates.some((predicate) => predicate.id === relation.prop)
      && relation.obj === car.id
    ),
    true,
  );
});

test("owned entity aliases and condition queries retain one ContextDB identity", async () => {
  const fetchImpl = async (url) => {
    const relative = sources.get(String(url));
    if (!relative) return new Response("missing", { status: 404 });
    const body = fs.readFileSync(path.join(awsPublic, relative));
    return new Response(body, {
      status: 200,
      headers: { "content-type": relative.endsWith(".json") ? "application/json" : "text/javascript" },
    });
  };
  const runtime = await loadPublishedSemanticPathRuntime("https://website.example", fetchImpl);
  const graphStore = await loadPublishedGraphStore("https://website.example", fetchImpl);

  runtime.execute("activity_possession_composed_statement", "I have a car.", graphStore);
  const local = graphStore.getSnapshot();
  const idMap = Object.fromEntries(Object.keys(local.entities).map((entityId) => {
    const entity = local.entities[entityId];
    if (entity.lemmas?.includes("speaker")) return [entityId, "usr_1"];
    const usedAsPredicate = Object.values(local.relations).some((relation) => relation.prop === entityId);
    return [entityId, `${usedAsPredicate ? "term" : "ctx"}_${entityId}`];
  }));
  graphStore.loadSnapshot({
    entities: Object.fromEntries(Object.entries(local.entities).map(([entityId, entity]) => [
      idMap[entityId],
      { ...entity, id: idMap[entityId] },
    ])),
    relations: Object.fromEntries(Object.entries(local.relations).map(([relationId, relation]) => [
      relationId,
      {
        ...relation,
        subj: idMap[relation.subj],
        prop: idMap[relation.prop],
        obj: idMap[relation.obj],
      },
    ])),
    mentions: Object.fromEntries(Object.entries(local.mentions).map(([mention, value]) => [
      mention,
      { entities: value.entities.map((entityId) => idMap[entityId]) },
    ])),
  });
  runtime.execute("owned_entity_alias_composed_statement", "My car is a Toyota Camry.", graphStore);
  runtime.execute("self_property_composed_statement", "My Toyota Camry is dirty.", graphStore);

  const snapshot = graphStore.getSnapshot();
  const carId = snapshot.mentions.car.entities[0];
  assert.deepEqual(Array.from(snapshot.mentions["toyota camry"].entities), [carId]);
  assert.deepEqual(Array.from(snapshot.mentions.toyota.entities), [carId]);
  assert.deepEqual(Array.from(snapshot.mentions.camry.entities), [carId]);
  assert.deepEqual(
    runtime.execute("owned_entity_status_composed_query", "What is the status of my Camry?", graphStore).answer,
    ["dirty"],
  );
  assert.deepEqual(
    runtime.execute("owned_entity_choice_composed_query", "Is my Toyota clean or dirty?", graphStore).answer,
    ["dirty"],
  );

  const beforeCorrection = graphStore.getSnapshot();
  const carCondition = Object.values(beforeCorrection.relations).find((relation) => (
    relation.subj === carId
    && beforeCorrection.entities[relation.prop]?.lemmas?.includes("condition")
  ));
  const cleanId = graphStore.ensureEntity("clean");
  graphStore.applyMutationOps([{
    type: "relation:rewire",
    payload: { relationId: carCondition.id, obj: cleanId },
  }]);
  runtime.execute("self_property_composed_statement", "My Toyota Camry is dirty.", graphStore);
  const corrected = graphStore.getSnapshot();
  const correctedConditions = Object.values(corrected.relations).filter((relation) => (
    relation.subj === carId
    && corrected.entities[relation.prop]?.lemmas?.includes("condition")
  ));
  assert.equal(correctedConditions.length, 1);
  assert.equal(correctedConditions[0].id, carCondition.id);
  assert.equal(corrected.entities[correctedConditions[0].obj]?.lemmas?.includes("dirty"), true);
  assert.equal(corrected.mentions.dirty.entities.length, 1);
  assert.deepEqual(
    runtime.execute("owned_entity_status_composed_query", "What is the status of my Camry?", graphStore).answer,
    ["dirty"],
  );

  const personalStore = await loadPublishedGraphStore("https://website.example", fetchImpl);
  runtime.execute("self_property_composed_statement", "My register status is open.", personalStore);
  const repeatedProperty = runtime.execute(
    "self_property_composed_statement",
    "My register status is closed.",
    personalStore,
  );
  assert.equal(repeatedProperty.bindings.related_subject, "");
  assert.deepEqual(Array.from(repeatedProperty.essence.at(-1)), [
    "present", "speaker", "register status", "closed",
  ]);
  const personal = personalStore.getSnapshot();
  const registerValues = Object.values(personal.relations).filter((relation) => (
    personal.entities[relation.subj]?.lemmas?.includes("speaker")
    && personal.entities[relation.prop]?.lemmas?.includes("register_status")
  ));
  assert.equal(registerValues.length, 1);
  assert.equal(personal.entities[registerValues[0].obj]?.lemmas?.includes("closed"), true);
  assert.equal(Object.values(personal.relations).some((relation) => (
    personal.entities[relation.subj]?.lemmas?.includes("register status")
    && personal.entities[relation.prop]?.lemmas?.includes("condition")
  )), false);
});

test("a command scenario constrains a named quantity question to the requested item", async () => {
  const fetchImpl = async (url) => {
    const relative = sources.get(String(url));
    if (!relative) return new Response("missing", { status: 404 });
    const body = fs.readFileSync(path.join(awsPublic, relative));
    return new Response(body, {
      status: 200,
      headers: { "content-type": relative.endsWith(".json") ? "application/json" : "text/javascript" },
    });
  };
  const runtime = await loadPublishedSemanticPathRuntime("https://website.example", fetchImpl);
  const graphStore = await loadPublishedGraphStore("https://website.example", fetchImpl);
  graphStore.loadSnapshot({
    entities: {
      usr_12: { id: "usr_12", names: ["ardenzo"], lemmas: [] },
      prop_observe: { id: "prop_observe", names: [], lemmas: ["observe_quantity"] },
      prop_item: { id: "prop_item", names: [], lemmas: ["item"] },
      prop_delta: { id: "prop_delta", names: [], lemmas: ["quantity_delta"] },
      cat_record: { id: "cat_record", names: [], lemmas: ["cat observation"] },
      cat: { id: "cat", names: [], lemmas: ["cat"] },
      three: { id: "three", names: [], lemmas: ["3"] },
      lantern_record: { id: "lantern_record", names: [], lemmas: ["lantern observation"] },
      lantern: { id: "lantern", names: [], lemmas: ["lantern"] },
      four: { id: "four", names: [], lemmas: ["4"] },
    },
    relations: {
      cat_owned: { id: "cat_owned", subj: "usr_12", prop: "prop_observe", obj: "cat_record" },
      cat_item: { id: "cat_item", subj: "cat_record", prop: "prop_item", obj: "cat" },
      cat_delta: { id: "cat_delta", subj: "cat_record", prop: "prop_delta", obj: "three" },
      lantern_owned: { id: "lantern_owned", subj: "usr_12", prop: "prop_observe", obj: "lantern_record" },
      lantern_item: { id: "lantern_item", subj: "lantern_record", prop: "prop_item", obj: "lantern" },
      lantern_delta: { id: "lantern_delta", subj: "lantern_record", prop: "prop_delta", obj: "four" },
    },
    mentions: {
      ardenzo: { entities: ["usr_12"] },
      cat: { entities: ["cat"] },
      lantern: { entities: ["lantern"] },
    },
  });
  const result = runtime.execute(
    "quantity_current_composed_query",
    "How many lanterns does Ardenzo have?",
    graphStore,
  );

  assert.deepEqual(result.answer, ["4"]);
  assert.equal(result.essence[0][1].entityId, "usr_12");
  assert.equal(result.essence[0][1].var, "owner_entity");
});

test("a named entity binding preserves the normalized name instead of its linguistic root", async () => {
  const fetchImpl = async (url) => {
    const relative = sources.get(String(url));
    if (!relative) return new Response("missing", { status: 404 });
    const body = fs.readFileSync(path.join(awsPublic, relative));
    return new Response(body, {
      status: 200,
      headers: { "content-type": relative.endsWith(".json") ? "application/json" : "text/javascript" },
    });
  };
  const runtime = await loadPublishedSemanticPathRuntime("https://website.example", fetchImpl);
  const graphStore = await loadPublishedGraphStore("https://website.example", fetchImpl);
  graphStore.loadSnapshot({
    entities: {
      usr_21: { id: "usr_21", names: ["austinflow0817verified"], lemmas: [] },
    },
    relations: {},
    mentions: { austinflow0817verified: { entities: ["usr_21"] } },
  });
  const result = runtime.execute(
    "quantity_current_composed_query",
    "How many cats does Austinflow0817verified have?",
    graphStore,
  );

  assert.equal(result.bindings.owner, "usr_21");
  assert.equal(result.essence[0][1].entityId, "usr_21");
});
