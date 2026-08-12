import test from "node:test";
import assert from "node:assert/strict";
import { webcrypto } from "node:crypto";
import { createTestDeviceKeys } from "../src/device-keys.js";
import {
  decryptTextEnvelope,
  defaultProviderCredentialMetadata,
  defaultTextMetadata,
  encryptTextEnvelope,
} from "../src/protected-assets.js";

test("protected text is absent from its envelope and decrypts only with the device key", async () => {
  const keys = await createTestDeviceKeys();
  const text = "zero-trust acceptance sentinel";
  const recipientId = "device_1234567890abcdef";
  const envelope = await encryptTextEnvelope({
    text,
    metadata: defaultTextMetadata("Acceptance text"),
    recipientId,
    publicKeySpki: keys.public.pubEnc,
    assetId: "pa_1234567890abcdef",
  });
  assert.equal(JSON.stringify(envelope).includes(text), false);
  assert.deepEqual(await decryptTextEnvelope({
    envelope,
    recipientId,
    privateKeyPkcs8: keys.private.encPkcs8,
  }), { text });
});

test("a different device key cannot decrypt the protected text", async () => {
  const owner = await createTestDeviceKeys();
  const other = await createTestDeviceKeys();
  const recipientId = "device_1234567890abcdef";
  const envelope = await encryptTextEnvelope({
    text: "private",
    metadata: defaultTextMetadata(),
    recipientId,
    publicKeySpki: owner.public.pubEnc,
    assetId: "pa_1234567890abcdef",
  });
  await assert.rejects(decryptTextEnvelope({
    envelope,
    recipientId,
    privateKeyPkcs8: other.private.encPkcs8,
  }));
});

test("a provider credential has a recipient wrap and a separate executor wrap", async () => {
  const recipient = await createTestDeviceKeys();
  const executor = await webcrypto.subtle.generateKey(
    { name: "RSA-OAEP", modulusLength: 2048, publicExponent: new Uint8Array([1, 0, 1]), hash: "SHA-256" },
    true,
    ["encrypt", "decrypt"]
  );
  const publicKeySpki = Buffer.from(
    await webcrypto.subtle.exportKey("spki", executor.publicKey)
  ).toString("base64url");
  const metadata = defaultProviderCredentialMetadata({
    field: "api_key",
    providerId: "provider.test",
    providerHost: "api.provider.test",
    capabilityId: "conditions.lookup",
  });
  const envelope = await encryptTextEnvelope({
    values: { api_key: "secret-value" },
    metadata,
    recipientId: "device_testrecipient1234",
    publicKeySpki: recipient.public.pubEnc,
    assetId: "pa_testexecutorcredential1234",
    executorKey: { keyId: "test-executor", publicKeySpki },
  });

  assert.equal(envelope.keyWraps.executor.algorithm, "RSA-OAEP-256");
  assert.equal(envelope.keyWraps.executor.keyId, "test-executor");
  assert.equal(JSON.stringify(envelope).includes("secret-value"), false);
  assert.deepEqual(await decryptTextEnvelope({
    envelope,
    recipientId: "device_testrecipient1234",
    privateKeyPkcs8: recipient.private.encPkcs8,
  }), { api_key: "secret-value" });
});
