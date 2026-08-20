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
- a reset-enveloped two-user Compute-sharing scenario that builds with one profile, discovers the exact shared manifest with another profile's 20/200 ordinary evidence, requires app-scoped entity-use IDs in the new local Path, and proves a bounded owner-published effect can update that owner's exact ordinary relation for a named cross-user service;
- one stored seamless capability-chain scenario that combines ordinary cross-user Context, protected markers, recipient permission requests, timed owner approval, recipient-local decryption, Convert build, and self/named Compute invocation using deployed primitives;
- guarded requests to reset an isolated test environment.

It does not own:

- product interpretation, Paths, entities, JPL, Shorthand, or ArrayLogic semantics;
- production identity recovery or production private keys;
- bypasses for email verification or authorization;
- browser-only WebAuthn activation, rendering, accessibility, worker lifecycle, IndexedDB persistence, or UI Path-learning behavior.

## Trust boundaries

The local state file contains a test access token and test-only private key material. It is mode `0600`, lives under `.state/`, and must never contain production credentials. Reset requires an explicit local allow-list and confirmation and sends the versioned canonical mode, but the authoritative decision and ordered one-time legacy purge are owned by Compute using a test-stack enable flag, exact environment identity, reset-control marker, and allowed caller.

## Contract

Requests use the website's API transport contract: POST to the configured cookies endpoint, set `X-Original-Host` to `/<action>/<path...>`, and replay the issued token through the cookie-compatible `X-accessToken` transport. Responses preserve the raw API envelope and expose the Compute payload for assertions.

Message scenarios use `websiteUrl` to call `/classify-input` and `/essence`, and load `/workers/graphWorkerLib.js` plus `/workers/quantityLedgerWorkerLib.js` from that same deployment. For statement turns they apply returned mutation operations before ingesting returned fact rows, matching the browser transaction order. A step explicitly marked `local-ledger` skips classification and Essence transport and executes the published browser primitive against the accumulated graph. The graph and ledger implementations remain owned and published by `aws`; `testing` only sequences inputs and asserts visible answers and execution mode.

Compute scenarios use the same authenticated profile to poll public Convert discovery and build/reuse states. They select the authoritative top-level registered capability manifest before any nested generation artifact, so a pre-creation `pending-capability-entity` cannot become an invocation target. A discovery result that requires extension fails explicitly until the harness performs the Edit/extension lifecycle; it is not treated as successful reuse. Retryable terminal background discovery and build failures receive at most two fresh replacement jobs, matching the browser controller; non-retryable failures and exhaustion remain explicit. Optional setup turns execute before Convert and become the same bounded recent-input and proven-Essence authoring context used by the browser. The runner loads the deployed tokenizer, semantic dataset/compiler, Pattern Schema runtime, graph store, Path-binding runtime, and Compute-capability worker. A `published-semantic-path` step selects a named equation from the deployed catalog, requires the deployed matcher to accept it, materializes its declared `binding`, `instanceBinding`, and constrained `boundVar` row references, and passes any catalog-owned write policy to the deployed graph runtime; unsupported references fail closed. Invocation then resolves the manifest's ContextDB inputs against that local graph, calls the normal `runEntity` route, validates any declared ContextDB effect, and applies its returned graph mutation operations before later Essence assertions. Scenarios can require exact annotated invocation examples and exact answer text. This proves the cross-layer contract without browser automation, but it does not prove IndexedDB persistence, worker acknowledgement, rendering, or physical input gestures.

The cross-user Compute-sharing runner requires two existing profiles and an explicit reset confirmation. The CLI performs the canonical reset before the first input and again in a final cleanup path, including after scenario failure. User 1 executes ordinary published Essence setup, publishes a named identity and entity state, authors the hard-stop Convert capability, invokes it, and queries the updated local graph. User 2 starts with a separate graph and no creator Path, hydrates User 1's named ordinary component, separates the exact owner-qualified referent from the behavior-only capability query, submits the original invocation plus up to 20 ordinary inputs and 200 ordinary graph entities, and requires Position discovery with that behavior query to return User 1's exact Compute entity/version. The Position propagation gate retries only bounded transient gateway statuses; an empty or unauthorized candidate set never becomes success. A possessive referent is exact when the supplied graph contains one owner-to-object pair through an ownership edge; duplicate lexical mentions such as the user node plus its name-value node or the owned object plus its kind node do not create false ambiguity. The returned model proposal must contain one exact dependency-to-property/subject/relation binding per manifest dependency. For a foreign relation, the owner-published capability-effect route revalidates the app owner, dependency, exact relation ID/version/publisher, and declared transition before updating the owner's canonical relation; the caller then uses the published label-preserving remap to install the acknowledged scalar under its canonical ID, proves the same exact update locally, and does not republish it as caller-owned data. Final published Essence queries prove both users observe the owner's updated state rather than an opaque canonical ID. The harness records `copiedCreatorPath: false` and `generatedLocalPath: true`; browser persistence and worker acknowledgement still require the existing website integration tests.

Because canonical reset deletes accounts as well as entities and Paths, the reset-enveloped sharing command clears only the explicitly named test profiles and bootstraps two fresh public users before its first scenario input. Reusing a pre-reset workspace or token is not accepted as a clean start. After registration, Position visibility receives one bounded propagation poll before absence is treated as a contract failure; the final canonical reset still runs after either success or failure.

Cross-user Context scenarios accept one existing test profile per declared actor and perform the same authenticated self-hydration that precedes browser inputs. Statement steps run the deployed semantic Path, publish its delta through that actor's normal authenticated Context route, and apply the server's authoritative IDs. Hydration steps and question `refreshLabels` call exact named hydration through the reader profile, reuse a unique remembered entity ID when present, merge the deployed Context publication envelope, and execute the deployed local question Path. The canonical refresh scenario deliberately performs the first named hydration before the owner publishes the tested fact so a stale-known-referent bug cannot pass.

The seamless chain extends that contract without duplicating product semantics. Its protected statement creates ciphertext locally, publishes only the ordinary graph plus opaque owner-validated marker, verifies that the reader's query discovers a requestable reference, exercises notifications and a 15-minute grant, rewraps the same content key to the reader's enrolled public-key version, retrieves only the recipient envelope, and injects decrypted data into a temporary local query graph. Convert polling retries bounded transient gateway failures without dropping job identity. The final invocations use the published Compute worker and normal `runEntity` transport. The runner emulates the data contracts, but does not claim browser user-activation or visual UI proof.

## Test placement

- Pure behavior belongs in the owning runtime repository.
- Cross-layer API/Compute acceptance belongs here.
- Browser-only seams receive a thin website integration test after headless acceptance succeeds.
