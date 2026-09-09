import { describe, expect, it } from 'vitest';
import {
  ADMIN_PASSWORD_POLICY,
  ADMIN_PASSWORD_SYMBOLS,
  deriveUsernameFromEmail,
  validateAdminCredentials,
} from './admin-user-provisioning';

/**
 * 有効な資格情報の素材。個々のテストはここから 1 項目だけ壊して「その 1 件だけが出る」ことを見る。
 */
const VALID = {
  username: 'changhwi',
  email: 'changhwi.chang@example.com',
  password: 'Aa1!aaaaaaaa', // 12 文字・大小英字・数字・記号
} as const;

describe('validateAdminCredentials — 不変条件', () => {
  // 🔴 上界だけでは空虚に満たせる（全部を violation にすれば「通ったなら妥当」は自明）。
  //    下界（妥当な素材は必ず通る）を併せて縛る。
  it('下界: policy を満たす素材は violations 0 件で通る', () => {
    expect(validateAdminCredentials(VALID)).toEqual([]);
  });

  it('上界: violations 0 件なら、policy の全条件を実際に満たしている', () => {
    // 総当たりで「通った」と報告された入力を、policy の定義から独立に検算する。
    const passwords = [
      'Aa1!aaaaaaaa',
      'Zz9~zzzzzzzz',
      'Qq5 qqqqqqqq', // 空白も Cognito の記号集合に含まれる
      'Aa1!aaaaaaaaaaaaaaaaaaaa',
      'aaaaaaaaaaaa', // 大文字・数字・記号なし → 通ってはいけない
      'Aa1!aaaaaaa', // 11 文字 → 通ってはいけない
      'Aa1aaaaaaaaa', // 記号なし → 通ってはいけない
    ];
    for (const password of passwords) {
      const ok = validateAdminCredentials({ ...VALID, password }).length === 0;
      const satisfies =
        password.length >= ADMIN_PASSWORD_POLICY.minLength &&
        /[a-z]/.test(password) &&
        /[A-Z]/.test(password) &&
        /[0-9]/.test(password) &&
        [...password].some((c) => ADMIN_PASSWORD_SYMBOLS.includes(c));
      expect(ok, `password=${JSON.stringify(password)}`).toBe(satisfies);
    }
  });

  // 🔴 これが今回 dev で実際に踏んだ欠陥（InvalidParameterException:
  //    "Username cannot be of email format, since user pool is configured for email alias"）。
  //    プールは signInAliases: { username: true, email: true } なので username 自体を
  //    メール形式にできない。散文の注意書きではなく述語で縛る。
  it('username がメール形式なら必ず拒否する', () => {
    const violations = validateAdminCredentials({ ...VALID, username: 'changhwi@example.com' });
    expect(violations).toContain('username-is-email');
  });

  it('email が不正なら拒否し、空 username も拒否する', () => {
    expect(validateAdminCredentials({ ...VALID, email: 'not-an-email' })).toContain('email-invalid');
    expect(validateAdminCredentials({ ...VALID, username: '   ' })).toContain('username-empty');
  });

  it('境界: minLength ちょうどは通り、1 文字足りないと落ちる', () => {
    const atLimit = `Aa1!${'a'.repeat(ADMIN_PASSWORD_POLICY.minLength - 4)}`;
    expect(atLimit).toHaveLength(ADMIN_PASSWORD_POLICY.minLength);
    expect(validateAdminCredentials({ ...VALID, password: atLimit })).toEqual([]);
    expect(validateAdminCredentials({ ...VALID, password: atLimit.slice(1) })).toContain(
      'password-too-short',
    );
  });

  it('Cognito の記号集合の外の文字は「記号」として数えない', () => {
    // 'あ' は Cognito の記号集合に無い。これを記号扱いすると requireSymbols が空振りする。
    expect(validateAdminCredentials({ ...VALID, password: 'Aa1あaaaaaaaa' })).toContain(
      'password-missing-symbol',
    );
  });
});

describe('deriveUsernameFromEmail — 不変条件', () => {
  /**
   * 🔴 **この 1 本が本命。** 導出した username がそのまま `admin-create-user` に渡るので、
   * 「導出結果は必ず username として妥当」でなければ、同じ AWS エラーを再び踏む。
   * 分岐ごとの期待値ではなく、入力を総当たりして不変条件を縛る。
   */
  it('どんな入力からでも、導出結果は username として妥当（＝メール形式にならない）', () => {
    const emails = [
      'changhwi.chang@gmail.com',
      'a@b.co',
      'UPPER.Case@Example.COM',
      'plus+tag@example.com',
      'dots...many@example.com',
      'ｆｕｌｌ幅@example.com',
      '@example.com',
      '...@example.com',
      'a@b@c@example.com',
      'no-at-sign-at-all',
      '',
    ];
    for (const email of emails) {
      const username = deriveUsernameFromEmail(email);
      const violations = validateAdminCredentials({ ...VALID, username });
      expect(violations, `email=${JSON.stringify(email)} -> username=${JSON.stringify(username)}`)
        .toEqual([]);
    }
  });

  it('ローカル部を採り、@ 以降は落とす', () => {
    expect(deriveUsernameFromEmail('changhwi.chang@gmail.com')).toBe('changhwi.chang');
  });

  it('導出結果には @ が一切含まれない', () => {
    for (const email of ['a@b@c@d.com', 'x@y.com', '@@@@']) {
      expect(deriveUsernameFromEmail(email)).not.toContain('@');
    }
  });
});

describe('ADMIN_PASSWORD_POLICY', () => {
  // CDK 側（infra/lib/stacks/web-stack.ts）がこの定数を使うことは
  // infra/test/web-stack.test.ts が縛る（散文の同期ではなく機械の同期）。
  it('Cognito の要求を満たす形をしている', () => {
    expect(ADMIN_PASSWORD_POLICY.minLength).toBeGreaterThanOrEqual(8);
    expect(ADMIN_PASSWORD_POLICY.requireLowercase).toBe(true);
    expect(ADMIN_PASSWORD_POLICY.requireUppercase).toBe(true);
    expect(ADMIN_PASSWORD_POLICY.requireDigits).toBe(true);
    expect(ADMIN_PASSWORD_POLICY.requireSymbols).toBe(true);
  });
});
