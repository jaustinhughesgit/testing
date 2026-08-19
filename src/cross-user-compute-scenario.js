/**
 * Platform: Proves that one user's Compute entity can be installed as a new ID-bound local Path for another user.
 * Technical: Builds with actor one, discovers with actor two's bounded ordinary graph evidence, applies scoped entity-use bindings, and verifies local effects.
 */
import fs from "node:fs";
import { StateStore } from "./state-store.js";
import { OneVarApiClient } from "./api-client.js";
import { actorProfiles } from "./cross-user-context-scenario.js";
import { loadPublishedGraphStore } from "./message-scenario.js";
import {
  authenticatedFetch,
  buildCapability,
  computePath,
  discoverExistingCapability,
  loadComputeRuntime,
  loadPublishedSemanticPathRuntime,
} from "./compute-scenario.js";

function assertEqual(actual, expected, label) {
  if (JSON.stringify(actual) !== JSON.stringify(expected)) {
    throw new Error(`${label}: expected ${JSON.stringify(expected)}, received ${JSON.stringify(actual)}`);
  }
}

function ordinaryEvidence(history, graph) {
  const entities = Object.values(graph?.entities || {}).filter((entity) => {
    const labels = [...(entity?.names || []), ...(entity?.lemmas || [])];
    return entity?.protected !== true
      && entity?.zt !== true
      && !labels.some((value) => /(?:^|\b)zt-|protected_asset:/i.test(String(value || "")));
  }).slice(0, 200).map((entity) => ({
    id: String(entity.id),
    names: (entity.names || []).map(String).slice(0, 12),
    lemmas: (entity.lemmas || []).map(String).slice(0, 12),
  }));
  const entityIds = new Set(entities.map((entity) => entity.id));
  const relations = Object.values(graph?.relations || {}).filter((relation) => (
    entityIds.has(String(relation?.subj || ""))
    && entityIds.has(String(relation?.prop || ""))
    && entityIds.has(String(relation?.obj || ""))
  )).slice(0, 400).map((relation) => ({
    id: String(relation.id),
    subj: String(relation.subj),
    prop: String(relation.prop),
    obj: String(relation.obj),
  }));
  const invocationText = String(history.at(-1) || "").toLowerCase();
  const resolvedMention = Object.entries(graph?.mentions || {})
    .filter(([mention, record]) => (
      invocationText.includes(String(mention).toLowerCase())
      && Array.isArray(record?.entities)
      && record.entities.length === 1
      && entityIds.has(String(record.entities[0]))
    ))
    .sort((left, right) => right[0].length - left[0].length)[0];
  return {
    recentInputs: history.slice(-20).map((text) => ({ text, inputKind: "statement", semanticEntity: null })),
    relatedContext: { entities, relations },
    invocationReferents: resolvedMention ? [{
      role: "qualified_owner",
      mention: resolvedMention[0],
      mentionKey: resolvedMention[0],
      entityId: String(resolvedMention[1].entities[0]),
      resolvedLocally: true,
      resolution: "contextdb_exact",
    }] : [],
    routing: {
      missCategory: "NEW_SEMANTIC_OPERATION",
      localGraphCandidate: false,
      computeEligible: true,
      localRepairExhausted: false,
      unclassifiedColdMiss: true,
    },
  };
}

function findOperation(manifest, operationId = "") {
  return manifest.operations?.find((operation) => operation.operationId === operationId)
    || manifest.operations?.[0]
    || null;
}

async function actor(config, profile) {
  const stateStore = new StateStore(config.stateDirectory, profile);
  const state = stateStore.load();
  if (!state.subdomain || !state.accessToken) throw new Error(`Profile ${profile} is not bootstrapped`);
  return {
    profile,
    stateStore,
    workspaceId: String(state.subdomain),
    client: new OneVarApiClient({ ...config, stateStore }),
    graphStore: await loadPublishedGraphStore(config.websiteUrl, fetch),
  };
}

function executeEssence(actorState, semanticPaths, step) {
  const result = semanticPaths.execute(step.equationId, step.input, actorState.graphStore);
  if (step.expect?.responseSentence) {
    assertEqual(result.responseSentence, step.expect.responseSentence, step.name || step.input);
  }
  if (step.expect?.answer) assertEqual(result.answer, step.expect.answer, step.name || step.input);
  return result;
}

