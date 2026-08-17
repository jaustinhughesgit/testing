/**
 * Platform: Proves one generic message-to-ContextDB-to-Compute chain across ordinary and zero-trust data.
 * Technical: Reuses the deployed semantic, graph, presentation, Convert, Compute, notification, and grant contracts.
 */
import fs from "node:fs";
import vm from "node:vm";
import { StateStore } from "./state-store.js";
import { OneVarApiClient } from "./api-client.js";
import { loadPublishedGraphStore } from "./message-scenario.js";
import {
  actorProfiles,
  hydrateCurrentActor,
  hydrateNamed,
  loadPublishedContextPublication,
  publishDelta,
} from "./cross-user-context-scenario.js";
import {
  authenticatedFetch,
  buildCapability,
  computePath,
  loadComputeRuntime,
  loadPublishedSemanticPathRuntime,
} from "./compute-scenario.js";
import {
  approveProtectedTextAccess,
  createProtectedText,
  requestProtectedTextAccess,
  useSharedProtectedText,
} from "./protected-assets.js";

function endpoint(websiteUrl, pathname) {
  return new URL(pathname, `${String(websiteUrl).replace(/\/+$/, "")}/`).toString();
}

function unwrap(value) {
  return value?.response ?? value;
}

async function loadProtectedPresentationRuntime(websiteUrl, fetchImpl) {
  const urls = [
    "/workers/pathBindingWorkerLib.js",
    "/workers/protectedSemanticInputWorkerLib.js",
    "/workers/protectedPresentationWorkerLib.js",
  ].map((pathname) => endpoint(websiteUrl, pathname));
  const responses = await Promise.all(urls.map((url) => fetchImpl(url)));
  responses.forEach((response, index) => {
    if (!response.ok) throw new Error(`${urls[index]} failed with HTTP ${response.status}`);
  });
  const sandbox = { console, structuredClone };
  sandbox.globalThis = sandbox;
  sandbox.self = sandbox;
  for (let index = 0; index < responses.length; index += 1) {
    vm.runInNewContext(await responses[index].text(), sandbox, { filename: urls[index] });
  }
  if (
    typeof sandbox.protectedPresentationWorkerLib?.graphViews !== "function"
    || typeof sandbox.protectedPresentationWorkerLib?.resolvedQueryGraph !== "function"
  ) throw new Error("The published protected presentation runtime is incomplete");
  return sandbox.protectedPresentationWorkerLib;
}

function stableTextId(value) {
  let hash = 2166136261;
  for (const character of String(value || "")) {
    hash ^= character.codePointAt(0);
    hash = Math.imul(hash, 16777619);
  }
  return (hash >>> 0).toString(16).padStart(8, "0");
}

function exactNamedEntity(actor, label) {
  const normalized = String(label || "").trim().toLowerCase();
  const matches = Object.values(actor.graphStore.getSnapshot().entities || {}).filter((entity) => (
    (entity?.names || []).some((name) => String(name).trim().toLowerCase() === normalized)
  ));
  if (matches.length !== 1) throw new Error(`Expected exactly one hydrated entity named ${label}, found ${matches.length}`);
  return matches[0];
}

function assertStep(step, execution) {
  if (step.expect?.answer) {
    const actual = (execution.answer || []).map(String);
    const expected = step.expect.answer.map(String);
    if (JSON.stringify(actual) !== JSON.stringify(expected)) {
      throw new Error(`${step.name || step.input}: expected answer ${JSON.stringify(expected)}, received ${JSON.stringify(actual)}`);
    }
  }
  if (step.expect?.response && execution.responseSentence !== step.expect.response) {
    throw new Error(
      `${step.name || step.input}: expected response ${JSON.stringify(step.expect.response)}, `
      + `received ${JSON.stringify(execution.responseSentence)}`
    );
  }
}

function scenarioVariables(scenario) {
  const ownerName = String(
    process.env[String(scenario?.ownerNameEnv || "ONEVAR_TEST_OWNER_NAME")]
    || scenario?.ownerName
    || "Austin"
  ).trim();
  return { ownerName };
}

