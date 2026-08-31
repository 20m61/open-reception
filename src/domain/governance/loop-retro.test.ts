import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';
import {
  GUIDELINE_BUDGET,
  evaluateLoopRetro,
  parseLearnedGuidelines,
  parseRetroRuns,
  parseRulesRevision,
} from './loop-retro';

const ROOT = resolve(import.meta.dirname, '..', '..', '..');
const RULES = resolve(ROOT, '.claude', 'rules', 'opus5-autonomous-loop.md');
const LEDGER = resolve(ROOT, 'docs', 'loop-retro.md');

describe('parseRulesRevision', () => {
  it('マーカーから版を読む', () => {
    expect(parseRulesRevision('# rules\n\n<!-- loop-rules-revision: 3 -->\n')).toBe(3);
  });

  it('マーカーが無ければ undefined（0 や 1 に落とさない）', () => {
    // 🔴 「版が無い」を「版 1」と読むと、**測れていないものを測れたことにする**。
    expect(parseRulesRevision('# rules\n')).toBeUndefined();
  });

  it('数字でないものは版として読まない', () => {
    expect(parseRulesRevision('<!-- loop-rules-revision: v3 -->')).toBeUndefined();
  });
});

describe('parseLearnedGuidelines', () => {
  const md = [
    '## セクション A',
    '',
    'なにか本文。',
    '',
    '> 由来: 2026-08-26 / #788（PR #804）。3 周かかった。',
    '> 2 周目の時点で気づくべきだった。',
    '',
    '### セクション B',
    '',
    '> 由来: 2026-08-07 / #4 Inc D-1（PR #639）。',
    '',
  ].join('\n');

  it('由来ブロックを教訓として拾い、直近の見出しに属させる', () => {
    const gs = parseLearnedGuidelines(md);
    expect(gs).toHaveLength(2);
    expect(gs[0]?.heading).toBe('セクション A');
    expect(gs[1]?.heading).toBe('セクション B');
  });

  it('日付・issue・PR を帰属として抜く', () => {
    const [first] = parseLearnedGuidelines(md);
    expect(first?.date).toBe('2026-08-26');
    expect(first?.issues).toEqual([788]);
    expect(first?.pulls).toEqual([804]);
  });

  it('引用の継続行まで 1 件の教訓として畳む（2 件に割らない）', () => {
    const [first] = parseLearnedGuidelines(md);
    expect(first?.raw).toContain('2 周目の時点で気づくべきだった');
  });

  it('PR 参照が無くても issue があれば帰属は成立する', () => {
    const [g] = parseLearnedGuidelines('> 由来: 2026-08-26 / #787。seed の在席状態。');
    expect(g?.issues).toEqual([787]);
    expect(g?.pulls).toEqual([]);
  });

  it('由来を持たない引用は教訓ではない', () => {
    expect(parseLearnedGuidelines('> ただの引用。\n> 続き。')).toEqual([]);
  });
});

describe('parseRetroRuns', () => {
  const ledger = [
    '| 日時 (UTC) | 規約版 | 観測範囲 | 教訓 | 結果 | 根拠 |',
    '| --- | --- | --- | --- | --- | --- |',
    '| 2026-01-05T09:00Z | 0→1 | — | — | NO_CHANGE | **EXAMPLE 行** |',
    '| 2026-08-31T00:00Z | 1→2 | 直近 14 日 | 追加 1 | UPDATED | PR #900 |',
    '| 2026-08-24T00:00Z | 1→1 | 直近 14 日 | なし | NO_CHANGE | 信号が弱い |',
  ].join('\n');

  it('新しい順に返し、EXAMPLE 行は実データとして数えない', () => {
    const runs = parseRetroRuns(ledger);
    expect(runs.map((r) => r.at)).toEqual(['2026-08-31T00:00Z', '2026-08-24T00:00Z']);
  });

  it('版の前後と結果を読む', () => {
    const [latest] = parseRetroRuns(ledger);
    expect(latest?.revisionFrom).toBe(1);
    expect(latest?.revisionTo).toBe(2);
    expect(latest?.result).toBe('UPDATED');
  });

  it('NO_CHANGE も実行として数える（「変更なし」は正当な結果）', () => {
    // Warp の improver skill と同じ扱い。空振りを記録しないと、
    // 「回っていない」と「回したが変えなかった」が区別できなくなる。
    const runs = parseRetroRuns(ledger);
    expect(runs.some((r) => r.result === 'NO_CHANGE')).toBe(true);
  });

  it('見出しや説明表の行は拾わない', () => {
    expect(parseRetroRuns('| 列 | 内容 |\n| --- | --- |\n| 日時 (UTC) | 実行開始時刻 |')).toEqual([]);
  });
});

