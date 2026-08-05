import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { runMessageScenarioObject } from "../src/message-scenario.js";

const graphSource = fs.readFileSync(
  path.resolve(import.meta.dirname, "../../aws/app/public/workers/graphWorkerLib.js"),
  "utf8"
);
const ledgerSource = fs.readFileSync(
  path.resolve(import.meta.dirname, "../../aws/app/lib/essenceRemainderPlan.js"),
  "utf8"
);

test("message scenarios execute published interpretation against the published local graph runtime", async () => {
  let graphAttempts = 0;
  const fetchImpl = async (url, options = {}) => {
    if (String(url).endsWith("/workers/graphWorkerLib.js")) {
      graphAttempts += 1;
      if (graphAttempts === 1) throw new Error("temporary network failure");
      return new Response(graphSource, { status: 200 });
    }
    if (String(url).endsWith("/workers/quantityLedgerWorkerLib.js")) {
      return new Response(ledgerSource, { status: 200 });
    }
    const body = JSON.parse(options.body || "{}");
    if (String(url).endsWith("/classify-input")) {
      return Response.json({ ok: true, kind: body.text.startsWith("How") ? "question" : "statement" });
    }
    if (body.inputKind === "statement") {
      return Response.json({
        essence: [
          ["present", "store", "have", "hammer"],
          ["present", "hammer", "{prop:quantity}", 20],
        ],
        overlayOps: [],
        mutationOps: [],
      });
    }
    return Response.json({
      essence: [
        ["*", "store", "have", "{item}"],
        ["present", "{item}", "{prop:quantity}", "{ask}"],
      ],
      overlayOps: [],
      mutationOps: [],
    });
  };

  const result = await runMessageScenarioObject({
    name: "inventory recall",
    steps: [
      { input: "The store has 20 hammers.", expect: { kind: "statement" } },
      {
        input: "How many hammers remain?",
        execution: "local-ledger",
        expect: { kind: "question", execution: "local-ledger", answer: ["20"] },
      },
    ],
  }, { websiteUrl: "https://website.example", fetchImpl });

  assert.equal(result.passed, 2);
  assert.equal(graphAttempts, 2);
  assert.deepEqual(result.results[1].answer, ["20"]);
  assert.equal(result.results[1].execution, "local-ledger");
  assert.ok(result.graph.entities > 0);
});
