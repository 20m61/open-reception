/**
 * `scripts/aws-local.sh` の観測可能な契約を、実際に bash を起動して検証する
 * （ADR 0010 / #1103）。
 *
 * ここが縛るのは優先度 1〜3:
 *   1. 実 AWS への安全性 … 実資格情報を引き継がない
 *   2. 誤操作の防止       … 宛先が実 AWS を向かない
 *   3. ロックイン回避     … エミュレータを env だけで差し替えられる
 *
 * 🔴 **`env` は前提（venv / エミュレータ本体）を要求しない。** 前提が無い環境でも
 * 「このレーンがどこを向き、どの資格情報で動くか」は観測できなければならない
 * （`local-aws.sh` で同じ設計を採り、実際に診断を助けた）。
 */
import { spawnSync } from 'node:child_process';
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

const ROOT = resolve(process.cwd());
const SCRIPT = join(ROOT, 'scripts/aws-local.sh');
const TIMEOUT = 60_000;

/** 実資格情報に見える sentinel。**本物ではない**（形だけ似せてある）。 */
const REAL = {
  AWS_ACCESS_KEY_ID: 'ASIAREALSENTINEL00000',
  AWS_SECRET_ACCESS_KEY: 'realSecretSentinel0000000000000000000000',
  AWS_SESSION_TOKEN: 'realSessionTokenSentinel0000000000000000',
  AWS_PROFILE: 'real-admin-profile-sentinel',
  AWS_CREDENTIAL_EXPIRATION: '2026-09-14T14:55:40+00:00',
} as const;

function runEnv(extra: Record<string, string> = {}) {
  return spawnSync('bash', [SCRIPT, 'env'], {
    cwd: ROOT,
    encoding: 'utf8',
    timeout: TIMEOUT,
    env: { ...process.env, ...extra },
  });
}

const valueOf = (stdout: string, key: string): string | undefined =>
  stdout
    .split('\n')
    .find((l) => l.startsWith(`${key}=`))
    ?.slice(key.length + 1)
    .trim();

describe('aws-local.sh: 実行系の選択', () => {
  it('既定は ministack（Docker 不要のローカル統合環境）', () => {
    const r = runEnv({ AWS_RUNTIME: '' });
    expect(r.status, `stderr=${r.stderr}`).toBe(0);
    expect(valueOf(r.stdout, 'AWS_RUNTIME')).toBe('ministack');
  });

  it('AWS_RUNTIME で差し替えられる（エミュレータ固有の分岐を呼び出し側に作らせない）', () => {
    expect(valueOf(runEnv({ AWS_RUNTIME: 'moto' }).stdout, 'AWS_RUNTIME')).toBe('moto');
    expect(valueOf(runEnv({ AWS_RUNTIME: 'localstack' }).stdout, 'AWS_RUNTIME')).toBe('localstack');
  });

  it('実行系ごとに既定 endpoint が変わる', () => {
    expect(valueOf(runEnv({ AWS_RUNTIME: 'ministack' }).stdout, 'AWS_ENDPOINT_URL')).toBe(
      'http://127.0.0.1:4566',
    );
    expect(valueOf(runEnv({ AWS_RUNTIME: 'moto' }).stdout, 'AWS_ENDPOINT_URL')).toBe(
      'http://127.0.0.1:5000',
    );
  });

  it('🔴 知らない実行系は黙って既定へ落とさず落ちる', () => {
    // 綴り間違いが「既定で動いた」ことにされると、何を検証したのか分からなくなる。
    const r = runEnv({ AWS_RUNTIME: 'ministak' });
    expect(r.status).not.toBe(0);
    expect(`${r.stdout}${r.stderr}`).toContain('ministak');
  });

  it('🔴 aws（実 AWS）はこのレーンからは選べない', () => {
    // このスクリプトは**ローカルエミュレータのライフサイクル**専用である。
    // 実 AWS を相手にする経路をここに作ると、誤って本番へ向く面が増える。
    const r = runEnv({ AWS_RUNTIME: 'aws' });
    expect(r.status).not.toBe(0);
  });
});

