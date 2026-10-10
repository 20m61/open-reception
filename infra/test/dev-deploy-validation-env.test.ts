import { execFileSync, spawnSync } from 'node:child_process';
import { chmodSync, existsSync, mkdtempSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync, mkdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, describe, expect, it } from 'vitest';
import * as cdk from 'aws-cdk-lib';
import { Template } from 'aws-cdk-lib/assertions';
import { DevDeployBrokerStack, nodeEval } from '../lib/stacks/dev-deploy-broker-stack';
import {
  FILE_SHA256_CHECK_SCRIPT,
  GITLEAKS_LINUX_X64_SHA256,
  GITLEAKS_URL,
  GITLEAKS_VERSION,
  SEMGREP_WHEEL_SHA256,
  SEMGREP_WHEEL_URL,
  VALIDATION_GIT_REMOTE,
  VALIDATION_INFRA_TEST_COMMAND,
  VALIDATION_IO_SAMPLER,
  VALIDATION_IO_SAMPLER_MAX_SECONDS,
  VALIDATION_IO_SAMPLE_INTERVAL_SECONDS,
  VALIDATION_SOURCE_BIND_SCRIPT,
  VALIDATION_TOOL_BIN,
  VALIDATION_UNIT_TEST_COMMAND,
  validationSourceBindScript,
} from '../lib/config/validation-gate-env';
import { checkAwsRuntimeSafety } from '../../src/domain/governance/aws-runtime';

/**
 * #1146 runbook 7.5 (2026-10-08): the Validation project's `npm test` failed 11 files for
 * environment reasons (no `.git`, CodeBuild role credentials visible, no gitleaks/semgrep, `aws`
 * next to `npx`). These tests bind the environment the stack gives Validation to the quality gate's.
 */

const REPO_ROOT = join(__dirname, '..', '..');

const template = (() => {
  const app = new cdk.App();
  const stack = new DevDeployBrokerStack(app, 'TestDevDeployBroker', {
    env: { account: '822063948773', region: 'ap-northeast-1' },
  });
  return Template.fromStack(stack);
})();
const resources = template.toJSON().Resources as Record<string, { Type: string; Properties: Record<string, unknown> }>;

const buildSpecOf = (name: string) => {
  const found = Object.values(resources).find((r) => r.Type === 'AWS::CodeBuild::Project' && r.Properties.Name === name);
  expect(found, name).toBeDefined();
  const text = (found!.Properties.Source as { BuildSpec: string }).BuildSpec;
  return JSON.parse(text) as { phases: Record<string, { commands: string[] }> };
};
const validation = buildSpecOf('OpenReceptionDevDeployValidation');
const validationTimeoutMinutes = (Object.values(resources).find(
  (r) => r.Type === 'AWS::CodeBuild::Project' && r.Properties.Name === 'OpenReceptionDevDeployValidation',
)!.Properties.TimeoutInMinutes) as number;
const installCommands = validation.phases.install!.commands;
const buildCommands = validation.phases.build!.commands;

/**
 * Hard limit for each run of a buildspec command in this file: the test fails instead of waiting. It
 * signals the direct child only (`sh`); what that child started is not reaped by it.
 */
const COMMAND_TIMEOUT_MS = 60_000;

const temps: string[] = [];
const tempDir = (prefix: string) => {
  const dir = mkdtempSync(join(tmpdir(), `or-validation-env-${prefix}`));
  temps.push(dir);
  return dir;
};
// Cleanup only. Under throttled disk I/O (#1146 reproduction) removing the scratch repositories
// took over vitest's 10 s hook default and failed the file; give it the suite's test timeout.
afterAll(() => {
  for (const dir of temps) rmSync(dir, { recursive: true, force: true });
}, 60_000);

const git = (cwd: string, ...args: string[]) =>
  execFileSync('git', args, {
    cwd,
    encoding: 'utf8',
    env: { ...process.env, GIT_CONFIG_GLOBAL: '/dev/null', GIT_CONFIG_NOSYSTEM: '1' },
  }).trim();

