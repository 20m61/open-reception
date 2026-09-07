import { describe, expect, it } from 'vitest';
import { asSecurityView, type SecurityView } from './SecurityManager';

/**
 * セキュリティ設定の応答が**確かめられた形かどうか** (#973)。
 *
 * 由来: 応答を `as SecurityView` で通していたため、企業プロキシや API のバージョンスキューが
 * 返す `200 {"ok":true}` がそのまま `view` に入り、`emergencyStop` が `undefined` になった。
 * 画面は**「現在: 通常稼働」と「緊急停止を有効にしました」を同時に**出し、`pinConfigured` も
 * `undefined` で「未設定」に化ける。`docs/runbook.md` §2.2 は緊急停止の確認を画面表示で
 * 行えと書いているので、この表示が嘘をつくのは受付を止められないのと同じである。
 *
 * 🔴 **e2e の fixture だけでは 1 フィールドしか縛れない。** 本文が複数フィールド欠けていると、
 * 述語のどの行を消しても別の行が拾ってしまい、**行単位の変異が生存する**（実測）。
 * 「境界のすぐ内側を踏む入力が要る」（`.claude/rules/opus5-autonomous-loop.md`）と同型なので、
 * ここでフィールドごとに 1 つずつ壊した入力を当てる。
 */
describe('asSecurityView (#973)', () => {
  const valid: SecurityView = {
    pinRequired: true,
    ipAllowlist: ['203.0.113.10'],
    pinConfigured: true,
    emergencyStop: false,
  };

  it('正しい形はそのまま通る', () => {
    expect(asSecurityView({ ...valid })).toEqual(valid);
  });

  it('サーバがフィールドを足しても通る（前方互換）', () => {
    // 追加は互換。ここを厳密一致にすると、API が 1 つ足しただけで画面が出なくなる。
    expect(asSecurityView({ ...valid, addedLater: 'x' })).not.toBeNull();
  });

  it.each(['pinRequired', 'ipAllowlist', 'pinConfigured', 'emergencyStop'] as const)(
    '%s が欠けていれば通さない',
    (field) => {
      const broken: Record<string, unknown> = { ...valid };
      delete broken[field];
      expect(asSecurityView(broken)).toBeNull();
    },
  );

  it.each([
    ['pinRequired', 'true'],
    ['pinConfigured', 1],
    ['emergencyStop', null],
    ['ipAllowlist', 'a,b'],
  ] as const)('%s の型が違えば通さない', (field, wrong) => {
    expect(asSecurityView({ ...valid, [field]: wrong })).toBeNull();
  });

  it('ipAllowlist の中身が文字列でなければ通さない', () => {
    // 要素まで見ないと `join('\n')` が `[object Object]` を画面へ出す。
    expect(asSecurityView({ ...valid, ipAllowlist: [1, 2] })).toBeNull();
  });

  it('オブジェクトでなければ通さない', () => {
    for (const notObject of [null, undefined, 'x', 3, true, []]) {
      expect(asSecurityView(notObject)).toBeNull();
    }
  });
});
