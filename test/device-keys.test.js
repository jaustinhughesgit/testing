import test from "node:test";
import assert from "node:assert/strict";
import { webcrypto } from "node:crypto";
import { createTestDeviceKeys } from "../src/device-keys.js";

test("creates exportable P-256 test-device material", async () => {
  const keys = await createTestDeviceKeys();
  assert.equal(keys.algorithm, "P-256");
  assert.equal(keys.testOnly, true);
  for (const value of [...Object.values(keys.public), ...Object.values(keys.private)]) {
    assert.ok(Buffer.from(value, "base64").length > 64);
  }
});

test("generated signing private key verifies against its registered public key", async () => {
  const keys = await createTestDeviceKeys();
  const privateKey = await webcrypto.subtle.importKey(
    "pkcs8",
    Buffer.from(keys.private.sigPkcs8, "base64"),
    { name: "ECDSA", namedCurve: "P-256" },
    false,
    ["sign"]
  );
  const publicKey = await webcrypto.subtle.importKey(
    "spki",
    Buffer.from(keys.public.pubSig, "base64"),
    { name: "ECDSA", namedCurve: "P-256" },
    false,
    ["verify"]
  );
  const challenge = new TextEncoder().encode("1var-headless-device-proof");
  const signature = await webcrypto.subtle.sign({ name: "ECDSA", hash: "SHA-256" }, privateKey, challenge);
  assert.equal(await webcrypto.subtle.verify({ name: "ECDSA", hash: "SHA-256" }, publicKey, signature, challenge), true);
});
