/**
 * 受付端末の PIN 許可の失敗表示 (#1021 AC4)。
 *
 * ## 何が問題か
 *
 * `KioskFlow` の PIN 画面は非 ok を**一括で** `setError(true)` にし、
 * 「**PIN が正しくありません。**」と出していた。AC4 で 429（試行回数制限）が
 * 返りうるようになったので、そのままだと**正しい PIN を入れた来訪者に
 * 「PIN が違う」と言う**ことになる。来訪者は正しい PIN を疑って打ち直し続け、
 * その間ずっと受付できない。
 *
 * 🔴 これは #973（admin ログイン）・#1021（`loginFailureForStatus`）・#1123
 * （担当者画面）が**すでに 3 回塞いでいる型**である（非 ok を 1 つの原因へ丸める）。
 * 4 回目を作らない。先例と同じ形（status → 原因の純関数）で解く。
 *
 * ## 縛る不変条件
 *
 * > **429 では PIN を疑わせない。** かつ **401 では従来どおり PIN を疑わせる**（下界）。
 */
import { describe, expect, it } from 'vitest';
import {
  authorizeFailureForStatus,
  authorizeFailureMessage,
  authorizeStateFromResponse,
  readAuthorizeErrorCode,
  type AuthorizeFailure,
} from './authorize-outcome';

const ALL: AuthorizeFailure[] = [
  'wrong_pin',
  'not_enrolled',
  'too_many_attempts',
  'unavailable',
  'unreachable',
];

describe('status から原因への写像 (#1021 AC4)', () => {
  it('🔴 429 は too_many_attempts（PIN のせいにしない）', () => {
    expect(authorizeFailureForStatus(429)).toBe('too_many_attempts');
  });

  it.each([401, 403])('%i は wrong_pin（サーバが検査したうえで断った）', (s) => {
    expect(authorizeFailureForStatus(s)).toBe('wrong_pin');
  });

  it.each([500, 502, 503, 504])('%i は unavailable（サーバ側の問題）', (s) => {
    expect(authorizeFailureForStatus(s)).toBe('unavailable');
  });
});

