import test from "node:test";
import assert from "node:assert/strict";
import { OneVarApiClient } from "../src/api-client.js";

test("uses the browser transport contract and persists its session", async () => {
  let saved = {};
  let calls = 0;
  const stateStore = { load: () => saved, update: (patch) => (saved = { ...saved, ...patch }) };
  const fetchImpl = async (url, options) => {
    calls += 1;
    assert.equal(url, "https://api.example.test/cookies");
    assert.equal(options.headers["X-Original-Host"], "https://www.example.test/example/entity");
    if (calls === 2) {
      assert.equal(options.headers["X-accessToken"], "test-token");
      assert.equal(options.headers.Cookie, "accessToken=test-token");
    }
    return new Response(JSON.stringify({ response: { oai: { html: { ok: true } } } }), {
      status: 200,
      headers: { "set-cookie": "accessToken=test-token; Path=/; HttpOnly" }
    });
  };
  const client = new OneVarApiClient({ apiUrl: "https://api.example.test/cookies", originalHost: "https://www.example.test", stateStore, fetchImpl });
  const result = await client.call("example", { path: ["entity"] });
  assert.deepEqual(result.data, { ok: true });
  assert.equal(saved.accessToken, "test-token");
  await client.call("example", { path: ["entity"] });
});