describe('aws-local.sh: 資格情報の隔離', () => {
  it('🔴 実 AWS 資格情報を引き継がない（上界と下界の両方）', () => {
    const r = runEnv(REAL);
    expect(r.status, `stderr=${r.stderr}`).toBe(0);
    const out = `${r.stdout}${r.stderr}`;

    // 上界: dummy が入っていること。
    expect(valueOf(r.stdout, 'AWS_ACCESS_KEY_ID')).toBe('test');
    expect(valueOf(r.stdout, 'AWS_SECRET_ACCESS_KEY')).toBe('test');
    // 実資格情報として成立させる 3 点を落とすこと。
    expect(valueOf(r.stdout, 'AWS_SESSION_TOKEN')).toBe('<unset>');
    expect(valueOf(r.stdout, 'AWS_PROFILE')).toBe('<unset>');
    expect(valueOf(r.stdout, 'AWS_CREDENTIAL_EXPIRATION')).toBe('<unset>');

    // 🔴 下界: 実資格情報の値が 1 度も現れないこと。
    for (const [name, value] of Object.entries(REAL)) {
      expect(out, `${name} の値が漏れている`).not.toContain(value);
    }
  });

  it('🔴 宛先が実 AWS を向かない', () => {
    const r = runEnv(REAL);
    expect(r.stdout).not.toContain('amazonaws.com');
  });

  it('🔴 呼び出し側が実 AWS の endpoint を渡しても拒否する', () => {
    // env を上書きできる以上、「上書きされたら従う」設計だと guard が意味を失う。
    const r = runEnv({ AWS_ENDPOINT_URL: 'https://dynamodb.ap-northeast-1.amazonaws.com' });
    expect(r.status).not.toBe(0);
    expect(`${r.stdout}${r.stderr}`).toContain('amazonaws.com');
  });
});

describe('aws-local.sh: 前提の無い環境でも観測できる', () => {
  it('env は venv やエミュレータ本体を要求しない', () => {
    // PATH を絞っても env は答えられること（診断が最初の 1 行で死なない）。
    const r = spawnSync('bash', [SCRIPT, 'env'], {
      cwd: ROOT,
      encoding: 'utf8',
      timeout: TIMEOUT,
      env: { ...process.env, PATH: '/usr/bin:/bin', AWS_LOCAL_HOME: '/nonexistent-dir' },
    });
    expect(r.status, `stderr=${r.stderr}`).toBe(0);
    expect(r.stdout).toContain('AWS_ENDPOINT_URL=');
  });
});

/**
 * 委譲（localstack compatibility layer）から**制御が戻ってくる**ことを縛る。
 *
 * 🔴 **これは実装時に実際に踏んだ欠陥である（2026-09-14）。** 委譲を `exec` で
 * 書いていたため、`exec` がシェルを置き換えて `bootstrap` / `seed` / テスト実行へ
 * **二度と戻らなかった**。委譲自体は成功するので出力は正常に見え、
 * **テストが 1 本も走らないまま緑**になる型である。
 */