async function invoke(actorState, runtime, manifest, operation, step, entityUseBindings = []) {
  const execution = await runtime.invokeComputePath(
    computePath(manifest, operation, { entityUseBindings }),
    {
      graphSnapshot: actorState.graphStore.getSnapshot(),
      sentence: step.input,
      inputOverrides: { [step.subjectInput || "vehicle"]: step.subjectValue },
      fetchImpl: authenticatedFetch(actorState.stateStore, fetch),
      requestId: step.requestId,
    }
  );
  if (!execution.ok) throw new Error(`${step.name || step.input}: ${JSON.stringify(execution.error)}`);
  assertEqual(execution.answer, step.expect.answer, step.name || step.input);
  if (execution.mutationOps?.length) {
    const applied = actorState.graphStore.applyMutationOps(execution.mutationOps);
    if (!applied?.ok) throw new Error(`Context effect failed: ${JSON.stringify(applied?.errors || [])}`);
  }
  return execution;
}

export async function runCrossUserComputeScenarioObject(scenario, {
  config,
  profileNames,
  progress = () => {},
} = {}) {
  const profiles = actorProfiles(scenario, profileNames);
  const [authorName, installerName] = scenario.actors;
  const author = await actor(config, profiles[authorName]);
  const installer = await actor(config, profiles[installerName]);
  const semanticPaths = await loadPublishedSemanticPathRuntime(config.websiteUrl, fetch);
  const runtime = await loadComputeRuntime(config.websiteUrl, fetch);
  const authorHistory = [];
  const authorSetup = [];

  for (const step of scenario.author.setup) {
    authorHistory.push(step.input);
    authorSetup.push(executeEssence(author, semanticPaths, step));
  }
  const built = await buildCapability(author.client, author.workspaceId, {
    ...scenario.author.build,
    authoringContext: {
      schemaVersion: 1,
      kind: "convertAuthoringContext",
      recentInputs: authorHistory.slice(-20).map((text) => ({ text, inputKind: "statement", semanticEntity: null })),
      essence: authorSetup.flatMap((result) => result.essence || []).slice(-120),
    },
  }, progress);
  const authorOperation = findOperation(built.manifest, scenario.author.build.operationId);
  if (!authorOperation) throw new Error("Author manifest omitted its requested operation");
  if (!authorOperation.entityDependencies?.length) {
    throw new Error("Author manifest omitted app-scoped entity dependency IDs");
  }

  const authorResults = [];
  for (const step of scenario.author.steps) {
    authorHistory.push(step.input);
    authorResults.push(step.type === "invoke"
      ? await invoke(author, runtime, built.manifest, authorOperation, step)
      : executeEssence(author, semanticPaths, step));
  }

  const installerHistory = [];
  for (const step of scenario.installer.setup) {
    installerHistory.push(step.input);
    executeEssence(installer, semanticPaths, step);
  }
  const invocation = scenario.installer.invoke;
  installerHistory.push(invocation.input);
  const reused = await discoverExistingCapability(
    installer.client,
    installer.workspaceId,
    invocation.input,
    ordinaryEvidence(installerHistory, installer.graphStore.getSnapshot()),
    progress
  );
  assertEqual(reused.manifest.entityId, built.manifest.entityId, "Position-selected Compute entity ID");
  assertEqual(reused.manifest.version, built.manifest.version, "Position-selected Compute version");
  const installerOperation = findOperation(reused.manifest, reused.discovery?.essence?.operationId);
  const entityUseBindings = reused.discovery?.entityUseBindings || [];
  assertEqual(entityUseBindings.length, installerOperation.entityDependencies.length, "entity use binding count");
  const execution = await invoke(
    installer,
    runtime,
    reused.manifest,
    installerOperation,
    invocation,
    entityUseBindings
  );
  if (!execution.contextEffects?.every((effect) => effect.sourceDependencyId && effect.targetEntityId)) {
    throw new Error("User 2 execution did not use the exact app dependency binding");
  }
  const verification = executeEssence(installer, semanticPaths, scenario.installer.verify);

  return {
    name: scenario.name,
    passed: scenario.author.setup.length + scenario.author.steps.length + scenario.installer.setup.length + 3,
    capability: {
      entityId: built.manifest.entityId,
      capabilityId: built.manifest.capabilityId,
      version: built.manifest.version,
      operationId: installerOperation.operationId,
      dependencyIds: installerOperation.entityDependencies.map((dependency) => dependency.dependencyId),
    },
    installation: {
      owner: installer.workspaceId,
      copiedCreatorPath: false,
      generatedLocalPath: true,
      entityUseBindings,
    },
    authorAnswers: authorResults.map((result) => result.answer || result.responseSentence || null).filter(Boolean),
    installerAnswer: execution.answer,
    installerVerification: verification.responseSentence,
  };
}

export async function runCrossUserComputeScenario(file, options) {
  return runCrossUserComputeScenarioObject(JSON.parse(fs.readFileSync(file, "utf8")), options);
}
