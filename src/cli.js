#!/usr/bin/env node
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { loadConfig, requireConnectionConfig, assertResetAllowed } from "./config.js";
import { StateStore } from "./state-store.js";
import { OneVarApiClient } from "./api-client.js";
import { createTestDeviceKeys } from "./device-keys.js";
import { parseVerificationUrl, waitForVerificationUrl } from "./mailbox.js";
import { runScenario } from "./scenario.js";

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

export async function main(argv = process.argv.slice(2)) {
  const { positional, flags } = parseArgs(argv);
  const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
  const config = loadConfig({ cwd: root, configPath: flags.config });
  requireConnectionConfig(config);
  const state = new StateStore(config.stateDirectory, String(flags.profile || "default"));
  const client = new OneVarApiClient({ ...config, stateStore: state });
  const [area, command, ...rest] = positional;

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
    state.update({ entity: data?.entity, subdomain: data?.file });
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
    state.update({ entity, subdomain: account?.file, emailVerified: true, deviceKeys: keys });
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
    state.update({ entity: verification.entity, emailVerified: true });
    output(result.data);
    return;
  }
  if (area === "encryption" && command === "setup") {
    const email = requireFlag(flags, "email");
    const entity = requireFlag(flags, "entity");
    const keys = await createTestDeviceKeys();
    const result = await client.call("createEncryption", { body: { email, entity, ...keys.public } });
    state.update({ entity, deviceKeys: keys });
    output(result.data);
    return;
  }
  if (area === "scenario" && command === "run") {
    output(await runScenario(path.resolve(process.cwd(), rest[0]), client));
    return;
  }
  if (area === "db" && command === "reset") {
    const { environmentId } = assertResetAllowed(config, String(flags.confirm || ""));
    const result = (await client.call("resetDB", { body: { testEnvironmentId: environmentId } })).data;
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
