#!/usr/bin/env node
/**
 * Platform: Gives agents and CI deterministic commands for cross-layer 1var acceptance, not alternate product semantics.
 * Technical: Parses subcommands/JSON flags and coordinates config, test-device state, API calls, mailbox checks, and scenarios.
 */
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { loadConfig, requireConnectionConfig, requireWebsiteConfig, assertResetAllowed } from "./config.js";
import { StateStore } from "./state-store.js";
import { OneVarApiClient } from "./api-client.js";
import { createTestDeviceKeys } from "./device-keys.js";
import { createProtectedCredential, createProtectedText, revealProtectedText } from "./protected-assets.js";
import { parseVerificationUrl, waitForVerificationUrl } from "./mailbox.js";
import { runScenario } from "./scenario.js";
import { runMessageScenario } from "./message-scenario.js";
import { runComputeScenario } from "./compute-scenario.js";
import { runCrossUserContextScenario } from "./cross-user-context-scenario.js";
import { runSeamlessCapabilityScenario } from "./seamless-capability-scenario.js";
import { runCrossUserComputeScenario } from "./cross-user-compute-scenario.js";

function parseArgs(argv) {
  const positional = [];
  const flags = {};
  for (let index = 0; index < argv.length; index += 1) {
    const value = argv[index];
    if (!value.startsWith("--")) { positional.push(value); continue; }
    const [key, inline] = value.slice(2).split("=", 2);
    if (inline !== undefined) flags[key] = inline;
    else if (argv[index + 1] && !argv[index + 1].startsWith("--")) flags[key] = argv[++index];
    else flags[key] = true;
  }
  return { positional, flags };
}

function bodyFrom(value) {
  if (!value) return {};
  const text = value.startsWith("@") ? fs.readFileSync(value.slice(1), "utf8") : value;
  return JSON.parse(text);
}

function requireFlag(flags, name) {
  if (!flags[name] || flags[name] === true) throw new Error(`--${name} is required`);
  return String(flags[name]);
}

function output(value) { process.stdout.write(`${JSON.stringify(value, null, 2)}\n`); }

const retryableResetStatus = new Set([429, 502, 503, 504]);

export async function resetDatabase(client, environmentId, { retries = 4, wait = setTimeout } = {}) {
  let result;
  let body = { testEnvironmentId: environmentId, mode: "canonical" };
  do {
    let attempt = 0;
    while (true) {
      try {
        result = (await client.call("resetDB", { body })).data;
        break;
      } catch (error) {
        if (!retryableResetStatus.has(error.status) || attempt >= retries) throw error;
        await new Promise((resolve) => wait(resolve, 250 * (2 ** attempt++)));
      }
    }
    const pending = result?.response;
    if (pending?.alert === "pending") {
      if (!pending.jobId || !pending.continuationToken || !Number.isInteger(pending.step)) {
        throw new Error("Database reset returned an invalid continuation");
      }
      body = {
        testEnvironmentId: environmentId,
        mode: "canonical",
        jobId: pending.jobId,
        continuationToken: pending.continuationToken,
        step: pending.step,
      };
    }
  } while (result?.response?.alert === "pending");
  return result;
}

export async function bootstrapProfileAfterReset(config, profile) {
  const state = new StateStore(config.stateDirectory, profile);
  // Canonical reset removed the account that owned any prior token and
  // workspace. Start this named test identity as a genuinely new user so the
  // scenario cannot pass with retained entities or Paths.
  state.save({});
  const client = new OneVarApiClient({ ...config, stateStore: state });
  const bootstrap = await client.call("newGroup", {
    path: ["newUser", "newUser"],
    body: {},
  });
  const account = bootstrap.data?.response ?? bootstrap.data;
  if (!account?.entity || !account?.file) {
    throw new Error(`Profile ${profile} could not be bootstrapped after reset`);
  }
  state.update({ userId: account.entity, subdomain: account.file });
  return { profile, userId: String(account.entity), subdomain: String(account.file) };
}

