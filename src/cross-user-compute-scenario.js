/**
 * Platform: Proves that one user's Compute entity can be installed as a new ID-bound local Path for another user.
 * Technical: Builds with actor one, discovers with actor two's bounded ordinary graph evidence, applies scoped entity-use bindings, and verifies local effects.
 */
import fs from "node:fs";
import { StateStore } from "./state-store.js";
import { OneVarApiClient } from "./api-client.js";
import {
  actorProfiles,
  hydrateCurrentActor,
  hydrateNamed,
} from "./cross-user-context-scenario.js";
import {
  loadPublishedContextPublication,
  publishDelta,
} from "./context-publication.js";
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
    ...(relation.publisherId ? { publisherId: String(relation.publisherId) } : {}),
    ...(Number(relation.version) > 0 ? { version: Number(relation.version) } : {}),
    ...(relation.contextSource ? { contextSource: String(relation.contextSource) } : {}),
  }));
  const invocationText = String(history.at(-1) || "").toLowerCase();
  const speakerCandidates = (graph?.mentions?.speaker?.entities || [])
    .map(String).filter((entityId) => entityIds.has(entityId));
  const speakerId = speakerCandidates.length === 1 ? speakerCandidates[0] : "";
  const mentionEntries = Object.entries(graph?.mentions || {}).map(([mention, record]) => [
    mention,
    (Array.isArray(record?.entities) ? record.entities : [])
      .map(String).filter((entityId) => entityIds.has(entityId)),
  ]);
  const resolvedMention = mentionEntries
    .map(([mention, record]) => {
      const candidates = record;
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
  const normalizedInvocation = invocationText.replace(/[\u2018\u2019]/g, "'");
  const possessive = normalizedInvocation
    .match(/(?:'s|s')\s+([a-z0-9][a-z0-9 .-]*?)(?=[.,!?]|$)/i);
  let qualifiedReferent = null;
  let capabilityQuery = null;
  if (possessive) {
    const ownerPrefix = normalizedInvocation.slice(0, possessive.index).trim();
    const ownerEntry = mentionEntries
      .filter(([mention]) => {
        const normalizedMention = String(mention).toLowerCase();
        return ownerPrefix === normalizedMention || ownerPrefix.endsWith(` ${normalizedMention}`);
      })
      .sort((left, right) => right[0].length - left[0].length)[0];
    const ownerText = String(ownerEntry?.[0] || "").toLowerCase();
    const objectText = possessive[1].trim();
    const objectEntry = mentionEntries.find(([mention]) => (
      String(mention).toLowerCase() === objectText
    ));
    const ownerIds = new Set((ownerEntry?.[1] || []).map(String));
    const objectIds = new Set((objectEntry?.[1] || []).map(String));
    const ownershipWords = new Set(["have", "has", "own", "owns", "possess", "possesses"]);
    const entityWords = (id) => [
      ...(graph?.entities?.[id]?.names || []),
      ...(graph?.entities?.[id]?.lemmas || []),
    ].map((value) => String(value).toLowerCase());
    const targets = [...new Set(relations.filter((relation) => (
      ownerIds.has(relation.subj)
      && objectIds.has(relation.obj)
      && entityWords(relation.prop).some((word) => ownershipWords.has(word))
    )).map((relation) => relation.obj))];
    const owners = [...ownerIds].filter((id) => entityIds.has(id));
    if (owners.length === 1 && targets.length === 1) {
      const phraseStart = possessive.index - ownerText.length;
      const phraseEnd = possessive.index + possessive[0].length;
      qualifiedReferent = {
        role: "qualified_owner",
        mention: ownerText,
        mentionKey: ownerText,
        entityId: owners[0],
        resolvedLocally: true,
        resolution: "contextdb_exact",
        targetEntityId: targets[0],
        targetMention: `${ownerText}'s ${objectText}`,
        targetResolvedLocally: true,
        targetResolution: "qualified-owner-edge",
      };
      capabilityQuery = `${normalizedInvocation.slice(0, phraseStart)}${objectText}`
        + normalizedInvocation.slice(phraseEnd);
      capabilityQuery = capabilityQuery.trim();
    }
  }
  return {
    recentInputs: history.slice(-20).map((text) => ({ text, inputKind: "statement", semanticEntity: null })),
    relatedContext: { entities, relations },
    ...(capabilityQuery ? { capabilityQuery } : {}),
    invocationReferents: qualifiedReferent ? [qualifiedReferent] : (resolvedMention ? [{
      role: "qualified_owner",
      mention: resolvedMention[0],
      mentionKey: resolvedMention[0],
      entityId: String(resolvedMention[1]),
      resolvedLocally: true,
      resolution: "contextdb_exact",
    }] : []),
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

async function invoke(actorState, runtime, manifest, operation, step, entityUseBindings = [], {
  contextPublication = null,
  publishOwnerDelta = false,
} = {}) {
  const subjectInput = operationSubjectInput(operation, step.subjectInput);
  const before = actorState.graphStore.getSnapshot();
  const execution = await runtime.invokeComputePath(
    computePath(manifest, operation, { entityUseBindings }),
    {
      graphSnapshot: actorState.graphStore.getSnapshot(),
      sentence: step.input,
      inputOverrides: { [subjectInput]: step.subjectValue },
      allocateEntityId: () => actorState.graphStore.allocateEntityId?.(),
      fetchImpl: authenticatedFetch(actorState.stateStore, fetch),
      requestId: step.requestId,
    }
  );
  if (!execution.ok) throw new Error(`${step.name || step.input}: ${JSON.stringify(execution.error)}`);
  assertEqual(execution.answer, step.expect.answer, step.name || step.input);
  const delegatedEffects = (execution.contextEffects || []).filter((effect) => (
    effect?.status === "requested" && effect?.authority === "owner-published-capability"
  ));
  if (delegatedEffects.length) {
    const effectAck = unwrapRouteValue((await actorState.client.call("contextGraphApplyCapabilityEffects", {
      path: [actorState.workspaceId],
      body: {
        schemaVersion: 1,
        idempotencyKey: `effect-${step.requestId}`,
        capabilityId: execution.computePlan.capabilityId,
        entityId: execution.computePlan.entityId,
        version: execution.computePlan.version,
        operationId: execution.computePlan.operationId,
        effects: delegatedEffects,
        source: { requestId: step.requestId, sentence: step.input },
      },
    })).data);
    if (effectAck?.ok === false) {
      throw new Error(`${step.name || step.input}: delegated effect failed: ${JSON.stringify(effectAck.error)}`);
    }
    const acknowledgements = new Map((effectAck?.effects || []).map((effect) => [
      String(effect.sourceDependencyId || ""), effect,
    ]));
    const valueIdMap = new Map();
    execution.contextEffects = execution.contextEffects.map((effect) => {
      if (effect?.authority !== "owner-published-capability") return effect;
      const acknowledgement = acknowledgements.get(String(effect.sourceDependencyId || ""));
      if (!acknowledgement?.valueEntityId || !acknowledgement?.relationId) {
        throw new Error(`${step.name || step.input}: delegated effect acknowledgement was incomplete`);
      }
      valueIdMap.set(String(effect.valueEntityId || ""), String(acknowledgement.valueEntityId));
      return {
        ...effect,
        valueEntityId: String(acknowledgement.valueEntityId),
        targetRelationVersion: Number(acknowledgement.relationVersion || 0),
        delegatedStatus: String(acknowledgement.status || "applied"),
      };
    });
    execution.mutationOps = (execution.mutationOps || []).flatMap((mutation) => {
      if (mutation?.type === "entity:create") {
        const replacementId = valueIdMap.get(String(mutation?.payload?.id || ""));
        if (!replacementId) return [mutation];
        if (before.entities?.[replacementId]) return [];
        return [{ ...mutation, payload: { ...mutation.payload, id: replacementId } }];
      }
      if (mutation?.type === "relation:rewire") {
        const replacementId = valueIdMap.get(String(mutation?.payload?.obj || ""));
        return replacementId
          ? [{ ...mutation, payload: { ...mutation.payload, obj: replacementId } }]
          : [mutation];
      }
      return [mutation];
    });
  }
  if (execution.mutationOps?.length) {
    const applied = actorState.graphStore.applyMutationOps(execution.mutationOps);
    if (!applied?.ok) throw new Error(`Context effect failed: ${JSON.stringify(applied?.errors || [])}`);
  }
  if (publishOwnerDelta && execution.mutationOps?.length) {
    if (!contextPublication) throw new Error("Owner Context publication runtime is unavailable");
    await publishDelta(actorState, before, actorState.graphStore.getSnapshot(), {
      requestId: step.requestId,
      sentence: step.input,
    }, contextPublication);
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
  const contextPublication = await loadPublishedContextPublication(config.websiteUrl, fetch);
  await hydrateCurrentActor(author, contextPublication);
  await hydrateCurrentActor(installer, contextPublication);
  const authorHistory = [];
  const authorSetup = [];

  for (const [index, step] of scenario.author.setup.entries()) {
    authorHistory.push(step.input);
    const before = author.graphStore.getSnapshot();
    const execution = executeEssence(author, semanticPaths, step);
    authorSetup.push(execution);
    await publishDelta(author, before, author.graphStore.getSnapshot(), {
      requestId: `carwash-author-setup-${index + 1}`,
      sentence: step.input,
    }, contextPublication);
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
  for (const [index, step] of scenario.author.steps.entries()) {
    authorHistory.push(step.input);
    if (step.type === "invoke") {
      authorResults.push(await invoke(
        author,
        runtime,
        built.manifest,
        authorOperation,
        step,
        [],
        { contextPublication, publishOwnerDelta: true }
      ));
      continue;
    }
    const before = author.graphStore.getSnapshot();
    const execution = executeEssence(author, semanticPaths, step);
    authorResults.push(execution);
    if (execution.kind === "statement") {
      await publishDelta(author, before, author.graphStore.getSnapshot(), {
        requestId: `carwash-author-step-${index + 1}`,
        sentence: step.input,
      }, contextPublication);
    }
  }

  const installerHistory = [];
  for (const step of scenario.installer.setup) {
    installerHistory.push(step.input);
    const before = installer.graphStore.getSnapshot();
    const execution = executeEssence(installer, semanticPaths, step);
    if (execution.kind === "statement") {
      await publishDelta(installer, before, installer.graphStore.getSnapshot(), {
        requestId: `carwash-installer-setup-${installerHistory.length}`,
        sentence: step.input,
      }, contextPublication);
    }
  }
  const invocation = scenario.installer.invoke;
  if (Array.isArray(scenario.installer.hydrateNamed) && scenario.installer.hydrateNamed.length) {
    await hydrateNamed(installer, scenario.installer.hydrateNamed, contextPublication);
  }
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
    entityUseBindings,
    { contextPublication, publishOwnerDelta: false }
  );
  if (!execution.contextEffects?.every((effect) => effect.sourceDependencyId && effect.targetEntityId)) {
    throw new Error("User 2 execution did not use the exact app dependency binding");
  }
  const verification = executeEssence(installer, semanticPaths, scenario.installer.verify);
  let authorServiceVerification = null;
  if (scenario.author.verifyAfterService) {
    await hydrateCurrentActor(author, contextPublication);
    authorServiceVerification = executeEssence(
      author,
      semanticPaths,
      scenario.author.verifyAfterService
    );
  }

  return {
    name: scenario.name,
    passed: scenario.author.setup.length
      + scenario.author.steps.length
      + scenario.installer.setup.length
      + 3
      + (scenario.author.verifyAfterService ? 1 : 0),
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
    authorServiceVerification: authorServiceVerification?.responseSentence || null,
  };
}

export async function runCrossUserComputeScenario(file, options) {
  return runCrossUserComputeScenarioObject(JSON.parse(fs.readFileSync(file, "utf8")), options);
}
