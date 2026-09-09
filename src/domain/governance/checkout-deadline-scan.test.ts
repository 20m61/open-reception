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
    expect(CASES.filter((c) => c.name.startsWith('🔴')).length).toBeGreaterThanOrEqual(5);
  });

  it('method が動的で読めないときは書き込み側へ倒す（安全側）', () => {
    expect(classifyDeadline("('/api/kiosk/checkout', { method: computeMethod(), signal: d.signal })")).toBe(
      'confirm',
    );
  });
});
