/**
 * 環境の観測をデータとして持つ (#728)。
 *
 * ## なぜデータにするのか
 *
 * #710 の周回で、散文の断定を止めるテストを **3 度**やり直した（literal → 申告値の英字 →
 * 部品の連結の完全一致）。いずれも言い換えで破られた。最後に効いたのは
 * 「`403` を含む文には観測時点が同居する」という文単位の規則だが、レビューの実測で
 * **4 クラスが依然として素通り**する:
 *
 *  - `403` と書かない断定（「例外なく拒否されます」）
 *  - **観測時点と同居させた**断定（「2026-08-18 に確認したとおり、あなたの環境でも 403 です」）
 *  - 制約節の**外**に書いた断定
 *  - 語彙リストに無い緩和表現
 *
 * 語彙は閉集合、日本語の言い換えは開集合なので原理的に埋まらない。
 * **自由文の置き場所そのものを消す**のがこの module の目的。
 */
import { describe, expect, it } from 'vitest';
import {
  OBSERVATION_STALE_DAYS,
  renderObservation,
  renderObservations,
  type EnvironmentObservation,
} from './environment-observation';

const AT = '2026-08-19';
const OBS: EnvironmentObservation = {
  date: '2026-08-10',
  command: 'gh pr create',
  status: 403,
  refs: [678],
};

describe('renderObservation (#728)', () => {
  it('🔴 観測時点を必ず前置する（断定形を書ける場所が構造上無い）', () => {
    const line = renderObservation(OBS, AT);
    expect(line.startsWith('2026-08-10 時点の観測')).toBe(true);
    expect(line).toContain('gh pr create');
    expect(line).toContain('403');
  });

  it('🔴 描画は data だけから決まる（渡した値が本文に出る）', () => {
    // 固定文と突き合わせるだけのテストは、値が定数へ化けても落ちない。
    // **別の値を渡すと出力も変わる**ことで、実測から来ていることを縛る。
    const other = renderObservation({ ...OBS, date: '2026-08-18', command: 'gh pr merge', status: 500 }, AT);
    expect(other).toContain('2026-08-18');
    expect(other).toContain('gh pr merge');
    expect(other).toContain('500');
    expect(other).not.toContain('gh pr create');
  });

  /**
   * 🔴 **`command` は唯一の文字列フィールド＝自由文スロットになりうる（レビュー B-1）。**
   * レビューの実測で `command: 'gh pr create（あなたの環境でも例外なく拒否されます）'` が
   * 全テストを通った。「行のテンプレを固定した」意味が消えるので、形で弾く。
   */
  it.each([
    'gh pr create（あなたの環境でも例外なく拒否されます）',
    'gh pr create — 確認したとおりあなたの環境でも 403 です',
    '例外なく拒否されます',
  ])('🔴 command に散文を混ぜたら投げる: %s', (command) => {
    expect(() => renderObservation({ ...OBS, command }, AT)).toThrow(/command/);
  });

  it('コマンドらしい形は通す', () => {
    for (const command of ['gh pr view --head', 'gh api graphql', 'npm run build:open-next']) {
      expect(() => renderObservation({ ...OBS, command }, AT)).not.toThrow();
    }
  });

  it('参照 issue を添える', () => {
    expect(renderObservation(OBS, AT)).toContain('#678');
  });

  /**
   * 🔴 **陳腐化を可視化する (#728 AC4)。** #710 の原因は「焼き込んだ値が古くなったのに
   * 誰も気づかなかった」こと。古い観測をそう見えるようにしておけば、次は気づける。
   */
  it('🔴 古い観測はそう表示される', () => {
    const stale = renderObservation({ ...OBS, date: '2026-01-01' }, AT);
    expect(stale).toContain('古い観測');
  });

  it('新しい観測には古い印を付けない', () => {
    expect(renderObservation({ ...OBS, date: AT }, AT)).not.toContain('古い観測');
  });

  it('境界: しきい値ちょうどは古くない、1 日超えたら古い', () => {
    const days = (n: number): string => {
      const d = new Date(`${AT}T00:00:00Z`);
      d.setUTCDate(d.getUTCDate() - n);
      return d.toISOString().slice(0, 10);
    };
    expect(renderObservation({ ...OBS, date: days(OBSERVATION_STALE_DAYS) }, AT)).not.toContain('古い観測');
    expect(renderObservation({ ...OBS, date: days(OBSERVATION_STALE_DAYS + 1) }, AT)).toContain('古い観測');
  });
});

describe('renderObservations (#728)', () => {
  it('観測の数だけ行を出す（自由文の挿入点が無い）', () => {
    const lines = renderObservations([OBS, { ...OBS, command: 'gh pr merge', refs: [702] }], AT).split('\n');
    expect(lines).toHaveLength(2);
    for (const line of lines) expect(line.startsWith('- 2026-08-10 時点の観測')).toBe(true);
  });

  it('空なら空文字（「観測がある」と嘘をつかない）', () => {
    expect(renderObservations([], AT)).toBe('');
  });
});
