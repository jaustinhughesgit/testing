/**
 * Platform: Proves recipient-only Protected Asset use without exposing plaintext or private keys to the server.
 * Technical: Creates and opens the same P-256 ECDH/HKDF and AES-GCM envelope used by the browser zero-trust client.
 */
import { randomUUID, webcrypto } from "node:crypto";
import { createTestDeviceKeys } from "./device-keys.js";

const subtle = webcrypto.subtle;
const encoder = new TextEncoder();
const decoder = new TextDecoder();
const b64url = (value) => Buffer.from(value).toString("base64url");
const bytes = (value) => Buffer.from(String(value || ""), "base64url");

export function defaultTextMetadata(label = "Protected text") {
  return {
    schemaVersion: 1,
    label: String(label || "Protected text"),
    assetType: "private_note",
    providerId: null,
    providerHost: null,
    fields: [{ name: "text", type: "string", required: true, validation: null, displayLabel: "Text" }],
    policy: {
      allowedUses: ["reveal"], destinations: [], capabilityIds: [], moduleIds: [],
      approvalMode: "every_use", unattendedAutomation: false,
      redaction: { revealLast: 0, label: "Protected" },
    },
    lifecycle: { expiresAt: null, rotationDays: null, recoverable: false },
    tags: [],
  };
}

export function defaultProviderCredentialMetadata({
  label = "Provider credential",
  field = "value",
  providerId,
  providerHost,
  capabilityId,
  approvalMode = "every_use",
} = {}) {
  return {
    schemaVersion: 1,
    label: String(label),
    assetType: "credential",
    providerId: String(providerId || ""),
    providerHost: String(providerHost || "").toLowerCase(),
    fields: [{ name: String(field), type: "string", required: true, validation: null, displayLabel: String(field) }],
    policy: {
      allowedUses: ["inject"],
      destinations: [{ host: String(providerHost || "").toLowerCase(), methods: ["GET"], pathPrefixes: ["/"] }],
      capabilityIds: [String(capabilityId || "")],
      moduleIds: ["compute"],
      approvalMode,
      unattendedAutomation: false,
      redaction: { revealLast: 0, label: "Protected" },
    },
    lifecycle: { expiresAt: null, rotationDays: null, recoverable: false },
    tags: [],
  };
}

export async function ensureProtectedAssetDevice(stateStore) {
  const state = stateStore.load();
  const deviceKeys = state.deviceKeys?.private?.encPkcs8 && state.deviceKeys?.public?.pubEnc
    ? state.deviceKeys
    : await createTestDeviceKeys();
  const recipientId = /^device_[a-zA-Z0-9_-]{16,160}$/.test(String(state.protectedAssetRecipientId || ""))
    ? state.protectedAssetRecipientId
    : `device_${randomUUID().replaceAll("-", "")}`;
  if (deviceKeys !== state.deviceKeys || recipientId !== state.protectedAssetRecipientId) {
    stateStore.update({ deviceKeys, protectedAssetRecipientId: recipientId });
  }
  return { deviceKeys, recipientId };
}

async function wrappingKey(privateKey, publicKey, salt, recipientId) {
  const shared = await subtle.deriveBits({ name: "ECDH", public: publicKey }, privateKey, 256);
  const base = await subtle.importKey("raw", shared, "HKDF", false, ["deriveKey"]);
  return subtle.deriveKey(
    { name: "HKDF", hash: "SHA-256", salt, info: encoder.encode(`1var.protected-asset.wrap.v1:${recipientId}`) },
    base,
    { name: "AES-GCM", length: 256 },
    false,
    ["encrypt", "decrypt"]
  );
}

export async function encryptTextEnvelope({
  text,
  values,
  metadata,
  recipientId,
  publicKeySpki,
  assetId,
  executorKey = null,
}) {
  const aad = encoder.encode(JSON.stringify({
    schemaVersion: 1, assetId, ownerIDs: [recipientId], assetType: metadata.assetType,
    providerId: metadata.providerId || null, policy: metadata.policy,
  }));
  const contentKey = await subtle.generateKey({ name: "AES-GCM", length: 256 }, true, ["encrypt", "decrypt"]);
  const contentKeyRaw = new Uint8Array(await subtle.exportKey("raw", contentKey));
  const contentIv = webcrypto.getRandomValues(new Uint8Array(12));
  const payload = encoder.encode(JSON.stringify(values || { text: String(text) }));
  try {
    const ciphertext = await subtle.encrypt({ name: "AES-GCM", iv: contentIv, additionalData: aad }, contentKey, payload);
    const recipientPublicKey = await subtle.importKey(
      "spki", Buffer.from(publicKeySpki, "base64"), { name: "ECDH", namedCurve: "P-256" }, false, []
    );
    const ephemeral = await subtle.generateKey({ name: "ECDH", namedCurve: "P-256" }, true, ["deriveBits"]);
    const salt = webcrypto.getRandomValues(new Uint8Array(32));
    const wrapIv = webcrypto.getRandomValues(new Uint8Array(12));
    const key = await wrappingKey(ephemeral.privateKey, recipientPublicKey, salt, recipientId);
    const wrappedKey = await subtle.encrypt(
      { name: "AES-GCM", iv: wrapIv, additionalData: aad }, key, contentKeyRaw
    );
    let executor = null;
    if (executorKey?.publicKeySpki) {
      const key = await subtle.importKey(
        "spki",
        Buffer.from(executorKey.publicKeySpki, "base64url"),
        { name: "RSA-OAEP", hash: "SHA-256" },
        false,
        ["encrypt"]
      );
      executor = {
        algorithm: "RSA-OAEP-256",
        keyId: String(executorKey.keyId || ""),
        ephemeralPublicKey: null,
        iv: null,
        wrappedKey: b64url(await subtle.encrypt({ name: "RSA-OAEP" }, key, contentKeyRaw)),
      };
    }
    return {
      schemaVersion: 1,
      algorithm: "A256GCM",
      iv: b64url(contentIv),
      ciphertext: b64url(ciphertext),
      aad: b64url(aad),
      keyWraps: { user: { [recipientId]: {
        algorithm: "ECDH-ES+A256KW",
        keyId: recipientId,
        ephemeralPublicKey: b64url(await subtle.exportKey("spki", ephemeral.publicKey)),
        iv: b64url(wrapIv),
        salt: b64url(salt),
        wrappedKey: b64url(wrappedKey),
      } }, executor },
    };
  } finally {
    contentKeyRaw.fill(0);
    payload.fill(0);
  }
}

