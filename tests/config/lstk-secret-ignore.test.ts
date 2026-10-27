/**
 * `.lstk/` 配下に落ちる LocalStack の資格情報が、**コミットされ得ない**ことを
 * `git check-ignore` の実挙動で検証する。
 *
 * ## なぜ要るか（2026-09-14 に実測）
 *
 * `.lstk/` は `config.toml` を**追跡している**ディレクトリである。そこへ `lstk` が
 * 実行時ファイルを書く。しかも `lstk.log` にこう出る:
 *
 * ```
 * system keyring unavailable (exec: "dbus-launch": executable file not found in $PATH),
 * falling back to file-based storage
 * ```
 *
 * つまり Claude Code on the web のようにキーリングが無い環境では、
 * **`LOCALSTACK_AUTH_TOKEN` はファイルとして `.lstk/` 配下に保存される**。
 * 追跡ディレクトリなので、`git add -A` 一回でトークンが commit され得る。
 *
 * `.claude/rules/local-aws-development.md` は「Never commit, print, fixture, or persist it」
 * と書いているが、**規約は書いてあるだけでは強制されない**。ここで機械的に塞ぐ。
 *
 * ## 何を縛るか
 *
 * 🔴 **無視されることだけを主張しない。** `.lstk/` を丸ごと無視すれば空虚に満たせるが、
 * それでは `config.toml`（**追跡されるべき設定**）まで落ちる。
 * **下界として「`config.toml` は無視されない」を併せて縛る。**
 */
import { spawnSync } from 'node:child_process';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

const ROOT = resolve(process.cwd());

/** `git check-ignore` は無視されるパスに対して exit 0 を返す。 */
function isIgnored(relativePath: string): boolean {
  const result = spawnSync('git', ['check-ignore', '-q', '--no-index', relativePath], {
    cwd: ROOT,
    encoding: 'utf8',
  });
  return result.status === 0;
}

describe('.lstk/ の秘密が commit され得ないこと', () => {
  it.each([
    '.lstk/auth-token',
    '.lstk/auth-token.lock',
    '.lstk/auth-token.json',
    '.lstk/credentials',
    '.lstk/lstk.log',
    '.lstk/state/session.json',
  ])('%s は無視される', (path) => {
    expect(isIgnored(path), `${path} が commit され得る`).toBe(true);
  });

  it('🔴 config.toml は無視されない（下界 — 丸ごと無視で空虚に満たさない）', () => {
    // これが無いと `.lstk/` を全部無視する実装でも上のテストは全部通ってしまい、
    // 追跡すべき設定まで静かに落ちる。
    expect(isIgnored('.lstk/config.toml'), 'config.toml まで無視されている').toBe(false);
  });
});
