import fs from "node:fs";

function isSubset(expected, actual) {
  if (expected === null || typeof expected !== "object") return Object.is(expected, actual);
  if (!Array.isArray(expected) && expected.$present === true) return actual !== undefined && actual !== null;
  if (!Array.isArray(expected) && expected.$type) return typeof actual === expected.$type;
  if (Array.isArray(expected)) return Array.isArray(actual) && expected.every((item, index) => isSubset(item, actual[index]));
  return actual && typeof actual === "object" && Object.entries(expected).every(([key, value]) => isSubset(value, actual[key]));
}

function resolveTemplates(value, context) {
  if (Array.isArray(value)) return value.map((item) => resolveTemplates(item, context));
  if (value && typeof value === "object") {
    return Object.fromEntries(Object.entries(value).map(([key, item]) => [key, resolveTemplates(item, context)]));
  }
  if (typeof value !== "string") return value;
  const exact = value.match(/^\$\{(state|env)\.([a-zA-Z0-9_]+)\}$/);
  if (exact) {
    const resolved = context[exact[1]]?.[exact[2]];
    if (resolved === undefined) throw new Error(`Scenario value '${value}' is not available`);
    return resolved;
  }
  return value.replace(/\$\{(state|env)\.([a-zA-Z0-9_]+)\}/g, (_, scope, key) => {
    const resolved = context[scope]?.[key];
    if (resolved === undefined) throw new Error(`Scenario value '${scope}.${key}' is not available`);
    return String(resolved);
  });
}

export async function runScenario(file, client) {
  const scenario = JSON.parse(fs.readFileSync(file, "utf8"));
  if (!Array.isArray(scenario.steps) || !scenario.steps.length) throw new Error("Scenario must contain at least one step");
  const context = { state: client.stateStore?.load?.() || {}, env: process.env };
  const results = [];
  for (const [index, step] of scenario.steps.entries()) {
    const path = resolveTemplates(step.path || [], context);
    const body = resolveTemplates(step.body || {}, context);
    const expected = resolveTemplates(step.expect, context);
    const result = await client.call(step.action, { path, body });
    if (expected !== undefined && !isSubset(expected, result.data)) {
      throw new Error(`Scenario '${scenario.name || file}' step ${index + 1} did not match its expected response`);
    }
    results.push({ name: step.name || step.action, data: result.data });
  }
  return { name: scenario.name || file, passed: results.length, results };
}

export { isSubset, resolveTemplates };
