import { describe, expect, it } from 'vitest';
import {
  evaluateGateRuns,
  evaluateRecordBranches,
  parseGateRuns,
  pendingDispatchBranches,
} from './gate-run-evaluation';

const HEADER = `| 日時 (UTC) | コミット SHA | tier | 結果 | SKIP 項目 | 起票 Issue / 備考 |
| --- | --- | --- | --- | --- | --- |`;

/** 実ファイルと同じ体裁の断片を組み立てる。 */
function doc(...rows: string[]): string {
  return `## 実行記録\n\n${HEADER}\n${rows.join('\n')}\n`;
}

const EXAMPLE =
  '| 2026-01-05T09:00Z | `abcdef1` | full | PASS | なし | **EXAMPLE 行**（実データではない。実運用の最初の行はこの下に追記する） |';

describe('parseGateRuns', () => {
  it('EXAMPLE 行を実データとして数えない', () => {
    // ここを取り違えると「1 回は回っている」と誤解し、定期実行が一度も動いていない
    // 状態を見逃す。実際このファイルは長らく EXAMPLE 行だけだった。
    expect(parseGateRuns(doc(EXAMPLE))).toEqual([]);
  });

  it('実記録を新しい順で返す', () => {
    const runs = parseGateRuns(
      doc(
        EXAMPLE,
        '| 2026-07-31T19:22Z | `ba60889` | full | FAIL | なし | 要 issue 起票 |',
        '| 2026-07-31T22:58Z | `3bc6f50` | full | PASS | なし | #545 クローズ |',
      ),
    );
    expect(runs.map((r) => r.result)).toEqual(['PASS', 'FAIL']);
    expect(runs[0]?.at).toBe('2026-07-31T22:58Z');
    expect(runs[0]?.sha).toBe('3bc6f50');
  });

  it('表以外の行に釣られない', () => {
    const noise = '| 列 | 内容 |\n| --- | --- |\n| tier | 通常は `full` |';
    expect(parseGateRuns(`${noise}\n${doc(EXAMPLE)}`)).toEqual([]);
  });
});

