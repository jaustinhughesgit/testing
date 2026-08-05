# Testing Repository Instructions

This repository is the headless acceptance boundary for the complete 1var platform. It is not a second product client and must not acquire independent product semantics.

Before changing it, read:

1. `../architecture/README.md`
2. `../architecture/docs/headless-acceptance-testing.md`
3. `docs/layer.md`
4. The `AGENTS.md` and `docs/layer.md` of every runtime repository exercised by the change

Rules:

- Test public cross-layer contracts, not private implementation details.
- Keep commands non-interactive and deterministic so agents and CI can run them.
- Never add production verification bypasses or store production credentials here.
- Database reset must remain protected by both client-side checks and server-side authorization.
- Prefer reusable scenarios over feature-specific shell scripts.
- A passing headless test does not replace the thin browser test required for browser-only APIs, rendering, or user activation.