/** A small "GitHub": main with a merge-free history of three commits and an executable file. */
const makeRemote = () => {
  const remote = tempDir('remote-');
  git(remote, 'init', '-q', '-b', 'main');
  git(remote, 'config', 'user.email', 't@example.invalid');
  git(remote, 'config', 'user.name', 't');
  const shas: string[] = [];
  for (const n of [1, 2, 3]) {
    writeFileSync(join(remote, 'a.txt'), `a${n}\n`);
    mkdirSync(join(remote, 'scripts'), { recursive: true });
    writeFileSync(join(remote, 'scripts', 'run.sh'), `#!/bin/sh\necho ${n}\n`);
    chmodSync(join(remote, 'scripts', 'run.sh'), 0o755);
    git(remote, 'add', '-A');
    git(remote, 'commit', '-q', '-m', `c${n}`);
    shas.push(git(remote, 'rev-parse', 'HEAD'));
  }
  return { remote, shas };
};

/** What the CodeConnections zip gives CodeBuild: the revision's files, no `.git`, modes lost. */
const archiveOf = (remote: string, sha: string) => {
  const dir = tempDir('src-');
  const tar = join(tempDir('tar-'), 'src.tar');
  git(remote, 'archive', '--format=tar', '-o', tar, sha);
  execFileSync('tar', ['-xf', tar, '-C', dir]);
  chmodSync(join(dir, 'scripts', 'run.sh'), 0o644);
  return dir;
};

const bind = (cwd: string, sha: string, remote: string) =>
  spawnSync('sh', ['-c', nodeEval(validationSourceBindScript(remote))], {
    cwd,
    encoding: 'utf8',
    timeout: COMMAND_TIMEOUT_MS,
    env: {
      ...process.env,
      OR_TRUSTED_SOURCE_REVISION: sha,
      GIT_CONFIG_GLOBAL: '/dev/null',
      GIT_CONFIG_NOSYSTEM: '1',
      GIT_CEILING_DIRECTORIES: tmpdir(),
    },
  });

