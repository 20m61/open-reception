import { describe, expect, it } from 'vitest';
import { evaluateGateRuns, parseGateRuns } from './gate-run-evaluation';

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

  it('**後続の行**が issue を参照していればハンドリング済みとみなす', () => {
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
});
