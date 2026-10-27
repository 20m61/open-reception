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
  ITERATIONS,
  MAX_ITERATIONS,
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
   * 🔴 **入力側の空も拒否する（レビュー 2 周目 MAJOR 4。実測で変異が生存した）。**
   *
   * 保存側だけを見ていると「**空 PIN がハッシュとして保存された世界**」が残る ——
   * そこでは空入力で通ってしまい、1 周目 BLOCKER が別の綴りで再発する。
   * 今日それを防いでいるのは保存側のガードだけで、落とすと全テストが素通りした。
   */
  it('🔴 空 PIN のハッシュが保存されていても、空入力では通らない', async () => {
    const hashedEmpty = await hashPin('');
    expect(isHashedPin(hashedEmpty)).toBe(true);
    expect(await verifyPinCredential(hashedEmpty, '')).toBe(false);
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

/**
 * 🔴 **`classify` の節と数値定数から機械的に導いた面（レビュー 2 周目 MAJOR 3）。**
 *
 * 2 周目のレビューが、コードから棚卸しした 40 変異のうち **13 の生存**を報告した。
 * 私の行列は「自分が思いついた平文」から作っており、**分類器の節（6 つ）と
 * 数値定数（3 つ）から導いていなかった** —— 規約「棚卸しの対象を分岐に狭めない。
 * 数値パラメータを必ず入れる」を、名指しされているのに守れていなかった。
 *
 * ここは節ごと・定数ごとに 1 ケースずつ置く。
 */
describe('🔴 分類器の節と定数（機械的に棚卸しした面）', () => {
  const salt = 'AAAAAAAAAAAAAAAAAAAAAA==';

  /** 節 1: アルゴリズム名。違えば**うちの形式ではない**＝平文として扱う。 */
  it('🔴 アルゴリズム名が違う値は平文として扱う', async () => {
    const other = `scrypt$10000$${salt}$BBBB`;
    expect(isHashedPin(other)).toBe(false);
    expect(await verifyPinCredential(other, other)).toBe(true);
  });

  /** 節 2: 反復回数が数字でない → うちの形式ではない（旧平文でありうる）。 */
  it('🔴 反復回数が数字でない値は平文として扱う', async () => {
    const weird = `pbkdf2-sha256$abc$${salt}$BBBB`;
    expect(isHashedPin(weird)).toBe(false);
    expect(await verifyPinCredential(weird, weird)).toBe(true);
  });

  /** 節 3: hash が空 → うちの形式ではない。 */
  it('🔴 hash が空の値は平文として扱う', async () => {
    const empty = `pbkdf2-sha256$10000$${salt}$`;
    expect(isHashedPin(empty)).toBe(false);
    expect(await verifyPinCredential(empty, empty)).toBe(true);
  });

  /**
   * 節 4: 反復回数 0。**うちの形式なので平文へは落とさない**（落とすと記録の文字列で通る）。
   * かつ `deriveBits` は 0 で throw するので、計算させてはいけない。
   */
  it('🔴 反復回数 0 の記録は誰も通さない（計算もしない）', async () => {
    const zero = `pbkdf2-sha256$0$${salt}$BBBB`;
    expect(await verifyPinCredential(zero, zero)).toBe(false);
    expect(await verifyPinCredential(zero, '4821')).toBe(false);
  });

  /** 節 5: 上限超過。同じく平文へ落とさない。 */
  it('🔴 上限を超える反復回数の記録は誰も通さない', async () => {
    const huge = `pbkdf2-sha256$100000000$${salt}$BBBB`;
    expect(await verifyPinCredential(huge, huge)).toBe(false);
  });

  /** 節 6: salt が空 / base64 でない。同じく平文へ落とさない。 */
  it.each(['pbkdf2-sha256$10000$$BBBB', 'pbkdf2-sha256$10000$***$BBBB'])(
    '🔴 salt が読めない記録 (%s) は誰も通さない',
    async (broken) => {
      expect(await verifyPinCredential(broken, broken)).toBe(false);
      // 🔴 下界（レビュー 3 周目 MINOR 4）: 「記録として読めない」ことまで主張する。
      //    `verify` が false なだけなら「hash だが一致しない」世界でも満たせるので、
      //    salt の検査を外す変異が**生存していた**。
      expect(isHashedPin(broken)).toBe(false);
    },
  );

  /**
   * 🔴 **定数の関係を縛る（レビュー 3 周目 MINOR 5）。**
   * `ITERATIONS` を上限より上へ動かすと、**自分が書いた記録を自分で読めなくなり**
   * サイト全体が締め出される（実測で再現）。doc が「AC4 が入ったら上げ直す余地がある」と
   * 書いている操作そのものなので、関係を固定する。
   */
  it('🔴 書き込む反復回数は記録側の上限以下', () => {
    expect(ITERATIONS).toBeLessThanOrEqual(MAX_ITERATIONS);
  });

  /**
   * 🔴 **上限の理由になっている値（210,000 の記録）が読めることを固定する。**
   * doc は「210,000 の記録を読めなくしないために上限を緩く取った」と書いているのに、
   * それを縛るテストが無く、上限を 20,001〜1e8 の任意値へ狭めても緑だった。
   */
  it('🔴 210,000 反復の記録も読める（上限を締めすぎない）', async () => {
    const encoder = new TextEncoder();
    const saltBytes = crypto.getRandomValues(new Uint8Array(16));
    const key = await crypto.subtle.importKey('raw', encoder.encode('4821'), 'PBKDF2', false, [
      'deriveBits',
    ]);
    const bits = await crypto.subtle.deriveBits(
      { name: 'PBKDF2', hash: 'SHA-256', salt: saltBytes as BufferSource, iterations: 210_000 },
      key,
      256,
    );
    const b64 = (bytes: Uint8Array) => btoa(String.fromCharCode(...bytes));
    const record = `pbkdf2-sha256$210000$${b64(saltBytes)}$${b64(new Uint8Array(bits))}`;
    expect(await verifyPinCredential(record, '4821')).toBe(true);
  });

  /** 🔴 文字列でない保存値で 500 にしない（authorize も管理画面も落ちる）。 */
  it('🔴 保存値が文字列でなくても落ちず、誰も通さない', async () => {
    const notString = undefined as unknown as string;
    expect(isHashedPin(notString)).toBe(false);
    expect(await verifyPinCredential(notString, '4821')).toBe(false);
  });

  /** 🔴 定数 1: salt の長さ（狭める型）。16 バイト＝base64 24 文字。 */
  it('🔴 salt は 16 バイト（狭める変異を止める）', async () => {
    const [, , saltPart] = (await hashPin('4821')).split('$');
    expect(saltPart).toHaveLength(24);
    expect(atob(saltPart ?? '')).toHaveLength(16);
  });

  /** 🔴 定数 2: 導出鍵の長さ（狭める型）。256bit＝32 バイト＝base64 44 文字。 */
  it('🔴 導出鍵は 256 bit（狭める変異を止める）', async () => {
    const [, , , hash] = (await hashPin('4821')).split('$');
    expect(atob(hash ?? '')).toHaveLength(32);
  });

  /** 🔴 定数 3: 組込み既定の値そのもの（記号参照だけだと変異が素通りする）。 */
  it('🔴 組込み既定は 0000（リテラルで固定する）', () => {
    expect(BUILTIN_DEFAULT_PIN).toBe('0000');
  });

  /**
   * 🔴 **配線: 照合は記録側の反復回数を使う**（定数で照合すると、`ITERATIONS` を
   * 上げた瞬間に**既存レコードが全部通らなくなる**）。現行と違う値の記録で確かめる。
   */
  it('🔴 記録に書かれた反復回数で照合する（現行の定数ではなく）', async () => {
    const encoder = new TextEncoder();
    const saltBytes = crypto.getRandomValues(new Uint8Array(16));
    const key = await crypto.subtle.importKey('raw', encoder.encode('4821'), 'PBKDF2', false, [
      'deriveBits',
    ]);
    const bits = await crypto.subtle.deriveBits(
      { name: 'PBKDF2', hash: 'SHA-256', salt: saltBytes as BufferSource, iterations: 20_000 },
      key,
      256,
    );
    const b64 = (bytes: Uint8Array) => btoa(String.fromCharCode(...bytes));
    const record = `pbkdf2-sha256$20000$${b64(saltBytes)}$${b64(new Uint8Array(bits))}`;
    expect(await verifyPinCredential(record, '4821')).toBe(true);
    expect(await verifyPinCredential(record, '9999')).toBe(false);
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