describe('Validation source: a repository bound to the trusted revision (7.5 class 1)', () => {
  it('runs before any candidate code (only environment setup precedes it; before npm ci)', () => {
    const at = installCommands.indexOf(nodeEval(VALIDATION_SOURCE_BIND_SCRIPT));
    expect(at).toBeGreaterThanOrEqual(0);
    expect(installCommands.slice(0, at).every((c) => /^(unset|export) /.test(c))).toBe(true);
    expect(installCommands.indexOf('npm ci')).toBeGreaterThan(at);
    expect(VALIDATION_SOURCE_BIND_SCRIPT).toContain(JSON.stringify(VALIDATION_GIT_REMOTE));
  });

  it('the remote is the same repository the Source action reads', () => {
    const pipeline = Object.values(resources).find((r) => r.Type === 'AWS::CodePipeline::Pipeline')!;
    expect(JSON.stringify(pipeline.Properties)).toContain('"FullRepositoryId":"20m61/open-reception"');
    expect(VALIDATION_GIT_REMOTE).toBe('https://github.com/20m61/open-reception.git');
  });

  it('gives the archive full history, origin/main and HEAD at the trusted revision', () => {
    const { remote, shas } = makeRemote();
    const sha = shas[2]!;
    const src = archiveOf(remote, sha);
    const r = bind(src, sha, remote);
    expect(r.stderr).toBe('');
    expect(r.status).toBe(0);
    expect(git(src, 'rev-parse', 'HEAD')).toBe(sha);
    expect(git(src, 'rev-parse', 'refs/remotes/origin/main')).toBe(sha);
    expect(git(src, 'rev-parse', '--is-shallow-repository')).toBe('false');
    expect(git(src, 'rev-list', '--count', 'HEAD')).toBe('3');
    expect(git(src, 'ls-remote', '--get-url', 'origin')).toBe(remote);
    expect(git(src, 'status', '--porcelain', '--untracked-files=all')).toBe('');
    // The archive dropped the executable bit; the checkout restores the revision's mode.
    expect(statSync(join(src, 'scripts', 'run.sh')).mode & 0o111).not.toBe(0);
  });

  it('binds a revision that is not main\'s tip (dev-deploy may point behind main)', () => {
    const { remote, shas } = makeRemote();
    const sha = shas[1]!;
    const src = archiveOf(remote, sha);
    const r = bind(src, sha, remote);
    expect(r.status).toBe(0);
    expect(git(src, 'rev-parse', 'HEAD')).toBe(sha);
    expect(git(src, 'rev-parse', 'refs/remotes/origin/main')).toBe(shas[2]);
  });

  it.each([
    ['a changed file', (src: string) => writeFileSync(join(src, 'a.txt'), 'tampered\n'), /differs from the trusted revision/],
    ['an extra file', (src: string) => writeFileSync(join(src, 'extra.txt'), 'x\n'), /files outside the trusted revision/],
    ['an extra ignored-looking file', (src: string) => writeFileSync(join(src, '.env'), 'x\n'), /files outside the trusted revision/],
    ['a missing file', (src: string) => rmSync(join(src, 'a.txt')), /differs from the trusted revision/],
    ['a .git of its own', (src: string) => mkdirSync(join(src, '.git')), /already carries \.git/],
  ])('fails closed when the archive has %s', (_label, mutate, message) => {
    const { remote, shas } = makeRemote();
    const sha = shas[2]!;
    const src = archiveOf(remote, sha);
    mutate(src);
    const r = bind(src, sha, remote);
    expect(r.status).not.toBe(0);
    expect(r.stderr).toMatch(message);
  });

  it('fails closed when the trusted revision is another commit than the archive', () => {
    const { remote, shas } = makeRemote();
    const src = archiveOf(remote, shas[2]!);
    const r = bind(src, shas[1]!, remote);
    expect(r.status).not.toBe(0);
    expect(r.stderr).toMatch(/differs from the trusted revision/);
  });

  it.each([['', 'empty'], ['abc123', 'short'], ['A'.repeat(40), 'uppercase']])(
    'fails closed on a malformed trusted revision (%s: %s)',
    (sha) => {
      const { remote, shas } = makeRemote();
      const src = archiveOf(remote, shas[2]!);
      const r = bind(src, sha, remote);
      expect(r.status).not.toBe(0);
      expect(r.stderr).toMatch(/trusted source revision missing or invalid/);
      expect(existsSync(join(src, '.git'))).toBe(false);
    },
  );

  it('fails closed when the fetched history is shallow (merge-method would see only part of main)', () => {
    const { remote, shas } = makeRemote();
    const shallow = tempDir('shallow-');
    rmSync(shallow, { recursive: true, force: true });
    execFileSync('git', ['clone', '-q', '--depth', '1', '--branch', 'main', `file://${remote}`, shallow]);
    const sha = shas[2]!;
    const src = archiveOf(remote, sha);
    const r = bind(src, sha, `file://${shallow}`);
    expect(r.status).not.toBe(0);
    expect(r.stderr).toMatch(/shallow/);
  });
});

/** Every env name `realCredentialSignals` reads, taken from the source (not a hand-kept copy). */
const credentialSignalNames = (() => {
  const src = readFileSync(join(REPO_ROOT, 'src/domain/governance/aws-runtime.ts'), 'utf8');
  const body = /function realCredentialSignals[\s\S]*?\n}\n/.exec(src)?.[0] ?? '';
  return [...new Set([...body.matchAll(/env\.(AWS_[A-Z_]+)/g)].map((m) => m[1]!))];
})();

/** Hard limit for one run of the unit lane's command against the stub (it takes milliseconds). */
const UNIT_LANE_TIMEOUT_MS = 30_000;
const TRAP_EXIT = 97;

/**
 * Run the unit lane's `npm test` command with its tool directory `toolBin` replaced by a fresh one
 * holding a stub `npm` that records its argv and environment.
 *
 * The command puts `toolBin` first on PATH, and in CodeBuild the install phase links the real
 * node / npm / npx there. Run verbatim, that real `npm test` re-ran the whole infra suite from
 * inside this test, recursively (#1146 build 81267eff: 893 s, and the 3rd attempt's timeout). So
 * the command never runs with `toolBin` in it, and the outer PATH starts with a trap `npm` that
 * fails at once (exit TRAP_EXIT) instead of the real one, should the stub ever be bypassed.
 */
