import test from "node:test";
import assert from "node:assert/strict";
import { assertResetAllowed } from "../src/config.js";

function config(overrides = {}) {
  return {
    environment: "local",
    apiUrl: "http://localhost:3001/cookies",
    originalHost: "http://localhost:3000",
    destructive: { allowDatabaseReset: true, allowedResetHosts: ["localhost"], testEnvironmentId: "local" },
    ...overrides
  };
}

test("allows an exact, explicitly configured test reset", () => {
  assert.deepEqual(assertResetAllowed(config(), "reset:local"), { environmentId: "local" });
});

test("rejects production, wrong hosts, and wrong confirmation", () => {
  assert.throws(() => assertResetAllowed(config({ environment: "production" }), "reset:production"), /forbidden/);
  assert.throws(() => assertResetAllowed(config({ apiUrl: "https://api.example.test/cookies" }), "reset:local"), /not explicitly allowed/);
  assert.throws(() => assertResetAllowed(config(), "yes"), /exactly/);
});