describe('文言 (#1021 AC4)', () => {
  it.each(ALL)('%s の文言は空でない', (f) => {
    expect(authorizeFailureMessage(f, undefined).trim().length).toBeGreaterThan(0);
  });

  it('原因ごとに文言が違う（2 つが同じなら区別した意味がない）', () => {
    const set = new Set(ALL.map((f) => authorizeFailureMessage(f, undefined)));
    expect(set.size).toBe(ALL.length);
  });

  /**
   * 🔴 **本体。** 429 で「PIN が正しくありません」と言わない。
   * 言うと、正しい PIN を持っている来訪者が自分の PIN を疑って打ち直し続ける。
   */
  it('🔴 too_many_attempts では PIN を疑わせない', () => {
    const m = authorizeFailureMessage('too_many_attempts', 90);
    expect(m).not.toContain('PIN が正しくありません');
    expect(m).not.toContain('PIN が違');
  });

  /** 🔴 下界: 401 では従来どおり PIN を疑わせる（全部を曖昧にしない）。 */
  it('🔴 wrong_pin では従来どおり PIN を指す（下界）', () => {
    expect(authorizeFailureMessage('wrong_pin', undefined)).toContain('PIN');
  });

  /**
   * 🔴 **待ち時間が分かるなら伝える。** 伝えないと来訪者は「いつ直るのか」が分からず、
   * 無言の拒否と区別できない（このリポジトリは `retryAfterMs` を返す設計にしてある）。
   */
  it('🔴 待ち時間が分かるなら秒数を出す', () => {
    expect(authorizeFailureMessage('too_many_attempts', 90)).toContain('90');
  });

  /**
   * 🔴 **大きい待ち時間は秒数で出さない（変異 M43 が生存した穴）。**
   *
   * 予算の窓は 10 分なので、超過直後の `Retry-After` は 600 近くになる。
   * 「約 600 秒後」は来訪者にとって**読めない**（嘘ではないが伝わらない）ので、
   * 上限を超えたら「しばらく」へ落とす。
   *
   * 🔴 この上限は**有限性の境界でもある** —— `Number.isFinite` を撤回したので、
   * `Infinity` を落としているのはこの比較である（上の `Infinity` の行が下界）。
   */
  it.each([
    [121, '上限のすぐ外'],
    [600, '窓ちょうど'],
    [86_400, '桁違い'],
  ])('🔴 待ち時間が %d 秒（%s）なら秒数を出さない', (value) => {
    const m = authorizeFailureMessage('too_many_attempts', value);
    expect(m, `${value} 秒がそのまま画面へ出ている`).not.toContain(String(value));
    expect(m.trim().length).toBeGreaterThan(0);
  });

  /** 🔴 下界: 上限**ちょうど**は出す（上限を狭める変異を落とす）。 */
  it('🔴 上限ちょうどの待ち時間は秒数を出す（下界）', () => {
    expect(authorizeFailureMessage('too_many_attempts', 120)).toContain('120');
  });

  /**
   * 🔴 **全部の原因で locale が効く（変異 M47 が生存した穴）。**
   *
   * 1 つでも `locale` を渡し忘れると、その原因だけ**既定 locale（ja）に固定**される。
   * 辞書を 4 言語ぶん足した意味が、その 1 行で消える。原因ごとに個別のテストを書くと
   * **書かなかった原因がそのまま穴**になるので（#1004 の教訓）、原因の**全列**を
   * 型から取って総当たりする。
   *
   * 判定は「ja と違う文字列が出ること」。文言そのものを書き写すと、辞書を直すたびに
   * テストも直すことになり、**辞書とテストが同じ誤りを共有**する。
   */
  it('🔴 どの原因でも locale が効く（ja に固定されない）', () => {
    for (const failure of ALL) {
      const ja = authorizeFailureMessage(failure, 90, 'ja');
      const en = authorizeFailureMessage(failure, 90, 'en');
      expect(en, `${failure} が locale を無視して ja に固定されている`).not.toBe(ja);
      expect(en.trim().length).toBeGreaterThan(0);
    }
  });

  /**
   * 🔴 下界: 秒数を出す枝でも locale が効く（`tooManyAttempts` と
   * `tooManyAttemptsLater` は別の辞書キーなので、片方だけ渡し忘れられる）。
   */
  it('🔴 秒数を出さない枝でも locale が効く（下界）', () => {
    const ja = authorizeFailureMessage('too_many_attempts', 600, 'ja');
    const en = authorizeFailureMessage('too_many_attempts', 600, 'en');
    expect(en).not.toBe(ja);
  });

  /**
   * 🔴 分からないときも文言が壊れない（「NaN 秒」「undefined 秒」と出さない）。
   *
   * 🔴 **`undefined` だけでは足りない（変異 M34 が生存した）。** この関数は
   * **公開されていて引数が `number | undefined`** なので、型は `NaN` を除外しない。
   * 今日の唯一の呼び出し元（`authorizeStateFromResponse`）が有限性を保証していても、
   * **直接呼ぶ面は実在する**ので、境界はこちら側でも持つ。
   * 0 と負も同じ（「約 0 秒後」「約 -5 秒後」と言わない）。
   */
  it.each<[string, number | undefined]>([
    ['undefined', undefined],
    ['NaN', Number.NaN],
    ['Infinity', Number.POSITIVE_INFINITY],
    ['0', 0],
    ['負', -5],
  ])('🔴 待ち時間が %s でも文言が壊れない', (_label, value) => {
    const m = authorizeFailureMessage('too_many_attempts', value);
    expect(m).not.toContain('NaN');
    expect(m).not.toContain('undefined');
    expect(m).not.toContain('Infinity');
    expect(m).not.toContain('約 0 秒');
    expect(m).not.toContain('-5');
    expect(m.trim().length).toBeGreaterThan(0);
    // 下界: 次の一手は残る。
    expect(m).toContain('担当者');
  });

  /**
   * 🔴 **次の一手を残す。** 429 は来訪者に落ち度が無いので、
   * 待つ以外の導線（有人対応を求める）を必ず出す —— さもないと立ち尽くす。
   */
  it('🔴 too_many_attempts でも次の一手がある', () => {
    const m = authorizeFailureMessage('too_many_attempts', 90);
    expect(m).toContain('担当者');
  });

  /** 🔴 未認証画面なので、設定の内訳や鍵名を出さない。 */
  it.each(ALL)('🔴 %s の文言が env 名・鍵名を漏らさない', (f) => {
    const m = authorizeFailureMessage(f, 30);
    expect(m).not.toMatch(/SECRET|ADMIN_|KIOSK_|PBKDF2|pbkdf2/);
  });
});