const runUnitLane = (command: string, toolBin: string, env: Record<string, string>) => {
  const bin = tempDir('tool-bin-');
  const dump = join(bin, 'env.json');
  const argvFile = join(bin, 'argv');
  writeFileSync(
    join(bin, 'npm'),
    `#!/bin/sh\necho "$@" > '${argvFile}'\nnode -e 'require("fs").writeFileSync(process.argv[1], JSON.stringify(process.env))' '${dump}'\n`,
  );
  chmodSync(join(bin, 'npm'), 0o755);
  const trap = tempDir('trap-');
  const trapMark = join(trap, 'ran');
  writeFileSync(join(trap, 'npm'), `#!/bin/sh\ntouch '${trapMark}'\nexit ${TRAP_EXIT}\n`);
  chmodSync(join(trap, 'npm'), 0o755);

  const local = command.replaceAll(toolBin, bin);
  expect(local).not.toContain(toolBin);
  expect('PATH' in env).toBe(false);
  const r = spawnSync('sh', ['-c', local], {
    // An empty directory: should any real npm still answer, `npm test` finds no package.json and
    // fails at once instead of running this suite (vitest's cwd is infra/).
    cwd: tempDir('unit-lane-cwd-'),
    encoding: 'utf8',
    timeout: UNIT_LANE_TIMEOUT_MS,
    env: { NODE_ENV: 'test', ...env, PATH: `${trap}:${process.env.PATH ?? ''}` },
  });
  const seen = existsSync(dump) ? (JSON.parse(readFileSync(dump, 'utf8')) as Record<string, string>) : undefined;
  const argv = existsSync(argvFile) ? readFileSync(argvFile, 'utf8').trim() : undefined;
  return { r, bin, seen, argv, trapRan: existsSync(trapMark) };
};

