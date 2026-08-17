# Testing Layer

## Responsibility

`testing` is a headless client and acceptance-test runner for contracts spanning `aws-api` and `compute`. It turns browser setup operations into commands without copying website presentation or creating alternate product behavior.

It owns:

- deterministic command invocation of public API actions;
- a persisted, gitignored test-device session;
- account bootstrap, email-verification, and test-device key-registration workflows;
- reusable acceptance scenarios;
- ordered message scenarios that call the website's public interpretation routes and execute its published worker-safe graph runtime;
- ordered Compute scenarios that drive public Convert jobs, execute a named published semantic Path into local ContextDB, resolve manifest bindings, and invoke the created or reused entity;
- ordered cross-user Context scenarios that use separate authenticated profiles, publish deployed local-Path graph deltas, hydrate a named public component before and after a later mutation, and require the deployed local question Path to return the refreshed value;
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

Compute scenarios use the same authenticated profile to poll public Convert discovery and build/reuse states. They select the authoritative top-level registered capability manifest before any nested generation artifact, so a pre-creation `pending-capability-entity` cannot become an invocation target. A discovery result that requires extension fails explicitly until the harness performs the Edit/extension lifecycle; it is not treated as successful reuse. The runner loads the deployed tokenizer, semantic dataset/compiler, Pattern Schema runtime, graph store, Path-binding runtime, and Compute-capability worker. A `published-semantic-path` step selects a named equation from the deployed catalog, requires the deployed matcher to accept it, and materializes its declared `binding`, `instanceBinding`, and constrained `boundVar` row references; unsupported references fail closed. Invocation then resolves the manifest's ContextDB inputs against that local graph and calls the normal `runEntity` route. This proves the cross-layer contract without browser automation, but it does not prove IndexedDB persistence, worker acknowledgement, rendering, or physical input gestures.

Cross-user Context scenarios accept one existing test profile per declared actor. Statement steps run the deployed semantic Path, publish its delta through that actor's normal authenticated Context route, and apply the server's authoritative IDs. Hydration steps and question `refreshLabels` call exact named hydration through the reader profile, merge the deployed Context publication envelope, and execute the deployed local question Path. The canonical refresh scenario deliberately performs the first named hydration before the owner publishes the tested fact so a stale-known-referent bug cannot pass.

## Test placement

- Pure behavior belongs in the owning runtime repository.
- Cross-layer API/Compute acceptance belongs here.
- Browser-only seams receive a thin website integration test after headless acceptance succeeds.