describe('evaluateLoopRetro', () => {
  const now = new Date('2026-08-31T00:00:00Z');
  const guideline = (date: string) => ({
    heading: 'h',
    date,
    issues: [1],
    pulls: [2],
    raw: `> 由来: ${date} / #1（PR #2）`,
    line: 1,
  });
  const run = (at: string, to: number) => ({
    at,
    revisionFrom: to - 1,
    revisionTo: to,
    result: 'UPDATED' as const,
    note: '',
  });

  const healthy = {
    guidelines: [guideline('2026-08-26')],
    runs: [run('2026-08-28T00:00Z', 2)],
    rulesRevision: 2,
    now,
  };

  it('健全なら指摘なし', () => {
    expect(evaluateLoopRetro(healthy)).toEqual([]);
  });

  it('一度も回っていなければ never_run', () => {
    const f = evaluateLoopRetro({ ...healthy, runs: [] });
    expect(f.map((x) => x.code)).toContain('never_run');
  });

  it('前回から間が空いたら stale', () => {
    const f = evaluateLoopRetro({ ...healthy, runs: [run('2026-07-01T00:00Z', 2)] });
    expect(f.map((x) => x.code)).toContain('stale');
  });

  it('教訓が上限を超えたら over_budget', () => {
    const many = Array.from({ length: GUIDELINE_BUDGET + 1 }, () => guideline('2026-08-26'));
    const f = evaluateLoopRetro({ ...healthy, guidelines: many });
    expect(f.map((x) => x.code)).toContain('over_budget');
  });

  it('上限ちょうどは指摘しない（境界のすぐ内側）', () => {
    const exact = Array.from({ length: GUIDELINE_BUDGET }, () => guideline('2026-08-26'));
    expect(evaluateLoopRetro({ ...healthy, guidelines: exact })).toEqual([]);
  });

  it('帰属の無い教訓は missing_provenance', () => {
    const orphan = { heading: 'h', issues: [], pulls: [], raw: '> 由来: なんとなく', line: 9 };
    const f = evaluateLoopRetro({ ...healthy, guidelines: [orphan] });
    expect(f.map((x) => x.code)).toContain('missing_provenance');
    expect(f.find((x) => x.code === 'missing_provenance')?.message).toContain('9');
  });

  it('日付はあるが issue も PR も無ければ帰属として認めない', () => {
    const f = evaluateLoopRetro({
      ...healthy,
      guidelines: [{ heading: 'h', date: '2026-08-26', issues: [], pulls: [], raw: '> 由来: 2026-08-26', line: 3 }],
    });
    expect(f.map((x) => x.code)).toContain('missing_provenance');
  });

  it('規約版と台帳の版が食い違えば revision_drift', () => {
    // 教訓を外側ループを通さずに手で足すと、ここで見える。
    const f = evaluateLoopRetro({ ...healthy, rulesRevision: 5 });
    expect(f.map((x) => x.code)).toContain('revision_drift');
  });

  it('版マーカーが無いときは「問題なし」ではなく revision_unmeasured', () => {
    // 🔴 空集合を「問題なし」と読まない（#717 と同じ 3 状態）。
    const f = evaluateLoopRetro({ ...healthy, rulesRevision: undefined });
    expect(f.map((x) => x.code)).toContain('revision_unmeasured');
    expect(f.map((x) => x.code)).not.toContain('revision_drift');
  });

  it('版が測れなくても、測れた範囲の指摘は出す（保留は「根拠が無い」ではない）', () => {
    const f = evaluateLoopRetro({ ...healthy, rulesRevision: undefined, runs: [] });
    expect(f.map((x) => x.code)).toContain('never_run');
  });
});

describe('実リポジトリの教訓台帳（fitness）', () => {
  const rules = readFileSync(RULES, 'utf8');

  it('規約ファイルが版マーカーを持つ', () => {
    expect(parseRulesRevision(rules)).toBeTypeOf('number');
  });

  it('教訓はすべて帰属（日付＋issue か PR）を持ち、上限を超えない', () => {
    const guidelines = parseLearnedGuidelines(rules);
    expect(guidelines.length).toBeGreaterThan(0);
    const findings = evaluateLoopRetro({
      guidelines,
      // 実行の間隔はゲートの関心ではない（運用の点検は npm run loop:retro 側）。
      runs: parseRetroRuns(readFileSync(LEDGER, 'utf8')),
      rulesRevision: parseRulesRevision(rules),
      now: new Date(),
    }).filter((f) => f.code === 'over_budget' || f.code === 'missing_provenance');
    expect(findings).toEqual([]);
  });
});
