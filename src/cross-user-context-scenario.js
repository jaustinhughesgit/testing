/**
 * Platform: Proves chronological cross-user Context publication, refresh, and local Path answers with separate test accounts.
 * Technical: Executes deployed semantic Paths, publishes graph deltas through authenticated profiles, rehydrates named public components, and queries the deployed graph runtime.
 */
import fs from "node:fs";
import vm from "node:vm";
import { StateStore } from "./state-store.js";
import { OneVarApiClient } from "./api-client.js";
import { loadPublishedGraphStore } from "./message-scenario.js";
import { loadPublishedSemanticPathRuntime } from "./compute-scenario.js";

function endpoint(websiteUrl, pathname) {
  return new URL(pathname, `${String(websiteUrl).replace(/\/+$/, "")}/`).toString();
}

function unwrapResponse(value) {
  return value?.response ?? value;
}

export async function loadPublishedContextPublication(websiteUrl, fetchImpl) {
  const url = endpoint(websiteUrl, "/workers/contextPublicationWorkerLib.js");
  const response = await fetchImpl(url);
  if (!response.ok) throw new Error(`${url} failed with HTTP ${response.status}`);
  const sandbox = { console, structuredClone };
  sandbox.globalThis = sandbox;
  sandbox.self = sandbox;
  vm.runInNewContext(await response.text(), sandbox, { filename: url });
  const library = sandbox.oneVarContextPublication;
  if (
    typeof library?.deltaEnvelope !== "function"
    || typeof library?.remapGraphSnapshotEntityIds !== "function"
    || typeof library?.mergeHydrationPage !== "function"
  ) throw new Error("The published website Context publication runtime is incomplete");
  return library;
}

export function actorProfiles(scenario, profileNames) {
  const actors = Array.isArray(scenario?.actors) ? scenario.actors.map(String) : [];
  const profiles = String(profileNames || "").split(",").map((value) => value.trim()).filter(Boolean);
  if (!actors.length || actors.length !== profiles.length) {
    throw new Error(`--profiles must supply one profile for each actor: ${actors.join(",") || "(none)"}`);
  }
  return Object.fromEntries(actors.map((actor, index) => [actor, profiles[index]]));
}

function assertAnswer(step, answer, diagnostics = {}) {
  const expected = step?.expect?.answer;
  if (!expected) return;
  const actual = Array.isArray(answer) ? answer.map(String) : [];
  if (
    !Array.isArray(expected)
    || expected.length !== actual.length
    || expected.some((value, index) => String(value) !== actual[index])
  ) throw new Error(
    `${step.name || step.input}: expected ${JSON.stringify(expected)}, received ${JSON.stringify(actual)}; `
    + `bindings ${JSON.stringify(diagnostics.bindings || {})}; essence ${JSON.stringify(diagnostics.essence || [])}`
  );
}

function stableTextId(value) {
  let hash = 2166136261;
  for (const character of String(value || "")) {
    hash ^= character.codePointAt(0);
    hash = Math.imul(hash, 16777619);
  }
  return (hash >>> 0).toString(16).padStart(8, "0");
}

export async function publishDelta(actor, before, after, source, contextPublication) {
  const addedRelationIds = Object.keys(after.relations || {}).filter((id) => !before.relations?.[id]);
  const removedRelationIds = Object.keys(before.relations || {}).filter((id) => !after.relations?.[id]);
  const payload = contextPublication.deltaEnvelope({
    before,
    after,
    addedRelationIds,
    removedRelationIds,
    source,
    idempotencyKey: source.requestId,
    userReferences: [],
  });
  if (!payload.relations.length) throw new Error(`${source.requestId}: semantic Path produced no publishable graph delta`);
  const result = unwrapResponse((await actor.client.call("contextGraphPublish", {
    path: [actor.workspaceId],
    body: payload,
  })).data);
  if (result?.ok === false) {
    throw new Error(
      `${source.requestId}: Context publication was rejected: `
      + `${result?.error?.code || result?.error?.message || JSON.stringify(result)}`
    );
  }
  const idMap = Object.fromEntries((result?.nodes || [])
    .map((node) => [String(node?.localId || ""), String(node?.serverId || "")])
    .filter(([localId, serverId]) => localId && serverId));
  actor.graphStore.loadSnapshot(contextPublication.remapGraphSnapshotEntityIds(after, idMap));
  return { nodes: (result?.nodes || []).length, relations: (result?.relations || []).length };
}

