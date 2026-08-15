import { describe, expect, it } from 'vitest';
import {
  MANUAL_ONLY_ALLOWLIST,
  extractHookCommands,
  findStaleAllowlistEntries,
  findUnwiredScripts,
  listScripts,
  stripComments,
} from '../../../scripts/check-script-wiring';

/**
 * 「検査が実際に走っているか」のメタ検査 (#656)。
 *
 * 2026-08-08、`scripts/evaluate-gate-runs.ts` を呼ぶものが**リポジトリ内に 1 つも無い**
 * ことが判明した。数日かけて作った `record_gap` / `orphan_branch` の検出器が、
 * **人が手で叩いたときしか走っていなかった**。#656 は「FAIL が誰にも見えないまま消える」
 * issue なので、走らない検出器では閉じない。
 *
 * `docs/ai-development-loop.md` は fitness チェックを 9 件列挙しているが、
 * **その検査自体が走っているかを見るものが無かった**。ここがそれ。
 */

describe('scripts/ の配線 (#656)', () => {
  /**
   * **実ファイルを走査するので既定の 5 秒では負荷に耐えない。**
   * 実際、ゲートの unit ステップ（load 78 / 空きメモリ 1.8G）で
   * `Test timed out in 5000ms` を出して落ちた。走査は 1 パス + メモ化へ直したうえで、
   * 時間制限も実態に合わせる。**アサーションは緩めていない** — ここが見るのは
   * 構造的性質であって速度ではない。
   */
  const IO_TIMEOUT = 30_000;
  it('自動経路から呼ばれないスクリプトは allowlist に理由付きで載っている', () => {
    const unwired = findUnwiredScripts();
    const unexplained = unwired.filter((name) => !(name in MANUAL_ONLY_ALLOWLIST));
    expect(
      unexplained,
      `自動で走る経路（package.json / quality-gate.sh / record-gate-run.sh / hooks / src / infra）から\n` +
        `参照されていないスクリプトがある。配線するか、MANUAL_ONLY_ALLOWLIST へ理由付きで載せること:\n` +
        `  ${unexplained.join(', ')}`,
    ).toEqual([]);
  }, IO_TIMEOUT);

  it('allowlist に「もう自動配線された」ものが残っていない（ドリフト検出）', () => {
    // `check-cjk-literals.ts` の例外リストと同じ型。例外は放置すると意味を失う。
    const stale = findStaleAllowlistEntries();
    expect(stale, `自動配線されたので allowlist から外せる: ${stale.join(', ')}`).toEqual([]);
  }, IO_TIMEOUT);

  it('allowlist の全項目に理由が書かれている', () => {
    // **理由を書けないものは載せない。** 「なんとなく手動」を許すとこの検査は形式になる。
    const empty = Object.entries(MANUAL_ONLY_ALLOWLIST)
      .filter(([, reason]) => reason.trim() === '')
      .map(([name]) => name);
    expect(empty).toEqual([]);
  }, IO_TIMEOUT);

  it('docs / .claude での言及を配線と数えない（言及は実行ではない）', () => {
    // 🔴 **この性質がこの検査の要。** `evaluate-gate-runs.ts` は `docs/` にも
    // `CLAUDE.md` にも書かれていたのに、誰も走らせていなかった。docs を配線と数えると、
    // 塞ごうとしている穴がそのまま素通りする。
    //
    // 実際に「docs にしか出てこないスクリプト」を作って検出されることを確かめたいが、
    // ファイルを作るテストにはしない。代わりに、配線元の集合に docs / .claude が
    // **含まれていない**ことを、検出結果の側から固定する:
    // `record-gate-run.sh` は `docs/quality-gate.md` に詳しく書かれているが、
    // 自動経路からは呼ばれないので未配線として出る（＝ allowlist に載っている）。
    expect(findUnwiredScripts()).toContain('record-gate-run.sh');
    expect(MANUAL_ONLY_ALLOWLIST['record-gate-run.sh']).toBeTruthy();
  }, IO_TIMEOUT);

  /**
   * 🔴 **#681 defect 1: サブディレクトリが検査対象に入っていなかった。**
   *
   * 旧 `listScripts()` は `readdirSync('scripts')` の**直下のファイルだけ**を見ていた。
   * `scripts/hooks/**` のようなサブディレクトリのスクリプトは、配線元
   * （`WIRING_DIRS`）としては走査されるのに、**検査対象としては一度も数えられて
   * いなかった**。「`scripts/` のスクリプトが呼ばれているか」を見るはずの検査が、
   * サブディレクトリを作った瞬間に静かに取りこぼす。
   */
  describe('サブディレクトリの走査 (#681 defect 1)', () => {
    it('scripts/ のサブディレクトリにあるスクリプトも検査対象に入る', () => {
      const scripts = listScripts();
      // 実在する 3 本のフック。名前は `scripts/` からの相対パスで持つ
      // （`pr-gate-guard.sh` のような basename だと、別ディレクトリの同名と衝突する）。
      expect(scripts).toContain('hooks/pr-gate-guard.sh');
      expect(scripts).toContain('hooks/guard-destructive.sh');
      expect(scripts).toContain('hooks/push-secret-guard.sh');
    }, IO_TIMEOUT);

    it('直下のスクリプトは従来どおり相対パス（＝ basename）で入る', () => {
      expect(listScripts()).toContain('quality-gate.sh');
    }, IO_TIMEOUT);

    it('共有ライブラリとポリシー JSON は検査対象にしない', () => {
      const scripts = listScripts();
      // `scripts/lib/gate-stamp.sh` は「呼ばれるべきスクリプト」ではなく共有ライブラリ。
      expect(scripts.filter((n) => n.startsWith('lib/'))).toEqual([]);
      // `scripts/aws-policies/*.json` はデータであってスクリプトではない。
      expect(scripts.filter((n) => n.startsWith('aws-policies/'))).toEqual([]);
    }, IO_TIMEOUT);
  });

  /**
   * 🔴 **#681 defect 2: 配線の推移性。手動でしか走らないものからの参照を
   * 「配線済み」と数えていた。**
   *
   * `scripts/aws-cloud-deploy.sh` は `WIRING_SOURCES`（自動で走る配線元）と
   * `MANUAL_ONLY_ALLOWLIST`（手動実行が正しい）の**両方**に載っていた。結果、
   * 「自動では一度も走らないスクリプトから呼ばれているだけ」で配線済みと数えられる
   * 抜け道が生まれ、`url-quality-gate.sh` が実際にこの経路で allowlist から外れ、
   * そこに書かれていた理由（実環境が要るので自動化しない / #65）が失われた。
   *
   * モジュール doc の「**自動で走る経路だけ**を配線とみなす」と実装を一致させる。
   */
  describe('配線の推移性 (#681 defect 2)', () => {
    it('手動でしか走らないスクリプトからの参照は配線と数えない', () => {
      // `url-quality-gate.sh` を非 docs から参照しているのは `aws-cloud-deploy.sh` の
      // `smoke` サブコマンドだけであり、その `aws-cloud-deploy.sh` 自身が manual-only。
      // よって「自動では一度も走らない」= 未配線として出るのが正しい。
      expect(findUnwiredScripts()).toContain('url-quality-gate.sh');
      expect(MANUAL_ONLY_ALLOWLIST['url-quality-gate.sh']).toBeTruthy();
    }, IO_TIMEOUT);

    // 「allowlist の全項目が未配線である」という性質は、上の
    // 「allowlist に『もう自動配線された』ものが残っていない（ドリフト検出）」が
    // 同じ述語で既に固定している。同じことを 2 回書いても独立には落ちないので置かない。
  });

  /**
   * 🔴 **`.claude/settings.json` の `hooks` だけは配線元に数える。**
   *
   * モジュール doc の「`.claude` 配下は数えない」は、**散文**（配下の markdown）に
   * ついての規則である。人か agent が読んで「そうしようと決めたときだけ」走るから。
   * 一方 `settings.json` の `hooks` ブロックは**ハーネスが強制実行する**ので、
   * `package.json` の scripts と同じ種類＝自動経路である。数えないと
   * `scripts/hooks/**` が「未配線」に見え、allowlist へ嘘の理由を書く羽目になる。
   *
   * 🔴 **`permissions.allow` は数えない。** あれは「実行してよい」であって
   * 「実行される」ではない。混ぜると `install_pkgs.sh` のような手動スクリプトが
   * 名前を書かれているだけで配線済みに見える。
   */
  describe('.claude/settings.json は hooks だけを配線元に数える', () => {
    it('hooks の command を拾う', () => {
      const commands = extractHookCommands({
        hooks: {
          PreToolUse: [
            { matcher: 'Bash', hooks: [{ type: 'command', command: 'bash "$X/scripts/hooks/a.sh"' }] },
          ],
        },
      });
      expect(commands.join('\n')).toContain('scripts/hooks/a.sh');
    });

    it('permissions.allow は拾わない（実行してよい ≠ 実行される）', () => {
      const commands = extractHookCommands({
        permissions: { allow: ['Bash(./scripts/manual-thing.sh:*)'] },
      });
      expect(commands.join('\n')).not.toContain('scripts/manual-thing.sh');
    });

    it('hooks が無くても壊れない', () => {
      expect(extractHookCommands({})).toEqual([]);
      expect(extractHookCommands(null)).toEqual([]);
    });

    it('実ファイルの hooks 経由で scripts/hooks/** が配線済みになる', () => {
      const unwired = new Set(findUnwiredScripts());
      expect(unwired.has('hooks/pr-gate-guard.sh')).toBe(false);
      expect(unwired.has('hooks/guard-destructive.sh')).toBe(false);
      expect(unwired.has('hooks/push-secret-guard.sh')).toBe(false);
    }, IO_TIMEOUT);
  });

  describe('stripComments: 言及を配線と数えないための前処理', () => {
    // 🔴 **この関数が無いと検査が狙いを外す。** 呼び出し元を全部消したうえで
    // コメントを数えると、`evaluate-gate-runs.ts` はこのテストファイルのコメントだけで
    // 「配線済み」に見え、#656 の再現を見逃す（実測で確認）。
    it('TS の行コメントを落とす', () => {
      expect(stripComments('a.ts', '// scripts/foo.ts を呼ぶ')).not.toContain('scripts/foo.ts');
    });

    it('TS のブロックコメントを落とす', () => {
      expect(stripComments('a.ts', '/**\n * scripts/foo.ts\n */')).not.toContain('scripts/foo.ts');
    });

    it('シェルのコメント行を落とす', () => {
      expect(stripComments('a.sh', '# scripts/foo.sh を呼ぶ')).not.toContain('scripts/foo.sh');
    });

    it('コードの参照は残す（落としすぎない）', () => {
      expect(stripComments('a.ts', "import x from '../scripts/foo';")).toContain('scripts/foo');
      expect(stripComments('a.sh', './scripts/foo.sh --publish')).toContain('scripts/foo.sh');
    });

    it('json はそのまま返す（コメント構文が無い）', () => {
      expect(stripComments('package.json', '"x": "tsx scripts/foo.ts"')).toContain('scripts/foo.ts');
    });
  });
});
