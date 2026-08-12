import test from "node:test";
import assert from "node:assert/strict";
import { resetDatabase } from "../src/cli.js";

test("follows reset continuations until the server reports success", async () => {
  const bodies = [];
  const client = {
    async call(_action, { body }) {
      bodies.push(body);
      if (bodies.length === 1) {
        return { data: { response: { alert: "pending", jobId: "job-1", continuationToken: "signed", step: 1 } } };
      }
      return { data: { response: { alert: "success" } } };
    },
  };

  const result = await resetDatabase(client, "test");
  assert.equal(result.response.alert, "success");
  assert.deepEqual(bodies[1], {
    testEnvironmentId: "test",
    mode: "canonical",
    jobId: "job-1",
    continuationToken: "signed",
    step: 1,
  });
});

test("retries a transient gateway failure without dropping continuation state", async () => {
  let calls = 0;
  const client = {
    async call() {
      calls += 1;
      if (calls === 1) throw Object.assign(new Error("gateway timeout"), { status: 504 });
      return { data: { response: { alert: "success" } } };
    },
  };

  const result = await resetDatabase(client, "test", { wait: (resolve) => resolve() });
  assert.equal(result.response.alert, "success");
  assert.equal(calls, 2);
});
