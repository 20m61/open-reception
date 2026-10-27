/**
 * `scripts/local-aws.sh` の preflight が、停止している Docker デーモンを
 * **起動する**ことを、偽の `docker` / `dockerd` を使って検証する（#1103 AC1）。
 *
 * ## なぜ要るか（2026-09-14 に実測して前提が覆った）
 *
 * 当初 preflight は `docker info` が失敗したら即 `exit 1` していた。Claude Code on the web の
 * 既定セッションはまさにその状態なので、**「この環境では Docker が使えない」と結論しかけた**。
 *
 * 実際には違った。`dockerd` / `containerd` / `runc` は**最初からインストールされており**、
 * セッションは root で動く。`dockerd` を起動すると **2 秒で上がり**、proxy 経由で
 * Docker Hub から pull でき、コンテナも動いた。**動かないのではなく、起動していないだけ**
 * だった。
 *
 * 🔴 **「観測」と「そこから引いた結論」を分けること。** 観測（既定でデーモンが動いていない）
 * は正しかったが、「だから有効にできないかもしれない」は**確かめずに書いた推論**であり、
 * 誤りだった。`CLAUDE.md`「調査の作法」の「見つからなかったは無いではない」と同じ型で、
 * **停止しているは起動できないではない**。
 *
 * ## 何を縛るか
 *
 * デーモンが停止していて `dockerd` が在るなら**起動を試みる**こと、既に動いているなら
 * **起動しない**こと（下界。常に起動する実装でも上界だけなら通ってしまう）、
 * `dockerd` すら無いなら**理由の分かる形で落ちる**こと。
 */
