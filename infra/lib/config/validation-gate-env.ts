/**
 * The candidate Validation project's environment, aligned with the quality gate (#1146).
 *
 * ## Why this exists
 *
 * Runbook 7.5 (2026-10-08, SHA 64ce41f, build OpenReceptionDevDeployValidation:3ba8ffbc…) went red
 * in `npm test` with 11 failed files, all for environment reasons; none was a defect of the code
 * under test. Each class was reproduced locally without AWS (2026-10-08, ct-run0-g14):
 *
 * 1. **No `.git`.** The CodeConnections source action hands CodeBuild a zip. `git archive` of the
 *    same SHA, run with no repository above it, fails the same five files with the same messages
 *    (merge-method `ref: HEAD`, change-budget `git rev-parse HEAD`, gate-stamp-consumers
 *    `git ls-files`, lstk-secret-ignore, publish-path-transport `origin`).
 * 2. **CodeBuild's role credentials are visible to the unit lane.** `src/domain/governance/aws-runtime.ts`
 *    fails fast on `AWS_CONTAINER_CREDENTIALS_RELATIVE_URI` (instrumentation, cognito-srp,
 *    unit-lane-aws-hermetic; `=/fake` reproduces 8/9/2 failures). The install phase already ran
 *    `unset`, but the log shows the variable back in the build phase: an `unset` there does not
 *    reach later phases. So the scrub is applied on the `npm test` command line itself.
 * 3. **No gitleaks / semgrep.** push-secret-guard needs a working gitleaks; gate-tooling-wiring
 *    expects both tools present (its "restoring gitleaks semgrep" message is the CodeBuild one).
 * 4. **`aws` and `npx` share a directory.** `n` installs node into `/usr/local/bin`, where the image's
 *    `aws` also lives. aws-cloud-deploy's "aws missing" case drops every PATH directory holding `aws`,
 *    which drops `npx` too (`npx: command not found`; reproduced with node and aws in one directory).
 *    The gate's environments keep node in its own directory (nvm), so Validation does the same.
 *
 * ## Why not `codeBuildCloneOutput` (full clone)
 *
 * A full clone requires `codestar-connections:UseConnection` on the Validation role, i.e. it hands
 * the GitHub connection to candidate-controlled code. The stack deliberately keeps source-provider
 * credentials in the pipeline plane (see the stack test "keeps source-provider credentials in the
 * pipeline plane"). The repository is public, so Validation fetches the history anonymously and
 * binds it to the trusted revision instead (`VALIDATION_SOURCE_BIND_SCRIPT`): the fetched commit
 * must be the trusted CommitId and its tree must equal the pipeline's source archive, file by file.
 */

export const VALIDATION_GIT_REMOTE = 'https://github.com/20m61/open-reception.git';

/** Broker-independent tool directory, outside the candidate tree and placed first on `npm test`'s PATH. */
export const VALIDATION_TOOL_BIN = '/tmp/open-reception-validation-bin';

/** Same version as `scripts/restore-gate-tools.sh` / `scripts/cloud-setup.sh` (a test keeps them equal). */
export const GITLEAKS_VERSION = '8.29.0';
/** From `gitleaks_8.29.0_checksums.txt` of the GitHub release. */
export const GITLEAKS_LINUX_X64_SHA256 = '39e07ad810336fd0ae80d0bd61c60d0521f628173e7583583b5df4a38738522c';
export const GITLEAKS_URL = `https://github.com/gitleaks/gitleaks/releases/download/v${GITLEAKS_VERSION}/gitleaks_${GITLEAKS_VERSION}_linux_x64.tar.gz`;

/**
 * semgrep is only required to be present by the unit lane (gate-tooling-wiring). The wheel itself is
 * hash-pinned; its Python dependencies are resolved by pip from PyPI (not hash-pinned).
 */