describe('Validation unit lane: no ambient AWS credentials (7.5 class 2)', () => {
  it('reads the signal list from aws-runtime.ts', () => {
    expect(credentialSignalNames).toContain('AWS_CONTAINER_CREDENTIALS_RELATIVE_URI');
    expect(credentialSignalNames).toContain('AWS_ACCESS_KEY_ID');
    expect(credentialSignalNames.length).toBeGreaterThanOrEqual(10);
  });

  it('npm test runs through the scrubbing command, and only npm test does', () => {
    expect(buildCommands).toContain(VALIDATION_UNIT_TEST_COMMAND);
    expect(buildCommands).not.toContain('npm test');
    expect(buildCommands.filter((c) => c.startsWith('env -u'))).toEqual([VALIDATION_UNIT_TEST_COMMAND]);
  });

  it('🔴 npm test sees none of the CodeBuild credential signals (behaviour, not text)', () => {
    const ambient: Record<string, string> = Object.fromEntries(
      credentialSignalNames.map((name) => [name, name === 'AWS_ACCESS_KEY_ID' ? 'ASIAEXAMPLEEXAMPLE00' : '/fake']),
    );
    // Positive control: this environment is what aws-runtime.ts refuses.
    expect(checkAwsRuntimeSafety(ambient).map((v) => v.code)).toContain('real_aws_without_opt_in');

    const { r, bin, seen, argv } = runUnitLane(VALIDATION_UNIT_TEST_COMMAND, VALIDATION_TOOL_BIN, ambient);
    expect(r.status, `${r.error ?? ''} ${r.stderr}`).toBe(0);
    expect(argv).toBe('test');
    expect(checkAwsRuntimeSafety(seen!)).toEqual([]);
    for (const name of credentialSignalNames) {
      if (name === 'AWS_ACCESS_KEY_ID') expect(seen![name]).toBe('test');
      else expect(seen![name], name).toBeUndefined();
    }
    expect(seen!.AWS_SECRET_ACCESS_KEY).toBe('test');
    expect(seen!.AWS_EC2_METADATA_DISABLED).toBe('true');
    // The command itself puts the tool directory first; here it is the stand-in for it.
    expect(VALIDATION_UNIT_TEST_COMMAND).toContain(`PATH="${VALIDATION_TOOL_BIN}:$PATH"`);
    expect(seen!.PATH!.split(':')[0]).toBe(bin);
  });

  it('🔴 never runs the npm in the real tool directory (CodeBuild puts the real npm there: #1146 81267eff)', () => {
    // A stand-in for VALIDATION_TOOL_BIN as CodeBuild leaves it: an npm the test must never run.
    // (The real npm there is `npm test` itself, i.e. the whole infra suite again, recursively.)
    const installed = tempDir('installed-tool-bin-');
    const ran = join(installed, 'ran');
    writeFileSync(join(installed, 'npm'), `#!/bin/sh\ntouch '${ran}'\nexit 97\n`);
    chmodSync(join(installed, 'npm'), 0o755);
    const command = VALIDATION_UNIT_TEST_COMMAND.replaceAll(VALIDATION_TOOL_BIN, installed);
    expect(command).not.toBe(VALIDATION_UNIT_TEST_COMMAND);

    const { r, seen } = runUnitLane(command, installed, {});
    expect(existsSync(ran)).toBe(false);
    expect(r.status, `${r.error ?? ''} ${r.stderr}`).toBe(0);
    expect(seen).toBeDefined();
  });

  it('🔴 no test runs the unit lane command except through runUnitLane', () => {
    // The pin above covers the helper; this covers its callers. Running the command verbatim (as
    // before #1146 81267eff) would pass anywhere the tool directory is absent and recurse in CodeBuild.
    const testDir = __dirname;
    const spawnLine = /\b(spawn|spawnSync|exec|execSync|execFile|execFileSync)\s*\(/;
    const offenders = readdirSync(testDir)
      .filter((f) => f.endsWith('.ts'))
      .flatMap((f) =>
        readFileSync(join(testDir, f), 'utf8')
          .split('\n')
          .map((line, i) => ({ f, i: i + 1, line }))
          .filter(({ line }) => spawnLine.test(line) && /VALIDATION_(UNIT_TEST_COMMAND|TOOL_BIN)\b(?!,\s*bin\))/.test(line)),
      )
      .map(({ f, i }) => `${f}:${i}`);
    expect(offenders).toEqual([]);
  });

  it('🔴 negative control: an npm other than the stub fails the run at once', () => {
    // Without the tool directory first on PATH, the trap npm (first on the outer PATH) answers.
    const command = VALIDATION_UNIT_TEST_COMMAND.replace(`PATH="${VALIDATION_TOOL_BIN}:$PATH" `, '');
    expect(command).not.toBe(VALIDATION_UNIT_TEST_COMMAND);
    const { r, seen, trapRan } = runUnitLane(command, VALIDATION_TOOL_BIN, {});
    expect(r.status).toBe(TRAP_EXIT);
    expect(trapRan).toBe(true);
    expect(seen).toBeUndefined();
  });
});

