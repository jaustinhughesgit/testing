import fs from "node:fs";

function isSubset(expected, actual) {
  if (expected === null || typeof expected !== "object") return Object.is(expected, actual);
  if (Array.isArray(expected)) return Array.isArray(actual) && expected.every((item, index) => isSubset(item, actual[index]));
  return actual && typeof actual === "object" && Object.entries(expected).every(([key, value]) => isSubset(value, actual[key]));
}

export async function runScenario(file, client) {
  const scenario = JSON.parse(fs.readFileSync(file, "utf8"));
  if (!Array.isArray(scenario.steps) || !scenario.steps.length) throw new Error("Scenario must contain at least one step");
  const results = [];
  for (const [index, step] of scenario.steps.entries()) {
    const result = await client.call(step.action, { path: step.path || [], body: step.body || {} });
    if (step.expect !== undefined && !isSubset(step.expect, result.data)) {
      throw new Error(`Scenario '${scenario.name || file}' step ${index + 1} did not match its expected response`);
    }
    results.push({ name: step.name || step.action, data: result.data });
  }
  return { name: scenario.name || file, passed: results.length, results };
}

export { isSubset };