export const SEMGREP_VERSION = '1.168.0';
export const SEMGREP_WHEEL = `semgrep-${SEMGREP_VERSION}-cp310.cp311.cp312.cp313.cp314.py310.py311.py312.py313.py314-none-manylinux_2_34_x86_64.whl`;
/** PyPI digest of SEMGREP_WHEEL (`https://pypi.org/pypi/semgrep/1.168.0/json`). */
export const SEMGREP_WHEEL_SHA256 = '09dfacb0530ed4a17bd2deb7914e9a25fc3581d5d84d5365cdac77bbebed8081';
export const SEMGREP_WHEEL_URL = `https://files.pythonhosted.org/packages/01/6c/3398532fe8ced8d3f01fad16231f496b878c83c534d9266df1cbe4aaea35/${SEMGREP_WHEEL}`;

/**
 * Every variable `aws-runtime.ts` reads as a real-credential signal, plus the SDK's other ambient
 * providers. Removed from `npm test`'s environment only (a test derives the list from aws-runtime.ts).
 */
export const VALIDATION_UNIT_LANE_UNSET = [
  'AWS_SESSION_TOKEN',
  'AWS_PROFILE',
  'AWS_CREDENTIAL_EXPIRATION',
  'AWS_ROLE_ARN',
  'AWS_WEB_IDENTITY_TOKEN_FILE',
  'AWS_CONTAINER_CREDENTIALS_RELATIVE_URI',
  'AWS_CONTAINER_CREDENTIALS_FULL_URI',
  'AWS_CONTAINER_AUTHORIZATION_TOKEN',
  'AWS_CONTAINER_AUTHORIZATION_TOKEN_FILE',
] as const;

/**
 * Validation: turn the source archive into a repository bound to the trusted revision.
 * `remote` is a JSON string literal; the stack passes VALIDATION_GIT_REMOTE (tests pass a local one).
 * Fails closed if the revision is malformed, the archive already has `.git`, the fetched history is
 * incomplete, or the archive has a file the revision lacks (or lacks / changes one it has). The
 * final `checkout --detach <sha>` leaves HEAD at the trusted revision with a clean tree.
 * File modes are not compared (an archive may drop them); the checkout restores the revision's.
 */
export const validationSourceBindScript = (remote: string): string =>
  [
    'const cp=require("child_process");',
    'const fs=require("fs");',
    'const sha=process.env.OR_TRUSTED_SOURCE_REVISION;',
    'if(typeof sha!=="string"||!/^[0-9a-f]{40}$/.test(sha)){throw new Error("trusted source revision missing or invalid")}',
    'if(fs.existsSync(".git")){throw new Error("source archive already carries .git")}',
    'const git=(...a)=>cp.execFileSync("git",a,{encoding:"utf8",stdio:["ignore","pipe","inherit"]}).trim();',
    'git("init","-q");',
    `git("remote","add","origin",${JSON.stringify(remote)});`,
    'git("fetch","-q","--no-tags","origin","+refs/heads/main:refs/remotes/origin/main",sha);',
    'if(git("cat-file","-t",sha)!=="commit"){throw new Error("trusted revision was not fetched")}',
    // No depth is requested, so GitHub sends full history; but a shallow server yields a repository
    // with missing parents that is not even marked shallow (measured with a file:// remote), so the
    // check is a walk of both histories to their roots rather than --is-shallow-repository.
    'try{git("rev-list","--count",sha,"refs/remotes/origin/main")}catch{throw new Error("fetched history is shallow or incomplete")}',
    'git("read-tree",sha);',
    'if(git("ls-files","--others","-z")!==""){throw new Error("source archive has files outside the trusted revision")}',
    'try{git("-c","core.fileMode=false","diff","--quiet")}catch{throw new Error("source archive differs from the trusted revision")}',
    'git("checkout","-q","-f","--detach",sha);',
  ].join(' ');

export const VALIDATION_SOURCE_BIND_SCRIPT = validationSourceBindScript(VALIDATION_GIT_REMOTE);

/** argv[1] = file, argv[2] = expected lowercase SHA-256 hex. Any difference fails closed. */
export const FILE_SHA256_CHECK_SCRIPT = [
  'const fs=require("fs");',
  'const crypto=require("crypto");',
  'const file=process.argv[1];',
  'const expected=process.argv[2];',
  'if(typeof expected!=="string"||!/^[0-9a-f]{64}$/.test(expected)){throw new Error("sha256 pin missing or invalid")}',
  'const actual=crypto.createHash("sha256").update(fs.readFileSync(file)).digest("hex");',
  'if(actual!==expected){throw new Error("sha256 mismatch: "+file)}',
].join(' ');

