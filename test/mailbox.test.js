import test from "node:test";
import assert from "node:assert/strict";
import { parseVerificationUrl, waitForVerificationUrl } from "../src/mailbox.js";

test("finds and parses a verification URL in mailbox JSON", async () => {
  const url = await waitForVerificationUrl({
    mailboxUrl: "https://mail.test/messages?to={recipient}",
    recipient: "coach@example.test",
    fetchImpl: async () => new Response(JSON.stringify({ body: "Open https://links.test/email-verify?eh=abc&su=1v4r-user now" }))
  });
  assert.deepEqual(parseVerificationUrl(url), { emailHash: "abc", entity: "1v4r-user" });
});
