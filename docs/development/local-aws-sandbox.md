# Local AWS sandbox strategy

Status: proposed baseline

## Decision

Use LocalStack as the default **AWS integration sandbox** for routine development, with real AWS staging retained as the final compatibility/release-verification layer. This is a candidate replacement for a long-lived AWS `dev` environment, not a replacement for staging or production verification.

Verification ladder:

1. unit/UI tests with the in-memory backend;
2. local integration with the real DynamoDB repository against LocalStack;
3. CDK synth/diff/security gates;
4. real AWS staging/device/external-service verification;
5. production release gates.

## Why this fits open-reception

The application already separates persistence through `DATA_BACKEND=memory|dynamodb`. The current default dev/test path is in-memory, while production uses the DynamoDB implementation. LocalStack can fill the missing middle layer: exercise the actual AWS SDK/DynamoDB path without requiring a shared cloud environment.

### Local responsibility

Prioritize LocalStack for:

- DynamoDB single-table persistence, TTL/GSI/query behavior used by the application;
- S3-backed asset flows;
- Secrets Manager configuration flows;
- Cognito/Lambda/API Gateway integration where emulator fidelity is adequate;
- CDK deployment smoke tests for the locally supported stack subset.

Continue using the in-memory backend for very fast unit/UI iteration.

### External / real AWS responsibility

Keep these outside the local proof boundary:

- real iPad/browser/device behavior and long-running soak behavior;
- Vonage/telephony/WebRTC and external network integrations;
- production speech-service quality/latency and service-specific edge cases;
- CloudFront, certificate, DNS and public-delivery behavior;
- IAM/KMS/Cognito security semantics that depend on AWS implementation details;
- destructive/replacement/live-drift behavior of CloudFormation/CDK.

## Claude Code on the web workflow

Install the current LocalStack CLI once in the environment:

```bash
npm install -g @localstack/lstk
export LOCALSTACK_AUTH_TOKEN='...'
```

The token must live only in the Claude Code environment/secret store.

Start/reset/stop:

```bash
lstk start
lstk status
lstk reset --force
lstk stop
```

For local infrastructure experiments:

```bash
lstk cdk synth
lstk cdk bootstrap
lstk cdk deploy
```

Only target stack/resource subsets known to be supported locally.

## Target integration mode

The desired local integration run should eventually be reproducible from a clean checkout with no real AWS credentials:

```text
LocalStack
  ├─ DynamoDB  <- DATA_BACKEND=dynamodb
  ├─ S3
  ├─ Secrets Manager
  ├─ Cognito (where useful)
  ├─ Lambda / API Gateway
  └─ other supported AWS integrations

Next.js app + Playwright/Vitest
  └─ deterministic local fixtures
```

The existing `memory` backend remains valuable and should not be removed; LocalStack adds an integration tier rather than replacing unit-test isolation.

## Guardrails

- No production/staging credentials or PII in local fixtures.
- Production AWS SDK defaults must remain production-safe; endpoint overrides must be explicit local/test configuration.
- Never change production resource security solely for emulator compatibility.
- A green local run never suppresses the existing AWS diff/negative/security/release checks.
- Reset local state between independent verification runs when deterministic results matter.

## Adoption plan

### Phase 1 — baseline

- commit `.lstk/config.toml` and Claude Code guidance;
- prove `lstk start/status/reset/stop` in Claude Code on the web;
- identify the CDK resource subset that deploys correctly to LocalStack.

### Phase 2 — DynamoDB integration

- add explicit local endpoint wiring to AWS SDK clients where required;
- make `scripts/seed-dynamodb.ts` able to target the local endpoint safely;
- run the real `DATA_BACKEND=dynamodb` implementation against LocalStack;
- add integration coverage for TTL/GSI/tenant/audit/session persistence behavior.

### Phase 3 — broader AWS golden path

- include S3/Secrets/Cognito/Lambda/API Gateway where valuable;
- provide one command that starts the sandbox, bootstraps resources, seeds fixtures and runs the golden path;
- keep external telephony/speech/device tests as separate adapters/gates.

### Phase 4 — dev-environment replacement trial

A persistent AWS `dev` environment becomes optional only when routine coding and integration no longer need it, the clean local golden path is reproducible in Claude Code on the web, and staging reliably covers the remaining AWS/device/external-service parity gap.

Do not delete or collapse staging: it remains the real-AWS compatibility gate.