export const GITLEAKS_ARCHIVE_PATH = '/tmp/open-reception-gitleaks.tgz';
export const SEMGREP_WHEEL_PATH = `/tmp/${SEMGREP_WHEEL}`;
export const SEMGREP_VENV = '/tmp/open-reception-semgrep';

/**
 * `npm test` with the gate's environment: no ambient AWS credential provider (dummy keys as in the
 * install phase), and the tool directory first on PATH. Other steps are left as they are.
 */
export const VALIDATION_UNIT_TEST_COMMAND = [
  'env',
  ...VALIDATION_UNIT_LANE_UNSET.flatMap((name) => ['-u', name]),
  'AWS_ACCESS_KEY_ID=test',
  'AWS_SECRET_ACCESS_KEY=test',
  'AWS_EC2_METADATA_DISABLED=true',
  `PATH="${VALIDATION_TOOL_BIN}:$PATH"`,
  'npm test',
].join(' ');

/**
 * `npm --prefix infra test`, instrumented (#1146, build efa5f85f, 2026-10-09).
 *
 * On MEDIUM the infra suite hit the 30-min project timeout (the cloud gate runs it in 85 s). A local
 * reproduction refuted CPU count, NODE_OPTIONS and network, and only disk-I/O throttling reproduced
 * the timeouts; the CodeBuild log alone could not tell. So the step prints `nproc` / memory / disk /
 * PSI before and after, and a sampler prints PSI, dirty/writeback pages and CPU counters every
 * VALIDATION_IO_SAMPLE_INTERVAL_SECONDS while the suite runs.
 *
 * - The verdict is the suite's: its status is captured (immune to `set -e`) and is the exit status.
 * - The sampler is killed as soon as the suite ends (pass or fail) and waited for; only an in-flight
 *   child (at most its `sleep 1`) can outlive it, by at most a second. No file is involved, so a full /tmp (the very
 *   condition being observed, #721) cannot keep it running. Left alone it stops by itself after
 *   VALIDATION_IO_SAMPLER_MAX_SECONDS ticks of at least a second each, i.e. never before the
 *   project timeout; the limit bounds its output.
 * - The sampler reads /proc only; missing /proc/pressure is printed as unavailable, not an error.
 * - The whole step runs in a subshell, so its `exit` does not end CodeBuild's shell.
 */
export const VALIDATION_IO_SAMPLE_INTERVAL_SECONDS = 15;
export const VALIDATION_IO_SAMPLER_MAX_SECONDS = 30 * 60;

const PRESSURE_DUMP =
  'for p in cpu io memory; do echo "pressure/$p"; cat /proc/pressure/$p 2>/dev/null || echo "(unavailable)"; done';

const ioSnapshot = (label: string) =>
  `( echo "== validation-io ${label}"; nproc; free -m; df -h /tmp .; ${PRESSURE_DUMP} ) || true`;

export const VALIDATION_IO_SAMPLER = [
  `i=0; while [ $i -lt ${VALIDATION_IO_SAMPLER_MAX_SECONDS} ]; do`,
  `if [ $((i % ${VALIDATION_IO_SAMPLE_INTERVAL_SECONDS})) -eq 0 ]; then`,
  'echo "== validation-io sample $(date +%T)";',
  `${PRESSURE_DUMP};`,
  'grep -E "^(MemAvailable|Dirty|Writeback):" /proc/meminfo;',
  'head -n 1 /proc/stat;',
  'fi; i=$((i + 1)); sleep 1; done',
].join(' ');

export const VALIDATION_INFRA_TEST_COMMAND = [
  `( ${ioSnapshot('before')};`,
  `( ${VALIDATION_IO_SAMPLER} ) & sampler=$!;`,
  'st=0; npm --prefix infra test -- --reporter=verbose || st=$?;',
  'kill $sampler 2>/dev/null || true; wait $sampler 2>/dev/null || true;',
  `${ioSnapshot('after')};`,
  'echo "== validation-io infra test exit $st"; exit $st )',
].join(' ');