describe('evaluateGateRuns: 事前定義した停止条件で評価する (#424)', () => {
  const now = new Date('2026-08-05T00:00:00Z');

  it('一度も実行されていなければ指摘する', () => {
    // 「仕組みは作ったが回っていない」を最優先で可視化する。#318 の週次 Routine が
    // 長らく未作成で、記録が EXAMPLE 行だけだった状態がまさにこれ。
    const f = evaluateGateRuns([], now);
    expect(f.some((x) => x.code === 'never_run' && x.severity === 'error')).toBe(true);
  });

  it('週次を超えて実行されていなければ指摘する', () => {
    const runs = parseGateRuns(doc(EXAMPLE, '| 2026-07-20T09:00Z | `aaa` | full | PASS | なし |  |'));
    const f = evaluateGateRuns(runs, now);
    expect(f.some((x) => x.code === 'stale')).toBe(true);
  });

  it('週次以内に回っていれば stale としない', () => {
    const runs = parseGateRuns(doc(EXAMPLE, '| 2026-08-03T09:00Z | `aaa` | full | PASS | なし |  |'));
    expect(evaluateGateRuns(runs, now).some((x) => x.code === 'stale')).toBe(false);
  });

  it('直近が FAIL なら error で指摘する', () => {
    const runs = parseGateRuns(doc(EXAMPLE, '| 2026-08-04T09:00Z | `aaa` | full | FAIL | なし | #1 |'));
    const f = evaluateGateRuns(runs, now);
    expect(f.some((x) => x.code === 'latest_failed' && x.severity === 'error')).toBe(true);
  });

  it('FAIL に issue 参照が無く、後続にも無ければ指摘する（ハンドリング漏れ）', () => {
    const runs = parseGateRuns(doc(EXAMPLE, '| 2026-08-04T09:00Z | `aaa` | full | FAIL | なし | 調査中 |'));
    expect(evaluateGateRuns(runs, now).some((x) => x.code === 'fail_without_issue')).toBe(true);
  });

  it('FAIL 行自身に issue 参照があればハンドリング漏れとしない', () => {
    const runs = parseGateRuns(doc(EXAMPLE, '| 2026-08-04T09:00Z | `aaa` | full | FAIL | なし | #545 起票済み |'));
    expect(evaluateGateRuns(runs, now).some((x) => x.code === 'fail_without_issue')).toBe(false);
  });

  it('無関係な issue 参照が過去の FAIL をまとめて解決扱いにしない', () => {
    // 「以降のどこかに #N があれば解決」だと、**別件の参照で古い FAIL まで消える**。
    // 参照が無い FAIL が 2 件あり、最後の PASS が片方だけに言及している場合、
    // 両方が解決済みに見えてしまう。解決は**直後の 1 行**に限定する。
    const runs = parseGateRuns(
      doc(
        EXAMPLE,
        '| 2026-08-01T09:00Z | `aaa` | full | FAIL | なし | 調査中 |',
        '| 2026-08-02T09:00Z | `bbb` | full | FAIL | なし | まだ調査中 |',
        '| 2026-08-03T09:00Z | `ccc` | full | PASS | なし | 2 件目を直した（#900） |',
      ),
    );
    const unresolved = evaluateGateRuns(runs, now).filter((x) => x.code === 'fail_without_issue');
    // 1 件目は直後の行に参照が無いので未解決のまま残る。
    expect(unresolved).toHaveLength(1);
    expect(unresolved[0]?.message).toContain('2026-08-01');
  });

  it('**直後の行**が issue を参照していればハンドリング済みとみなす', () => {
    // `record-gate-run.sh` は issue 起票の**前**に行を書くので、FAIL 行の備考は必ず
    // プレースホルダになる。かつ記録は append-only で後から追記できない。
    // FAIL 行だけを見て判定すると**永久に消えない指摘**になり、検査が狼少年になる。
    // 実際の運用は「FAIL → 起票 → 修正 → 再実行し、その行に顛末を書く」なので、
    // 後続行の参照をもって解決とみなす。
    const runs = parseGateRuns(
      doc(
        EXAMPLE,
        '| 2026-08-03T09:00Z | `aaa` | full | FAIL | なし | 要 issue 起票 |',
        '| 2026-08-04T09:00Z | `bbb` | full | PASS | なし | 再実行し green（#545 クローズ） |',
      ),
    );
    expect(evaluateGateRuns(runs, now).some((x) => x.code === 'fail_without_issue')).toBe(false);
  });

  it('SKIP は「その後の full PASS かつ SKIP 無し」で解決とみなす', () => {
    // **FAIL で直したのと同じ罠。** append-only なので過去の SKIP 行は消せず、
    // 既定が exit 1 のままだと**評価器が二度と緑にならない**。ツールが復旧したことは
    // 「後の --full --strict が SKIP 無しで PASS した」ことで証明できる。
    const runs = parseGateRuns(
      doc(
        EXAMPLE,
        '| 2026-08-03T09:00Z | `aaa` | full | PASS | sast (semgrep) |  |',
        '| 2026-08-04T09:00Z | `bbb` | full | PASS | なし | 復旧確認 |',
      ),
    );
    expect(evaluateGateRuns(runs, now).some((x) => x.code === 'skipped_steps')).toBe(false);
  });

  it('full 以外の記録は定期実行の証跡として数えない', () => {
    // 設定を誤った Routine や手入力が `fast`/`pr` の PASS を積むと、**定期実行の
    // --full --strict が回っていないのに stale が解除され、報告も緑になる**。
    const runs = parseGateRuns(doc(EXAMPLE, '| 2026-08-04T09:00Z | `aaa` | pr | PASS | なし |  |'));
    const f = evaluateGateRuns(runs, now);
    expect(f.some((x) => x.code === 'non_full_record')).toBe(true);
    // full の記録がゼロなので「回っていない」扱いにする。
    expect(f.some((x) => x.code === 'never_run')).toBe(true);
  });

  it('SKIP が記録されていれば指摘する（--strict 下では出ないはず＝設定劣化）', () => {
    // `--strict` なら SKIP は FAIL になる。SKIP が残っている＝strict を付け忘れたか、
    // ゲートが黙って弱くなっている。
    const runs = parseGateRuns(
      doc(EXAMPLE, '| 2026-08-04T09:00Z | `aaa` | full | PASS | sast (semgrep) |  |'),
    );
    expect(evaluateGateRuns(runs, now).some((x) => x.code === 'skipped_steps')).toBe(true);
  });

  it('健全なら指摘ゼロ', () => {
    const runs = parseGateRuns(doc(EXAMPLE, '| 2026-08-04T09:00Z | `aaa` | full | PASS | なし |  |'));
    expect(evaluateGateRuns(runs, now)).toEqual([]);
  });

  describe('記録の穴 (#656)', () => {
    // **`stale` は直近 1 件の経過日数しか見ない。** 週次の途中で 1 回分の記録が
    // main に載らなくても、**次の週の記録が載った時点で永久に見えなくなる**。
    // #656 で実際に起きたのはこれ（routine は記録を push したが PR を作らず、
    // FAIL の記録が 5 日間 main に無かった）。穴は隣接する記録の間隔で捕まえる。

    it('週次記録の途中が抜けていれば、直近が新しくても指摘する', () => {
      const runs = parseGateRuns(
        doc(
          EXAMPLE,
          '| 2026-07-20T09:00Z | `aaa` | full | PASS | なし |  |',
          // 2026-07-27 の記録が無い（= 14 日空く）
          '| 2026-08-03T09:00Z | `ccc` | full | PASS | なし |  |',
        ),
      );
      const f = evaluateGateRuns(runs, now);
      expect(f.some((x) => x.code === 'stale')).toBe(false);
      expect(f.some((x) => x.code === 'record_gap' && x.severity === 'error')).toBe(true);
    });

    it('週次どおり並んでいれば穴としない', () => {
      const runs = parseGateRuns(
        doc(
          EXAMPLE,
          '| 2026-07-20T09:00Z | `aaa` | full | PASS | なし |  |',
          '| 2026-07-27T09:00Z | `bbb` | full | PASS | なし |  |',
          '| 2026-08-03T09:00Z | `ccc` | full | PASS | なし |  |',
        ),
      );
      expect(evaluateGateRuns(runs, now).some((x) => x.code === 'record_gap')).toBe(false);
    });

    it('抜けていた記録を後から追記すれば指摘が消える', () => {
      // **解決手段のない指摘は狼少年になる**（FAIL / SKIP で既に踏んだ罠）。
      // 穴の解決は「その回の行を追記する」こと。実際 2026-08-03 の行は 5 日後に
      // 回収して追記した（PR #657）。ゲート出力が復元できなくても、経緯を備考に
      // 書いた行を追記すれば記録の連続性は取り戻せる。
      const runs = parseGateRuns(
        doc(
          EXAMPLE,
          '| 2026-07-20T09:00Z | `aaa` | full | PASS | なし |  |',
          '| 2026-08-03T09:00Z | `ccc` | full | PASS | なし |  |',
          '| 2026-07-27T09:00Z | `bbb` | full | FAIL | なし | 回収（原因未記録・#656） |',
        ),
      );
      expect(evaluateGateRuns(runs, now).some((x) => x.code === 'record_gap')).toBe(false);
    });

    it('最初の記録より前は穴としない', () => {
      // routine が存在しなかった期間まで遡って指摘すると、初回から永久に赤くなる。
      const runs = parseGateRuns(doc(EXAMPLE, '| 2026-08-03T09:00Z | `ccc` | full | PASS | なし |  |'));
      expect(evaluateGateRuns(runs, now).some((x) => x.code === 'record_gap')).toBe(false);
    });

    it('full 以外の記録は穴を埋めない', () => {
      // `pr` の記録が間に挟まっても、定期実行（--full --strict）の証跡にはならない。
      const runs = parseGateRuns(
        doc(
          EXAMPLE,
          '| 2026-07-20T09:00Z | `aaa` | full | PASS | なし |  |',
          '| 2026-07-27T09:00Z | `bbb` | pr | PASS | なし |  |',
          '| 2026-08-03T09:00Z | `ccc` | full | PASS | なし |  |',
        ),
      );
      expect(evaluateGateRuns(runs, now).some((x) => x.code === 'record_gap')).toBe(true);
    });
  });
});

