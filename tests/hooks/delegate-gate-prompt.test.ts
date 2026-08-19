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
  headSha: 'placeholder-上書きされる',
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
  /** コミット後にツリーを汚す（指紋は汚した後に採るので**一致したまま**になる）。 */
  dirty?: boolean;
  /** spec の branch を、実際に居るブランチと違う値にする。 */
  branch?: string;
  /** spec の headSha を実 HEAD ではなくこの値にする。 */
  headSha?: string;
  /** `origin/<branch>` の作り方。既定は HEAD と同じ（= push 済み）。 */
  remote?: 'same' | 'stale' | 'missing' | 'dwim-decoy';
  /** spec から headSha キーごと落とす（`''` ではなく **欠落**。TypeError の再現に要る）。 */
  omitHeadSha?: boolean;
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
  // 🔴 **実際にコミットする。** 裏取りは「記録がある」だけでなく「その記録が
  // spec の headSha / clean なツリーのものである」ことまで見るので、コミットの無い
  // repo で組むと**全ケースが格下げされ**、verified 側を何も検証できなくなる。
  const git = (...args: string[]): string =>
    execFileSync('git', ['-c', 'user.email=t@example.com', '-c', 'user.name=t', ...args], {
      cwd: dir,
      encoding: 'utf8',
    }).trim();
  // 🔴 **spec の branch に居ること。** 裏取りは spec の branch と現在のブランチの一致まで
  // 見る（打ち間違いを「未 push」と誤診しないため）。`git init` の既定ブランチ名のままだと
  // 全ケースがそこで格下げされる。
  git('checkout', '-q', '-b', SPEC.branch);
  git('add', '-A');
  git('commit', '-q', '-m', 'init', '--no-gpg-sign');
  const realHead = git('rev-parse', 'HEAD');
  const headSha = options.headSha ?? realHead;
  // 委譲先は `git fetch origin && git checkout` で**リモートの**コミットを取るので、
  // 裏取りは origin の ref まで見る。ネットワークは要らない（ref を直に置く）。
  const remote = options.remote ?? 'same';
  if (remote === 'dwim-decoy') {
    // 🔴 **`origin/<branch>` は remote-tracking ref とは限らない。** ローカルブランチ
    // `refs/heads/origin/<branch>` があると、`git rev-parse origin/<branch>` は
    // DWIM 解決でそちらを返す（warning つき exit 0）。完全修飾＋`--verify` で引かないと、
    // **別コミットを「push 済み」と誤認する**。`refs/remotes` の方は作らない。
    writeFileSync(join(dir, 'DECOY.md'), 'decoy\n');
    git('add', '-A');
    git('commit', '-q', '-m', 'decoy', '--no-gpg-sign');
    git('branch', `origin/${SPEC.branch}`, git('rev-parse', 'HEAD'));
    git('reset', '-q', '--hard', realHead);
  } else if (remote !== 'missing') {
    if (remote === 'stale') {
      writeFileSync(join(dir, 'STALE.md'), 'stale\n');
      git('add', '-A');
      git('commit', '-q', '-m', 'stale', '--no-gpg-sign');
      git('update-ref', `refs/remotes/origin/${SPEC.branch}`, git('rev-parse', 'HEAD'));
      git('reset', '-q', '--hard', realHead);
    } else {
      git('update-ref', `refs/remotes/origin/${SPEC.branch}`, realHead);
    }
  }

  // 汚すのは**指紋を採る前**。指紋には未コミットの内容も入るので、後から汚すと
  // 「一致しない」になってしまい、見たい「一致するが範囲外」を作れない。
  if (options.dirty === true) writeFileSync(join(dir, '.gitignore'), '# dirty\n', { flag: 'a' });

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
  const specBody = {
    ...SPEC,
    ...(options.branch === undefined ? {} : { branch: options.branch }),
    headSha,
    localFastGate: options.localFastGate,
  } as Record<string, unknown>;
  // 🔴 **`''` ではなくキーごと落とす。** 空文字は `startsWith('')` が真になるので
  // 照合を素通りし、**検証をスタンプ照合の後ろへ戻す変異を検出できない**（実際に踏んだ）。
  // 実際に落ちたのは `undefined.trim()` の TypeError なので、欠落で再現する。
  if (options.omitHeadSha === true) delete specBody['headSha'];

  let specPath: string;
  if (options.specInRepo !== undefined) {
    specPath = join(dir, options.specInRepo);
    writeFileSync(specPath, JSON.stringify(specBody));
  } else {
    const specDir = mkdtempSync(join(tmpdir(), 'delegate-spec-'));
    created.push(specDir);
    specPath = join(specDir, 'spec.json');
    writeFileSync(specPath, JSON.stringify(specBody));
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

describe('delegate-gate-prompt.ts: 裏取りの範囲を超えて名乗らない (#711 レビュー MAJOR-A)', () => {
  /**
   * 🔴 **指紋は HEAD を含まない。** スタンプが証明するのは「いまの作業ツリーの内容に
   * green 記録がある」ことだけで、「spec が名指しするコミットに green 記録がある」ではない。
   * commit し忘れ・古い push のまま生成すると、委譲先が checkout するツリーは裏取り対象と
   * 別物なのに、本文は「裏取り済み」と**強く断定**してしまう。
   */
  it('🔴 未コミットの変更があるときは verified を名乗らない', () => {
    const r = run({ localFastGate: 'green', stamp: 'matching', dirty: true });
    expect(r.status, r.stderr).toBe(0); // fail-open は維持する
    expect(r.stdout).not.toContain('ゲートスタンプで裏取り済み');
    expect(r.stdout).toContain('ゲートスタンプでは裏取りできませんでした');
    expect(r.stderr).toContain('未コミットの変更');
  }, 120_000);

  it('🔴 spec の headSha が HEAD と違うときは verified を名乗らない', () => {
    const r = run({ localFastGate: 'green', stamp: 'matching', headSha: 'deadbee' });
    expect(r.status, r.stderr).toBe(0);
    expect(r.stdout).not.toContain('ゲートスタンプで裏取り済み');
    expect(r.stderr).toContain('headSha');
  }, 120_000);
});

describe('delegate-gate-prompt.ts: 委譲先が取れないツリーを保証しない (#711 レビュー MAJOR-2)', () => {
  /**
   * 🔴 **未 push / 古い push も裏取りの範囲外。** 委譲先は `git fetch origin && git checkout`
   * で**リモートの**コミットを取るので、ローカルにしか無いツリーに「裏取り済み」と
   * 断定すると、委譲先が絶対に手に入れられないものを保証したことになる。
   * dirty より起こりやすい —— commit してから push する前に生成する順序はふつう。
   */
  it('🔴 まだ push していないときは verified を名乗らない', () => {
    const r = run({ localFastGate: 'green', stamp: 'matching', remote: 'missing' });
    expect(r.status, r.stderr).toBe(0); // fail-open は維持する
    expect(r.stdout).not.toContain('ゲートスタンプで裏取り済み');
    expect(r.stderr).toContain('見つかりません');
  }, 120_000);

  it('🔴 origin が HEAD より古いときは verified を名乗らない', () => {
    const r = run({ localFastGate: 'green', stamp: 'matching', remote: 'stale' });
    expect(r.status, r.stderr).toBe(0);
    expect(r.stdout).not.toContain('ゲートスタンプで裏取り済み');
    // 「見つかりません」（未 push）と混ざらない文字列で縛る —— `origin/` だけだと
    // 不一致の分岐を未 push へ潰す変異が落ちない。
    expect(r.stderr).toContain('古いか別物');
  }, 120_000);
});

describe('delegate-gate-prompt.ts: 満たしようのない助言を出さない (#711 レビュー M1)', () => {
  it('🔴 spec の branch を打ち間違えたとき、「未 push」と誤診しない', () => {
    // `git push -u origin HEAD` は**現在の**ブランチを押すので、branch の誤記に対して
    // それを促すと何度やっても解消しない。本当の原因を言う。
    const r = run({ localFastGate: 'green', stamp: 'matching', branch: 'fix/topci' });
    expect(r.status, r.stderr).toBe(0);
    expect(r.stdout).not.toContain('ゲートスタンプで裏取り済み');
    expect(r.stderr).toContain('現在のブランチ');
    expect(r.stderr).not.toContain('git push -u origin HEAD');
  }, 120_000);
});

describe('delegate-gate-prompt.ts: origin の引き方 (#711 レビュー Minor-1)', () => {
  it('🔴 ローカルブランチ `origin/<branch>` を remote-tracking と取り違えない', () => {
    // 完全修飾をやめると、この囮のコミットを「push 済み」と誤認して verified を名乗る。
    const r = run({ localFastGate: 'green', stamp: 'matching', remote: 'dwim-decoy' });
    expect(r.status, r.stderr).toBe(0);
    expect(r.stdout).not.toContain('ゲートスタンプで裏取り済み');
    expect(r.stderr).toContain('見つかりません');
  }, 120_000);
});

describe('delegate-gate-prompt.ts: 終了コードの契約 (#711 レビュー Minor-1)', () => {
  // 「非 0」でしか縛っていないと、1（裏取りの失敗）と 3（入力が不正）の区別が
  // 導入した周回でそのまま壊れる（実際に headSha 欠落が TypeError → exit 1 になった）。
  it('🔴 裏取りの失敗は 1', () => {
    expect(run({ localFastGate: 'green', stamp: 'mismatched' }).status).toBe(1);
  }, 120_000);

  it('🔴 headSha が欠けていたら 3（TypeError で 1 に化けない）', () => {
    // 🔴 **検証がスタンプ照合より後ろにあると、ここで `undefined.trim()` が投げて
    // exit 1 ＋ Node のスタックトレースになる**（実際に踏んだ / レビュー MAJOR-3）。
    const r = run({ localFastGate: 'green', stamp: 'matching', omitHeadSha: true });
    expect(r.status).toBe(3);
    expect(r.stderr).toContain('headSha');
    expect(r.stderr).not.toContain('TypeError');
  }, 120_000);

  it('🔴 headSha が短すぎても 3（裏取りを素通りさせない）', () => {
    // 空文字や 1 文字は `startsWith` が真になり、照合を**素通り**する。
    const r = run({ localFastGate: 'green', stamp: 'matching', headSha: 'c' });
    expect(r.status).toBe(3);
    expect(r.stdout).not.toContain('## 手順');
  }, 120_000);
});
