# Local AWS sandbox strategy

Status: **implementation baseline complete; Claude Code Web runtime validation pending**

## Decision

Use LocalStack as the default **AWS integration sandbox** for routine development, with real AWS staging retained as the final compatibility/release-verification layer. This is a candidate replacement for a long-lived AWS `dev` environment, not a replacement for staging or production verification.

Verification ladder:

1. unit/UI tests with `DATA_BACKEND=memory`;
2. local integration with the real `DATA_BACKEND=dynamodb` repository against LocalStack;
3. CDK synth/diff/security gates;
4. real AWS staging/device/external-service verification;
5. production release gates.

## Implemented developer lane

The repository now contains a disposable local lane:

```bash
npm install -g @localstack/lstk
export LOCALSTACK_AUTH_TOKEN='...'

npm run local:aws:up
npm run local:aws:test
npm run local:aws:reset
npm run local:aws:down
```

`npm run local:aws:up`:

- starts LocalStack through the repo-local `.lstk/config.toml`;
- creates `open-reception-local` with the production-compatible `PK/SK`, `GSI1PK/GSI1SK`, GSI1 and `ttl` definition;
- runs the existing DynamoDB seed with deterministic mock/demo data;
- uses dummy local AWS credentials only.

`npm run local:aws:test` additionally executes `scripts/local-aws-smoke.ts` against the **real DynamoDB backend implementation**. The smoke path covers collection put/get/query, GSI lookup, conditional create, compare-and-set update/removal, singleton persistence, indexed log lookup/range query, and delete.

The application code is not given a LocalStack-only repository. AWS SDK v3 is redirected by the standard `AWS_ENDPOINT_URL` environment variable only in the local execution lane.

## Local responsibility

Prioritize the sandbox for DynamoDB persistence semantics first. Extend it to S3, Secrets Manager, Cognito, Lambda/API Gateway only when the additional emulator coverage materially improves feedback time.

Keep the existing in-memory backend for the fastest unit/UI iteration.

## Real AWS / external responsibility

Keep these outside the local proof boundary:

- real iPad/browser/device behavior and soak behavior;
- Vonage/telephony/WebRTC;
- speech-service quality/latency and provider edge cases;
- CloudFront, certificate, DNS and public-delivery behavior;
- IAM/KMS/Cognito security semantics that depend on AWS implementation details;
- destructive/replacement/live-drift behavior of CloudFormation/CDK.

## Guardrails

- `LOCALSTACK_AUTH_TOKEN` belongs only in the Claude Code environment/secret store.
- No staging/production credentials or PII are required locally.
- Never weaken production resource security for emulator compatibility.
- A green local run never suppresses AWS diff/negative/security/release checks.
- Local state is disposable; fixtures/bootstrap are the source of reproducibility.

## Replacement decision gate

Do not delete a persistent AWS `dev` environment yet. First run `npm run local:aws:test` from a clean Claude Code Web session and exercise representative feature work through this lane. If routine development no longer needs real AWS and staging covers the remaining device/external/AWS-specific gaps, record a measured recommendation to **remove or downsize dev**.

Staging remains the real-AWS compatibility gate.