/**
 * 応答 → 画面状態の写像（#1021 AC4）。
 *
 * 🔴 **配線をここで縛る（#826 の教訓）。** 純関数の分岐を全部 kill しても、
 * 呼び出し側を変異させていなければ保証は丸ごと落ちる。`KioskFlow` の PIN 画面は
 * この 1 式を呼ぶだけにしてあり、その 1 行は `authorize-wiring.test.ts` が静的に固定する。
 */
describe('応答から画面状態への写像 (#1021 AC4)', () => {
  it('🔴 429 と Retry-After から待ち時間つきの状態を作る', () => {
    const s = authorizeStateFromResponse(429, '90', null);
    expect(s).toEqual({ kind: 'error', failure: 'too_many_attempts', retryAfterSec: 90 });
  });

  it('🔴 Retry-After が無ければ待ち時間は undefined（NaN にしない）', () => {
    expect(authorizeStateFromResponse(429, null, null).retryAfterSec).toBeUndefined();
  });

  /**
   * 🔴 **本体（変異 M34 が生存した穴）。** ヘッダが数値でないとき
   * `Number.parseInt` は `NaN` を返す。検査を外すと文言が「約 NaN 秒後」になる。
   * `undefined` だけ当てていては**この綴りに届かない**。
   */
  it.each(['soon', '', 'Wed, 21 Oct 2015 07:28:00 GMT'])(
    '🔴 Retry-After が数値でない（%j）なら待ち時間は undefined',
    (header) => {
      const s = authorizeStateFromResponse(429, header, null);
      expect(s.kind).toBe('error');
      expect(s.retryAfterSec).toBeUndefined();
      // 下界: 文言が壊れていない（NaN を出さない）。
      expect(authorizeFailureMessage(s.failure, s.retryAfterSec)).not.toContain('NaN');
    },
  );

  it('🔴 401 は wrong_pin（下界。全部 too_many_attempts にしていない）', () => {
    expect(authorizeStateFromResponse(401, null, null).failure).toBe('wrong_pin');
  });
});

/**
 * 未登録の端末への案内（#1237 journey B）。
 *
 * PIN 認可は登録済みの端末に限られた（`/api/kiosk/authorize` が 403 `not_enrolled`）。
 * PIN 画面が 403 を一律に「PIN が正しくありません」と出すと、**正しい PIN を持つ担当者が
 * PIN を疑って打ち直し続け**、登録が要るという本当の原因へ辿り着けない。
 *
 * ## 縛る不変条件
 *
 * > **`not_enrolled` と判定するのは「403 かつ本文の error が `not_enrolled`」のときだけ。**
 * > そのときは PIN を疑わせず、登録し直す導線を出す。
 * > それ以外の 401/403 は従来どおり `wrong_pin`（下界。全部を登録案内へ倒さない）。
 */
