const VERIFY_URL = /https?:\/\/[^\s"'<>]+\/email-verify\?[^\s"'<>]+/i;

function findUrl(value) {
  if (typeof value === "string") return value.match(VERIFY_URL)?.[0]?.replace(/&amp;/g, "&") || null;
  if (Array.isArray(value)) {
    for (const item of value) { const found = findUrl(item); if (found) return found; }
  } else if (value && typeof value === "object") {
    for (const item of Object.values(value)) { const found = findUrl(item); if (found) return found; }
  }
  return null;
}

export async function waitForVerificationUrl({ mailboxUrl, recipient, timeoutMs = 30000, pollIntervalMs = 500, fetchImpl = globalThis.fetch }) {
  if (!mailboxUrl) throw new Error("mail.mailboxUrl is required for mailbox verification");
  const endpoint = mailboxUrl.replace("{recipient}", encodeURIComponent(recipient));
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const response = await fetchImpl(endpoint);
    if (response.ok) {
      const text = await response.text();
      let content = text;
      try { content = JSON.parse(text); } catch {}
      const url = findUrl(content);
      if (url) return url;
    }
    await new Promise((resolve) => setTimeout(resolve, pollIntervalMs));
  }
  throw new Error(`No verification link arrived for ${recipient} within ${timeoutMs}ms`);
}

export function parseVerificationUrl(value) {
  const url = new URL(value);
  const emailHash = url.searchParams.get("eh");
  const entity = url.searchParams.get("su");
  if (!emailHash || !entity) throw new Error("Verification URL must contain eh and su");
  return { emailHash, entity };
}
