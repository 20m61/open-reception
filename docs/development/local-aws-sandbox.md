# Local AWS sandbox strategy

Status: **runtime-validated in Claude Code on the web (2026-09-14).** The lane runs end to end there — `up` / `test` / `reset` / `down` — after three defects found by actually running it. The persistent-AWS-dev replacement decision is **recorded: `downsize`** (#1103); see "Replacement decision gate".

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

### `LOCALSTACK_AUTH_TOKEN`

`lstk` refuses without it in a non-interactive environment — **even for the Community image**, because the token authenticates the CLI itself, not just the Pro feature set. It is a runtime secret, so it belongs in the environment/secret store and must be added **before** a session is created: environment variables in Claude Code on the web are baked in at container start and do not reach an already-running session. A headless lane needs a **CI Auth Token**, not a personal developer token.

#### 🔴 Check the key name, not just "is it set" (measured 2026-09-14)

A session was started believing the token was configured. Every ordinary probe said it was not:

```bash
printenv LOCALSTACK_AUTH_TOKEN   # exit 1
echo "${LOCALSTACK_AUTH_TOKEN+set}"  # empty
```

The token **was** present. It had been registered in the environment dialog as `"LOCALSTACK_AUTH_TOKEN "` — **with a trailing space** — and the value carried one too. A trailing space makes a perfectly valid environment entry that is **not a valid shell identifier**, so bash never exposes it as a variable and `printenv NAME` cannot find it. The entry is invisible to exactly the checks a person reaches for first.

This is the repository's own investigation rule in its purest form: *"not found" is not "absent" — it is "not found under those conditions."* Two probes that disagree are a signal to widen the conditions, not to pick the answer you expected. What separated them here:

```bash
env | cut -d= -f1 | grep -n 'LOCALSTACK'   # shows the name, with its trailing space
python3 -c "import os; print([repr(k) for k in os.environ if 'LOCALSTACK' in k])"
```

**Fix it in the environment dialog** (delete and re-add the key without surrounding whitespace), then start a **new** session — an existing session cannot be repaired, because the value is baked in at container start.

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

## 🔴 Three defects that only running it could find (measured 2026-09-14)

The lane had never completed a run. Each of these makes `npm run local:aws:up` fail, and each was invisible to review:

### 1. `lstk` lifecycle commands reject `AWS_ENDPOINT_URL`

The lane exports `AWS_ENDPOINT_URL` so the app and the AWS CLI reach LocalStack. But `lstk start` **refuses to run** while it is set:

```
Error: start does not support AWS_ENDPOINT_URL: it operates on a local Docker
container or local filesystem state with no remote equivalent
```

So `npm run local:aws:up` could never succeed with the repository's own defaults. 🔴 **The failure message lied about the cause**: `start_localstack` answered any failure with "configure `LOCALSTACK_AUTH_TOKEN`", so an endpoint problem read as a token problem, and the first diagnosis was wrong. Lifecycle calls now go through `lstk_lifecycle()`, which strips the variable with `env -u`; the lane keeps it for everything else. `tests/hooks/local-aws-lstk-lifecycle.test.ts` pins both sides — the lower bound matters, because "stop exporting it at all" would satisfy the upper bound while pointing the app at **real AWS**.

### 2. The container cannot activate its license behind a TLS-terminating loopback proxy

LocalStack contacts `https://api.localstack.cloud/v1` at startup and exits **55** if it cannot. In Claude Code on the web it cannot, for two independent reasons:

- the agent proxy binds **127.0.0.1 only** (measured in `/proc/net/tcp`), so a bridge-network container has no route to it;
- the proxy re-terminates TLS, so the container must trust its CA.

`lstk`'s config supports `image`, `env` and `volumes` but **not `network`**, so it cannot place the container on the host network. Two candidate escapes were tested and both failed:

| Attempt | Result |
| --- | --- |
| `lstk` with `env`/`volumes` carrying proxy + CA | ⛔ still unreachable — bridge container cannot route to `127.0.0.1` |
| Community image (`image = "localstack/localstack"`) to avoid licensing | ⛔ `lstk` forwards `LOCALSTACK_AUTH_TOKEN` into the container, which then attempts Pro activation and exits 55 anyway |

What works — measured, `freemium` activated and `Ready` — is a **self-managed container** on the host network with the CA mounted, driven through `lstk --endpoint-url`, which is `lstk`'s own documented path for an externally managed emulator. `scripts/local-aws.sh` picks this automatically (`LOCAL_AWS_CONTAINER_MODE=auto`) when it sees a loopback proxy, and stays with `lstk start` everywhere else. Force either with `LOCAL_AWS_CONTAINER_MODE=lstk|self`.

The same container gets `/var/run/docker.sock`; without it LocalStack logs `Docker not available` and Lambda cannot run.

### 3. `lstk aws` prints a banner on **stdout**, corrupting captured values

```
> Note: No AWS profile found, run 'lstk setup aws'
```

A `--query ... --output text` capture therefore returns `"> Note: ...\nENABLED"`, so the TTL check never matched `ENABLED` and `bootstrap_table` re-enabled TTL on every run. The second `up` died on `TimeToLive is already enabled` — **`up` was not idempotent**, which also broke `test` and `reset`. `lstk_aws_value()` now strips banner lines.

🔴 The fix is the capture, **not** a swallowed error: tolerating `already enabled` would produce the same green while leaving the corrupted capture in place, converting a loud failure into a silent one.

### Regression check

Changing these methods risks dropping guarantees the previous shape happened to hold. The prior mutations were re-applied as a matrix in an isolated `git worktree`. First run: **12 of 13 killed**, with every pre-existing guarantee (credential isolation, `env` independence from preflight, daemon early-return, `dockerd` absence check, wait-timeout floor) still killed — so the method change cost nothing. The single survivor was the **new** `auto` mode detection, which nothing bound because every other test injected `LOCAL_AWS_CONTAINER_MODE` explicitly; collapsing `auto` to always-`lstk` passed the whole suite. Closed by the detection tests in `local-aws-self-managed.test.ts`, after which the full matrix re-ran at **13/13**.

The survivor is the point of doing this: it was a guarantee nobody would have missed until the next proxied session failed to start.

## Measured service coverage (2026-09-14, this license tier)

| Service | Result |
| --- | --- |
| DynamoDB | ✅ production backend, 8 deterministic integration tests + smoke |
| S3 | ✅ bucket create / put / get |
| Secrets Manager | ✅ create / get |
| Lambda | ✅ create **and invoke** (`{"ok": true}`) — requires the docker socket |
| API Gateway | ✅ REST API create |
| IAM | ✅ role create |
| Cognito | ⛔ **not included in this license** — `cognito-idp service is not included within your LocalStack license` |

Cognito being unavailable is a licensing fact, not a configuration mistake; user-pool and authorizer behavior stays on the real-AWS side of the boundary.

## Condition 4: the production backend is what gets exercised

`src/lib/data/dynamodb.emulator.test.ts` runs the **production `DynamoBackend`** against real LocalStack DynamoDB. There is no LocalStack-specific repository: the class is constructed with no arguments, so it configures itself from `AWS_ENDPOINT_URL` and `TABLE_NAME` exactly as it does in the deployed Lambda.

It pins what the in-memory fake in `dynamodb.test.ts` **cannot** guarantee, since the fake is a predicate this repository wrote itself:

- GSI1 exists on the table and is queryable (a shape mismatch throws on real DynamoDB);
- tenant isolation across the index — asserted as an upper **and** lower bound, because "cannot be read from the other tenant" passes in a world where nothing can be read at all;
- conditional create and compare-and-set rejection enforced by the real engine;
- `ttl` written as epoch seconds, bounded by a window measured around the write rather than an approximation;
- internal keys (`PK`/`SK`/`ttl`/`GSI1PK`/`GSI1SK`) stripped before data reaches callers;
- audit-log range and index queries, with a future `since` as the lower bound.

🔴 **It does not run in the default quality gate.** The suite is skipped unless `LOCAL_AWS_INTEGRATION=1`, which only `scripts/local-aws.sh test` sets — LocalStack green is never promoted into release evidence. But *enabled and unreachable* fails rather than skips, so a broken emulator cannot masquerade as a passing run.

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

**Decision: `downsize` — stop running an *always-on* AWS `dev` environment, while keeping a
real AWS environment reachable on demand.** Recorded 2026-09-15 (#1103; measurements 2026-09-14/15). Measured, not inferred;
the measurements, the precondition, and the one thing still unmeasured are all below.

🔴 **Not `remove`.** `dev` is today the only real AWS environment that exists — `staging` has
never been stood up — and it is where `/admin/login` is actually verified. See
"Why `downsize` and not `remove`".

🔴 **Recording this recommendation is not executing it.** Tearing down or resizing AWS
resources is a stop boundary (cost / infrastructure). The change itself needs human approval.

### What routine development can now do locally

Measured in Claude Code on the web, no AWS account credentials, no Docker, cold start ~16s:

| Capability | Result | How it was measured |
| --- | --- | --- |
| DynamoDB persistence (table/GSI1/TTL/conditional write/tenant isolation) | ✅ verified | production `DynamoBackend`, 8 integration tests + `npm run aws:local:capability` |
| S3 / Secrets Manager / SSM / Lambda invoke / API Gateway | ✅ | `npm run aws:local:test` |
| `cdk synth` | ✅ 18s | no credentials and no emulator needed; gated behind a fresh `build:open-next` |
| `cdk bootstrap` / `cdk deploy` → emulator | ✅ 13.9s | real CloudFormation stack created in MiniStack |
| `cdk diff` after that deploy | ✅ **"There were no differences"** | real change-set path, not `--method=template` |

The deploy→diff loop **round-trips locally**. Plain CDK v2 honours `AWS_ENDPOINT_URL`, so this
needs no `cdklocal` and no new dependency.

### What it cannot do — and the one that bites

🔴 **Cognito SRP password verification is `permissive`, not missing.** MiniStack issues
ID/Access/Refresh tokens for a **wrong password**; Moto rejects the production call shape
entirely and also accepts a wrong password when coaxed into answering. Details and the
measurement table are in [`../local-aws.md`](../local-aws.md) ("Cognito は素通りする").

This is the finding that shapes the recommendation. A permissive emulator is worse than an
absent one: it lets someone add a green "admin login works locally" test that **cannot fail**
if authentication is removed. So `/admin/login` and anything behind it stays a real-AWS
concern regardless of how good the local lane gets.

Unchanged from before, still real-AWS-only: IAM evaluation, KMS, real token verification/JWKS,
CloudFront/certificate/DNS delivery, CloudFormation replacement & drift, Transcribe streaming,
Polly audio quality, Vonage/WebRTC, real device/browser behavior.

### Why `downsize` and not `remove`

The capabilities that still need AWS — auth, IAM, delivery — are real and frequently touched.
What the local lane removes is the **routine** need: persistence, infra shape and API wiring no
longer touch AWS at all, and `cdk synth`/`deploy`/`diff` round-trip against the emulator.

🔴 **But `dev` is currently the only real AWS environment that exists, and it is where the
auth path is actually exercised.** Checked 2026-09-14:

- `staging` appears only as a type union (`infra/lib/config/environments.ts:7`), an IAM
  resource pattern, a cost filter and test fixtures. **It has never been stood up.**
- Every deployment record in `docs/runbook-cloud-aws-deploy.md` is `-c env=dev`; the most
  recent one (2026-09-14) applied the custom domain for the first time.
- `scripts/e2e-live.sh` requires `LIVE_BASE_URL` + `LIVE_ADMIN_USER` + `LIVE_ADMIN_PASSWORD`
  and drives `/admin/login` against a live deployment; `scripts/url-quality-gate.sh` runs
  ZAP/Lighthouse against a live URL. These are the **only** place the Cognito path above —
  the one that cannot be verified locally — is checked at all.

So `downsize` here means **stop paying for an always-on `dev`, not stop having a real AWS
environment.** `remove` would delete the only place auth is verified.

🔴 **Precondition before acting:** a real AWS environment must remain reachable for
`e2e-live` / `url-quality-gate` / `aws:negative-tests` — whether that is an on-demand `dev`
re-created from CDK when needed, or a `staging` that someone actually stands up first.
Deploys already run on demand under human approval with short-lived STS credentials
(ADR 0009 / #675), so "on-demand rather than always-on" is a change of *lifetime*, not of
*capability*.

### Still unmeasured

**No cost figure for the current persistent `dev` environment is on record**, so the size of the
saving is unknown. This recommendation rests on **capability**, not cost — it says the persistent
environment is not *needed* for routine development, not how much it costs to keep. Reading the
number requires real AWS billing access (`src/lib/platform/aws-cost-explorer.ts`, real AWS only);
that is the remaining input before acting, and it affects *how far* to downsize, not *whether*.

A real AWS environment remains the compatibility gate regardless of the outcome. Today that is
`dev`; if it is ever to be `staging`, `staging` has to exist first.
