/**
 * Platform: Proves the public Convert-to-Compute lifecycle against browser-local ContextDB state from a command prompt.
 * Technical: Polls public Convert jobs, loads published graph/compute runtimes, resolves manifest bindings locally, and invokes the created entity through the normal API route.
 */
import fs from "node:fs";
import vm from "node:vm";
import { executeMessageStep, loadPublishedGraphStore } from "./message-scenario.js";
import { loadPublishedContextPublication, publishDelta } from "./context-publication.js";

const wait = (milliseconds) => new Promise((resolve) => setTimeout(resolve, milliseconds));

function unwrap(value) {
  let current = value;
  for (let index = 0; index < 12; index += 1) {
    if (!current || typeof current !== "object" || Array.isArray(current)) break;
    if (current.build || current.capabilityManifest || current.computeDiscovery) return current;
    if (current.oai?.html && typeof current.oai.html === "object") current = current.oai.html;
    else if (current.response && typeof current.response === "object") current = current.response;
    else if (current.html && typeof current.html === "object") current = current.html;
    else break;
  }
  return current;
}

function boundedDiagnostic(value) {
  try { return JSON.stringify(value).slice(0, 4_000); }
  catch { return String(value); }
}

function convertFailureDiagnostic(result) {
  return boundedDiagnostic({
    keys: result && typeof result === "object" ? Object.keys(result) : [],
    error: result?.error || null,
    errorDetails: result?.errorDetails || null,
    diagnostics: result?.diagnostics || null,
    computeDiscovery: result?.computeDiscovery ? {
      decision: result.computeDiscovery.decision || null,
      source: result.computeDiscovery.source || null,
      confidence: result.computeDiscovery.confidence ?? null,
      reason: result.computeDiscovery.reason || null,
      existingEntityId: result.computeDiscovery.existingManifest?.entityId || null,
      existingCapabilityId: result.computeDiscovery.existingManifest?.capabilityId || null,
    } : null,
    build: result?.build ? {
      status: result.build.status || null,
      error: result.build.error || null,
      errorDetails: result.build.errorDetails || null,
      diagnostics: result.build.diagnostics || null,
      failure: result.build.failure || null,
    } : null,
  });
}

export function isRetryableDiscoveryFailure(result) {
  return result?.errorDetails?.retryable === true
    && String(result.errorDetails.stage || "") === "compute_discovery";
}

function findManifest(value, seen = new Set()) {
  if (!value || typeof value !== "object" || seen.has(value)) return null;
  seen.add(value);
  if (
    Number(value.schemaVersion) === 1
    && value.capabilityId
    && value.entityId
    && Array.isArray(value.operations)
  ) return value;
  for (const child of Array.isArray(value) ? value : Object.values(value)) {
    const found = findManifest(child, seen);
    if (found) return found;
  }
  return null;
}

export function selectCapabilityManifest(value) {
  const direct = value?.capabilityManifest;
  if (
    Number(direct?.schemaVersion) === 1
    && direct.capabilityId
    && direct.entityId
    && Array.isArray(direct.operations)
  ) return direct;
  return findManifest(value);
}

export function selectReusableCapabilityManifest(value, status) {
  if (String(status || "") === "CAPABILITY_EXTENSION_REQUIRED") {
    throw new Error("Convert discovery requires an entity extension, which this create/reuse scenario does not perform");
  }
  return selectCapabilityManifest(value);
}

