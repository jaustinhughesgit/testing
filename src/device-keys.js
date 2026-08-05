import { webcrypto } from "node:crypto";

const subtle = webcrypto.subtle;
const b64 = (buffer) => Buffer.from(buffer).toString("base64");

export async function createTestDeviceKeys() {
  const encryption = await subtle.generateKey({ name: "ECDH", namedCurve: "P-256" }, true, ["deriveKey", "deriveBits"]);
  const signing = await subtle.generateKey({ name: "ECDSA", namedCurve: "P-256" }, true, ["sign", "verify"]);
  return {
    public: {
      pubEnc: b64(await subtle.exportKey("spki", encryption.publicKey)),
      pubSig: b64(await subtle.exportKey("spki", signing.publicKey))
    },
    private: {
      encPkcs8: b64(await subtle.exportKey("pkcs8", encryption.privateKey)),
      sigPkcs8: b64(await subtle.exportKey("pkcs8", signing.privateKey))
    },
    algorithm: "P-256",
    testOnly: true
  };
}