export async function main(argv = process.argv.slice(2)) {
  const { positional, flags } = parseArgs(argv);
  const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
  const config = loadConfig({ cwd: root, configPath: flags.config });
  const [area, command, ...rest] = positional;
  if (area === "message" && command === "run") {
    requireWebsiteConfig(config);
    if (!rest[0]) throw new Error("message run requires a scenario file");
    output(await runMessageScenario(path.resolve(process.cwd(), rest[0]), { websiteUrl: config.websiteUrl }));
    return;
  }

  requireConnectionConfig(config);
  if (area === "context" && command === "run") {
    requireWebsiteConfig(config);
    if (!rest[0]) throw new Error("context run requires a scenario file");
    output(await runCrossUserContextScenario(path.resolve(process.cwd(), rest[0]), {
      config,
      profileNames: requireFlag(flags, "profiles"),
    }));
    return;
  }
  if (area === "capability-chain" && command === "run") {
    requireWebsiteConfig(config);
    if (!rest[0]) throw new Error("capability-chain run requires a scenario file");
    output(await runSeamlessCapabilityScenario(path.resolve(process.cwd(), rest[0]), {
      config,
      profileNames: requireFlag(flags, "profiles"),
      progress: ({ index, name, phase, status, poll }) => process.stderr.write(
        `${index} ${name}${phase ? ` ${phase} ${poll}: ${status}` : ""}\n`
      ),
    }));
    return;
  }
  if (area === "compute-sharing" && command === "run") {
    requireWebsiteConfig(config);
    if (!rest[0]) throw new Error("compute-sharing run requires a scenario file");
    const profileNames = requireFlag(flags, "profiles");
    const confirmation = requireFlag(flags, "reset");
    const { environmentId } = assertResetAllowed(config, confirmation);
    const resetProfile = profileNames.split(",").map((value) => value.trim()).filter(Boolean)[0];
    const resetState = new StateStore(config.stateDirectory, resetProfile);
    const resetClient = new OneVarApiClient({ ...config, stateStore: resetState });
    const before = await resetDatabase(resetClient, environmentId);
    if (before?.ok === false || before?.response?.alert !== "success") {
      throw new Error("Pre-run database reset was rejected or incomplete");
    }
    const resetProfiles = profileNames.split(",").map((value) => value.trim()).filter(Boolean);
    for (const profile of resetProfiles) await bootstrapProfileAfterReset(config, profile);
    let result;
    let runError;
    try {
      result = await runCrossUserComputeScenario(path.resolve(process.cwd(), rest[0]), {
        config,
        profileNames,
        progress: ({ phase, status, poll }) => process.stderr.write(`${phase} ${poll}: ${status}\n`),
      });
    } catch (error) {
      runError = error;
    }
    const after = await resetDatabase(resetClient, environmentId).catch((error) => ({
      ok: false,
      error: { code: error?.code || "RESET_AFTER_FAILED", message: error?.message || String(error) },
    }));
    if (after?.ok === false || after?.response?.alert !== "success") {
      if (runError) runError.message += "; final database reset also failed";
      else throw new Error("Final database reset was rejected or incomplete");
    }
    if (runError) throw runError;
    output({ ...result, resetBefore: true, resetAfter: true });
    return;
  }
  const state = new StateStore(config.stateDirectory, String(flags.profile || "default"));
  const client = new OneVarApiClient({ ...config, stateStore: state });

  if (area === "api" && command === "call") {
    const [action, ...requestPath] = rest;
    const body = bodyFrom(String(flags.body || ""));
    if (flags.entity && body.entity == null && body.su == null) body.entity = String(flags.entity);
    output((await client.call(action, { path: requestPath, body })).data);
    return;
  }
  if (area === "account" && command === "bootstrap") {
    const result = await client.call("newGroup", { path: ["newUser", "newUser"], body: {} });
    const data = result.data?.response ?? result.data;
    state.update({ userId: data?.entity, subdomain: data?.file });
    output(data);
    return;
  }
  if (area === "account" && command === "setup") {
    const email = requireFlag(flags, "email");
    const bootstrap = await client.call("newGroup", { path: ["newUser", "newUser"], body: {} });
    const account = bootstrap.data?.response ?? bootstrap.data;
    const entity = String(account?.entity || "");
    if (!entity) throw new Error("Account bootstrap did not return an entity");
    await client.call("requestEmailVerify", { body: { email, entity } });
    const verificationUrl = await waitForVerificationUrl({ ...config.mail, recipient: email });
    const verification = parseVerificationUrl(verificationUrl);
    await client.call("emailVerify", { body: verification });
    const keys = await createTestDeviceKeys();
    const enrolled = await client.call("createEncryption", { body: { email, entity, ...keys.public } });
    state.update({ userId: account?.entity, subdomain: account?.file, emailVerified: true, deviceKeys: keys });
    output({ ok: true, entity, subdomain: account?.file, encryption: enrolled.data });
    return;
  }
  if (area === "email" && command === "request") {
    const email = requireFlag(flags, "email");
    const entity = requireFlag(flags, "entity");
    output((await client.call("requestEmailVerify", { body: { email, entity } })).data);
    return;
  }
  if (area === "email" && command === "verify") {
    const verificationUrl = flags.url
      ? String(flags.url)
      : await waitForVerificationUrl({ ...config.mail, recipient: requireFlag(flags, "email") });
    const verification = parseVerificationUrl(verificationUrl);
    const result = await client.call("emailVerify", { body: verification });
    state.update({ subdomain: verification.entity, emailVerified: true });
    output(result.data);
    return;
  }
  if (area === "encryption" && command === "setup") {
    const email = requireFlag(flags, "email");
    const entity = requireFlag(flags, "entity");
    const keys = await createTestDeviceKeys();
    const result = await client.call("createEncryption", { body: { email, entity, ...keys.public } });
    state.update({ userId: String(result.data?.userID || ""), subdomain: entity, deviceKeys: keys });
    output(result.data);
    return;
  }
  if (area === "protected-asset" && command === "create-text") {
    const text = requireFlag(flags, "text");
    output(await createProtectedText(client, state, { text, label: String(flags.label || "Protected text") }));
    return;
  }
  if (area === "protected-asset" && command === "create-credential") {
    output(await createProtectedCredential(client, state, {
      value: requireFlag(flags, "value"),
      label: String(flags.label || "Provider credential"),
      field: requireFlag(flags, "field"),
      providerId: requireFlag(flags, "provider-id"),
      providerHost: requireFlag(flags, "provider-host"),
      capabilityId: requireFlag(flags, "capability-id"),
      approvalMode: String(flags["approval-mode"] || "every_use"),
    }));
    return;
  }
  if (area === "protected-asset" && command === "reveal-text") {
    const reference = String(flags.reference || state.load().lastProtectedAssetReference || "");
    if (!reference) throw new Error("--reference is required when the profile has no last protected asset");
    output({ ok: true, reference, ...(await revealProtectedText(client, state, reference)) });
    return;
  }
  if (area === "scenario" && command === "run") {
    output(await runScenario(path.resolve(process.cwd(), rest[0]), client));
    return;
  }
  if (area === "compute" && command === "run") {
    requireWebsiteConfig(config);
    if (!rest[0]) throw new Error("compute run requires a scenario file");
    output(await runComputeScenario(path.resolve(process.cwd(), rest[0]), {
      client,
      stateStore: state,
      websiteUrl: config.websiteUrl,
      progress: ({ phase, status, poll }) => process.stderr.write(`${phase} ${poll}: ${status}\n`),
    }));
    return;
  }
  if (area === "db" && command === "reset") {
    const { environmentId } = assertResetAllowed(config, String(flags.confirm || ""));
    const result = await resetDatabase(client, environmentId);
    if (result?.ok === false || result?.response?.alert !== "success") {
      const error = new Error(`Database reset was rejected or incomplete${result?.error?.code ? `: ${result.error.code}` : ""}`);
      error.response = result;
      throw error;
    }
    output(result);
    return;
  }
  throw new Error("Unknown command. See README.md for supported commands.");
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main().catch((error) => {
    process.stderr.write(`${error.message}\n`);
    if (error.response) process.stderr.write(`${JSON.stringify(error.response, null, 2)}\n`);
    process.exitCode = 1;
  });
}
