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

  /**
   * 🔴 **記録として読めたものは、平文へ落ちない。**
   * 落とすと、**記録の文字列そのものが PIN として通る**。
   * 構造は揃っているが中身が合わない記録（塩や桁が壊れた等）で確かめる。
   */
  it('🔴 記録として読める値は fail closed（その文字列自体でも通らない）', async () => {
    const wrong = 'pbkdf2-sha256$210000$AAAAAAAAAAAAAAAAAAAAAA==$BBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBw=';
    expect(isHashedPin(wrong)).toBe(true);
    expect(await verifyPinCredential(wrong, '4821')).toBe(false);
    expect(await verifyPinCredential(wrong, wrong)).toBe(false);
  });

  /**
   * 🔴 **接頭辞が偶然一致する旧平文を、読めなくしない（レビュー指摘。実測で再現した）。**
   *
   * 管理 API は `pin` に数字も長さも要求していないので、旧レコードには**何でも入りうる**。
   * 接頭辞だけで「ハッシュ」と判定すると、`'pbkdf2-sha256$office'` を PIN にしていた
   * サイトは**本人の PIN でも通らなくなる**（＝受付端末が authorize できない）。
   * 構造として読めない値は平文として扱う。
   */
  it.each([
    'pbkdf2-sha256$office',
    'pbkdf2-sha256$',
    'pbkdf2-sha256$abc$def',
    'pbkdf2-sha256$1$$',
    // 🔴 **区切りが多い形（実測 B4 で穴が出た）。** 個数を見ないと、後段の検証
    //    （数字 / base64）を**先頭 4 つだけで**通してしまい、この旧平文が記録として
    //    読まれて締め出される。これが「読めるかで判定する」の下界になる。
    'pbkdf2-sha256$210000$AAAA$BBBB$extra',
  ])('🔴 接頭辞が似ているだけの旧平文 (%s) は平文として照合する', async (legacy) => {
    expect(isHashedPin(legacy)).toBe(false);
    expect(await verifyPinCredential(legacy, legacy)).toBe(true);
    expect(await verifyPinCredential(legacy, '4821')).toBe(false);
  });
});

describe('🔴 レビュー 1 周目で見つかった面', () => {
  /**
   * 🔴 **BLOCKER: 空の資格情報は誰も通さない。**
   *
   * 実測で `verifyPinCredential('', '')` が **true** だった。`.env.example` が配る
   * `KIOSK_PIN=`（空）のまま `pinRequired: true` にしたサイトでは、
   * `POST /api/kiosk/authorize` に **`pin` を入れずに投げるだけで**セッションが取れる。
   */
  it('🔴 保存値が空なら、空入力でも通らない', async () => {
    expect(await verifyPinCredential('', '')).toBe(false);
    expect(await verifyPinCredential('', '0000')).toBe(false);
  });

  /**
   * 🔴 **MAJOR: 長さガードが落ちると、保存値を接頭辞に持つ入力が全部通る。**
   *
   * 実測でこの変異は**生存していた**（行列に「早期 return を落とす」型が無かった）。
   * ガードが無いと `charCodeAt` が `NaN` → `NaN|0 = 0` になり、
   * 旧平文レコードのサイトで `4821` を知っていれば任意の後続文字列で通る。
   */
  it('🔴 保存値を接頭辞に持つ長い入力は通らない（早期 return の面）', async () => {
    expect(await verifyPinCredential('4821', '4821XYZ')).toBe(false);
    expect(await verifyPinCredential('4821', '482')).toBe(false);
    // 下界: 本人は通る（全部拒否にして満たしていない）。
    expect(await verifyPinCredential('4821', '4821')).toBe(true);
  });

  /**
   * 🔴 **MAJOR: 反復回数を狭める変異が生存していた**（数値パラメータの型）。
   * 記録に実際に焼き込まれている値を見る。
   */
  it('🔴 記録には想定した反復回数が入っている', async () => {
    expect((await hashPin('4821')).split('$')[1]).toBe('10000');
  });

  /**
   * 🔴 **MINOR: 記録側の反復回数に上限を持つ。**
   * 実測で `iterations=1e8` の記録は 1 回の照合に 52.7 秒かかった（未認証経路から踏める）。
   */
  it('🔴 上限を超える反復回数の記録は読めないものとして拒否する', async () => {
    const huge = `pbkdf2-sha256$100000000$AAAAAAAAAAAAAAAAAAAAAA==$BBBB`;
    expect(isHashedPin(huge)).toBe(false);
    // 平文へも落ちない（空でないので比較はするが、入力が一致しない限り通らない）。
    expect(await verifyPinCredential(huge, '4821')).toBe(false);
  });
});

describe('pinConfigured の判定 (#1021 AC3)', () => {
  it('🔴 組込み既定のままなら「未設定」と答える（以前は常に true だった）', () => {
    expect(isPinConfigured({ pin: BUILTIN_DEFAULT_PIN })).toBe(false);
    expect(isPinConfigured({ pin: '' })).toBe(false);
  });

  it('運用者が決めた平文は「設定済み」', () => {
    expect(isPinConfigured({ pin: '4821' })).toBe(true);
  });

  it('🔴 ハッシュは中身を見られないので「設定済み」として扱う', async () => {
    expect(isPinConfigured({ pin: await hashPin(BUILTIN_DEFAULT_PIN) })).toBe(true);
  });
});
