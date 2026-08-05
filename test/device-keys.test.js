import test from "node:test";
import assert from "node:assert/strict";
import { createTestDeviceKeys } from "../src/device-keys.js";

test("creates exportable P-256 test-device material", async () => {
  const keys = await createTestDeviceKeys();
  assert.equal(keys.algorithm, "P-256");
  assert.equal(keys.testOnly, true);
  for (const value of [...Object.values(keys.public), ...Object.values(keys.private)]) {
    assert.ok(Buffer.from(value, "base64").length > 64);
  }
});
