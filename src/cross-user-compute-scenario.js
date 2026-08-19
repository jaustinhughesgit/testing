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

export function ordinaryEvidence(history, graph) {
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
  const speakerCandidates = (graph?.mentions?.speaker?.entities || [])
    .map(String).filter((entityId) => entityIds.has(entityId));
  const speakerId = speakerCandidates.length === 1 ? speakerCandidates[0] : "";
  const resolvedMention = Object.entries(graph?.mentions || {})
    .map(([mention, record]) => {
      const candidates = (Array.isArray(record?.entities) ? record.entities : [])
        .map(String).filter((entityId) => entityIds.has(entityId));
      const owned = speakerId ? candidates.filter((entityId) => relations.some(
        (relation) => relation.subj === speakerId && relation.obj === entityId
      )) : [];
      const resolved = owned.length === 1
        ? owned[0]
        : (candidates.length === 1 ? candidates[0] : "");
      return [mention, resolved];
    })
    .filter(([mention, entityId]) => (
      entityId && invocationText.includes(String(mention).toLowerCase())
    ))
    .sort((left, right) => right[0].length - left[0].length)[0];
  return {
    recentInputs: history.slice(-20).map((text) => ({ text, inputKind: "statement", semanticEntity: null })),
    relatedContext: { entities, relations },
    invocationReferents: resolvedMention ? [{
      role: "qualified_owner",
      mention: resolvedMention[0],
      mentionKey: resolvedMention[0],
      entityId: String(resolvedMention[1]),
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

function unwrapRouteValue(value) {
  let current = value;
  for (let index = 0; index < 10; index += 1) {
    if (!current || typeof current !== "object" || Array.isArray(current)) break;
    if (Array.isArray(current.manifests) || Array.isArray(current.results)) break;
    if (current.oai?.html && typeof current.oai.html === "object") current = current.oai.html;
    else if (current.response && typeof current.response === "object") current = current.response;
    else if (current.html && typeof current.html === "object") current = current.html;
    else break;
  }
  return current;
}

async function inspectPublishedCapability(actorState, manifest, query) {
  const listed = unwrapRouteValue((await actorState.client.call("capabilities", {
    path: ["find", manifest.capabilityId],
    body: { includeInactive: true, limit: 25 },
  })).data);
  const searched = unwrapRouteValue((await actorState.client.call("search", {
    body: { text: query, topK: 60, bandWindow: 512 },
  })).data);
  const semanticQuery = [
    `capability ${manifest.name || manifest.capabilityId}`,
    manifest.description,
    ...(manifest.operations || []).flatMap((operation) => [
      `operation ${operation.operationId || ""} ${operation.description || ""}`,
      ...(operation.inputs || []).map((input) => [
        "input", input.name, input.type, input.required === false ? "optional" : "required",
        input.description, input.bindingHint?.source, input.bindingHint?.resolver,
        input.bindingHint?.subject, input.bindingHint?.property,
      ].filter(Boolean).join(" ")),
      ...(operation.outputs || []).map((output) => [
        "output", output.name, output.type, output.required === false ? "optional" : "required",
        output.description, output.bindingHint?.source, output.bindingHint?.resolver,
        output.bindingHint?.subject, output.bindingHint?.property,
      ].filter(Boolean).join(" ")),
    ]),
  ].filter(Boolean).join(" ").replace(/\s+/g, " ").trim().slice(0, 6_000);
  const exactSearched = unwrapRouteValue((await actorState.client.call("search", {
    body: { text: semanticQuery, topK: 60, bandWindow: 512 },
  })).data);
  const listedManifest = (listed?.manifests || []).find((item) =>
    String(item?.entityId || "") === String(manifest.entityId)
  );
  const searchCandidate = (searched?.results || []).find((item) =>
    String(item?.su || "") === String(manifest.entityId)
  );
  const exactCandidate = (exactSearched?.results || []).find((item) =>
    String(item?.su || "") === String(manifest.entityId)
  );
  return {
    registryAvailable: !!listedManifest,
    positionAvailable: !!searchCandidate,
    canUse: searchCandidate?.canUse === true,
    exactPositionAvailable: !!exactCandidate,
    exactCanUse: exactCandidate?.canUse === true,
    searchCandidate: searchCandidate ? {
      su: String(searchCandidate.su),
      policy_id: searchCandidate.policy_id || null,
      perm: searchCandidate.perm || null,
      canUse: searchCandidate.canUse === true,
      bandDelta: searchCandidate.bandDelta ?? null,
    } : null,
    listedCount: Array.isArray(listed?.manifests) ? listed.manifests.length : 0,
    searchCount: Array.isArray(searched?.results) ? searched.results.length : 0,
    exactSearchCount: Array.isArray(exactSearched?.results) ? exactSearched.results.length : 0,
    operationEvidence: (manifest.operations || []).map((operation) => ({
      operationId: operation.operationId,
      inputs: (operation.inputs || []).map((input) => ({
        name: input.name,
        source: input.bindingHint?.source || null,
        resolver: input.bindingHint?.resolver || null,
      })),
      utteranceExamples: (operation.utteranceExamples || []).slice(0, 12),
    })),
  };
}

export async function pollCapabilityPublication(inspect, {
  attempts = 12,
  wait = (ms) => new Promise((resolve) => setTimeout(resolve, ms)),
  delayMs = 1_000,
} = {}) {
  let publication = null;
  for (let attempt = 1; attempt <= attempts; attempt += 1) {
    publication = await inspect();
    if (publication.registryAvailable && publication.positionAvailable && publication.canUse) {
      return publication;
    }
    if (attempt < attempts) await wait(delayMs);
  }
  return publication;
}

export function assertFreshCapabilityBuild(result) {
  const status = String(result?.build?.status || "");
  if (status !== "BUILT_AND_REGISTERED") {
    throw new Error(
      `Clean-start sharing proof requires a newly built capability, received ${status || "unknown"}`
    );
  }
  return status;
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

export function operationSubjectInput(operation, requested = "") {
  const inputs = new Set((operation?.inputs || []).map((input) => String(input?.name || "")).filter(Boolean));
  const explicit = String(requested || "").trim();
  if (explicit && inputs.has(explicit)) return explicit;
  const effectSubjects = [...new Set((operation?.contextEffects || [])
    .map((effect) => String(effect?.subjectInput || "").trim())
    .filter((name) => name && inputs.has(name)))];
  if (effectSubjects.length === 1) return effectSubjects[0];
  const entityReferences = (operation?.inputs || []).filter((input) => (
    input?.required !== false
    && String(input?.bindingHint?.source || "").toLowerCase() === "utterance"
    && ["entity", "entity_reference", "resolved_entity"].includes(
      String(input?.bindingHint?.resolver || "").toLowerCase().replace(/[ -]+/g, "_")
    )
  ));
  if (entityReferences.length === 1) return String(entityReferences[0].name);
  throw new Error("The selected Compute operation does not expose one exact invocation subject input");
}

async function invoke(actorState, runtime, manifest, operation, step, entityUseBindings = []) {
  const subjectInput = operationSubjectInput(operation, step.subjectInput);
  const execution = await runtime.invokeComputePath(
    computePath(manifest, operation, { entityUseBindings }),
    {
      graphSnapshot: actorState.graphStore.getSnapshot(),
      sentence: step.input,
      inputOverrides: { [subjectInput]: step.subjectValue },
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
  const authorBuildStatus = assertFreshCapabilityBuild(built.result);
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
  const publication = await pollCapabilityPublication(
    () => inspectPublishedCapability(installer, built.manifest, invocation.input)
  );
  if (!publication.registryAvailable || !publication.positionAvailable || !publication.canUse) {
    throw new Error(`Built Compute definition is not reusable by User 2: ${JSON.stringify(publication)}`);
  }
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
      cleanStart: true,
      authorBuildStatus,
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
      publication,
    },
    authorAnswers: authorResults.map((result) => result.answer || result.responseSentence || null).filter(Boolean),
    installerAnswer: execution.answer,
    installerVerification: verification.responseSentence,
  };
}

export async function runCrossUserComputeScenario(file, options) {
  return runCrossUserComputeScenarioObject(JSON.parse(fs.readFileSync(file, "utf8")), options);
}