describe('Validation tools: gitleaks / semgrep pinned and verified, node apart from aws (7.5 classes 3/4)', () => {
  const at = (cmd: string) => {
    const i = installCommands.indexOf(cmd);
    expect(i, cmd).toBeGreaterThanOrEqual(0);
    return i;
  };

  it('gitleaks is the version the gate restores (scripts/restore-gate-tools.sh)', () => {
    const restore = readFileSync(join(REPO_ROOT, 'scripts/restore-gate-tools.sh'), 'utf8');
    expect(/GITLEAKS_VERSION=([0-9.]+)/.exec(restore)?.[1]).toBe(GITLEAKS_VERSION);
    expect(GITLEAKS_URL).toContain(`/v${GITLEAKS_VERSION}/gitleaks_${GITLEAKS_VERSION}_linux_x64.tar.gz`);
  });

  it('every download is hash-checked before it is unpacked or installed', () => {
    const glDownload = installCommands.findIndex((c) => c.startsWith('curl ') && c.includes(GITLEAKS_URL));
    const glCheck = installCommands.findIndex((c) => c.includes(GITLEAKS_LINUX_X64_SHA256));
    const glUnpack = installCommands.findIndex((c) => c.startsWith('tar ') && c.endsWith(' gitleaks'));
    expect(glDownload).toBeGreaterThanOrEqual(0);
    expect(glCheck).toBeGreaterThan(glDownload);
    expect(glUnpack).toBeGreaterThan(glCheck);
    expect(installCommands[glUnpack]).toContain(`-C ${VALIDATION_TOOL_BIN} `);

    const sgDownload = installCommands.findIndex((c) => c.startsWith('curl ') && c.includes(SEMGREP_WHEEL_URL));
    const sgCheck = installCommands.findIndex((c) => c.includes(SEMGREP_WHEEL_SHA256));
    const sgInstall = installCommands.findIndex((c) => c.includes('pip install'));
    expect(sgDownload).toBeGreaterThanOrEqual(0);
    expect(sgCheck).toBeGreaterThan(sgDownload);
    expect(sgInstall).toBeGreaterThan(sgCheck);
    expect(installCommands.some((c) => c.includes(`${VALIDATION_TOOL_BIN}/semgrep`) && c.startsWith('ln -s '))).toBe(true);
    // Installed before npm ci so a broken download stops the build before candidate code runs.
    expect(sgInstall).toBeLessThan(at('npm ci'));
    expect(glUnpack).toBeLessThan(at('npm ci'));
  });

  it.each([
    ['gitleaks', GITLEAKS_LINUX_X64_SHA256],
    ['semgrep', SEMGREP_WHEEL_SHA256],
  ])('🔴 the %s hash check rejects other bytes and accepts the pinned ones', (_name, pin) => {
    const check = installCommands.find((c) => c.includes(pin))!;
    const file = check.split(' ').at(-2)!;
    const dir = tempDir('hash-');
    const local = join(dir, 'artifact');
    const rewritten = check.replace(` ${file} `, ` ${local} `);
    writeFileSync(local, 'not the release');
    expect(spawnSync('sh', ['-c', rewritten], { timeout: COMMAND_TIMEOUT_MS }).status).not.toBe(0);
    // The check is the same script with another pin: it accepts a file whose digest is the pin.
    const ok = nodeEval(FILE_SHA256_CHECK_SCRIPT, local, '4c0a1b2b6d6e6c6c7e0bd4dbf6c5cfd34c25a29e1b0e1c1d9f2b19b2c8f0f2c1');
    expect(spawnSync('sh', ['-c', ok], { timeout: COMMAND_TIMEOUT_MS }).status).not.toBe(0);
    const digest = execFileSync('node', ['-e', 'process.stdout.write(require("crypto").createHash("sha256").update(require("fs").readFileSync(process.argv[1])).digest("hex"))', local], { encoding: 'utf8' });
    expect(spawnSync('sh', ['-c', nodeEval(FILE_SHA256_CHECK_SCRIPT, local, digest)], { timeout: COMMAND_TIMEOUT_MS }).status).toBe(0);
  });

  it('node / npm / npx get a directory of their own, first on npm test\'s PATH, without aws', () => {
    const link = installCommands.find((c) => c.startsWith('for b in node npm npx;'));
    expect(link).toBeDefined();
    expect(link).toContain(`${VALIDATION_TOOL_BIN}/$b`);
    expect(installCommands.some((c) => /\baws\b/.test(c) && c.includes(VALIDATION_TOOL_BIN))).toBe(false);

    // Behaviour: run the link command against a fake image where node and aws share a directory,
    // then drop every PATH entry holding aws (what aws-cloud-deploy.test.ts does): npx survives.
    const image = tempDir('image-');
    for (const b of ['node', 'npm', 'npx', 'aws']) {
      writeFileSync(join(image, b), `#!/bin/sh\necho ${b}\n`);
      chmodSync(join(image, b), 0o755);
    }
    const bin = tempDir('bin-');
    const r = spawnSync('sh', ['-c', link!.replaceAll(VALIDATION_TOOL_BIN, bin)], {
      encoding: 'utf8',
      timeout: COMMAND_TIMEOUT_MS,
      env: { NODE_ENV: 'test', PATH: `${image}:/usr/bin:/bin` },
    });
    expect(r.status, r.stderr).toBe(0);
    const probe = spawnSync('sh', ['-c', 'command -v npx && ! command -v aws'], {
      encoding: 'utf8',
      timeout: COMMAND_TIMEOUT_MS,
      env: { NODE_ENV: 'test', PATH: `${bin}:/usr/bin:/bin` },
    });
    expect(probe.status).toBe(0);
    expect(probe.stdout.trim()).toBe(join(bin, 'npx'));
  });
});

