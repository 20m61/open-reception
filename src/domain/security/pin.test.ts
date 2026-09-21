/**
 * 受付端末 PIN の保存形式 (#1021 AC3)。
 *
 * ## 何を縛るか
 *
 * 🔴 **平文を置かない**。ただし**旧レコードは読めなければならない** ——
 * 既存の設定ストアには平文 PIN が入っており、読めなくすると
 * `pinRequired: true` のサイトが**誰も authorize できなくなる**。
 *
 * 🔴 **`pinConfigured` は「運用者が決めたか」を答える。** 以前は `pin !== ''` で
 * 判定していたが、既定値が `'0000'` で入るため**常に true** だった ——
 * 運用者は `0000` のまま「設定済み」と読む（#1021 MAJOR-8 の本体）。
 */
import { describe, expect, it } from 'vitest';
import {
  BUILTIN_DEFAULT_PIN,
  hashPin,
  isPinConfigured,
  isHashedPin,
  verifyPinCredential,
} from './pin';

describe('PIN のハッシュ保存 (#1021 AC3)', () => {
  it('🔴 ハッシュに PIN そのものが残らない', async () => {
    const stored = await hashPin('4821');
    expect(stored).not.toContain('4821');
    expect(isHashedPin(stored)).toBe(true);
  });

  it('🔴 同じ PIN でも毎回違う（salt が効いている）', async () => {
    expect(await hashPin('4821')).not.toBe(await hashPin('4821'));
  });

  it('🔴 ハッシュは自分の PIN を通し、他を通さない', async () => {
    const stored = await hashPin('4821');
    expect(await verifyPinCredential(stored, '4821')).toBe(true);
    expect(await verifyPinCredential(stored, '4822')).toBe(false);
    expect(await verifyPinCredential(stored, '')).toBe(false);
  });

  /**
   * 🔴 **本体の下界。** 旧レコード（平文）を読めなくすると、
   * `pinRequired: true` のサイトが**誰も authorize できなくなる**。
   */
  it('🔴 旧レコードの平文も検証できる（読み互換）', async () => {
    expect(await verifyPinCredential('4821', '4821')).toBe(true);
    expect(await verifyPinCredential('4821', '4822')).toBe(false);
  });

  it('壊れたハッシュ文字列は誰も通さない（fail closed）', async () => {
    for (const broken of ['pbkdf2-sha256$', 'pbkdf2-sha256$abc$def', 'pbkdf2-sha256$1$$']) {
      expect(await verifyPinCredential(broken, '4821'), broken).toBe(false);
      // 🔴 下界: 壊れた文字列を**平文として**照合しに行かない（その文字列自体でも通らない）。
      expect(await verifyPinCredential(broken, broken), broken).toBe(false);
    }
  });
});

describe('pinConfigured の判定 (#1021 AC3)', () => {
  it('🔴 組込み既定のままなら「未設定」と答える（以前は常に true だった）', () => {
    expect(isPinConfigured(BUILTIN_DEFAULT_PIN)).toBe(false);
    expect(isPinConfigured('')).toBe(false);
  });

  it('運用者が決めた平文は「設定済み」', () => {
    expect(isPinConfigured('4821')).toBe(true);
  });

  it('🔴 ハッシュは中身を見られないので「設定済み」として扱う', async () => {
    expect(isPinConfigured(await hashPin(BUILTIN_DEFAULT_PIN))).toBe(true);
  });
});
