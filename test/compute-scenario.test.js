import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import {
  loadPublishedSemanticPathRuntime,
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
