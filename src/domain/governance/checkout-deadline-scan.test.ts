import { describe, expect, it } from 'vitest';
import { classifyDeadline, resolveConstants, stringConstants } from './checkout-deadline-scan';

/**
 * 退館フローの締切分類の**回帰行列** (#1029)。
 *
 * 🔴 **これは「思いついた変異」の置き場ではなく、実際に抜けられた綴りの記録である。**
 * 分類方式を 5 回替え、5 回とも別の側を壊した（見逃し 3 回・偽陽性 2 回）。
 * `.claude/rules/opus5-autonomous-loop.md`「方式を替えたら、前の方式が守っていた変異を
 * 当て直す」を人の注意に任せると必ず落ちるので、**表にして機械に持たせる**。
 *
 * 🔴 **見逃しと偽陽性を 1 つの表に入れてある。** 5 回の失敗の共通点は「片方だけ測った」
 * ことだった。方式を替えるときは、この表が両方向を同時に押さえる。
 */

/** `args` は `fetchArguments` が返す形（開き括弧から閉じ括弧まで）を模す。 */
const CASES: readonly { name: string; source: string; args: string; expect: 'read' | 'confirm' }[] = [
  {
    name: '在館一覧の GET（method も body も無い）',
    source: '',
    args: "('/api/kiosk/checkout', { signal: presentDeadline.signal })",
    expect: 'read',
  },
  {
    name: '自己特定 resolve（POST だが退館は確定しない）',
    source: '',
    args: "('/api/kiosk/checkout/resolve', { method: 'POST', body: x, signal: resolveDeadline.signal })",
    expect: 'read',
  },
  {
    name: '退館確定 confirm（パスで当たる）',
    source: '',
    args: "('/api/kiosk/checkout/confirm', { method: 'POST', body: x, signal: confirmDeadline.signal })",
    expect: 'confirm',
  },
  {
    name: '在館一覧から選んだ確定（同じパスへ POST）',
    source: '',
    args: "('/api/kiosk/checkout', { method: 'POST', body: x, signal: confirmDeadline.signal })",
    expect: 'confirm',
  },
  // ---- ここから下は「実際に抜けられた綴り」 ----
  {
    // 6 周目: `method: 'POST'` の綴り一致に依存していたので見逃した
    name: '🔴 見逃し例 1: method の値を定数へ括り出す',
    source: "const POST_METHOD = 'POST';",
    args: "('/api/kiosk/checkout', { method: POST_METHOD, body: x, signal: d.signal })",
    expect: 'confirm',
  },
  {
    // 7 周目: `body:` の有無に依存していたので見逃した
    name: '🔴 見逃し例 2: body を持たない書き込み（query 文字列）',
    source: '',
    args: "(`/api/kiosk/checkout?stayId=${id}`, { method: 'POST', signal: d.signal })",
    expect: 'confirm',
  },
  {
    // 6 周目: `method` キーの有無に依存していたので誤検知した
    name: '🔴 偽陽性例 1: GET を明示しただけ（振る舞い不変）',
    source: '',
    args: "('/api/kiosk/checkout', { method: 'GET', signal: presentDeadline.signal })",
    expect: 'read',
  },
  {
    // 8 周目: パス規則が文字列リテラルにしか当たらず誤検知した
    name: '🔴 偽陽性例 2: resolve の URL を定数へ括り出す（振る舞い不変）',
    source: "const RESOLVE_URL = '/api/kiosk/checkout/resolve';",
    args: "(RESOLVE_URL, { method: 'POST', body: x, signal: resolveDeadline.signal })",
    expect: 'read',
  },
  {
    name: '🔴 偽陽性例 3: confirm の URL を定数へ括り出す（振る舞い不変）',
    source: "const CONFIRM_URL = '/api/kiosk/checkout/confirm';",
    args: "(CONFIRM_URL, { method: 'POST', body: x, signal: confirmDeadline.signal })",
    expect: 'confirm',
  },
  {
    name: 'GET を定数へ括り出しても読み取りのまま',
    source: "const GET_METHOD = 'GET';",
    args: "('/api/kiosk/checkout', { method: GET_METHOD, signal: presentDeadline.signal })",
    expect: 'read',
  },
  {
    /*
      9 周目: `method:` を `body:` **より先に**見ていたので、body の中に入れ子で現れた
      `method` を fetch の method と取り違えて `read` へ落とした。7 周目の `body:` 規則は
      この入力を kill していたので、**方式の入替えで kill が減った = 退行**である。
      `.claude/rules/opus5-autonomous-loop.md`「方式を替えたら、前の方式が守っていた変異を
      当て直す」に当たる。行列が「抜けられた綴り」しか持たず、**前の方式が守っていた入力**を
      持っていなかったため機械では検出できなかった。
    */
    name: '🔴 見逃し例 3: body の中に入れ子で現れた method（7 周目方式が守っていた）',
    source: '',
    args: "('/api/kiosk/checkout', { body: JSON.stringify({ method: 'get' }), method: 'POST', signal: d.signal })",
    expect: 'confirm',
  },
  {
    // 9 周目レビューの入力探査。以下 4 つは**振る舞いを変えない書き換え**なのに read へ落ちていた。
    name: '🔴 見逃し例 4: shorthand で init を組む',
    source: '',
    args: "('/api/kiosk/checkout', { method, headers, body, signal: d.signal })",
    expect: 'confirm',
  },
  {
    name: '🔴 見逃し例 5: spread で init を組む（args から読めない）',
    source: '',
    args: "('/api/kiosk/checkout', { ...POST_INIT, signal: d.signal })",
    expect: 'confirm',
  },
  {
    name: '🔴 見逃し例 6: 引用符付きキー',
    source: '',
    args: "('/api/kiosk/checkout', { 'method': 'POST', 'body': x, signal: d.signal })",
    expect: 'confirm',
  },
  {
    name: '🔴 見逃し例 7: 計算キー（定数を解決して初めて読める）',
    source: "const METHOD_KEY = 'method';",
    args: "('/api/kiosk/checkout', { [METHOD_KEY]: 'POST', signal: d.signal })",
    expect: 'confirm',
  },
];

