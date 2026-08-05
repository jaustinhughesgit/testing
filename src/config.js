import fs from "node:fs";
import path from "node:path";

function list(value) {
  return String(value || "").split(",").map((item) => item.trim()).filter(Boolean);
}

function readJson(file) {
  if (!fs.existsSync(file)) return {};
  return JSON.parse(fs.readFileSync(file, "utf8"));
}

export function loadConfig({ cwd = process.cwd(), env = process.env, configPath } = {}) {
  const file = path.resolve(cwd, configPath || env.ONEVAR_TEST_CONFIG || "testing.config.json");
  const stored = readJson(file);
  const config = {
    environment: env.ONEVAR_TEST_ENVIRONMENT || stored.environment || "",
    apiUrl: env.ONEVAR_TEST_API_URL || stored.apiUrl || "",
    originalHost: env.ONEVAR_TEST_ORIGINAL_HOST || stored.originalHost || "",
    websiteUrl: env.ONEVAR_TEST_WEBSITE_URL || stored.websiteUrl || stored.originalHost || "",
    stateDirectory: path.resolve(cwd, env.ONEVAR_TEST_STATE_DIRECTORY || stored.stateDirectory || ".state"),
    mail: {
      mode: env.ONEVAR_TEST_MAIL_MODE || stored.mail?.mode || "mailbox",
      mailboxUrl: env.ONEVAR_TEST_MAILBOX_URL || stored.mail?.mailboxUrl || "",
      timeoutMs: Number(env.ONEVAR_TEST_MAIL_TIMEOUT_MS || stored.mail?.timeoutMs || 30000),
      pollIntervalMs: Number(env.ONEVAR_TEST_MAIL_POLL_INTERVAL_MS || stored.mail?.pollIntervalMs || 500)
    },
    destructive: {
      allowDatabaseReset: String(env.ONEVAR_TEST_ALLOW_DATABASE_RESET ?? stored.destructive?.allowDatabaseReset ?? false) === "true",
      allowedResetHosts: env.ONEVAR_TEST_ALLOWED_RESET_HOSTS ? list(env.ONEVAR_TEST_ALLOWED_RESET_HOSTS) : (stored.destructive?.allowedResetHosts || []),
      testEnvironmentId: env.ONEVAR_TEST_RESET_ENVIRONMENT_ID || stored.destructive?.testEnvironmentId || ""
    },
    configFile: file
  };

  if (config.apiUrl) new URL(config.apiUrl);
  if (config.originalHost) new URL(config.originalHost);
  if (config.websiteUrl) new URL(config.websiteUrl);
  return config;
}

export function requireWebsiteConfig(config) {
  if (!config.websiteUrl) {
    throw new Error(`websiteUrl is required; set ONEVAR_TEST_WEBSITE_URL or add it to ${config.configFile}`);
  }
}

export function requireConnectionConfig(config) {
  if (!config.apiUrl || !config.originalHost) {
    throw new Error(`apiUrl and originalHost are required; copy testing.config.example.json to ${config.configFile}`);
  }
}

export function assertResetAllowed(config, confirmation) {
  requireConnectionConfig(config);
  const env = String(config.environment || "").trim().toLowerCase();
  const environmentId = String(config.destructive.testEnvironmentId || "").trim();
  const host = new URL(config.apiUrl).hostname.toLowerCase();
  const productionLike = !env || ["prod", "production", "live"].includes(env) || /(^|[.-])(prod|production|live)([.-]|$)/.test(host);

  if (productionLike) throw new Error("Database reset is forbidden for empty or production-like environments");
  if (!config.destructive.allowDatabaseReset) throw new Error("Database reset is disabled in this testing configuration");
  if (!config.destructive.allowedResetHosts.map((value) => value.toLowerCase()).includes(host)) {
    throw new Error(`Database reset host '${host}' is not explicitly allowed`);
  }
  if (!environmentId || environmentId !== config.environment) {
    throw new Error("The reset environment ID must exactly match the configured environment");
  }
  if (confirmation !== `reset:${config.environment}`) {
    throw new Error(`Confirmation must be exactly 'reset:${config.environment}'`);
  }
  return { environmentId };
}
