import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import {
  computePath,
  loadComputeRuntime,
  loadPublishedSemanticPathRuntime,
} from "../src/compute-scenario.js";
import {
  assertFreshCapabilityBuild,
  ordinaryEvidence,
  operationSubjectInput,
  pollCapabilityPublication,
} from "../src/cross-user-compute-scenario.js";
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
  ["https://website.example/workers/computeCapabilityWorkerLib.js", "workers/computeCapabilityWorkerLib.js"],
  ["https://website.example/modules/_pathbuilder/semantic-graph-path-dataset.json", "modules/_pathbuilder/semantic-graph-path-dataset.json"],
]);

async function localFetch(url) {
  const relative = sources.get(String(url));
  if (!relative) return new Response("missing", { status: 404 });
  return new Response(fs.readFileSync(path.join(awsPublic, relative)), {
    status: 200,
    headers: { "content-type": relative.endsWith(".json") ? "application/json" : "text/javascript" },
  });
}

function entityId(snapshot, label) {
  return Object.values(snapshot.entities).find((entity) => (
    [...(entity.names || []), ...(entity.lemmas || [])].includes(label)
  ))?.id;
}

function invokeFetch(manifest, operation) {
  return async (_url, options = {}) => {
    const inputs = JSON.parse(options.body || "{}").inputs || {};
    return new Response(JSON.stringify({
      ok: true,
      kind: "computeResult",
      capabilityId: manifest.capabilityId,
      operationId: operation.operationId,
      entityId: manifest.entityId,
      version: manifest.version,
      result: { vehicle: inputs.vehicle, state: "clean" },
    }), { status: 200, headers: { "content-type": "application/json" } });
  };
}

test("the sharing runner uses the effect's exact generated subject input name", () => {
  assert.equal(operationSubjectInput({
    inputs: [{
      name: "utterance",
      required: true,
      bindingHint: { source: "utterance", resolver: "entity_reference" },
    }],
    contextEffects: [{ subjectInput: "utterance" }],
  }, "vehicle"), "utterance");
});

test("the sharing runner waits for bounded Position propagation after registration", async () => {
  let calls = 0;
  const publication = await pollCapabilityPublication(async () => {
    calls += 1;
    return {
      registryAvailable: true,
      positionAvailable: calls >= 3,
      canUse: calls >= 3,
    };
  }, { attempts: 4, delayMs: 0, wait: async () => {} });
  assert.equal(calls, 3);
  assert.equal(publication.positionAvailable, true);
  assert.equal(publication.canUse, true);
});

test("the reset-gated sharing proof rejects a retained functional capability", () => {
  assert.equal(
    assertFreshCapabilityBuild({ build: { status: "BUILT_AND_REGISTERED" } }),
    "BUILT_AND_REGISTERED"
  );
  assert.throws(
    () => assertFreshCapabilityBuild({ build: { status: "CAPABILITY_REUSED" } }),
    /requires a newly built capability/
  );
});

