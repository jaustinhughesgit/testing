# Testing Layer

## Responsibility

`testing` is a headless client and acceptance-test runner for contracts spanning `aws-api` and `compute`. It turns browser setup operations into commands without copying website presentation or creating alternate product behavior.

It owns:

- deterministic command invocation of public API actions;
- a persisted, gitignored test-device session;
- account bootstrap, email-verification, and test-device key-registration workflows;
- reusable acceptance scenarios;
- ordered message scenarios that call the website's public interpretation routes and execute its published worker-safe graph runtime;
- guarded requests to reset an isolated test environment.

It does not own:

- product interpretation, Paths, entities, JPL, Shorthand, or ArrayLogic semantics;
- production identity recovery or production private keys;
- bypasses for email verification or authorization;
- browser-only WebAuthn activation, rendering, accessibility, worker lifecycle, IndexedDB persistence, or UI Path-learning behavior.

## Trust boundaries

The local state file contains a test access token and test-only private key material. It is mode `0600`, lives under `.state/`, and must never contain production credentials. Reset requires an explicit local allow-list and confirmation, but the authoritative decision is made by Compute using a test-stack enable flag, exact environment identity, and an allowed authenticated user.

## Contract

Requests use the website's API transport contract: POST to the configured cookies endpoint, set `X-Original-Host` to `/<action>/<path...>`, and replay the issued token through the cookie-compatible `X-accessToken` transport. Responses preserve the raw API envelope and expose the Compute payload for assertions.

Message scenarios use `websiteUrl` to call `/classify-input` and `/essence`, and load `/workers/graphWorkerLib.js` plus `/workers/quantityLedgerWorkerLib.js` from that same deployment. For statement turns they apply returned mutation operations before ingesting returned fact rows, matching the browser transaction order. A step explicitly marked `local-ledger` skips classification and Essence transport and executes the published browser primitive against the accumulated graph. The graph and ledger implementations remain owned and published by `aws`; `testing` only sequences inputs and asserts visible answers and execution mode.

## Test placement

- Pure behavior belongs in the owning runtime repository.
- Cross-layer API/Compute acceptance belongs here.
- Browser-only seams receive a thin website integration test after headless acceptance succeeds.
