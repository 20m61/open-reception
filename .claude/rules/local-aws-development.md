# Local AWS development

- Prefer a disposable LocalStack sandbox for routine AWS integration before using a real AWS dev/staging environment.
- Use the current `lstk` CLI (`lstk start`, `lstk status`, `lstk reset --force`, `lstk stop`, `lstk cdk ...`). Do not add new dependencies on the deprecated `localstack` CLI or `cdklocal`.
- `LOCALSTACK_AUTH_TOKEN` is a runtime secret. Never commit, print, fixture, or persist it.
- Never require real staging/production AWS credentials for local development.
- LocalStack passing is not AWS parity. Infrastructure/auth/network/delivery changes still require the repository's existing CDK and real-AWS verification gates.
- Never weaken production IAM, encryption, tenancy, audit, or deployment controls to make the emulator pass; introduce local-only endpoint/config wiring instead.

## open-reception-specific boundary

- Keep `DATA_BACKEND=memory` as the fastest unit/UI path.
- Add/use `DATA_BACKEND=dynamodb` against LocalStack as the integration path so the real DynamoDB repository implementation is exercised before AWS deployment.
- Prioritize DynamoDB, S3, Secrets Manager, Cognito, Lambda and API Gateway integration locally where supported.
- Treat telephony/WebRTC/Vonage, device/browser behavior, real Cognito edge cases, CloudFront/certificate/DNS delivery, and speech-service fidelity as external or real-AWS/device verification concerns.
- Seed deterministic local fixture data and reset the emulator rather than preserving a shared developer state.

See `docs/development/local-aws-sandbox.md` for the replacement trial and verification ladder.