describe('未登録の端末 (#1237 journey B)', () => {
  const CODES = [null, 'not_enrolled', 'forbidden', 'unauthorized', 'too_many_attempts', ''];
  const STATUSES = [401, 403, 429, 500, 503];

  it('🔴 not_enrolled になるのは 403 かつ error=not_enrolled のときだけ（総当たり）', () => {
    for (const status of STATUSES) {
      for (const code of CODES) {
        const failure = authorizeStateFromResponse(status, null, code).failure;
        const expected = status === 403 && code === 'not_enrolled';
        expect(failure === 'not_enrolled', `status=${status} code=${String(code)}`).toBe(expected);
      }
    }
  });

  /** 🔴 下界: 他の 403（IP 不許可・PIN 認可無効）と 401 は従来どおり wrong_pin。 */
  it.each<[number, string | null]>([
    [401, 'unauthorized'],
    [401, 'not_enrolled'],
    [403, 'forbidden'],
    [403, null],
  ])('🔴 %i / %j は wrong_pin のまま（下界）', (status, code) => {
    expect(authorizeStateFromResponse(status, null, code).failure).toBe('wrong_pin');
  });

  /** 🔴 status の判定（429 / 5xx）は error に上書きされない。 */
  it('🔴 429 と 5xx は error コードに関係なく従来の原因', () => {
    expect(authorizeStateFromResponse(429, '30', 'not_enrolled')).toEqual({
      kind: 'error',
      failure: 'too_many_attempts',
      retryAfterSec: 30,
    });
    expect(authorizeStateFromResponse(503, null, 'not_enrolled').failure).toBe('unavailable');
  });

  it('🔴 not_enrolled では PIN を疑わせない', () => {
    for (const locale of ['ja', 'ja-simple'] as const) {
      const m = authorizeFailureMessage('not_enrolled', undefined, locale);
      expect(m).not.toContain('PIN が正しくありません');
      expect(m).not.toContain('PIN が違');
      expect(m).not.toBe(authorizeFailureMessage('wrong_pin', undefined, locale));
    }
    expect(authorizeFailureMessage('not_enrolled', undefined, 'en')).not.toMatch(/incorrect pin/i);
  });

  /** 🔴 次の一手: 登録し直す導線（担当者・URL / QR）を出す。 */
  it('🔴 not_enrolled は登録し直す導線を出す', () => {
    const m = authorizeFailureMessage('not_enrolled', undefined, 'ja');
    expect(m).toContain('担当者');
    expect(m).toContain('QR');
    expect(m).toContain('登録');
  });
});

/**
 * 応答本文から error コードを読む（#1237 journey B）。
 *
 * 🔴 **読めなくても状態は作れる。** 本文が JSON でない・`error` が文字列でない・読み取りが
 * 失敗した、のいずれでも `null` を返す（throw すると PIN 画面が `unreachable` へ落ち、
 * 応答は届いているのに「通信を確かめて」と言うことになる）。
 */
describe('応答本文の error コード (#1237 journey B)', () => {
  it('🔴 JSON の error を返す', async () => {
    const res = new Response(JSON.stringify({ error: 'not_enrolled', message: 'x' }), {
      status: 403,
    });
    await expect(readAuthorizeErrorCode(res)).resolves.toBe('not_enrolled');
  });

  it.each<[string, string]>([
    ['JSON でない', 'not json'],
    ['空', ''],
    ['error が無い', '{}'],
    ['error が文字列でない', '{"error":403}'],
    ['null', 'null'],
  ])('🔴 %s なら null', async (_label, body) => {
    await expect(readAuthorizeErrorCode(new Response(body, { status: 403 }))).resolves.toBeNull();
  });

  it('🔴 読み取りが失敗しても null（throw しない）', async () => {
    const res = new Response('{"error":"not_enrolled"}', { status: 403 });
    await res.text(); // 本文を消費済みにする（2 度目の読み取りは reject する）
    await expect(readAuthorizeErrorCode(res)).resolves.toBeNull();
  });
});