describe('evaluateRecordBranches: PR にならなかった push を捕まえる (#656)', () => {
  // **記録を push しても PR が作られなければ、内容は main に載らない。** 2026-08-03 の
  // 週次ゲートはこれで FAIL の記録を 5 日間失った（`chore/gate-run-20260803` は
  // 紐づく PR が 1 つも無かった）。**squash マージなので ancestry では判定できない** —
  // 見るのは「そのブランチに PR が在るか」だけ。
  const main = 'main';
  const NOW = new Date('2026-08-08T12:00:00Z');
  /** 既定の猶予。これを超えて PR が無いものだけを取りこぼしとみなす。 */
  const OPTS = { now: NOW, graceHours: 24 };
  /** 猶予の外（十分に古い）＝ 本物の取りこぼし相当。 */
  const OLD = '2026-08-01T12:00:00Z';

  it('PR が 1 つも無いリモートブランチを指摘する', () => {
    const f = evaluateRecordBranches(
      [{ name: 'main' }, { name: 'chore/gate-run-20260803', tipCommittedAt: OLD }],
      [],
      main,
      OPTS,
    );
    expect(f.some((x) => x.code === 'orphan_branch' && x.severity === 'error')).toBe(true);
    expect(f[0]?.message).toContain('chore/gate-run-20260803');
  });

  it('既定ブランチ自身は指摘しない', () => {
    expect(evaluateRecordBranches([{ name: 'main' }], [], main, OPTS)).toEqual([]);
  });

  it('PR が在るブランチは指摘しない', () => {
    // **状態は問わない。** open なら進行中、merged なら内容は main に載っており、
    // closed なら捨てる判断が見えている — いずれも一度は人間の目を通っている。
    // だから状態はモデルに持たない（持っても判定に読まれず、腐るだけ）。
    // 「全状態を数える」を保証するのはスクリプト側の `state=all` の問い合わせ。
    const f = evaluateRecordBranches(
      [{ name: 'main' }, { name: 'feat/x', tipCommittedAt: OLD }],
      ['feat/x'],
      main,
      OPTS,
    );
    expect(f).toEqual([]);
  });

  it('別のブランチの PR で orphan を打ち消さない', () => {
    // 「PR が 1 件でもあれば良し」にすると、**無関係な PR が全ブランチを緑にする**。
    const f = evaluateRecordBranches(
      [
        { name: 'main' },
        { name: 'chore/gate-run-20260803', tipCommittedAt: OLD },
        { name: 'feat/x', tipCommittedAt: OLD },
      ],
      ['feat/x'],
      main,
      OPTS,
    );
    expect(f.map((x) => x.code)).toEqual(['orphan_branch']);
    expect(f[0]?.message).toContain('chore/gate-run-20260803');
  });

  describe('PR 作成前の窓を殺さない（猶予期間）', () => {
    // 🔴 **push 済みで PR をまだ作っていない**のは完全に正常な状態。これを error にすると、
    // 週次 routine が回るたび進行中のブランチが全部並び、検査が狼少年になる
    // （FAIL / SKIP で 2 度踏んだのと同じ形）。実際 2026-08-08 に自分の作業ブランチ 2 本が
    // 誤検出された。本物（#656 の `chore/gate-run-20260803`）は **5 日間**放置されていた。

    it('数分前に push されたブランチは指摘しない', () => {
      const justNow = '2026-08-08T11:55:00Z';
      const f = evaluateRecordBranches(
        [{ name: 'main' }, { name: 'feat/wip', tipCommittedAt: justNow }],
        [],
        main,
        OPTS,
      );
      expect(f).toEqual([]);
    });

    it('猶予を超えて PR が無ければ指摘する', () => {
      const f = evaluateRecordBranches(
        [{ name: 'main' }, { name: 'feat/wip', tipCommittedAt: OLD }],
        [],
        main,
        OPTS,
      );
      expect(f.map((x) => x.code)).toEqual(['orphan_branch']);
    });

    it('日時が分からなければ指摘する側に倒す', () => {
      // **極性が肝心。** ローカルに無いオブジェクト＝一度も fetch していないブランチで、
      // まさに #656 が起きた形（クラウド routine が push し、こちらは知らないまま）。
      // 「不明だから見逃す」にすると、捕まえたい相手だけが漏れる。
      const f = evaluateRecordBranches([{ name: 'main' }, { name: 'feat/wip' }], [], main, OPTS);
      expect(f.map((x) => x.code)).toEqual(['orphan_branch']);
    });

    it('読めない日時も指摘する側に倒す', () => {
      const f = evaluateRecordBranches(
        [{ name: 'main' }, { name: 'feat/wip', tipCommittedAt: 'not-a-date' }],
        [],
        main,
        OPTS,
      );
      expect(f.map((x) => x.code)).toEqual(['orphan_branch']);
    });
  });
});


