# Local AWS development

- Prefer a disposable LocalStack sandbox for routine AWS integration before using a real AWS dev/staging environment.
- Use the current `lstk` CLI (`lstk start`, `lstk status`, `lstk reset --force`, `lstk stop`, `lstk cdk ...`). Do not add new dependencies on the deprecated `localstack` CLI or `cdklocal`.
- `LOCALSTACK_AUTH_TOKEN` is a runtime secret. Never commit, print, fixture, or persist it. Headless/CI-equivalent lanes need a CI Auth Token, not a personal developer token.
- Verify the Docker **daemon**, not the `docker` CLI. The CLI is present in Claude Code on the web while the daemon is not, so `command -v docker` succeeding proves nothing.
- A stopped daemon is not an unavailable one. Claude Code on the web ships `dockerd`/`containerd`/`runc` and runs as root; `local-aws.sh preflight` starts the daemon (~2s) instead of failing closed. Do not conclude "Docker is unavailable here" from `docker info` failing — try starting it.
- Never let the local lane inherit real AWS credentials. Assign dummy values unconditionally and clear `AWS_SESSION_TOKEN` / `AWS_PROFILE`; `${VAR:-test}` silently keeps a real deploy window's credentials.
- Never require real staging/production AWS credentials for local development.
- LocalStack passing is not AWS parity. Infrastructure/auth/network/delivery changes still require the repository's existing CDK and real-AWS verification gates.
- Never weaken production IAM, encryption, tenancy, audit, or deployment controls to make the emulator pass; introduce local-only endpoint/config wiring instead.

- Verify the token's **key name**, not just its presence. An environment-dialog key with a trailing space (`"LOCALSTACK_AUTH_TOKEN "`) is a valid env entry but not a valid shell identifier, so `printenv NAME` and `${NAME+x}` both report it missing while the value is really there. When two probes disagree, widen the conditions before concluding "unset"; list raw keys (`env | cut -d= -f1`, `os.environ` reprs). It cannot be repaired in a running session — fix the dialog and start a new one.
- `lstk` needs the auth token **even for the Community image** (it authenticates the CLI), and it forwards the token into the container, which then attempts Pro activation. Choosing the Community image does not make the lane license-free.
- Never let `AWS_ENDPOINT_URL` reach `lstk` lifecycle commands (`start`/`stop`); they refuse to run while it is set. Strip it with `env -u` for those calls only — removing it from the lane entirely points the app at real AWS.
- Treat `AWS_CREDENTIAL_EXPIRATION` as part of credential isolation. With it left in place from a closed deploy window, the AWS CLI rejects even the dummy `test` credentials as expired.
- `lstk aws` writes a `> Note:` banner to **stdout**; strip banner lines before comparing a `--query`/`--output text` capture, or every comparison silently fails.
- Behind a TLS-terminating proxy bound to loopback, the emulator container needs host networking plus the proxy CA; `lstk` config has no `network` key, so self-manage the container and drive it via `lstk --endpoint-url`. Mount `/var/run/docker.sock` or Lambda cannot run.

## open-reception-specific boundary

- Keep `DATA_BACKEND=memory` as the fastest unit/UI path.
- Add/use `DATA_BACKEND=dynamodb` against LocalStack as the integration path so the real DynamoDB repository implementation is exercised before AWS deployment.
- Prioritize DynamoDB, S3, Secrets Manager, Cognito, Lambda and API Gateway integration locally where supported.
- Treat telephony/WebRTC/Vonage, device/browser behavior, real Cognito edge cases, CloudFront/certificate/DNS delivery, and speech-service fidelity as external or real-AWS/device verification concerns.
- Seed deterministic local fixture data and reset the emulator rather than preserving a shared developer state.

See `docs/development/local-aws-sandbox.md` for the replacement trial and verification ladder.