describe('退館フローの締切分類の回帰行列 (#1029)', () => {
  for (const c of CASES) {
    it(c.name, () => {
      const resolved = resolveConstants(c.args, stringConstants(c.source));
      expect(classifyDeadline(resolved)).toBe(c.expect);
    });
  }

  /*
    🔴 **下界。** 表が「全部 read」や「全部 confirm」でも満たせる形になっていないこと。
    5 回の失敗のうち 2 回は偽陽性側だったので、両方が実在することを固定する。
  */
  it('表は読み取りと書き込みの両方を含む', () => {
    expect(CASES.some((c) => c.expect === 'read')).toBe(true);
    expect(CASES.some((c) => c.expect === 'confirm')).toBe(true);
    // 実際に抜けられた綴りが記録されていること（減らすときは理由を書く）。
    expect(CASES.filter((c) => c.name.startsWith('🔴')).length).toBeGreaterThanOrEqual(10);
  });

  it('method が動的で読めないときは書き込み側へ倒す（安全側）', () => {
    expect(classifyDeadline("('/api/kiosk/checkout', { method: computeMethod(), signal: d.signal })")).toBe(
      'confirm',
    );
  });

  /*
    🔴 **誇張しない。** 上の表は「args に init が現れる」形しか押さえられない。
    `args` の外に init を置く形は原理的に読めず、**読み取りへ落ちる**。
    これは方式の限界であって行を足せば直るものではない（前提の置き換えは #1040）。
    塞げていないことを**測って記録する** —— 黙って通すと「行列が全部 kill だから穴が無い」
    という誤読を招く。
  */
  it('🔴 塞げていない: args の外に init を置くと読み取りへ落ちる (#1040)', () => {
    expect(classifyDeadline("('/api/kiosk/checkout', buildInit())")).toBe('read');
  });
});

/**
 * `resolveConstants` の置換範囲。
 *
 * 🔴 **分類を経由しないで直接縛る**（9 周目 MINOR-4）。否定先読み
 * `(?<![\w$.'"`])` を丸ごと削除しても行列 15 本が素通りした ―― 先読みを踏む入力が
 * 表に 1 つも無く、**保証の存在だけがあって検出力がゼロ**だった。
 */
describe('resolveConstants は識別子の出現だけを置き換える (#1029)', () => {
  const constants = stringConstants("const NAME = 'POST';");

  it('素の識別子は置き換える（下界。この検査が空虚でないこと）', () => {
    expect(resolveConstants('(u, { method: NAME })', constants)).toBe("(u, { method: 'POST' })");
  });

  it('プロパティ名は置き換えない', () => {
    expect(resolveConstants('(u, { init: o.NAME })', constants)).toBe('(u, { init: o.NAME })');
  });

  it('既に引用符で囲まれたキーは置き換えない', () => {
    expect(resolveConstants("(u, { 'NAME': 1 })", constants)).toBe("(u, { 'NAME': 1 })");
  });

  it('識別子の一部には当たらない', () => {
    expect(resolveConstants('(u, { NAMES: 1, XNAME: 2 })', constants)).toBe('(u, { NAMES: 1, XNAME: 2 })');
  });
});