describe('pendingDispatchBranches: 証拠が無いものを「判定保留」として出す (#675)', () => {
  /**
   * 🔴 **「不明」を「問題なし」として黙らせない。**
   *
   * `evaluateRecordBranches` は猶予内のブランチを**指摘しない**。それは正しい（PR 作成前の
   * 窓を赤にすると狼少年になる）。しかし黙って除外すると、レポートは
   * 「指摘はありません」＝**全部片づいた**ように読める。
   *
   * 2026-08-15、まさにこの情報が無いために「クラウド routine は死んだ」と誤診して再投入し、
   * PR を 2 本（#698 / #699）作って main に空コミットを残した。**走っているのか止まったのか
   * 分からない**という状態が、そう表示されていれば起きなかった。
   *
   * #675 の「evidence 無しで running/completed へ遷移しない」はここに対応する。
   * warning にはしない ―― 猶予内は正常な窓であり、赤くする理由が無い。**数として出すだけ。**
   */
  const OPTS = { now: new Date('2026-08-18T12:00:00Z'), graceHours: 24 };

  it('PR がまだ無く猶予内のブランチを返す', () => {
    const branches = [
      { name: 'feat/a', tipCommittedAt: '2026-08-18T11:00:00Z' },
      { name: 'main', tipCommittedAt: '2026-08-18T11:00:00Z' },
    ];
    expect(pendingDispatchBranches(branches, [], 'main', OPTS)).toEqual(['feat/a']);
  });

  it('PR が在るブランチは判定保留ではない（証拠がある）', () => {
    const branches = [{ name: 'feat/a', tipCommittedAt: '2026-08-18T11:00:00Z' }];
    expect(pendingDispatchBranches(branches, ['feat/a'], 'main', OPTS)).toEqual([]);
  });

  it('猶予を超えたものは判定保留ではない（そちらは orphan_branch が指摘する）', () => {
    const branches = [{ name: 'feat/a', tipCommittedAt: '2026-08-15T11:00:00Z' }];
    expect(pendingDispatchBranches(branches, [], 'main', OPTS)).toEqual([]);
  });

  it('🔴 orphan と判定保留は排他かつ網羅（PR の無いブランチは必ずどちらか一方）', () => {
    // **これが本体のアサーション。** 2 つの関数が別々に窓を判定するので、片方の条件を
    // 変えるともう片方との間に穴（どちらにも出ない＝黙って消えるブランチ）か
    // 二重計上ができる。境界そのものを固定する。
    const branches = [
      { name: 'fresh', tipCommittedAt: '2026-08-18T11:59:00Z' },
      { name: 'boundary', tipCommittedAt: '2026-08-17T12:00:00Z' },
      { name: 'old', tipCommittedAt: '2026-08-01T00:00:00Z' },
      { name: 'unknown-date' },
    ];
    const orphans = evaluateRecordBranches(branches, [], 'main', OPTS).map((f) =>
      branches.find((b) => f.message.includes(`'${b.name}'`))!.name,
    );
    const pending = pendingDispatchBranches(branches, [], 'main', OPTS);

    expect([...orphans, ...pending].sort()).toEqual(
      branches.map((b) => b.name).sort(),
    );
    expect(orphans.filter((n) => pending.includes(n))).toEqual([]);
  });
});