/**
 * #1146 (build efa5f85f, 2026-10-09): `npm --prefix infra test` hit the 30-min project timeout on
 * MEDIUM while the cloud gate runs it in 85 s. A local reproduction pointed at disk I/O, but the
 * CodeBuild log alone cannot say what saturated. So the step prints the machine's state before and
 * after, and samples /proc pressure while it runs. The instrumentation must never change the
 * step's verdict and must never outlive it.
 */
describe('Validation infra test: instrumented, verdict unchanged (#1146 efa5f85f)', () => {
  /** A stub `npm` that records its argv, optionally sleeps, and exits with $STUB_EXIT. */
  const stubNpm = () => {
    const stub = tempDir('infra-npm-');
    writeFileSync(
      join(stub, 'npm'),
      `#!/bin/sh\necho "$@" > '${join(stub, 'argv')}'\necho STUB-NPM-RAN\nsleep "\${STUB_SLEEP:-0}"\nexit "\${STUB_EXIT:-0}"\n`,
    );
    chmodSync(join(stub, 'npm'), 0o755);
    return stub;
  };
  const run = (command: string, stub: string, env: Record<string, string> = {}, shellFlags = '-c') => {
    const started = Date.now();
    // spawnSync returns only once every holder of the child's stdout has exited, so a sampler left
    // running in the background would show up here as a long elapsed time (CodeBuild waits likewise).
    const r = spawnSync('sh', [shellFlags, command], {
      encoding: 'utf8',
      timeout: COMMAND_TIMEOUT_MS,
      env: { NODE_ENV: 'test', PATH: `${stub}:${process.env.PATH ?? ''}`, ...env },
    });
    return { ...r, elapsedMs: Date.now() - started };
  };

  it('replaces the bare infra test step, in the same place', () => {
    expect(buildCommands.filter((c) => c === VALIDATION_INFRA_TEST_COMMAND)).toHaveLength(1);
    expect(buildCommands).not.toContain('npm --prefix infra test');
    const at = buildCommands.indexOf(VALIDATION_INFRA_TEST_COMMAND);
    expect(buildCommands[at - 1]).toBe('npm --prefix infra run typecheck');
    expect(buildCommands[at + 1]).toMatch(/npx cdk synth /);
  });

  it('runs the infra suite with per-test durations', () => {
    const stub = stubNpm();
    expect(run(VALIDATION_INFRA_TEST_COMMAND, stub).status).toBe(0);
    expect(readFileSync(join(stub, 'argv'), 'utf8').trim()).toBe('--prefix infra test -- --reporter=verbose');
  });

  it.each([
    ['passes', 0, '-c'],
    ['fails', 1, '-c'],
    ['fails with another status', 7, '-c'],
    ['fails under set -e', 3, '-ec'],
  ])('🔴 the build sees the infra test\'s own status when it %s', (_label, code, flags) => {
    const stub = stubNpm();
    const r = run(VALIDATION_INFRA_TEST_COMMAND, stub, { STUB_EXIT: String(code) }, flags);
    expect(r.status, r.stderr).toBe(code);
    expect(r.stdout).toContain('STUB-NPM-RAN');
    // The after-snapshot is printed on failure too, after the suite.
    expect(r.stdout.indexOf('== validation-io before')).toBeGreaterThanOrEqual(0);
    expect(r.stdout.indexOf('== validation-io after')).toBeGreaterThan(r.stdout.indexOf('STUB-NPM-RAN'));
    expect(r.stdout).toContain(`== validation-io infra test exit ${code}`);
  });

  it('does not end the shell it runs in (CodeBuild runs a phase\'s commands in one shell)', () => {
    const stub = stubNpm();
    const r = run(`${VALIDATION_INFRA_TEST_COMMAND}; echo "next step: $?"`, stub, { STUB_EXIT: '4' });
    expect(r.stdout).toContain('next step: 4');
  });

  it('🔴 the sampler samples while the suite runs and stops with it, pass or fail', () => {
    for (const code of [0, 1]) {
      const stub = stubNpm();
      const r = run(VALIDATION_INFRA_TEST_COMMAND, stub, { STUB_EXIT: String(code), STUB_SLEEP: '2' });
      expect(r.status, r.stderr).toBe(code);
      expect(r.stdout).toMatch(/== validation-io sample \d\d:\d\d:\d\d/);
      expect(r.stdout).toMatch(/^MemAvailable:/m);
      expect(r.stdout).toMatch(/^cpu /m);
      // Bounded by the suite (2 s) plus one sampler tick, not by the sampler's own limit (30 min).
      expect(r.elapsedMs).toBeLessThan(15_000);
    }
  });

  it('keeps the verdict when the sampler has already ended on its own (set -e too)', () => {
    const stub = stubNpm();
    const command = VALIDATION_INFRA_TEST_COMMAND.replace(`-lt ${VALIDATION_IO_SAMPLER_MAX_SECONDS} ]`, '-lt 1 ]');
    expect(command).not.toBe(VALIDATION_INFRA_TEST_COMMAND);
    for (const code of [0, 6]) {
      const r = run(command, stub, { STUB_EXIT: String(code), STUB_SLEEP: '2' }, '-ec');
      expect(r.status, r.stderr).toBe(code);
      expect(r.stdout).toContain('== validation-io after');
    }
  });

  it('tolerates a kernel without /proc/pressure', () => {
    const stub = stubNpm();
    const command = VALIDATION_INFRA_TEST_COMMAND.replaceAll('/proc/pressure/', '/nonexistent-pressure/');
    for (const code of [0, 5]) {
      const r = run(command, stub, { STUB_EXIT: String(code), STUB_SLEEP: '1' });
      expect(r.status, r.stderr).toBe(code);
      expect(r.stdout).toContain('(unavailable)');
    }
  });

  it('🔴 the sampler ends on its own within the project timeout, with bounded output', () => {
    expect(VALIDATION_IO_SAMPLER_MAX_SECONDS).toBeLessThanOrEqual(validationTimeoutMinutes * 60);
    expect(VALIDATION_IO_SAMPLE_INTERVAL_SECONDS).toBe(15);
    // Never killed, one-second ticks made instant: it must still terminate by itself.
    const sampler = VALIDATION_IO_SAMPLER.replace('sleep 1', 'sleep 0');
    expect(sampler).not.toBe(VALIDATION_IO_SAMPLER);
    const r = spawnSync('sh', ['-c', sampler], { encoding: 'utf8', timeout: COMMAND_TIMEOUT_MS });
    expect(r.status, r.stderr).toBe(0);
    const samples = (r.stdout.match(/^== validation-io sample /gm) ?? []).length;
    expect(samples).toBe(Math.ceil(VALIDATION_IO_SAMPLER_MAX_SECONDS / VALIDATION_IO_SAMPLE_INTERVAL_SECONDS));
    // header + 3 x (name + some/full) + 3 meminfo fields + the cpu line
    expect(r.stdout.split('\n').length).toBeLessThanOrEqual(samples * 14 + 1);
  });

  it('🔴 the sampler reads only /proc and runs only these commands (no network, AWS or git)', () => {
    const paths = VALIDATION_IO_SAMPLER.match(/(?<![\w$])\/[\w./$-]+/g) ?? [];
    expect(paths.length).toBeGreaterThan(0);
    for (const p of paths) expect(p.startsWith('/proc/') || p === '/dev/null', p).toBe(true);
    // Allowlist of every word in the sampler, quoted text included: a new command cannot slip in.
    const words = new Set(VALIDATION_IO_SAMPLER.match(/[A-Za-z_][\w-]*/g));
    const allowed = new Set([
      'i', 'while', 'lt', 'do', 'if', 'eq', 'then', 'echo', 'validation-io', 'sample', 'date', 'T',
      'for', 'p', 'in', 'cpu', 'io', 'memory', 'pressure', 'cat', 'proc', 'dev', 'null', 'unavailable', 'done',
      'grep', 'E', 'MemAvailable', 'Dirty', 'Writeback', 'meminfo', 'head', 'n', 'stat', 'fi', 'sleep',
    ]);
    expect([...words].filter((w) => !allowed.has(w))).toEqual([]);
    expect(VALIDATION_INFRA_TEST_COMMAND).toContain(VALIDATION_IO_SAMPLER);
  });
});
