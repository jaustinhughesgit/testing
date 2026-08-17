import test from "node:test";
import assert from "node:assert/strict";
import { scenarioRequestId } from "../src/seamless-capability-scenario.js";

test("repeated scenario wording is idempotent within one run but fresh across runs", () => {
  const request = {
    index: 5,
    kind: "protected",
    workspaceId: "workspace-owner",
    input: "I have *** items.",
  };
  const first = scenarioRequestId({ ...request, runKey: "run-one" });
  assert.equal(first, scenarioRequestId({ ...request, runKey: "run-one" }));
  assert.notEqual(first, scenarioRequestId({ ...request, runKey: "run-two" }));
  assert.notEqual(first, scenarioRequestId({ ...request, runKey: "run-one", index: 6 }));
});
