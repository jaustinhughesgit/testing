/**
 * Platform: Exercises the same public API/Compute boundary as the website without privileged test-only transport.
 * Technical: Fetch client for original-host actions, cookie-compatible access tokens, JSON envelopes, and persisted session updates.
 */
function accessTokenFrom(headers) {
  const values = typeof headers.getSetCookie === "function"
    ? headers.getSetCookie()
    : [headers.get("set-cookie")].filter(Boolean);
  for (const value of values) {
    const match = String(value).match(/(?:^|[,;]\s*)accessToken=([^;,]+)/i);
    if (match) return decodeURIComponent(match[1]);
  }
  return null;
}

export function unwrapApiEnvelope(raw) {
  return raw?.response?.oai?.html ?? raw;
}

export class OneVarApiClient {
  constructor({ apiUrl, originalHost, stateStore, fetchImpl = globalThis.fetch }) {
    this.apiUrl = apiUrl;
    this.originalHost = originalHost.replace(/\/$/, "");
    this.stateStore = stateStore;
    this.fetchImpl = fetchImpl;
  }

  async call(action, { path = [], body = {} } = {}) {
    if (!action || !/^[a-zA-Z0-9_-]+(?::[a-zA-Z0-9_-]+)?$/.test(action)) throw new Error("A valid action is required");
    const encodedAction = action.split(":").map(encodeURIComponent).join(":");
    const suffix = [encodedAction, ...path.map((value) => encodeURIComponent(String(value)))].join("/");
    const state = this.stateStore.load();
    const headers = {
      "Content-Type": "application/json",
      "X-Original-Host": `${this.originalHost}/${suffix}`
    };
    if (state.accessToken) {
      headers.Cookie = `accessToken=${encodeURIComponent(state.accessToken)}`;
      headers["X-accessToken"] = state.accessToken;
    }

    const response = await this.fetchImpl(this.apiUrl, {
      method: "POST",
      headers,
      body: JSON.stringify(body)
    });
    const text = await response.text();
    let raw;
    try { raw = text ? JSON.parse(text) : {}; } catch { raw = text; }

    const accessToken = accessTokenFrom(response.headers);
    if (accessToken) this.stateStore.update({ accessToken });
    if (!response.ok) {
      const error = new Error(`API request failed with HTTP ${response.status}`);
      error.status = response.status;
      error.response = raw;
      throw error;
    }
    return { raw, data: unwrapApiEnvelope(raw), status: response.status };
  }
}