describe('測れなかった実行を数える (#717)', () => {
  /** 既存テストと同じ形の行を作る。 */
  const row = (at: string, note: string) =>
    `| ${at} | \`abc1234\` | full | PASS | なし | ${note} |`;

  it('🔴 未測定の印が付いた行を数える', () => {
    // クラウドは浅い clone。恒常的に起きていても**後から数える手段が無い**のが本体。
    const findings = evaluateGateRuns(
      parseGateRuns(
        [
          row('2026-08-18T00:00Z', '自動記録（record-gate-run.sh）'),
          row('2026-08-19T00:00Z', '自動記録（record-gate-run.sh） / 未測定: 変更パスを集めきれない'),
        ].join('\n'),
      ),
      new Date('2026-08-19T01:00Z'),
    );
    const found = findings.find((f) => f.code === 'unmeasured_scope');
    expect(found, JSON.stringify(findings)).toBeDefined();
    expect(found!.severity).toBe('warning');
    expect(found!.message).toContain('1 件');
  });

  it('印が無ければ指摘しない（常態化させない）', () => {
    const findings = evaluateGateRuns(
      parseGateRuns(row('2026-08-19T00:00Z', '自動記録（record-gate-run.sh）')),
      new Date('2026-08-19T01:00Z'),
    );
    expect(findings.some((f) => f.code === 'unmeasured_scope')).toBe(false);
  });
});
