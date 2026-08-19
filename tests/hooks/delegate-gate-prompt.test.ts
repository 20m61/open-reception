/**
 * 委譲プロンプト生成器がゲートスタンプで申告を裏取りすることを固定する (#711)。
 *
 * ## なぜ実走で縛るのか
 *
 * 判定は純関数側（`src/domain/governance/gate-stamp-check.ts`）でユニットテスト済み。
 * **危ないのは配線**で、スクリプトがスタンプを読まなくなっても、あるいはチェックの
 * 結果を無視しても、ドメインのテストは全部 green のままになる。
 * この一連の周回で同じ型を何度も踏んでいる。
 */
import { execFileSync, spawnSync } from 'node:child_process';
import { cpSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { afterAll, describe, expect, it } from 'vitest';

const REPO = process.cwd();
const created: string[] = [];
afterAll(() => {
  for (const dir of created) rmSync(dir, { recursive: true, force: true });
});

/**
 * SKILL.md が名指ししている spec の置き場所を**そこから読む** (#711 レビュー Minor 4)。
 *
 * ハードコードすると、SKILL.md 側だけ `spec.json`（＝ignore されない場所）へ戻っても
 * 誰も落ちない。この repo が既に使っている「散文と実測を突き合わせる」手法
 * （`tests/config/loop-round-skill.test.ts`）に揃える。
 */
const SKILL_SPEC_PATH = (() => {
  const skill = readFileSync(resolve(REPO, '.claude/skills/loop-round/SKILL.md'), 'utf8');
  const m = /delegate-gate-prompt\.ts\s+(\S+\.json)/.exec(skill);
  if (m === null) throw new Error('SKILL.md に delegate-gate-prompt.ts の spec パスが見つかりません');
  return m[1];
})();

const SPEC = {
  branch: 'fix/x',
  headSha: 'abc1234',
  baseSha: 'def5678',
  title: 'fix(x): y',
  summary: 's',
  changedFiles: ['a.ts'],
  refs: [711],
};

/**
 * scripts/ と domain だけを持つ一時 git リポジトリでスクリプトを走らせる。
 *
 * `stamp` に文字列を渡すと、その内容でスタンプを置く（`null` なら置かない＝記録なし）。
 */
function run(options: {
  localFastGate: string;
  stamp: 'matching' | 'mismatched' | 'none';
  /** スクリプトを起動する cwd（リポジトリ root からの相対）。既定は root。 */
  cwd?: string;
  /** spec をリポジトリ **内**のこのパスへ置く（`.gitignore` の効きを見る）。 */
  specInRepo?: string;
}): { status: number; stderr: string; stdout: string } {
  // 🔴 **パスに `$(...)` を仕込む。** probe がライブラリのパスを文字列へ埋め込んで
  // いると、bash がここを**コマンド置換として実行**して別のパスを source しようとし、
  // 裏取りが静かに exit 2（判定不能）へ縮退する。`$1` で渡していれば無害。
  const dir = mkdtempSync(join(tmpdir(), 'delegate-prompt-$(echo x)-'));
  created.push(dir);
  // 🔴 **要る物だけ写す。** `src` 全体は 11MB あり、ケースごとに複製すると
  // ディスクを食う（#721 でゲートを落としたのはディスク枯渇だった）。
  mkdirSync(join(dir, 'src/domain'), { recursive: true });
  cpSync(resolve(REPO, 'scripts'), join(dir, 'scripts'), { recursive: true });
  cpSync(resolve(REPO, 'src/domain/governance'), join(dir, 'src/domain/governance'), { recursive: true });
  // 指紋は未追跡（非 ignore）ファイルも見る。`.gitignore` を写さないと
  // 「repo 内に spec を置いても指紋が変わらない」を検証できない。
  cpSync(resolve(REPO, '.gitignore'), join(dir, '.gitignore'));
  execFileSync('git', ['init', '-q'], { cwd: dir });

  if (options.stamp !== 'none') {
    const fingerprint =
      options.stamp === 'matching'
        ? execFileSync('bash', ['-c', '. scripts/lib/gate-stamp.sh && gate_tree_fingerprint'], {
            cwd: dir,
            encoding: 'utf8',
          }).trim()
        : 'deadbeef'.repeat(8);
    writeFileSync(
      join(dir, '.git', 'open-reception-gate-stamp'),
      `fast\t${fingerprint}\t2026-08-19T00:00Z\tcode\n`,
    );
  }

  // 🔴 **spec を repo 内の非 ignore な場所へ置くと指紋が変わる**（未追跡ファイルも
  // 指紋に入るため）。既定は repo 外。`specInRepo` を渡したときだけ中へ置く。
  let specPath: string;
  if (options.specInRepo !== undefined) {
    specPath = join(dir, options.specInRepo);
    writeFileSync(specPath, JSON.stringify({ ...SPEC, localFastGate: options.localFastGate }));
  } else {
    const specDir = mkdtempSync(join(tmpdir(), 'delegate-spec-'));
    created.push(specDir);
    specPath = join(specDir, 'spec.json');
    writeFileSync(specPath, JSON.stringify({ ...SPEC, localFastGate: options.localFastGate }));
  }
  const result = spawnSync(
    resolve(REPO, 'node_modules/.bin/tsx'),
    [join(dir, 'scripts/delegate-gate-prompt.ts'), specPath],
    { cwd: options.cwd === undefined ? dir : join(dir, options.cwd), encoding: 'utf8' },
  );
  return { status: result.status ?? -1, stderr: result.stderr ?? '', stdout: result.stdout ?? '' };
}

describe('delegate-gate-prompt.ts: 申告をスタンプで裏取りする (#711)', () => {
  it('🔴 green と申告されたのに一致する記録が無ければ非 0 で止まる', () => {
    // spec に green と書けば #705 の事象はそのまま再現する ——「申告の誠実性に依存」を塞ぐ。
    const r = run({ localFastGate: 'green', stamp: 'mismatched' });
    expect(r.status).not.toBe(0);
    expect(r.stderr).toContain('green 記録がありません');
    // 本文を出さない（嘘の前提を委譲先へ渡さない）。
    expect(r.stdout).not.toContain('## 手順');
  }, 120_000);

  it('green と申告され一致する記録があれば通り、本文に裏取り済みと出る', () => {
    const r = run({ localFastGate: 'green', stamp: 'matching' });
    expect(r.status, r.stderr).toBe(0);
    expect(r.stdout).toContain('## 手順');
    expect(r.stdout).toContain('ゲートスタンプで裏取り済み');
  }, 120_000);

  it('🔴 記録が無い（判定不能）ときは通す（「測れなかった」を「嘘だった」に倒さない）', () => {
    // ここで落とすと #705 と同じ型の誤りを逆向きに作ることになる。
    const r = run({ localFastGate: 'green', stamp: 'none' });
    expect(r.status, r.stderr).toBe(0);
    expect(r.stderr).toContain('裏取りできませんでした');
    expect(r.stderr).toContain('exit=3');
    expect(r.stdout).toContain('## 手順');
    // 🔴 **通したことを本文にも残す。** ここが「裏取り済み」と同じ出力になると、
    // 記録が無い環境（新しい worktree では常態）で #705 の事象が無傷で通る。
    expect(r.stdout).toContain('ゲートスタンプでは裏取りできませんでした');
    expect(r.stdout).not.toContain('ゲートスタンプで裏取り済み');
  }, 120_000);

  it('not-run の申告は裏取りの対象にしない', () => {
    const r = run({ localFastGate: 'not-run', stamp: 'mismatched' });
    expect(r.status, r.stderr).toBe(0);
    expect(r.stdout).toContain('## 手順');
  }, 120_000);
});

describe('delegate-gate-prompt.ts: 正直な申告を落とさない (#711 レビュー指摘)', () => {
  it('🔴 サブディレクトリから起動しても、一致する記録を見つける', () => {
    // 指紋は `git ls-files` をプロセスの cwd に対して採る。cwd を固定しないと
    // `infra/` などから起動したときだけ偽の FAIL になる
    // （`scripts/aws-cloud-deploy.sh:257-263` が同じ罠を既に踏んで直している）。
    const r = run({ localFastGate: 'green', stamp: 'matching', cwd: 'scripts' });
    expect(r.status, r.stderr).toBe(0);
    expect(r.stdout).toContain('## 手順');
  }, 120_000);

  it('🔴 SKILL.md が名指しする場所へ spec を置いても指紋を壊さない', () => {
    // 未追跡（非 ignore）ファイルも指紋に入るので、repo 内に spec を書くと
    // **正直な green 申告が落ちる**。`.gitignore` で経路を用意しておく。
    const r = run({ localFastGate: 'green', stamp: 'matching', specInRepo: SKILL_SPEC_PATH });
    expect(r.status, r.stderr).toBe(0);
    expect(r.stdout).toContain('## 手順');
  }, 120_000);
});
