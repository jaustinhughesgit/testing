import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { bootstrapProfileAfterReset, resetDatabase } from "../src/cli.js";

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

test("a reset-enveloped run bootstraps a genuinely new named user", async () => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "onevar-reset-profile-"));
  const calls = [];
  const config = {
    stateDirectory: directory,
    apiUrl: "https://api.example.test/cookies",
    originalHost: "https://api.example.test",
    fetchImpl: async (_url, options) => {
      calls.push(options);
      return new Response(JSON.stringify({
        response: { oai: { html: { response: { entity: "u:new", file: "workspace-new" } } } },
      }), {
        status: 200,
        headers: { "content-type": "application/json", "set-cookie": "accessToken=fresh-token; Path=/" },
      });
    },
  };
  fs.writeFileSync(path.join(directory, "author.json"), JSON.stringify({
    accessToken: "stale-token",
    subdomain: "old-workspace",
  }));

  const result = await bootstrapProfileAfterReset(config, "author");
  const stored = JSON.parse(fs.readFileSync(path.join(directory, "author.json"), "utf8"));

  assert.deepEqual(result, { profile: "author", userId: "u:new", subdomain: "workspace-new" });
  assert.equal(calls.length, 1);
  assert.equal(calls[0].headers.Cookie, undefined);
  assert.equal(stored.accessToken, "fresh-token");
  assert.equal(stored.subdomain, "workspace-new");
  assert.equal(stored.userId, "u:new");
  fs.rmSync(directory, { recursive: true, force: true });
});
