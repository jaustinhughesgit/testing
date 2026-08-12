# 1var Headless Testing

This repository makes the website's operational contracts callable from a terminal and from CI. It lets a feature be specified as an acceptance scenario, implemented in its owning layer, verified through API and Compute, and only then connected to the website.

## Setup

Requires Node.js 20 or newer and no third-party packages.

```sh
cp testing.config.example.json testing.config.json
npm test
```

Point `apiUrl` and `originalHost` at an isolated local or test deployment. Do not put production credentials in this repository.

## Commands

```sh
# Call any existing action. The first request also captures the test session cookie.
node src/cli.js api call checkEmailVerified --entity 1v4r-example --body '{}'

# Mirror the current account bootstrap contract.
node src/cli.js account bootstrap

# Or complete bootstrap, real test-mail verification, and test-device enrollment in one command.
node src/cli.js account setup --email coach@example.test

# Request a real verification message, obtain its link from the configured test mailbox, and verify it.
node src/cli.js email request --email coach@example.test --entity 1v4r-example
node src/cli.js email verify --email coach@example.test

# Create test-only P-256 device keys and register their public keys.
node src/cli.js encryption setup --email coach@example.test --entity 1v4r-example

# Encrypt text locally, store only its recipient-wrapped envelope, and reveal it locally.
node src/cli.js protected-asset create-text --text 'private value' --label 'Acceptance secret'
node src/cli.js protected-asset reveal-text

# Encrypt a provider credential with separate device and secure-executor wraps.
node src/cli.js protected-asset create-credential \
  --value 'test-secret' --field api_key \
  --provider-id provider.example --provider-host api.provider.example \
  --capability-id example.lookup

# Run a reusable JSON acceptance scenario.
node src/cli.js scenario run scenarios/smoke.example.json

# Run messages through the published classifier/Essence endpoints and the
# published browser-local graph runtime, preserving one ContextDB across turns.
ONEVAR_TEST_WEBSITE_URL=https://1var.com \
  node src/cli.js message run scenarios/hardware-store-messages.json

# Reset only an explicitly enabled, server-authorized test environment.
node src/cli.js db reset --confirm reset:local
```

Every command accepts `--config <path>` and `--profile <name>`. `api call` accepts `--body '<json>'`, `--body @path/to/body.json`, and repeated path segments after the action.

Provider credentials let Compute inject only the declared field into the
declared provider. Ordinary server routes still receive only ciphertext and
metadata; recipient reveal remains controlled by the local device key.

## Development loop

1. Add a failing scenario that states the externally visible contract.
2. Add focused unit or contract tests in the repository that owns the primitive.
3. Implement the primitive in `aws-api` and/or `compute`.
4. Run those tests and this repository's headless scenario against an isolated stack.
5. Connect the successful contract to `aws` and add only the browser-specific integration check.

Email verification uses a real test mailbox adapter; it does not turn verification off. Device setup uses Node WebCrypto for a test device. Real WebAuthn enrollment still needs a browser test because user activation and authenticator behavior cannot be proven headlessly by this client.

Message scenarios download the website's published worker-safe graph runtime and call its public classification and Essence routes. This avoids copying interpretation or ContextDB semantics into `testing`; browser persistence, Path lifecycle, rendering, and user activation remain separate browser tests.

Database reset is deliberately double-gated. The CLI rejects production-like targets and demands explicit configuration and confirmation. Compute independently requires `TEST_RESET_ENABLED=true`, an exact `TEST_RESET_ENVIRONMENT_ID`, and the authenticated user's ID in `TEST_RESET_ALLOWED_USER_IDS`.