describe('aws-local.sh: localstack への委譲', () => {
  it('🔴 委譲したあとも後段（bootstrap / seed）が走る', () => {
    const dir = mkdtempSync(join(tmpdir(), 'aws-local-deleg-'));
    const marker = join(dir, 'delegated');
    const stub = join(dir, 'local-aws-stub.sh');
    writeFileSync(stub, `#!/bin/sh\ntouch "${marker}"\necho "[stub] delegated $*"\n`);
    chmodSync(stub, 0o755);

    // aws / npm を無害な stub にして、後段が「走ったこと」だけを観測する。
    const bin = join(dir, 'bin');
    mkdirSync(bin, { recursive: true });
    for (const name of ['aws', 'npm']) {
      const p = join(bin, name);
      writeFileSync(p, '#!/bin/sh\nexit 0\n');
      chmodSync(p, 0o755);
    }

    const r = spawnSync('bash', [SCRIPT, 'up'], {
      cwd: ROOT,
      encoding: 'utf8',
      timeout: TIMEOUT,
      env: {
        ...process.env,
        AWS_RUNTIME: 'localstack',
        LOCAL_AWS_SCRIPT: stub,
        PATH: `${bin}:${process.env.PATH ?? ''}`,
      },
    });

    expect(existsSync(marker), '委譲そのものが起きていない').toBe(true);
    // 🔴 本題: 委譲のあとに後段が走ったこと。`exec` だとここへ到達しない。
    const out = `${r.stdout}${r.stderr}`;
    expect(out, '委譲で制御が戻っていない（exec になっている）').toContain('bootstrap complete');
    expect(r.status, `stdout=${r.stdout} stderr=${r.stderr}`).toBe(0);
  });
});

describe('aws-local.sh: capability サブコマンド (#1103)', () => {
  const source = readFileSync(SCRIPT, 'utf8');

  it('usage に載っている（隠しサブコマンドにしない）', () => {
    expect(source).toMatch(/usage:.*\|capability\}/);
  });

  it('🔴 エミュレータを上げてから測る（測れないまま ⛔ を並べさせない）', () => {
    // capability だけ start/bootstrap を呼ばないと、エミュレータが落ちている環境で
    // 全能力が「使えない」ように見え、**素通りの記録が安全側へ格下げされる**。
    const dispatch = source.split('\n').find((l) => l.trim().startsWith('capability)'));
    expect(dispatch, 'capability の dispatch 行が見つからない').toBeTruthy();
    expect(dispatch).toContain('start_emulator');
    expect(dispatch).toContain('bootstrap');
  });

  it('probe 本体を呼ぶ（npm script 越しの再帰にしない）', () => {
    expect(source).toMatch(/aws-local-capability\.ts/);
  });
});

describe('aws-local-capability.ts: 判定を配線へ書き戻させない (#1103 round2 MAJOR-1)', () => {
  const probe = readFileSync(join(ROOT, 'scripts/aws-local-capability.ts'), 'utf8');

  // 🔴 このスクリプトは**エミュレータ稼働が前提**なので既定ゲートから実行できない。
  // round2 のレビューは、判定を純関数へ切り出した後も**呼び出し側へ書き戻せば
  // 全部 green のまま round1 の BLOCKER が復活する**ことを実測した（3 変異が生存）。
  // 実行できない層なので、せめて「判定を自前で書いていないこと」を静的に縛る。
  // 同種の先例: 本ファイル上部（aws-local.sh の本文検査）、tests/config/loop-round-skill.test.ts。

  it('🔴 負の対照を自前で三項演算子に畳まない（round1 BLOCKER の再発形）', () => {
    expect(probe).not.toMatch(/\bbad\.ok\s*\?/);
    expect(probe).toContain('negativeFromLoginResult(');
    expect(probe).toContain('decideNegativeOutcome(');
    // 効果そのものを差し替えて fallback を無効化する形も塞ぐ（round2 W3）。
    expect(probe).toMatch(/tryFallback:\s*\(\)\s*=>\s*wrongPasswordWithPlainUsername/);
  });

  it('🔴 正の対照の判定も自前で書かない', () => {
    expect(probe).toContain('positiveFromLoginResult(');
    expect(probe).toContain('positiveFromBooleanProbe(');
    expect(probe).toContain('negativeFromBooleanProbe(');
  });

  it('🔴 終了コードを自前で決めない（「測れなかった」で 0 を返す形へ戻させない）', () => {
    expect(probe).toContain('exitCodeFor(');
    expect(probe).not.toMatch(/process\.exit\(0\)/);
  });

  it('🔴 実 AWS を向いたまま走らせない（リソースを作るスクリプトなので）', () => {
    expect(probe).toContain('resolveAwsRuntimeConfig');
    expect(probe).toMatch(/\.emulated/);
  });
});
