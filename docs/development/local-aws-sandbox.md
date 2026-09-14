# Local AWS sandbox strategy

Status: **implementation baseline complete on `chore/local-aws-dev-sandbox`; Claude Code Web runtime validation pending**

## Decision

Use LocalStack as the default **AWS integration sandbox** for routine development, with real AWS staging retained as the final compatibility/release-verification layer. This is a candidate replacement for a long-lived AWS `dev` environment, not a replacement for staging or production verification.

Verification ladder:

1. unit/UI tests with `DATA_BACKEND=memory`;
2. local integration with the real `DATA_BACKEND=dynamodb` repository against LocalStack;
3. CDK synth/diff/security gates;
4. real AWS staging/device/external-service verification;
5. production release gates.

## Implemented developer lane

```bash
npm install -g @localstack/lstk
export LOCALSTACK_AUTH_TOKEN='...'

npm run local:aws:up
npm run local:aws:test
npm run local:aws:reset
npm run local:aws:down
```

Claude Code Web is a headless/non-interactive environment, so `LOCALSTACK_AUTH_TOKEN` must be configured as an environment secret before `lstk start`. Do not commit it.

`LOCALSTACK_AUTH_TOKEN` is a runtime secret: keep it in the environment/secret store only, and never commit, print, fixture, or attach it to evidence. A headless/CI-equivalent lane needs a **CI Auth Token** rather than a personal developer token; a personal token is not licensed for unattended runs.

Environment variables in Claude Code on the web are **baked in at container start**, so a token added to the environment dialog does not reach an already-running session. Add it first, then create the session.

## 🔴 Docker is available in Claude Code on the web — it is just not started (measured 2026-09-14)

A first pass measured a clean session and found no Docker daemon, and nearly concluded that this lane could not run here. **That conclusion was wrong.** The measurement was right; the inference drawn from it was not.

`dockerd`, `containerd` and `runc` are all installed, and the session runs as root. Starting the daemon takes about two seconds, after which image pulls reach Docker Hub through the agent proxy and containers run normally:

| Step | Result |
| --- | --- |
| `dockerd` start | ✅ up in ~2s (Server 29.3.1, storage-driver `overlayfs`, cgroup v1) |
| `docker pull hello-world` | ✅ succeeds through the proxy |
| `docker run hello-world` | ✅ runs |
| `npm install -g @localstack/lstk` | ✅ installs (v1.0.1) |
| `lstk start` | ⛔ `authentication required: set LOCALSTACK_AUTH_TOKEN` |

🔴 **"Stopped" is not "cannot be started."** This is the same shape as the repository's own investigation rule that "not found" only ever means "not found under those conditions" — separate what you measured from what you inferred from it. The default state (daemon down) is a fact; "therefore Docker is unavailable here" was an untested inference.

`scripts/local-aws.sh preflight` now **starts the daemon** when it is down rather than failing closed, so a fresh session needs no manual step. Verified end to end by stopping `dockerd` and re-running preflight, which brought it back up in 2s. `tests/hooks/local-aws-docker-daemon.test.ts` pins the behavior with fake `docker`/`dockerd` binaries, including the lower bound that an already-running daemon is **not** restarted.

```bash
npm run local:aws:preflight   # starts dockerd if needed, then checks lstk/npm
```

The Docker **CLI** is present even when the daemon is down, which makes this easy to misread — the repository's quality gate reports the same condition when it skips ZAP (`docker デーモンに接続できません（CLI はあります）`). Check the daemon, not the CLI.

### The one remaining prerequisite: `LOCALSTACK_AUTH_TOKEN`

`lstk start` refuses without it in a non-interactive environment. It is a runtime secret, so it belongs in the environment/secret store and must be added **before** a session is created — environment variables in Claude Code on the web are baked in at container start and do not reach an already-running session. A headless lane needs a **CI Auth Token**, not a personal developer token.

**This is what #1103 AC1 now waits on** — not Docker.

### Diagnosing without starting anything

```bash
npm run local:aws:env
```

`env` deliberately skips `preflight()` so the lane stays observable where the prerequisites are missing — otherwise the first line fails and nothing is learned. It prints no secret: the credentials are the constant `test` by construction.

## 🔴 The local lane is isolated from real AWS credentials

`scripts/local-aws.sh` assigns dummy credentials **unconditionally** and clears `AWS_SESSION_TOKEN` and `AWS_PROFILE`.

This used to be written `${AWS_ACCESS_KEY_ID:-test}`. Because `:-` means *if unset*, a session holding a real AWS deploy window inherited real STS credentials into the local lane, with the session token never cleared — the full short-lived credential set. AC1 asks for LocalStack to run **without real AWS credentials**, and the `:-` form did not guarantee that. The blast radius was small while the endpoint pointed at localhost, but small is not the same as guaranteed: one wrong `AWS_ENDPOINT_URL` and real credentials reach real AWS.

`tests/hooks/local-aws-credential-isolation.test.ts` pins this by spawning bash. It asserts both sides: that the dummy values are present, **and** that sentinel real-looking values never appear in the output — asserting only the former would pass in a world where both are emitted.

`npm run local:aws:up` starts LocalStack, creates `open-reception-local` with production-compatible `PK/SK`, `GSI1PK/GSI1SK`, GSI1 and `ttl`, runs the existing deterministic DynamoDB seed, and uses dummy local AWS credentials only.

`npm run local:aws:test` additionally executes `scripts/local-aws-smoke.ts` against the **real DynamoDB backend implementation**. The smoke path covers collection put/get/query, GSI lookup, conditional create, compare-and-set update/removal, singleton persistence, indexed log lookup/range query, and delete.

The application code is not given a LocalStack-only repository. AWS SDK v3 is redirected by the standard `AWS_ENDPOINT_URL` environment variable only in the local execution lane.

## Local responsibility

Prioritize DynamoDB persistence semantics first. Extend to S3, Secrets Manager, Cognito, Lambda/API Gateway only when additional emulator coverage materially improves feedback time. Keep the existing in-memory backend for the fastest unit/UI iteration.

## Real AWS / external responsibility

Keep device/soak behavior, Vonage/WebRTC, speech-service fidelity, CloudFront/certificate/DNS/public delivery, AWS-specific IAM/KMS/Cognito semantics, and CloudFormation replacement/live-drift behavior outside the local proof boundary.

## Guardrails

- `LOCALSTACK_AUTH_TOKEN` belongs only in the Claude Code environment/secret store.
- No staging/production credentials or PII are required locally.
- Never weaken production resource security for emulator compatibility.
- A green local run never suppresses AWS diff/negative/security/release checks.
- Local state is disposable; fixtures/bootstrap are the source of reproducibility.

## Replacement decision gate

Do not delete a persistent AWS `dev` environment yet. First run `npm run local:aws:test` from a clean Claude Code Web session and exercise representative feature work through this lane. If routine development no longer needs real AWS and staging covers the remaining device/external/AWS-specific gaps, record a measured recommendation to **remove or downsize dev**.

Staging remains the real-AWS compatibility gate.