export async function decryptTextEnvelope({ envelope, recipientId, privateKeyPkcs8 }) {
  const wrap = envelope?.keyWraps?.user?.[recipientId];
  if (!wrap) throw new Error("The envelope has no wrap for this test device");
  const privateKey = await subtle.importKey(
    "pkcs8", Buffer.from(privateKeyPkcs8, "base64"), { name: "ECDH", namedCurve: "P-256" }, false, ["deriveBits"]
  );
  const ephemeral = await subtle.importKey(
    "spki", bytes(wrap.ephemeralPublicKey), { name: "ECDH", namedCurve: "P-256" }, false, []
  );
  const aad = bytes(envelope.aad);
  const key = await wrappingKey(privateKey, ephemeral, bytes(wrap.salt), recipientId);
  const rawContentKey = new Uint8Array(await subtle.decrypt(
    { name: "AES-GCM", iv: bytes(wrap.iv), additionalData: aad }, key, bytes(wrap.wrappedKey)
  ));
  try {
    const contentKey = await subtle.importKey("raw", rawContentKey, { name: "AES-GCM" }, false, ["decrypt"]);
    const plaintext = await subtle.decrypt(
      { name: "AES-GCM", iv: bytes(envelope.iv), additionalData: aad }, contentKey, bytes(envelope.ciphertext)
    );
    return JSON.parse(decoder.decode(plaintext));
  } finally {
    rawContentKey.fill(0);
  }
}

export async function createProtectedText(client, stateStore, { text, label }) {
  const { deviceKeys, recipientId } = await ensureProtectedAssetDevice(stateStore);
  const assetId = `pa_${randomUUID().replaceAll("-", "")}`;
  const metadata = defaultTextMetadata(label);
  const envelope = await encryptTextEnvelope({
    text, metadata, recipientId, assetId, publicKeySpki: deviceKeys.public.pubEnc,
  });
  const result = (await client.call("protectedAsset:create", { body: { assetId, metadata, envelope, recipientGrants: [] } })).data;
  const reference = String(result?.asset?.reference || `protected_asset:${assetId}`);
  stateStore.update({ lastProtectedAssetReference: reference });
  return result;
}

export async function createProtectedCredential(client, stateStore, {
  value,
  label,
  field,
  providerId,
  providerHost,
  capabilityId,
  approvalMode = "every_use",
}) {
  const { deviceKeys, recipientId } = await ensureProtectedAssetDevice(stateStore);
  const assetId = `pa_${randomUUID().replaceAll("-", "")}`;
  const metadata = defaultProviderCredentialMetadata({
    label, field, providerId, providerHost, capabilityId, approvalMode,
  });
  const executorKey = (await client.call("protectedAsset:executor-key", { body: {} })).data;
  const envelope = await encryptTextEnvelope({
    values: { [field]: String(value) },
    metadata,
    recipientId,
    assetId,
    publicKeySpki: deviceKeys.public.pubEnc,
    executorKey,
  });
  const result = (await client.call("protectedAsset:create", {
    body: { assetId, metadata, envelope, recipientGrants: [] },
  })).data;
  const reference = String(result?.asset?.reference || `protected_asset:${assetId}`);
  stateStore.update({ lastProtectedAssetReference: reference });
  return result;
}

export async function revealProtectedText(client, stateStore, reference) {
  const state = stateStore.load();
  if (!state.deviceKeys?.private?.encPkcs8 || !state.protectedAssetRecipientId) {
    throw new Error("This profile does not hold the device key for that protected asset");
  }
  const result = (await client.call("protectedAsset:envelope", {
    body: { reference, purpose: "local_reveal", approved: true },
  })).data;
  return decryptTextEnvelope({
    envelope: result.envelope,
    recipientId: state.protectedAssetRecipientId,
    privateKeyPkcs8: state.deviceKeys.private.encPkcs8,
  });
}