export async function hydrateNamed(actor, labels, contextPublication) {
  let working = actor.graphStore.getSnapshot();
  const users = [];
  for (const rawLabel of labels) {
    const query = String(rawLabel || "").trim();
    let cursor = null;
    let pages = 0;
    let namedServerId = "";
    const snapshot = actor.graphStore.getSnapshot();
    const exactEntityIds = Object.values(snapshot.entities || {})
      .filter((entity) => (entity?.names || []).some((name) => (
        String(name).trim().toLowerCase() === query.toLowerCase()
      )))
      .map((entity) => String(entity.id || ""))
      .filter(Boolean);
    const preferredEntityId = exactEntityIds.length === 1 ? exactEntityIds[0] : "";
    do {
      const page = unwrapResponse((await actor.client.call("contextGraphHydrateNamed", {
        path: [actor.workspaceId],
        body: {
          schemaVersion: 1,
          query,
          ...(preferredEntityId ? { entityId: preferredEntityId } : {}),
          cursor,
          limit: 300,
        },
      })).data);
      pages += 1;
      if (page?.ambiguous === true) throw new Error(`Named hydration for ${query} is ambiguous`);
      if (page?.found !== true) throw new Error(`Named hydration did not find ${query}`);
      namedServerId ||= String(page.namedServerId || "");
      working = contextPublication.mergeHydrationPage(working, page, {});
      cursor = String(page?.cursor || "") || null;
    } while (cursor && pages < 20);
    users.push({ query, namedServerId, pages });
  }
  actor.graphStore.loadSnapshot(working);
  return users;
}

export async function hydrateCurrentActor(actor, contextPublication) {
  let working = actor.graphStore.getSnapshot();
  let cursor = null;
  let pages = 0;
  do {
    const page = unwrapResponse((await actor.client.call("contextGraphHydrate", {
      path: [actor.workspaceId],
      body: { schemaVersion: 1, cursor, limit: 300 },
    })).data);
    working = contextPublication.mergeHydrationPage(working, page, {});
    cursor = String(page?.cursor || "") || null;
    pages += 1;
  } while (cursor && pages < 20);
  actor.graphStore.loadSnapshot(working);
}

export async function runCrossUserContextScenarioObject(scenario, {
  config,
  profileNames,
  fetchImpl = fetch,
} = {}) {
  if (!config?.apiUrl || !config?.originalHost || !config?.websiteUrl) {
    throw new Error("apiUrl, originalHost, and websiteUrl are required");
  }
  if (!Array.isArray(scenario?.steps) || !scenario.steps.length) {
    throw new Error("Cross-user Context scenario requires ordered steps");
  }
  const profiles = actorProfiles(scenario, profileNames);
  const contextPublication = await loadPublishedContextPublication(config.websiteUrl, fetchImpl);
  const semanticPaths = await loadPublishedSemanticPathRuntime(config.websiteUrl, fetchImpl);
  const actors = {};
  for (const actorName of scenario.actors) {
    const stateStore = new StateStore(config.stateDirectory, profiles[actorName]);
    const state = stateStore.load();
    const workspaceId = String(state.subdomain || "");
    if (!workspaceId || !state.accessToken) {
      throw new Error(`Actor ${actorName} profile ${profiles[actorName]} is not bootstrapped`);
    }
    actors[actorName] = {
      stateStore,
      workspaceId,
      graphStore: await loadPublishedGraphStore(config.websiteUrl, fetchImpl),
      client: new OneVarApiClient({ ...config, stateStore, fetchImpl }),
    };
    await hydrateCurrentActor(actors[actorName], contextPublication);
  }

  const results = [];
  for (const [index, step] of scenario.steps.entries()) {
    const actor = actors[String(step.actor || "")];
    if (!actor) throw new Error(`Step ${index + 1} names unknown actor ${step.actor || "(blank)"}`);
    if (step.type === "statement") {
      const before = actor.graphStore.getSnapshot();
      const execution = semanticPaths.execute(step.equationId, step.input, actor.graphStore);
      if (execution.kind !== "statement") throw new Error(`${step.name || step.input} is not a statement Path`);
      const publication = await publishDelta(actor, before, actor.graphStore.getSnapshot(), {
        requestId: `cross-user-v2-${index + 1}-${stableTextId(`${actor.workspaceId}\n${step.input}`)}`,
        sentence: String(step.input || ""),
      }, contextPublication);
      results.push({ name: step.name || `step ${index + 1}`, type: step.type, actor: step.actor, publication });
      continue;
    }
    if (step.type === "hydrate") {
      const users = await hydrateNamed(actor, step.labels || [], contextPublication);
      results.push({ name: step.name || `step ${index + 1}`, type: step.type, actor: step.actor, users });
      continue;
    }
    if (step.type === "question") {
      if (Array.isArray(step.refreshLabels) && step.refreshLabels.length) {
        await hydrateNamed(actor, step.refreshLabels, contextPublication);
      }
      const execution = semanticPaths.execute(step.equationId, step.input, actor.graphStore);
      if (execution.kind !== "question") throw new Error(`${step.name || step.input} is not a question Path`);
      assertAnswer(step, execution.answer, execution);
      results.push({
        name: step.name || `step ${index + 1}`,
        type: step.type,
        actor: step.actor,
        answer: execution.answer,
      });
      continue;
    }
    throw new Error(`Step ${index + 1} has unsupported type ${step.type}`);
  }
  return { name: scenario.name || "cross-user Context scenario", passed: results.length, results };
}

export async function runCrossUserContextScenario(file, options) {
  return runCrossUserContextScenarioObject(JSON.parse(fs.readFileSync(file, "utf8")), options);
}