test("the non-protected two-user carwash flow updates only the exact installed entity binding", async () => {
  const semanticPaths = await loadPublishedSemanticPathRuntime("https://website.example", localFetch);
  const computeRuntime = await loadComputeRuntime("https://website.example", localFetch);
  const user1 = await loadPublishedGraphStore("https://website.example", localFetch);
  const user2 = await loadPublishedGraphStore("https://website.example", localFetch);
  const operation = {
    operationId: "wash",
    inputs: [{
      name: "vehicle",
      type: "string",
      required: true,
      bindingHint: { source: "utterance", resolver: "entity_reference" },
    }],
    outputs: [
      { name: "vehicle", type: "string", required: true },
      { name: "state", type: "string", required: true },
    ],
    contextEffects: [{
      type: "contextdb.replace_object",
      subjectInput: "vehicle",
      currentValue: "dirty",
      newValue: "clean",
    }],
    entityDependencies: [{
      schemaVersion: 1,
      dependencyId: "compute-carwash::v1::wash::context_effect_1",
      name: "current_state",
      kind: "contextdb_relation",
      access: "read_write",
      effectIndex: 0,
      subjectInput: "vehicle",
    }],
    freshness: { mode: "none", ttlSeconds: 0 },
    protectedAssetRequirements: [],
    answerTemplate: "Your {{vehicle}} is clean",
  };
  const manifest = {
    schemaVersion: 1,
    capabilityId: "carwash",
    entityId: "compute-carwash",
    version: 1,
    execution: { readOnly: false, timeoutMs: 10_000 },
    operations: [operation],
  };

  semanticPaths.execute("activity_possession_composed_statement", "I have a car", user1);
  semanticPaths.execute("owned_entity_alias_composed_statement", "My car is a Toyota Camry", user1);
  semanticPaths.execute("self_property_composed_statement", "My Toyota Camry is dirty.", user1);
  const authorExecution = await computeRuntime.invokeComputePath(
    computePath(manifest, operation),
    {
      graphSnapshot: user1.getSnapshot(),
      sentence: "Wash my Camry",
      inputOverrides: { vehicle: "Camry" },
      fetchImpl: invokeFetch(manifest, operation),
    }
  );
  assert.equal(authorExecution.ok, true);
  assert.equal(authorExecution.answer, "Your Camry is clean");
  assert.equal(user1.applyMutationOps(authorExecution.mutationOps).ok, true);
  assert.equal(
    semanticPaths.execute(
      "owned_entity_status_composed_query",
      "What is the status of my Camry",
      user1
    ).responseSentence,
    "The status of your Camry is clean."
  );
  assert.equal(
    semanticPaths.execute(
      "owned_entity_choice_composed_query",
      "Is my Toyota clean or dirty?",
      user1
    ).responseSentence,
    "Your Toyota is clean."
  );

  semanticPaths.execute("activity_possession_composed_statement", "I have a car.", user2);
  semanticPaths.execute("self_property_composed_statement", "My car is dirty.", user2);
  semanticPaths.execute("self_property_composed_statement", "My register status is dirty.", user2);
  const before = user2.getSnapshot();
  const speakerId = entityId(before, "speaker");
  const carId = Object.values(before.relations).find((relation) => (
    relation.subj === speakerId
    && before.entities[relation.obj]?.lemmas?.includes("car")
  ))?.obj;
  const carCondition = Object.values(before.relations).find((relation) => (
    relation.subj === carId
    && before.entities[relation.obj]?.lemmas?.includes("dirty")
  ));
  const conditionId = carCondition?.prop;
  const registerStatus = Object.values(before.relations).find((relation) => (
    before.entities[relation.prop]?.lemmas?.includes("register_status")
  ));
  assert.ok(carCondition);
  assert.ok(registerStatus);
  assert.equal(
    ordinaryEvidence(["I have a car.", "My car is dirty.", "Wash my car."], before)
      .invocationReferents[0].entityId,
    carId
  );

  const bindings = [{
    schemaVersion: 1,
    sourceDependencyId: operation.entityDependencies[0].dependencyId,
    targetEntityId: conditionId,
    targetRelationId: carCondition.id,
    targetSubjectEntityId: carId,
    access: "read_write",
  }];
  const installerExecution = await computeRuntime.invokeComputePath(
    computePath(manifest, operation, { entityUseBindings: bindings }),
    {
      graphSnapshot: before,
      sentence: "Wash my car.",
      inputOverrides: { vehicle: "car" },
      fetchImpl: invokeFetch(manifest, operation),
    }
  );
  assert.equal(installerExecution.ok, true);
  assert.equal(installerExecution.answer, "Your car is clean");
  assert.equal(installerExecution.contextEffects[0].sourceDependencyId, bindings[0].sourceDependencyId);
  assert.equal(installerExecution.contextEffects[0].targetEntityId, conditionId);
  assert.equal(user2.applyMutationOps(installerExecution.mutationOps).ok, true);

  const after = user2.getSnapshot();
  assert.equal(
    semanticPaths.execute(
      "owned_entity_status_composed_query",
      "What is the status of my car",
      user2
    ).responseSentence,
    "The status of your Car is clean."
  );
  assert.equal(after.relations[registerStatus.id].obj, registerStatus.obj);
  assert.notEqual(after.relations[carCondition.id].obj, carCondition.obj);
});
