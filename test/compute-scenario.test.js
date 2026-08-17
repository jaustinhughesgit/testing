import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import {
  loadPublishedSemanticPathRuntime,
  selectCapabilityManifest,
  selectReusableCapabilityManifest,
} from "../src/compute-scenario.js";

const awsPublic = path.resolve(import.meta.dirname, "../../aws/app/public");
const sources = new Map([
  ["https://public.1var.com/compromise.js", "modules/_analyzer/compromise.js"],
  ["https://public.1var.com/compromise-numbers.js", "modules/_analyzer/compromise-numbers.js"],
  ["https://website.example/workers/semanticEntityCompilerWorkerLib.js", "workers/semanticEntityCompilerWorkerLib.js"],
  ["https://website.example/workers/patternWorkerLib.js", "workers/patternWorkerLib.js"],
  ["https://website.example/modules/_pathbuilder/semantic-graph-path-dataset.json", "modules/_pathbuilder/semantic-graph-path-dataset.json"],
]);

test("compute scenarios prefer the authoritative registered manifest over an internal pending build artifact", () => {
  const operation = {
    operationId: "format",
    inputs: [],
    outputs: [{ name: "formatted", type: "string", required: true }],
  };
  const manifest = selectCapabilityManifest({
    parseResults: {
      capabilityManifest: {
        schemaVersion: 1,
        capabilityId: "formatter",
        entityId: "pending-capability-entity",
        operations: [operation],
      },
    },
    capabilityManifest: {
      schemaVersion: 1,
      capabilityId: "formatter",
      entityId: "1v4r-registered",
      operations: [operation],
    },
  });
  assert.equal(manifest.entityId, "1v4r-registered");
});

test("compute create/reuse scenarios fail explicitly when discovery requires Edit", () => {
  assert.throws(
    () => selectReusableCapabilityManifest({}, "CAPABILITY_EXTENSION_REQUIRED"),
    /requires an entity extension/
  );
});

test("a command scenario executes the published composed self-property Path", async () => {
  const fetchImpl = async (url) => {
    const relative = sources.get(String(url));
    if (!relative) return new Response("missing", { status: 404 });
    const body = fs.readFileSync(path.join(awsPublic, relative));
    return new Response(body, {
      status: 200,
      headers: { "content-type": relative.endsWith(".json") ? "application/json" : "text/javascript" },
    });
  };
  const runtime = await loadPublishedSemanticPathRuntime("https://website.example", fetchImpl);
  const ingested = [];
  const result = runtime.execute(
    "self_property_composed_statement",
    "My register status is closed.",
    { ingestEssenceRows: (rows) => ingested.push(...rows) },
  );

  assert.equal(result.execution, "published-semantic-path");
  assert.equal(result.bindings.subject, "speaker");
  assert.equal(result.bindings.property, "register status");
  assert.equal(result.bindings.value, "closed");
  assert.deepEqual(Array.from(ingested.at(-1)), ["present", "speaker", "register status", "closed"]);
});