function substitute(value, variables) {
  if (typeof value === "string") {
    return value.replace(/\{\{([a-zA-Z0-9_]+)\}\}/g, (_match, name) => {
      if (!Object.hasOwn(variables, name)) throw new Error(`Unknown scenario variable ${name}`);
      return String(variables[name]);
    });
  }
  if (Array.isArray(value)) return value.map((entry) => substitute(entry, variables));
  if (value && typeof value === "object") {
    return Object.fromEntries(Object.entries(value).map(([key, entry]) => [key, substitute(entry, variables)]));
  }
  return value;
}

export async function runSeamlessCapabilityScenarioObject(rawScenario, {
  config,
  profileNames,
  fetchImpl = fetch,
  progress = () => {},
} = {}) {
  if (!config?.apiUrl || !config?.originalHost || !config?.websiteUrl) {
    throw new Error("apiUrl, originalHost, and websiteUrl are required");
  }
  const scenario = substitute(rawScenario, scenarioVariables(rawScenario));
  const profiles = actorProfiles(scenario, profileNames);
  const contextPublication = await loadPublishedContextPublication(config.websiteUrl, fetchImpl);
  const semanticPaths = await loadPublishedSemanticPathRuntime(config.websiteUrl, fetchImpl);
  const protectedPresentation = await loadProtectedPresentationRuntime(config.websiteUrl, fetchImpl);
  const computeRuntime = await loadComputeRuntime(config.websiteUrl, fetchImpl);
  const actors = {};
  for (const actorName of scenario.actors) {
    const stateStore = new StateStore(config.stateDirectory, profiles[actorName]);
    const state = stateStore.load();
    if (!state.subdomain || !state.accessToken) {
      throw new Error(`Actor ${actorName} profile ${profiles[actorName]} is not bootstrapped`);
    }
    actors[actorName] = {
      stateStore,
      workspaceId: String(state.subdomain),
      graphStore: await loadPublishedGraphStore(config.websiteUrl, fetchImpl),
      client: new OneVarApiClient({ ...config, stateStore, fetchImpl }),
    };
    await hydrateCurrentActor(actors[actorName], contextPublication);
  }

  const memory = { protected: {}, capabilities: {} };
  const results = [];
  for (const [index, step] of scenario.steps.entries()) {
    const actor = actors[String(step.actor || "")];
    if (!actor) throw new Error(`Step ${index + 1} names unknown actor ${step.actor || "(blank)"}`);
    progress({ index: index + 1, name: step.name || step.type, type: step.type });

    if (step.type === "statement") {
      const before = actor.graphStore.getSnapshot();
      const execution = semanticPaths.execute(step.equationId, step.input, actor.graphStore);
      const publication = await publishDelta(actor, before, actor.graphStore.getSnapshot(), {
        requestId: `seamless-${index + 1}-${stableTextId(`${actor.workspaceId}\n${step.input}`)}`,
        sentence: step.input,
      }, contextPublication);
      results.push({ type: step.type, actor: step.actor, input: step.input, publication });
      continue;
    }

    if (step.type === "hydrate") {
      const users = await hydrateNamed(actor, step.labels || [], contextPublication);
      results.push({ type: step.type, actor: step.actor, users });
      continue;
    }

    if (step.type === "question") {
      if (step.refreshLabels?.length) await hydrateNamed(actor, step.refreshLabels, contextPublication);
      const execution = semanticPaths.execute(step.equationId, step.input, actor.graphStore);
      assertStep(step, execution);
      results.push({
        type: step.type, actor: step.actor, input: step.input,
        answer: execution.answer, response: execution.responseSentence,
      });
      continue;
    }

    if (step.type === "protectedStatement") {
      const secret = String(process.env[String(step.secretEnv || "ONEVAR_TEST_PROTECTED_VALUE")] || "");
      if (!secret) throw new Error(`${step.secretEnv || "ONEVAR_TEST_PROTECTED_VALUE"} is required`);
      const created = await createProtectedText(actor.client, actor.stateStore, {
        text: secret,
        label: step.label || "Protected semantic value",
      });
      const reference = String(created?.asset?.reference || actor.stateStore.load().lastProtectedAssetReference || "");
      const before = actor.graphStore.getSnapshot();
      semanticPaths.execute(step.equationId, step.semanticInput, actor.graphStore);
      const views = protectedPresentation.graphViews(before, actor.graphStore.getSnapshot(), [{
        semanticText: secret,
        reference,
      }]);
      const publication = await publishDelta(actor, before, views.publication, {
        requestId: `seamless-protected-${index + 1}-${stableTextId(`${actor.workspaceId}\n${step.input}`)}`,
        sentence: step.input,
      }, contextPublication);
      memory.protected[step.as || "default"] = { reference, owner: step.actor };
      results.push({
        type: step.type, actor: step.actor, input: step.input,
        reference, protectedEntityCount: views.protectedEntityIds.size, publication,
      });
      continue;
    }

    if (step.type === "protectedQuestion") {
      if (step.refreshLabels?.length) await hydrateNamed(actor, step.refreshLabels, contextPublication);
      const execution = semanticPaths.execute(step.equationId, step.input, actor.graphStore);
      const graph = actor.graphStore.getSnapshot();
      const prefix = protectedPresentation.relationRowsBeforeAggregates(execution.essence);
      const details = actor.graphStore.queryByEssenceTemplates(prefix);
      const references = protectedPresentation.requestableQueryReferences(details, new Map(), graph);
      const expectedReference = memory.protected[step.asset || "default"]?.reference;
      if (!expectedReference || !references.includes(expectedReference)) {
        throw new Error(`${step.name || step.input}: protected query did not retain its requestable asset reference`);
      }
      memory.protected[step.asset || "default"].query = { execution, references };
      results.push({
        type: step.type, actor: step.actor, input: step.input,
        permissionRequired: true, referenceCount: references.length,
      });
      continue;
    }

    if (step.type === "requestProtectedAccess") {
      const item = memory.protected[step.asset || "default"];
      const requested = await requestProtectedTextAccess(
        actor.client,
        item.reference,
        `seamless-${actor.workspaceId}-${index + 1}`
      );
      item.requestId = String(requested.requestId || "");
      item.requester = step.actor;
      results.push({ type: step.type, actor: step.actor, requestId: item.requestId });
      continue;
    }

    if (step.type === "receiveProtectedRequest") {
      const item = memory.protected[step.asset || "default"];
      const inbox = unwrap((await actor.client.call("notifications", {
        path: ["inbox"], body: { limit: 50 },
      })).data);
      const notification = (inbox?.notifications || []).find((entry) => (
        entry?.kind === "protected_access_request" && entry?.payload?.requestId === item.requestId
      ));
      if (!notification) throw new Error(`Owner notification for ${item.requestId} was not delivered`);
      item.notificationId = notification.notificationId;
      results.push({ type: step.type, actor: step.actor, received: true });
      continue;
    }

    if (step.type === "approveProtectedAccess") {
      const item = memory.protected[step.asset || "default"];
      const requester = actors[item.requester];
      const decision = await approveProtectedTextAccess(actor.client, actor.stateStore, {
        requestId: item.requestId,
        notificationId: item.notificationId,
        reference: item.reference,
        requesterUserId: requester.stateStore.load().userId,
        grantDuration: step.grantDuration || "15_minutes",
      });
      if (String(decision?.decision || "") !== "approved") throw new Error("Protected access was not approved");
      results.push({
        type: step.type, actor: step.actor, decision: "approved",
        grantDuration: step.grantDuration || "15_minutes",
      });
      continue;
    }

    if (step.type === "resolvedProtectedQuestion") {
      const item = memory.protected[step.asset || "default"];
      const values = await useSharedProtectedText(actor.client, actor.stateStore, item.reference, item.requestId);
      const graph = actor.graphStore.getSnapshot();
      const entityReferences = Object.fromEntries(Object.entries(graph.entities || {})
        .filter(([, entity]) => entity?.protectedAssetReference === item.reference)
        .map(([entityId]) => [entityId, item.reference]));
      const resolvedGraph = protectedPresentation.resolvedQueryGraph(
        graph,
        entityReferences,
        { [item.reference]: values }
      );
      const temporaryStore = await loadPublishedGraphStore(config.websiteUrl, fetchImpl);
      temporaryStore.loadSnapshot(resolvedGraph);
      const execution = semanticPaths.execute(step.equationId, step.input, temporaryStore);
      assertStep(step, execution);
      results.push({
        type: step.type, actor: step.actor, input: step.input,
        answer: execution.answer, response: execution.responseSentence,
        decryptedLocally: true,
      });
      continue;
    }

    if (step.type === "buildCapability") {
      const built = await buildCapability(actor.client, actor.workspaceId, step.build, (status) => (
        progress({ index: index + 1, name: step.name || step.type, type: step.type, ...status })
      ));
      memory.capabilities[step.as || "default"] = built;
      results.push({
        type: step.type, actor: step.actor,
        capabilityId: built.manifest.capabilityId,
        entityId: built.manifest.entityId,
        buildStatus: built.result?.build?.status || "CAPABILITY_REUSED",
      });
      continue;
    }

    if (step.type === "invokeCapability") {
      const built = memory.capabilities[step.capability || "default"];
      if (!built) throw new Error(`Capability ${step.capability || "default"} has not been built`);
      if (step.refreshLabels?.length) await hydrateNamed(actor, step.refreshLabels, contextPublication);
      const operationId = String(step.operationId || built.manifest.operations?.[0]?.operationId || "");
      const operation = built.manifest.operations.find((entry) => entry.operationId === operationId);
      if (!operation) throw new Error(`Built manifest omitted operation ${operationId}`);
      const contextBindingHints = {};
      const referentMemory = [];
      if (step.contextSubject) {
        const subject = exactNamedEntity(actor, step.contextSubject);
        for (const input of operation.inputs || []) {
          if (String(input?.bindingHint?.source || "").toLowerCase() !== "contextdb") continue;
          contextBindingHints[input.name] = {
            ...input.bindingHint,
            source: "contextdb",
            subject: step.contextSubject,
            subjectEntityId: subject.id,
          };
          referentMemory.push({
            role: "context_subject",
            mentionKey: String(step.contextSubject).toLowerCase(),
            entityId: subject.id,
            inputNames: [input.name],
            successfulUses: 1,
            corrections: 0,
          });
        }
      }
      const execution = await computeRuntime.invokeComputePath(
        computePath(built.manifest, operation, { contextBindingHints, referentMemory }),
        {
          graphSnapshot: actor.graphStore.getSnapshot(),
          sentence: step.input,
          fetchImpl: authenticatedFetch(actor.stateStore, fetchImpl),
          requestId: `seamless-compute-${index + 1}`,
        }
      );
      if (!execution.ok || execution.clarification) {
        throw new Error(`Compute invocation did not complete: ${JSON.stringify(execution.error || execution.clarification)}`);
      }
      if (step.expect?.response && execution.answer !== step.expect.response) {
        throw new Error(`${step.name || step.input}: expected ${JSON.stringify(step.expect.response)}, received ${JSON.stringify(execution.answer)}`);
      }
      results.push({
        type: step.type, actor: step.actor, input: step.input,
        response: execution.answer,
        inputBindings: execution.computePlan?.inputBindings || [],
      });
      continue;
    }

    throw new Error(`Step ${index + 1} has unsupported type ${step.type}`);
  }

  return {
    name: scenario.name || "seamless capability scenario",
    passed: results.length,
    results,
  };
}

export async function runSeamlessCapabilityScenario(file, options) {
  return runSeamlessCapabilityScenarioObject(JSON.parse(fs.readFileSync(file, "utf8")), options);
}
