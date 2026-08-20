/**
 * Platform: Reuses the website's published Context acknowledgement contract in headless scenarios.
 * Technical: Publishes graph deltas and remaps temporary graph identities to authoritative server IDs.
 */
import vm from "node:vm";

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

export function retainProtectedEntityReferences(actor, snapshot) {
  actor.protectedEntityReferences ||= new Map();
  for (const [entityId, reference] of Object.entries(snapshot?.protectedEntityReferences || {})) {
    if (entityId && /^protected_asset:pa_[a-zA-Z0-9_-]{16,160}$/.test(String(reference || ""))) {
      actor.protectedEntityReferences.set(entityId, String(reference));
    }
  }
  for (const [entityId, entity] of Object.entries(snapshot?.entities || {})) {
    const reference = String(entity?.protectedAssetReference || "");
    if (/^protected_asset:pa_[a-zA-Z0-9_-]{16,160}$/.test(reference)) {
      actor.protectedEntityReferences.set(entityId, reference);
    }
  }
  return actor.protectedEntityReferences;
}

export function publicationRelationIds(before = {}, after = {}) {
  const beforeRelations = before.relations || {};
  const afterRelations = after.relations || {};
  const addedRelationIds = Object.keys(afterRelations).filter((id) => !beforeRelations[id]);
  const removedRelationIds = Object.keys(beforeRelations).filter((id) => !afterRelations[id]);
  const changedRelationIds = Object.keys(afterRelations).filter((id) => (
    !!beforeRelations[id]
    && JSON.stringify(beforeRelations[id]) !== JSON.stringify(afterRelations[id])
  ));
  const changedEntityIds = Object.keys(after.entities || {}).filter((id) => (
    !!before.entities?.[id]
    && JSON.stringify(before.entities[id]) !== JSON.stringify(after.entities[id])
  ));
  const carrierRelationIds = changedEntityIds.flatMap((entityId) => {
    const relation = Object.values(afterRelations).find((candidate) => (
      candidate?.subj === entityId || candidate?.prop === entityId || candidate?.obj === entityId
    ));
    return relation?.id ? [relation.id] : [];
  });
  return {
    addedRelationIds: [...new Set([
      ...addedRelationIds,
      ...changedRelationIds,
      ...carrierRelationIds,
    ])],
    removedRelationIds,
  };
}

export async function publishDelta(actor, before, after, source, contextPublication) {
  const { addedRelationIds, removedRelationIds } = publicationRelationIds(before, after);
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
  const relationIdMap = Object.fromEntries((result?.relations || [])
    .map((relation) => [String(relation?.localId || ""), String(relation?.serverId || "")])
    .filter(([localId, serverId]) => localId && serverId));
  const remapped = contextPublication.remapGraphSnapshotEntityIds(after, idMap, relationIdMap);
  retainProtectedEntityReferences(actor, remapped);
  actor.graphStore.loadSnapshot(remapped);
  return { nodes: (result?.nodes || []).length, relations: (result?.relations || []).length };
}
