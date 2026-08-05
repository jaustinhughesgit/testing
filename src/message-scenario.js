import fs from "node:fs";
import vm from "node:vm";

function endpoint(websiteUrl, pathname) {
  return new URL(pathname, `${String(websiteUrl).replace(/\/+$/, "")}/`).toString();
}

async function fetchWithRetry(fetchImpl, url, options = {}, attempts = 3) {
  let lastError = null;
  for (let attempt = 1; attempt <= attempts; attempt += 1) {
    try {
      const response = await fetchImpl(url, options);
      if (response.ok || (response.status !== 429 && response.status < 500) || attempt === attempts) {
        return response;
      }
      lastError = new Error(`${url} failed with HTTP ${response.status}`);
    } catch (error) {
      lastError = error;
      if (attempt === attempts) break;
    }
    await new Promise((resolve) => setTimeout(resolve, attempt * 250));
  }
  throw new Error(`${url} transport failed after ${attempts} attempts: ${lastError?.message || "unknown error"}`);
}

async function jsonRequest(fetchImpl, url, options = {}) {
  const response = await fetchWithRetry(fetchImpl, url, options);
  const data = await response.json().catch(() => ({}));
  if (!response.ok || data?.ok === false) {
    throw new Error(`${url} failed with HTTP ${response.status}: ${data?.error || data?.detail || "unknown error"}`);
  }
  return data;
}

async function loadPublishedGraphStore(websiteUrl, fetchImpl) {
  const url = endpoint(websiteUrl, "/workers/graphWorkerLib.js");
  const response = await fetchWithRetry(fetchImpl, url);
  if (!response.ok) throw new Error(`${url} failed with HTTP ${response.status}`);
  const source = await response.text();
  const sandbox = { console };
  sandbox.globalThis = sandbox;
  vm.runInNewContext(source, sandbox, { filename: url });
  if (typeof sandbox.createGraphStoreLite !== "function") {
    throw new Error("The published website graph runtime did not expose createGraphStoreLite");
  }
  return sandbox.createGraphStoreLite();
}

function derivedOperations(rows) {
  return (Array.isArray(rows) ? rows : [])
    .map((row) => String(row?.[2] || "").match(/^\{op:(add|subtract|multiply|divide)\}$/i)?.[1]?.toLowerCase())
    .filter(Boolean);
}

function exactStringArray(actual, expected) {
  return Array.isArray(actual)
    && Array.isArray(expected)
    && actual.length === expected.length
    && actual.every((value, index) => String(value) === String(expected[index]));
}

function assertStep(step, actual, index) {
  const expected = step.expect || {};
  const label = step.name || `step ${index + 1}`;
  if (expected.kind && actual.kind !== expected.kind) {
    throw new Error(`${label}: expected kind ${expected.kind}, received ${actual.kind}`);
  }
  if (expected.answer && !exactStringArray(actual.answer, expected.answer)) {
    throw new Error(
      `${label}: expected answer ${JSON.stringify(expected.answer)}, received ${JSON.stringify(actual.answer)}; `
      + `essence ${JSON.stringify(actual.essence)}`
    );
  }
  if (expected.operations) {
    const missing = expected.operations.filter((operation) => !actual.operations.includes(operation));
    if (missing.length) {
      throw new Error(
        `${label}: missing derived operation(s) ${missing.join(", ")}; received ${JSON.stringify(actual.operations)}; `
        + `essence ${JSON.stringify(actual.essence)}`
      );
    }
  }
}

export async function runMessageScenarioObject(scenario, { websiteUrl, fetchImpl = fetch } = {}) {
  if (!websiteUrl) throw new Error("websiteUrl is required for a message scenario");
  if (!Array.isArray(scenario?.steps) || !scenario.steps.length) {
    throw new Error("Message scenario must contain at least one step");
  }

  const graphStore = await loadPublishedGraphStore(websiteUrl, fetchImpl);
  const results = [];
  for (const [index, step] of scenario.steps.entries()) {
    const text = String(step.input || "").trim();
    if (!text) throw new Error(`Message scenario step ${index + 1} requires input`);

    const classification = await jsonRequest(fetchImpl, endpoint(websiteUrl, "/classify-input"), {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ text, llmTemplateId: step.llmTemplateId || null }),
    });
    const interpretation = await jsonRequest(fetchImpl, endpoint(websiteUrl, "/essence"), {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        text,
        inputKind: classification.kind,
        classification,
        llmTemplateId: step.llmTemplateId || null,
        contextDB: { graph: graphStore.getSnapshot() },
      }),
    });

    const rows = Array.isArray(interpretation.essence) ? interpretation.essence : [];
    let answer = [];
    if (classification.kind === "statement") {
      graphStore.applyMutationOps(interpretation.mutationOps || []);
      graphStore.ingestEssenceRows(rows);
    }
    if (classification.kind === "question") {
      const query = graphStore.queryByEssenceTemplates(rows);
      answer = Array.from(query?.vars?.ask || []);
    }
    const result = {
      name: step.name || `step ${index + 1}`,
      input: text,
      kind: classification.kind,
      answer,
      operations: derivedOperations(rows),
      mutations: Array.isArray(interpretation.mutationOps)
        ? interpretation.mutationOps.map((operation) => operation.type)
        : [],
      essence: rows,
    };
    assertStep(step, result, index);
    results.push(result);
  }

  return {
    name: scenario.name || "message scenario",
    passed: results.length,
    graph: {
      entities: Object.keys(graphStore.getSnapshot().entities || {}).length,
      relations: Object.keys(graphStore.getSnapshot().relations || {}).length,
    },
    results,
  };
}

export async function runMessageScenario(file, options) {
  return runMessageScenarioObject(JSON.parse(fs.readFileSync(file, "utf8")), options);
}