import { spawnSync } from 'node:child_process';
import { chmodSync, existsSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { describe, expect, it } from 'vitest';
import { makeTempDir } from '../helpers/temp';

const ROOT = resolve(process.cwd());
const SCRIPT = join(ROOT, 'scripts/local-aws.sh');
const TIMEOUT = 60_000;

/** スクリプトが「起動を決めた」ときだけ出す文言。決定的に観測できる唯一の合図。 */
const STARTING = 'Starting dockerd';

function writeExe(dir: string, name: string, body: string): void {
  const p = join(dir, name);
  writeFileSync(p, `#!/bin/sh\n${body}\n`);
  chmodSync(p, 0o755);
}

/**
 * 偽の PATH を組む。
 *
 * `docker info` は `UP_MARKER` が在るときだけ成功する。`dockerd` はその marker を作る
 * ―― つまり「dockerd を起動したらデーモンが上がる」を模す。
 */
function fakeEnv(options: {
  daemonAlreadyUp: boolean;
  dockerdPresent: boolean;
  /** dockerd が「上がった」と見えるまでの秒数（既定の待ち時間を測るために使う）。 */
  dockerdStartupDelaySeconds?: number;
}) {
  const dir = makeTempDir('local-aws-docker-');
  const upMarker = join(dir, 'daemon-up');
  const dockerdCalled = join(dir, 'dockerd-called');

  if (options.daemonAlreadyUp) writeFileSync(upMarker, '');

  writeExe(
    dir,
    'docker',
    `if [ "$1" = "info" ]; then [ -f "${upMarker}" ] && exit 0 || exit 1; fi\nexit 0`,
  );
  // 🔴 **PATH の前置では「不在」を作れない。** 実環境の /usr/bin/dockerd が
  // `command -v` に見つかってしまうため、スクリプト側の `DOCKERD_BIN` を使って
  // 在不在を決める（2026-09-14 の変異検証で、この穴が D3 を生存させた）。
  const dockerdBin = options.dockerdPresent
    ? join(dir, 'dockerd')
    : join(dir, 'definitely-absent-dockerd');
  if (options.dockerdPresent) {
    const delay = options.dockerdStartupDelaySeconds ?? 0;
    writeExe(
      dir,
      'dockerd',
      `touch "${dockerdCalled}"\nsleep ${delay}\ntouch "${upMarker}"\nsleep 30`,
    );
  }
  writeExe(dir, 'lstk', 'exit 0');
  writeExe(dir, 'npm', 'exit 0');

  return { dir, upMarker, dockerdCalled, dockerdBin };
}

function runPreflight(dir: string, dockerdBin: string) {
  return spawnSync('bash', [SCRIPT, 'preflight'], {
    cwd: ROOT,
    encoding: 'utf8',
    timeout: TIMEOUT,
    env: {
      ...process.env,
      // 偽物を先に見せる。実環境の docker があってもそちらへ行かせない。
      PATH: `${dir}:${process.env.PATH ?? ''}`,
      DOCKERD_BIN: dockerdBin,
      // 不在経路が待ちループへ落ちたとき、テストを 30 秒待たせない。
      DOCKERD_WAIT_SECONDS: '3',
    },
  });
}

describe('local-aws.sh の Docker デーモン起動', () => {
  it(
    'デーモンが停止していて dockerd が在るなら、起動して先へ進む',
    () => {
      const { dir, dockerdCalled, dockerdBin } = fakeEnv({
        daemonAlreadyUp: false,
        dockerdPresent: true,
      });
      const result = runPreflight(dir, dockerdBin);

      expect(result.status, `stdout=${result.stdout} stderr=${result.stderr}`).toBe(0);
      expect(result.stdout).toContain(STARTING);
      // この経路では preflight が `docker info` の成功を待つので、戻った時点で
      // 偽 dockerd は必ず走り終えている（marker を見ても競合しない）。
      expect(existsSync(dockerdCalled), 'dockerd を起動していない').toBe(true);
    },
    TIMEOUT,
  );

  it(
    '🔴 デーモンが既に動いているなら dockerd を起動しない（下界）',
    () => {
      // これが無いと「常に dockerd を叩く」実装でも上のテストは通ってしまう。
      //
      // 🔴 **marker ファイルの有無で見てはいけない。** `docker info` が即成功するので
      // preflight は 1 回目のループで返り、**背景の dockerd が marker を書く前に**
      // プロセスが終わりうる ―― 実際、早期 return を削る変異はこの書き方を素通りした
      // （2026-09-14 の変異検証で生存）。決定的に観測できるのはスクリプト自身の stdout。
      const { dir, dockerdBin } = fakeEnv({ daemonAlreadyUp: true, dockerdPresent: true });
      const result = runPreflight(dir, dockerdBin);

      expect(result.status).toBe(0);
      expect(result.stdout, '既に動いているのに dockerd を起動した').not.toContain(STARTING);
    },
    TIMEOUT,
  );

  it(
    'dockerd が無いなら、起動を試みずに理由の分かる形で落ちる',
    () => {
      const { dir, dockerdBin } = fakeEnv({ daemonAlreadyUp: false, dockerdPresent: false });
      const result = runPreflight(dir, dockerdBin);

      expect(result.status).not.toBe(0);
      const out = `${result.stdout}${result.stderr}`;
      // 🔴 **`/dockerd/` では緩すぎる。** タイムアウト文言にも "dockerd" が入るので、
      // 「不在を検出して即落ちる」と「30 秒待って諦める」を同じものとして受理してしまう
      // （2026-09-14 の変異検証で、不在チェックを削る変異が生存した）。
      expect(out).toContain('dockerd is not installed');
      expect(out, '不在なのに起動を試みている').not.toContain(STARTING);
      expect(out, '不在チェックではなく待ちタイムアウトで落ちている').not.toContain(
        'did not become ready',
      );
    },
    TIMEOUT,
  );

  it(
    '🔴 既定の待ち時間が正で、すぐには上がらないデーモンも待てる',
    () => {
      // `DOCKERD_WAIT_SECONDS` を注入する他のテストは**既定値を縛らない**ので、
      // 既定を 0 へ狭める変異が素通りする（2026-09-14 の変異検証で D4 が生存）。
      // ここでは注入せず、起動に時間のかかる dockerd を使って既定の下界を踏む。
      const { dir, dockerdBin } = fakeEnv({
        daemonAlreadyUp: false,
        dockerdPresent: true,
        dockerdStartupDelaySeconds: 2,
      });
      const result = spawnSync('bash', [SCRIPT, 'preflight'], {
        cwd: ROOT,
        encoding: 'utf8',
        timeout: TIMEOUT,
        // DOCKERD_WAIT_SECONDS は**渡さない**（既定値を測るため）。
        env: { ...process.env, PATH: `${dir}:${process.env.PATH ?? ''}`, DOCKERD_BIN: dockerdBin },
      });

      expect(result.status, `stdout=${result.stdout} stderr=${result.stderr}`).toBe(0);
      expect(result.stdout).toContain(STARTING);
    },
    TIMEOUT,
  );

  it(
    '🔴 env は前提が壊れていても観測できる（preflight を通さない）',
    () => {
      // 🔴 **これは preflight の方式変更で一度失われた保証である。**
      // 以前は「preflight を通すと docker が無くて落ちる」ことが `env` の独立性を
      // 間接的に縛っていた。preflight がデーモンを**起動する**ようになった結果、
      // `env) preflight; lane_env` という変異が緑のまま通るようになった
      // （2026-09-14 の変異検証で C4 が生存）。前提を壊して直接縛り直す。
      const { dir, dockerdBin } = fakeEnv({ daemonAlreadyUp: false, dockerdPresent: false });
      const result = spawnSync('bash', [SCRIPT, 'env'], {
        cwd: ROOT,
        encoding: 'utf8',
        timeout: TIMEOUT,
        env: {
          ...process.env,
          PATH: `${dir}:${process.env.PATH ?? ''}`,
          DOCKERD_BIN: dockerdBin,
          DOCKERD_WAIT_SECONDS: '1',
        },
      });

      expect(result.status, 'env が前提の欠如で落ちている').toBe(0);
      expect(result.stdout).toContain('AWS_ENDPOINT_URL=');
      expect(result.stdout).toContain('AWS_ACCESS_KEY_ID=test');
      const out = `${result.stdout}${result.stderr}`;
      expect(out, 'env が preflight を通っている').not.toContain('dockerd is not installed');
      expect(out, 'env が preflight を通っている').not.toContain(STARTING);
    },
    TIMEOUT,
  );
});