function requirementEnvelope(segments, authoringContext = null) {
  const normalized = segments.map((segment, index) => {
    const text = String(segment || "").replace(/\s+/g, " ").trim();
    if (!text) throw new Error(`Convert segment ${index + 1} is empty`);
    return index < segments.length - 1 && !/[.!?]["']?$/.test(text) ? `${text}.` : text;
  });
  return {
    schemaVersion: 1,
    kind: "convertRequirements",
    userRequest: normalized.join("\n"),
    requirementSegments: normalized,
    relevantItems: [],
    ...(authoringContext ? { authoringContext } : {}),
  };
}

async function callConvert(client, workspaceId, body, { retries = 4 } = {}) {
  let attempt = 0;
  while (true) {
    try {
      return unwrap((await client.call("convert", { path: [workspaceId], body })).data);
    } catch (error) {
      if (![429, 502, 503, 504].includes(Number(error?.status)) || attempt >= retries) throw error;
      await wait(500 * (2 ** attempt++));
    }
  }
}

export async function buildCapability(client, workspaceId, build, progress = () => {}) {
  const prompt = requirementEnvelope(build.requirementSegments || [], build.authoringContext || null);
  let discoveryJobId = null;
  let discoveryReplacements = 0;
  let capabilityRequest = null;
  let blueprintId = "entity.declarative.remote.v1";
  for (let poll = 0; poll < 90; poll += 1) {
    const result = await callConvert(client, workspaceId, {
      llmTemplateId: build.llmTemplateId || "original-v1",
      prompt,
      computeDiscovery: true,
      discoveryOnly: true,
      backgroundComputeDiscovery: true,
      computeDiscoveryJobId: discoveryJobId,
    });
    const status = String(result?.build?.status || "");
    progress({ phase: "discovery", status, poll: poll + 1 });
    if (isRetryableDiscoveryFailure(result) && discoveryReplacements < 2) {
      discoveryReplacements += 1;
      discoveryJobId = null;
      progress({
        phase: "discovery-replacement",
        status: result.errorDetails.code || "RETRYABLE_DISCOVERY_FAILURE",
        poll: discoveryReplacements,
      });
      continue;
    }
    if (status === "DISCOVERY_PENDING") {
      discoveryJobId = String(result?.build?.backgroundJob?.jobId || discoveryJobId || "");
      if (!discoveryJobId) throw new Error("Convert discovery omitted its job id");
      await wait(Math.max(250, Number(result?.build?.backgroundJob?.retryAfterMs || 2_000)));
      continue;
    }
    if (status !== "CAPABILITY_BUILD_REQUIRED") {
      const manifest = selectReusableCapabilityManifest(result, status);
      if (manifest) return { result, manifest, prompt };
      throw new Error(
        `Convert discovery stopped with ${status || "an unknown status"}: ${convertFailureDiagnostic(result)}`
      );
    }
    capabilityRequest = result?.build?.capabilityRequest;
    blueprintId = String(result?.computeDiscovery?.buildCommand?.blueprintId || blueprintId);
    break;
  }
  if (!capabilityRequest) throw new Error("Convert discovery did not return a capability contract");

  const expectedBinding = build.expectBinding || null;
  if (expectedBinding) {
    const inputs = capabilityRequest.operations?.flatMap((operation) => operation.inputs || []) || [];
    const matched = inputs.some((input) =>
      input.name === expectedBinding.name
      && input.bindingHint?.source === expectedBinding.source
      && input.bindingHint?.subject === expectedBinding.subject
      && input.bindingHint?.property === expectedBinding.property
    );
    if (!matched) throw new Error(`Convert contract did not preserve expected binding ${JSON.stringify(expectedBinding)}`);
  }

  let buildId = null;
  let computeBuildJobId = null;
  let buildContinuation = null;
  for (let poll = 0; poll < 120; poll += 1) {
    const result = await callConvert(client, workspaceId, {
      llmTemplateId: build.llmTemplateId || "original-v1",
      prompt,
      capabilityRequest,
      buildComputeCapability: true,
      backgroundComputeBuild: true,
      computeBuildJobId,
      blueprintId,
      buildId,
      buildContinuation,
    });
    const status = String(result?.build?.status || "");
    progress({ phase: "build", status, poll: poll + 1 });
    if (status === "BUILD_PENDING") {
      buildId = String(result?.build?.buildId || buildId || "");
      computeBuildJobId = String(result?.build?.backgroundJob?.jobId || computeBuildJobId || "");
      if (!buildId || !computeBuildJobId) throw new Error("Convert build omitted continuation identity");
      await wait(Math.max(250, Number(result?.build?.backgroundJob?.retryAfterMs || 2_000)));
      continue;
    }
    if (status === "BUILD_RETRY_REQUIRED") {
      buildId = String(result?.build?.buildId || buildId || "");
      buildContinuation = result?.build?.continuation;
      computeBuildJobId = null;
      if (!buildId || !buildContinuation) throw new Error("Convert build retry omitted continuation state");
      continue;
    }
    const manifest = selectCapabilityManifest(result);
    if (!manifest) {
      const contractEffects = (capabilityRequest?.operations || []).map((operation) => ({
        operationId: operation.operationId,
        contextEffects: operation.contextEffects || [],
      }));
      throw new Error(
        `Convert build stopped with ${status || "an unknown status"}: ${convertFailureDiagnostic(result)}; `
        + `contract effects ${boundedDiagnostic(contractEffects)}`
      );
    }
    return { result, manifest, prompt, capabilityRequest };
  }
  throw new Error("Convert build exceeded its bounded polling window");
}

export async function discoverExistingCapability(
  client,
  workspaceId,
  utterance,
  semanticEvidence,
  progress = () => {}
) {
  const prompt = {
    schemaVersion: 1,
    userRequest: String(utterance || "").trim(),
    requirementSegments: [],
    relevantItems: semanticEvidence ? [semanticEvidence] : [],
  };
  let discoveryJobId = null;
  let discoveryReplacements = 0;
  for (let poll = 0; poll < 90; poll += 1) {
    const result = await callConvert(client, workspaceId, {
      llmTemplateId: "original-v1",
      prompt,
      computeDiscovery: true,
      discoveryOnly: true,
      backgroundComputeDiscovery: true,
      computeDiscoveryJobId: discoveryJobId,
    });
    const status = String(result?.build?.status || "");
    progress({ phase: "reuse-discovery", status, poll: poll + 1 });
    if (isRetryableDiscoveryFailure(result) && discoveryReplacements < 2) {
      discoveryReplacements += 1;
      discoveryJobId = null;
      progress({
        phase: "reuse-discovery-replacement",
        status: result.errorDetails.code || "RETRYABLE_DISCOVERY_FAILURE",
        poll: discoveryReplacements,
      });
      continue;
    }
    if (status === "DISCOVERY_PENDING") {
      discoveryJobId = String(result?.build?.backgroundJob?.jobId || discoveryJobId || "");
      if (!discoveryJobId) throw new Error("Reuse discovery omitted its job id");
      await wait(Math.max(250, Number(result?.build?.backgroundJob?.retryAfterMs || 2_000)));
      continue;
    }
    if (status !== "CAPABILITY_REUSED") {
      throw new Error(`Expected CAPABILITY_REUSED, received ${status || "unknown"}: ${convertFailureDiagnostic(result)}`);
    }
    const manifest = selectCapabilityManifest(result);
    if (!manifest) throw new Error("Reuse discovery omitted the exact capability manifest");
    return { result, manifest, discovery: result.computeDiscovery || null, prompt };
  }
  throw new Error("Reuse discovery exceeded its bounded polling window");
}

export async function loadComputeRuntime(websiteUrl, fetchImpl) {
  const url = new URL("/workers/computeCapabilityWorkerLib.js", `${websiteUrl.replace(/\/+$/, "")}/`).toString();
  const response = await fetchImpl(url);
  if (!response.ok) throw new Error(`${url} failed with HTTP ${response.status}`);
  const sandbox = { console };
  sandbox.globalThis = sandbox;
  sandbox.self = sandbox;
  vm.runInNewContext(await response.text(), sandbox, { filename: url });
  if (typeof sandbox.createComputeCapabilityRuntime !== "function") {
    throw new Error("Published website did not expose createComputeCapabilityRuntime");
  }
  return sandbox.createComputeCapabilityRuntime();
}

export async function loadPublishedSemanticPathRuntime(websiteUrl, fetchImpl) {
  const base = `${websiteUrl.replace(/\/+$/, "")}/`;
  const urls = [
    "https://public.1var.com/compromise.js",
    "https://public.1var.com/compromise-numbers.js",
    new URL("/workers/pathBindingWorkerLib.js", base).toString(),
    new URL("/workers/pathResponseWorkerLib.js", base).toString(),
    new URL("/workers/semanticEntityCompilerWorkerLib.js", base).toString(),
    new URL("/workers/patternWorkerLib.js", base).toString(),
  ];
  const responses = await Promise.all(urls.map((url) => fetchImpl(url)));
  responses.forEach((response, index) => {
    if (!response.ok) throw new Error(`${urls[index]} failed with HTTP ${response.status}`);
  });
  const sources = await Promise.all(responses.map((response) => response.text()));
  const datasetUrl = new URL("/modules/_pathbuilder/semantic-graph-path-dataset.json", base).toString();
  const datasetResponse = await fetchImpl(datasetUrl);
  if (!datasetResponse.ok) throw new Error(`${datasetUrl} failed with HTTP ${datasetResponse.status}`);
  const dataset = await datasetResponse.json();
  const sandbox = { console, structuredClone };
  sandbox.globalThis = sandbox;
  sandbox.self = sandbox;
  sources.forEach((source, index) => vm.runInNewContext(source, sandbox, { filename: urls[index] }));
  if (sandbox.compromiseNumbers && typeof sandbox.nlp?.extend === "function") {
    sandbox.nlp.extend(sandbox.compromiseNumbers);
  }
  if (
    typeof sandbox.nlp !== "function"
    || typeof sandbox.pathResponseWorkerLib?.render !== "function"
    || typeof sandbox.createPatternRuntimeV3 !== "function"
    || typeof sandbox.oneVarSemanticEntityCompiler?.compileEquation !== "function"
  ) throw new Error("Published semantic Path runtime is incomplete");
  const patternRuntime = sandbox.createPatternRuntimeV3();
  const installed = patternRuntime.installSubpatterns(dataset.capabilityFramework?.subpatterns || [], { replace: true });
  if (!installed.ok) throw new Error(`Published subpatterns failed validation: ${installed.errors?.join("; ")}`);
  let instanceCounter = 0;

  const requestTimeValues = (now = new Date()) => {
    const timeZone = Intl.DateTimeFormat().resolvedOptions().timeZone || "UTC";
    const dateParts = Object.fromEntries(
      new Intl.DateTimeFormat("en-CA", {
        timeZone,
        year: "numeric",
        month: "2-digit",
        day: "2-digit",
      }).formatToParts(now).map((part) => [part.type, part.value]),
    );
    const date = `${dateParts.year}-${dateParts.month}-${dateParts.day}`;
    const offsetPart = new Intl.DateTimeFormat("en-US", {
      timeZone,
      timeZoneName: "longOffset",
    }).formatToParts(now).find((part) => part.type === "timeZoneName")?.value || "GMT";
    const offsetMatch = offsetPart.match(/^GMT([+-]\d{2}:\d{2})$/);
    const offset = offsetMatch?.[1] || "+00:00";
    return {
      dateStartIso: `${date}T00:00:00${offset}`,
      dateEndIso: `${date}T23:59:59${offset}`,
      timeZone,
      dateGranularity: "date",
    };
  };

  const tokensFor = (text) => {
    const doc = sandbox.nlp(String(text || "")).compute("tagger").compute("root");
    const directTerms = doc.terms().json();
    const hasTags = directTerms.some((term) =>
      Array.isArray(term?.tags) ? term.tags.length : Object.keys(term?.tags || {}).length
    );
    const terms = hasTags
      ? directTerms
      : (doc.json() || []).flatMap((sentence) => sentence?.terms || []);
    return terms.map((term) => ({
      text: term?.text ?? "",
      normal: term?.normal ?? "",
      lemma: String(term?.root || term?.normal || "").toLowerCase(),
      tags: Array.isArray(term?.tags)
        ? term.tags.map(String)
        : Object.keys(term?.tags || {}).filter((tag) => term.tags[tag]),
    }));
  };
  const bindingValue = (binding, tokens, graphStore, requestTime) => {
    if (binding.source === "currentSpeaker") return "speaker";
    if (binding.source === "literal") return binding.literal;
    if (binding.source === "requestTime") {
      const value = requestTime[binding.value];
      if (value == null) throw new Error(`Command Path requestTime value ${binding.value} is unsupported`);
      return value;
    }
    if (binding.source !== "token") throw new Error(`Command Path binding source ${binding.source} is unsupported`);
    const start = Math.max(1, Number(binding.token || 1));
    const end = Math.max(start, Number(binding.tokenEnd || start));
    const selected = tokens.slice(start - 1, end);
    if (binding.value === "number") {
      const raw = selected.map((token) => String(token.normal || token.text || token.lemma || ""))
        .filter(Boolean).join(" ");
      return sandbox.oneVarPathBindingWorkerLib?.parseNumberValue?.(raw) ?? raw;
    }
    // Entity identity must preserve the normalized surface form. Linguistic
    // roots are correct for verbs/nouns but can stem a person's name (for
    // example a name ending in "verified") and break exact positioning.
    const field = binding.value === "text"
      ? "text"
      : (["normal", "resolvedEntity", "existingRelatedEntity", "resolvedEntityList"].includes(binding.value) ? "normal" : "lemma");
    const value = selected.map((token) => String(token[field] || "").toLowerCase()).filter(Boolean).join(" ");
    if (["resolvedEntity", "existingRelatedEntity"].includes(binding.value)) {
      if (binding.value === "existingRelatedEntity" && typeof graphStore.getSnapshot !== "function") return "";
      const graph = graphStore.getSnapshot();
      const lemmaValue = selected.map((token) => String(token.lemma || token.normal || token.text || "").toLowerCase())
        .filter(Boolean).join(" ");
      const mentionKeys = sandbox.oneVarPathBindingWorkerLib?.mentionResolutionKeys?.(value, lemmaValue)
        || [value];
      const candidates = [...new Set(mentionKeys.flatMap((key) => (
        graph.mentions?.[key]?.entities || []
      )))].filter((entityId) => graph.entities?.[entityId]);
      if (binding.value === "existingRelatedEntity") {
        const subjectCandidates = (graph.mentions?.speaker?.entities || [])
          .filter((entityId) => graph.entities?.[entityId]);
        const subjectId = subjectCandidates.length === 1 ? subjectCandidates[0] : "";
        const related = subjectId ? candidates.filter((entityId) => Object.values(graph.relations || {}).some(
          (relation) => relation.subj === subjectId && relation.obj === entityId
        )) : [];
        return related.length === 1 ? related[0] : "";
      }
      const exactNames = candidates.filter((entityId) => (
        graph.entities[entityId].names || []
      ).some((name) => mentionKeys.includes(String(name).toLowerCase())));
      const exactNamed = sandbox.oneVarPathBindingWorkerLib?.uniquelyNamedMentionCandidate?.(
        graph,
        candidates,
        mentionKeys
      ) || "";
      const resolved = exactNamed || (exactNames.length === 1 ? exactNames[0] : (candidates.length === 1 ? candidates[0] : ""));
      if (resolved) return resolved;
    }
    return value;
  };
  const resolveCell = (cell, bindings, graphStore) => {
    if (!cell || typeof cell !== "object" || Array.isArray(cell)) return cell;
    if (cell.ref === "binding") return bindings[cell.name];
    if (cell.ref === "instanceBinding") {
      const baseName = String(bindings[cell.name] || cell.name || "entity")
        .toLowerCase().replace(/[^a-z0-9_]+/g, "_");
      return `@instance:${baseName}:${instanceCounter}`;
    }
    if (cell.ref === "boundVar") {
      const variableName = String(cell.name || "").replace(/^\{|\}$/g, "").trim();
      const value = bindings[cell.base];
      const entityId = String(value || "").trim();
      return graphStore.getSnapshot().entities?.[entityId]
        ? { var: variableName, entityId, lemma: "" }
        : { var: variableName, entityId: "", lemma: String(value || "").trim().toLowerCase() };
    }
    throw new Error(`Command Path row reference ${cell.ref || "unknown"} is unsupported`);
  };
  const resolveValue = (value, bindings, graphStore) => {
    if (Array.isArray(value)) return value.map((entry) => resolveValue(entry, bindings, graphStore));
    if (!value || typeof value !== "object") return value;
    if (value.ref) return resolveCell(value, bindings, graphStore);
    return Object.fromEntries(Object.entries(value).map(([name, entry]) => [
      name,
      resolveValue(entry, bindings, graphStore),
    ]));
  };

  return {
    execute(equationId, text, graphStore) {
      const equation = dataset.equations?.find((entry) => entry.id === equationId);
      if (!equation) throw new Error(`Published semantic equation ${equationId} was not found`);
      const path = sandbox.oneVarSemanticEntityCompiler.compileEquation(equation, dataset.entities);
      const tokens = tokensFor(text);
      const match = patternRuntime.matchPath(path, tokens, { identifiedKind: path.left?.state?.pattern?.kind });
      if (!match.matched) {
        throw new Error(
          `Published semantic Path ${equationId} did not match: ${match.reason || "unknown"}; `
          + `tokens ${JSON.stringify(tokens)}; details ${JSON.stringify(match)}`
        );
      }
      instanceCounter += 1;
      const requestTime = requestTimeValues();
      const specs = new Map((path.right?.state?.bindings || []).map((binding) => [binding.name, binding]));
      for (const binding of match.bindings || []) specs.set(binding.name, { ...specs.get(binding.name), ...binding });
      const bindings = Object.fromEntries([...specs].map(([name, binding]) => [
        name,
        bindingValue(binding, tokens, graphStore, requestTime),
      ]));
      const baseRows = (path.right?.state?.rows || []).map((row) =>
        row.map((cell) => resolveCell(cell, bindings, graphStore))
      );
      const present = (value) => Array.isArray(value)
        ? value.length > 0
        : value != null && String(value).trim() !== "";
      const conditionalRows = (path.right?.state?.conditionalRows || []).flatMap((conditional) => {
        const whenAll = (conditional?.whenAll || []).map(String);
        const whenAny = (conditional?.whenAny || []).map(String);
        const whenNone = (conditional?.whenNone || []).map(String);
        if (!whenAll.every((name) => present(bindings[name]))) return [];
        if (whenAny.length && !whenAny.some((name) => present(bindings[name]))) return [];
        if (!whenNone.every((name) => !present(bindings[name]))) return [];
        return (conditional?.rows || []).map((row) =>
          row.map((cell) => resolveCell(cell, bindings, graphStore))
        );
      });
      const rows = sandbox.oneVarPathBindingWorkerLib?.orderConstraintRowsBeforeAggregates
        ? sandbox.oneVarPathBindingWorkerLib.orderConstraintRowsBeforeAggregates(baseRows, conditionalRows)
        : [...baseRows, ...conditionalRows];
      const mode = path.right?.state?.mode || "statement";
      let answer = [];
      let queryValues = {};
      if (mode === "question") {
        const query = graphStore.queryByEssenceTemplates(rows);
        answer = Array.from(query?.vars?.ask || []);
        queryValues = query?.vars || {};
      } else {
        if (path.right?.state?.transaction) {
          const transaction = resolveValue(path.right.state.transaction, bindings, graphStore);
          const applied = graphStore.applyDeclarativeTransaction(transaction);
          if (!applied?.ok) {
            throw new Error(`Published semantic Path ${equationId} transaction failed: ${JSON.stringify(applied?.errors || [])}`);
          }
        }
        graphStore.ingestEssenceRows(rows, {
          writePolicy: path.right?.state?.writePolicy || null,
        });
      }
      const resolveEntity = (value) => {
        const entity = graphStore.getSnapshot?.()?.entities?.[String(value || "")];
        return entity?.names?.[0] || entity?.lemmas?.[0] || value;
      };
      const responseValues = sandbox.pathResponseWorkerLib.values(
        bindings,
        queryValues,
        { resolveEntity }
      );
      const responseSentence = mode === "question"
        ? sandbox.pathResponseWorkerLib.render(path.right?.state?.responseTemplate || "{{ask|join:, }}", responseValues)
        : "";
      return {
        name: equationId,
        input: text,
        kind: mode,
        execution: "published-semantic-path",
        answer,
        responseSentence,
        operations: [],
        mutations: [],
        essence: rows,
        bindings,
      };
    },
  };
}

export function computePath(manifest, operation, {
  contextBindingHints = {}, referentMemory = [], entityUseBindings = [],
} = {}) {
  return {
    left: { state: { pattern: { kind: "question", operation: "invoke_compute_capability", slotDefinitions: [] } } },
    right: {
      lib: "computeCapability",
      state: {
        schemaVersion: 3,
        mode: "question",
        operation: "invoke_compute_capability",
        compute: {
          schemaVersion: 1,
          capabilityId: manifest.capabilityId,
          entityId: manifest.entityId,
          version: manifest.version,
          operationId: operation.operationId,
          inputs: operation.inputs || [],
          entityDependencies: operation.entityDependencies || [],
          entityUseBindings,
          contextBindingHints,
          referentMemory,
          outputs: operation.outputs || [],
          contextEffects: operation.contextEffects || [],
          execution: {
            readOnly: manifest.execution?.readOnly === true,
            timeoutMs: Number(manifest.execution?.timeoutMs || 0),
          },
          protectedAssetRequirements: operation.protectedAssetRequirements || [],
          freshness: operation.freshness || { mode: "none", ttlSeconds: 0 },
          answerTemplate: operation.answerTemplate,
        },
      },
    },
  };
}

export function authenticatedFetch(stateStore, fetchImpl) {
  return async (url, options = {}) => {
    const token = stateStore.load().accessToken;
    const headers = new Headers(options.headers || {});
    if (token) {
      headers.set("Cookie", `accessToken=${encodeURIComponent(token)}`);
      headers.set("X-accessToken", token);
    }
    return fetchImpl(url, { ...options, headers });
  };
}

export async function runComputeScenarioObject(scenario, {
  client,
  stateStore,
  websiteUrl,
  fetchImpl = fetch,
  progress = () => {},
} = {}) {
  if (!client || !stateStore || !websiteUrl) throw new Error("client, stateStore, and websiteUrl are required");
  const workspaceId = String(stateStore.load().subdomain || "");
  if (!workspaceId) throw new Error("The selected profile has no workspace; run account bootstrap first");
  const graphStore = await loadPublishedGraphStore(websiteUrl, fetchImpl);
  const semanticPaths = await loadPublishedSemanticPathRuntime(websiteUrl, fetchImpl);
  const publishSetupContext = (scenario.setup || []).some((step) => step.publishContext === true);
  const contextPublication = publishSetupContext
    ? await loadPublishedContextPublication(websiteUrl, fetchImpl)
    : null;
  const publicationActor = { client, workspaceId, graphStore };
  const setupResults = [];
  for (const [index, step] of (scenario.setup || []).entries()) {
    const before = graphStore.getSnapshot();
    const result = step.execution === "published-semantic-path"
      ? semanticPaths.execute(step.equationId, step.input, graphStore)
      : await executeMessageStep(step, { websiteUrl, fetchImpl, graphStore, index });
    if (step.expect?.kind && result.kind !== step.expect.kind) {
      throw new Error(`Expected setup Essence kind ${step.expect.kind}, received ${result.kind}`);
    }
    if (step.expect?.execution && result.execution !== step.expect.execution) {
      throw new Error(`Expected setup execution ${step.expect.execution}, received ${result.execution}`);
    }
    const publication = step.publishContext === true
      ? await publishDelta(publicationActor, before, graphStore.getSnapshot(), {
          requestId: `compute-setup-v1-${workspaceId}-${index + 1}`,
          sentence: String(step.input || ""),
        }, contextPublication)
      : null;
    setupResults.push({ type: "essence", ...result, ...(publication ? { publication } : {}) });
  }
  const build = {
    ...(scenario.build || {}),
    authoringContext: scenario.build?.authoringContext || (setupResults.length ? {
      schemaVersion: 1,
      kind: "convertAuthoringContext",
      recentInputs: setupResults.slice(-20).map((result) => ({
        text: result.input,
        inputKind: result.kind,
        semanticEntity: null,
      })),
      essence: setupResults.flatMap((result) => result.essence || []).slice(-120),
    } : null),
  };
  const built = await buildCapability(client, workspaceId, build, progress);
  const runtime = await loadComputeRuntime(websiteUrl, fetchImpl);
  const operationId = String(scenario.build?.operationId || built.manifest.operations?.[0]?.operationId || "");
  const operation = built.manifest.operations?.find((item) => item.operationId === operationId);
  if (!operation) throw new Error(`Built manifest omitted operation ${operationId}`);
  if (scenario.build?.expectContextEffect) {
    const expected = scenario.build.expectContextEffect;
    const matched = (operation.contextEffects || []).some((effect) =>
      Object.entries(expected).every(([name, value]) => String(effect?.[name]) === String(value))
    );
    if (!matched) {
      throw new Error(`Built manifest omitted expected ContextDB effect ${JSON.stringify(expected)}; received ${JSON.stringify(operation.contextEffects || [])}`);
    }
  }
  if (Array.isArray(scenario.build?.expectUtterances)) {
    const normalizeUtterance = (value) => String(value || "")
      .toLowerCase().replace(/[.!?]+$/g, "").replace(/\s+/g, " ").trim();
    for (const expected of scenario.build.expectUtterances) {
      const example = (operation.utteranceExamples || []).find((candidate) =>
        normalizeUtterance(typeof candidate === "string" ? candidate : candidate?.text)
          === normalizeUtterance(expected)
      );
      if (!example) {
        throw new Error(`Built manifest omitted required invocation ${JSON.stringify(expected)}`);
      }
      if (scenario.build.expectAnnotatedUtterances === true) {
        const requiredNames = (operation.inputs || []).filter((input) =>
          input?.required !== false && String(input?.bindingHint?.source || "").toLowerCase() === "utterance"
        ).map((input) => input.name);
        const missing = requiredNames.filter((name) =>
          typeof example !== "object" || !Object.prototype.hasOwnProperty.call(example.inputs || {}, name)
        );
        if (missing.length) {
          throw new Error(`Invocation ${JSON.stringify(expected)} omitted required input annotation(s): ${missing.join(", ")}`);
        }
        const expectedValue = scenario.build.expectUtteranceValues?.[expected];
        if (expectedValue != null && requiredNames.length === 1) {
          const actualValue = example.inputs?.[requiredNames[0]];
          if (String(actualValue).toLowerCase() !== String(expectedValue).toLowerCase()) {
            throw new Error(
              `Invocation ${JSON.stringify(expected)} expected ${requiredNames[0]}=${JSON.stringify(expectedValue)}, `
              + `received ${JSON.stringify(actualValue)}`
            );
          }
        }
      }
    }
  }
  const path = computePath(built.manifest, operation);
  const transport = authenticatedFetch(stateStore, fetchImpl);
  const results = [...setupResults];

  const exampleInputs = (input) => {
    const key = String(input || "").toLowerCase().replace(/[.!?]+$/g, "").replace(/\s+/g, " ").trim();
    const example = (operation.utteranceExamples || []).find((candidate) => {
      const text = typeof candidate === "string" ? candidate : candidate?.text;
      return String(text || "").toLowerCase().replace(/[.!?]+$/g, "").replace(/\s+/g, " ").trim() === key;
    });
    return example && typeof example === "object" && !Array.isArray(example)
      ? { ...(example.inputs || {}) }
      : {};
  };

  for (const [index, step] of (scenario.steps || []).entries()) {
    if (step.type === "essence") {
      const result = step.execution === "published-semantic-path"
        ? semanticPaths.execute(step.equationId, step.input, graphStore)
        : await executeMessageStep(step, {
          websiteUrl,
          fetchImpl,
          graphStore,
          index,
        });
      if (step.expect?.kind && result.kind !== step.expect.kind) {
        throw new Error(`Expected Essence kind ${step.expect.kind}, received ${result.kind}`);
      }
      if (step.expect?.execution && result.execution !== step.expect.execution) {
        throw new Error(`Expected Essence execution ${step.expect.execution}, received ${result.execution}`);
      }
      if (step.expect?.answer && JSON.stringify(result.answer || []) !== JSON.stringify(step.expect.answer)) {
        throw new Error(
          `Expected Essence answer ${JSON.stringify(step.expect.answer)}, received ${JSON.stringify(result.answer || [])}; `
          + `essence ${JSON.stringify(result.essence || [])}`
        );
      }
      if (step.expect?.responseSentence && result.responseSentence !== step.expect.responseSentence) {
        throw new Error(
          `Expected response sentence ${JSON.stringify(step.expect.responseSentence)}, received ${JSON.stringify(result.responseSentence || "")}`
        );
      }
      results.push({ type: "essence", ...result });
      continue;
    }
    if (step.type !== "invoke") throw new Error(`Scenario step ${index + 1} has unsupported type ${step.type}`);
    const inputOverrides = { ...exampleInputs(step.input), ...(step.inputs || {}) };
    if (step.subjectValue != null) {
      const candidates = (operation.inputs || []).filter((input) =>
        input?.required !== false && String(input?.bindingHint?.source || '').toLowerCase() === 'utterance'
      );
      if (candidates.length !== 1) {
        throw new Error(
          `subjectValue requires exactly one required utterance input, received ${candidates.length}: `
          + boundedDiagnostic(candidates)
        );
      }
      inputOverrides[candidates[0].name] = step.subjectValue;
    }
    const execution = await runtime.invokeComputePath(path, {
      graphSnapshot: graphStore.getSnapshot(),
      sentence: String(step.input || ""),
      inputOverrides,
      fetchImpl: transport,
      requestId: `command-scenario-${index + 1}`,
    });
    if (!execution.ok) throw new Error(`Compute invocation failed: ${JSON.stringify(execution.error)}`);
    if (step.expect?.answer && execution.answer !== step.expect.answer) {
      throw new Error(
        `Expected answer ${JSON.stringify(step.expect.answer)}, received ${JSON.stringify(execution.answer)}; `
        + `plan ${JSON.stringify(execution.computePlan)}; operation ${boundedDiagnostic(operation)}; `
        + `graph ${JSON.stringify(graphStore.getSnapshot())}`
      );
    }
    if (step.expect?.input) {
      const binding = execution.computePlan?.inputBindings?.find((item) => item.name === step.expect.input.name);
      if (!binding || String(binding.value) !== String(step.expect.input.value)) {
        throw new Error(`Expected resolved input ${JSON.stringify(step.expect.input)}, received ${JSON.stringify(binding)}`);
      }
    }
    if (step.expect?.mutationCount != null && execution.mutationOps?.length !== Number(step.expect.mutationCount)) {
      throw new Error(`Expected ${step.expect.mutationCount} mutation operations, received ${execution.mutationOps?.length || 0}`);
    }
    if (execution.mutationOps?.length) {
      const applied = graphStore.applyMutationOps(execution.mutationOps);
      if (!applied?.ok) throw new Error(`Context effect application failed: ${JSON.stringify(applied?.errors || [])}`);
    }
    results.push({
      type: "invoke",
      input: step.input,
      answer: execution.answer,
      inputBindings: execution.computePlan?.inputBindings || [],
      entityId: built.manifest.entityId,
      capabilityId: built.manifest.capabilityId,
      mutationOps: execution.mutationOps || [],
      contextEffects: execution.contextEffects || [],
    });
  }

  return {
    name: scenario.name || "compute scenario",
    passed: results.length,
    buildStatus: built.result?.build?.status || "CAPABILITY_REUSED",
    capabilityId: built.manifest.capabilityId,
    entityId: built.manifest.entityId,
    requirementSegments: built.prompt.requirementSegments,
    graph: graphStore.getSnapshot(),
    results,
  };
}

export async function runComputeScenario(file, options) {
  return runComputeScenarioObject(JSON.parse(fs.readFileSync(file, "utf8")), options);
}
