import { describe, expect, it } from 'vitest';
import {
  CAPABILITY_VERDICTS,
  classifyCapability,
  matrixMark,
  negativeFromLoginResult,
  positiveFromLoginResult,
  positiveFromBooleanProbe,
  negativeFromBooleanProbe,
  resolveNegativeOutcome,
  shouldTryFallbackNegative,
  decideNegativeOutcome,
  exitCodeFor,
  type CapabilityVerdict,
  type NegativeOutcome,
  type PositiveOutcome,
} from './emulator-capability';

const POSITIVES: ReadonlyArray<PositiveOutcome> = ['passed', 'failed', 'unreachable'];
const NEGATIVES: ReadonlyArray<NegativeOutcome> = ['rejected', 'accepted', 'unreachable'];

describe('エミュレータ能力の判定', () => {
  it('🔴 負の対照が通ってしまったら、正の対照が何であっても permissive（素通りが支配する）', () => {
    // #1103 実測: MiniStack の Cognito は誤ったパスワードでもトークンを発行した。
    // 🔴 レビュー指摘 M3: 当初これを (failed, accepted) -> unavailable に丸めていた。
    // Moto は「本番と同じ呼び方では正の対照が落ちる」が「平文 username なら誤った PW も
    // 受理する」ので、丸めると**素通りするエミュレータが安全そうな ⛔ に化ける**。
    // 拒否すべきものを受理した事実は、正の対照が何であっても最も危険な信号である。
    for (const positive of POSITIVES) {
      expect(classifyCapability({ positive, negative: 'accepted' })).toBe('permissive');
    }
  });

  it('🔴 verified 以外は matrix 記号 ✅ にならない（上界）', () => {
    for (const verdict of CAPABILITY_VERDICTS) {
      if (verdict === 'verified') continue;
      expect(matrixMark(verdict)).not.toBe('✅');
    }
  });

  it('🔴 verified は到達可能で、✅ を返す（下界。全部を非 verified にして上界を空虚に満たさない）', () => {
    expect(classifyCapability({ positive: 'passed', negative: 'rejected' })).toBe('verified');
    expect(matrixMark('verified')).toBe('✅');
  });

  it('🔴 4 つの判定の記号は互いに相異なる（permissive を unavailable と同じ記号に潰さない）', () => {
    // 🔴 レビュー指摘 m1: 当初「✅ は verified だけ」「全部 truthy」しか主張しておらず、
    // `unavailable` を `permissive` と同じ記号にする変異が素通りしていた。
    // モジュール自身が「permissive は unavailable より危険なので分ける」と言っている
    // 当の不変条件なので、ここで縛る。
    const marks = CAPABILITY_VERDICTS.map(matrixMark);
    expect(new Set(marks).size).toBe(CAPABILITY_VERDICTS.length);
  });

  it('正の対照を走らせられなかったら、判定を下さない（inconclusive）', () => {
    for (const negative of NEGATIVES) {
      if (negative === 'accepted') continue; // 素通りが支配する（上記）
      expect(classifyCapability({ positive: 'unreachable', negative })).toBe('inconclusive');
    }
  });

  it('正の対照が落ちた能力は unavailable（負の対照が素通りでない限り）', () => {
    expect(classifyCapability({ positive: 'failed', negative: 'rejected' })).toBe('unavailable');
    expect(classifyCapability({ positive: 'failed', negative: 'unreachable' })).toBe('unavailable');
  });

  it('🔴 負の対照を走らせられなかった能力は permissive と区別して inconclusive にする', () => {
    expect(classifyCapability({ positive: 'passed', negative: 'unreachable' })).toBe('inconclusive');
  });

  it('判定はすべて CAPABILITY_VERDICTS に含まれる（記号表の網羅が保証される）', () => {
    for (const positive of POSITIVES) {
      for (const negative of NEGATIVES) {
        const verdict: CapabilityVerdict = classifyCapability({ positive, negative });
        expect(CAPABILITY_VERDICTS).toContain(verdict);
        expect(matrixMark(verdict)).toBeTruthy();
      }
    }
  });
});

describe('ログイン結果 → 負の対照の outcome', () => {
  it('🔴 「拒否された」と言えるのは資格情報が拒否されたときだけ', () => {
    expect(negativeFromLoginResult({ ok: false, reason: 'invalid_credentials' })).toBe('rejected');
  });

  it('🔴 障害（error）を「拒否された」と読まない ―― これは素通りを ✅ に化けさせる', () => {
    // 🔴 レビュー指摘 B1（BLOCKER）: 当初 `bad.ok ? 'accepted' : 'rejected'` と書いており、
    // ネットワーク障害・5xx・throttle・IdToken 欠落（すべて reason='error'）を
    // 「誤ったパスワードが拒否された」と読んでいた。負の対照の client を死んだポートへ
    // 向けるだけで、**誤った PW でトークンを出す MiniStack が ✅ verified / exit 0** になる。
    // 本モジュールが潰そうとしている欠陥（成功だけを見る判定）の裏返しである。
    expect(negativeFromLoginResult({ ok: false, reason: 'error' })).toBe('unreachable');
  });

  it('追加チャレンジは拒否の証拠にならない（判定不能）', () => {
    // MFA 要求や初回 PW 変更要求は「PW が誤っていたから止まった」ことを意味しない。
    expect(negativeFromLoginResult({ ok: false, reason: 'challenge_required' })).toBe('unreachable');
    expect(negativeFromLoginResult({ ok: false, reason: 'password_change_required' })).toBe(
      'unreachable',
    );
  });

  it('トークンが出たら accepted（素通り）', () => {
    expect(negativeFromLoginResult({ ok: true, idToken: 'x' })).toBe('accepted');
    // `ok` なら idToken の有無に関わらず素通り扱い。安全側（`ok && idToken` は緩い）。
    expect(negativeFromLoginResult({ ok: true })).toBe('accepted');
  });

  it('🔴 rejected を返すのは invalid_credentials だけ（他の理由を足しても安全側へ倒れる）', () => {
    const reasons = ['invalid_credentials', 'password_change_required', 'challenge_required', 'error'] as const;
    const rejected = reasons.filter(
      (reason) => negativeFromLoginResult({ ok: false, reason }) === 'rejected',
    );
    expect(rejected).toEqual(['invalid_credentials']);
  });
});

describe('probe の配線（測定結果 → outcome）', () => {
  it('🔴 正の対照: 障害（error）を「能力が無い」と読まない', () => {
    expect(positiveFromLoginResult({ ok: true, idToken: 'x' })).toBe('passed');
    expect(positiveFromLoginResult({ ok: false, reason: 'error' })).toBe('unreachable');
    expect(positiveFromLoginResult({ ok: false, reason: 'invalid_credentials' })).toBe('failed');
  });

  it('真偽の probe: 例外は unreachable（false と混ぜない）', () => {
    expect(positiveFromBooleanProbe(true)).toBe('passed');
    expect(positiveFromBooleanProbe(false)).toBe('failed');
    expect(positiveFromBooleanProbe('threw')).toBe('unreachable');
    expect(negativeFromBooleanProbe(true)).toBe('rejected');
    expect(negativeFromBooleanProbe(false)).toBe('accepted');
    expect(negativeFromBooleanProbe('threw')).toBe('unreachable');
  });

  it('🔴 正の対照が通っていないとき、production 由来の rejected を信用しない', () => {
    // レビュー round2 MAJOR-3: `cognito-srp.ts` は **UserNotFoundException も**
    // `invalid_credentials` に畳む。Moto は正しい PW でも誤った PW でも
    // UserNotFound を返すので、「誤った PW が拒否された」と読むと嘘になる。
    // 正の対照が通っていない＝そこまで到達できていないので、拒否の証拠にならない。
    expect(
      resolveNegativeOutcome({ positive: 'failed', production: 'rejected', fallback: 'unreachable' }),
    ).toBe('unreachable');
  });

  it('🔴 正の対照が通っていなくても、別の呼び方で受理されたら素通り', () => {
    expect(
      resolveNegativeOutcome({ positive: 'failed', production: 'rejected', fallback: 'accepted' }),
    ).toBe('accepted');
  });

  it('🔴 fallback は accepted のときだけ上書きする（実測した rejected を捨てない）', () => {
    // レビュー round2 MINOR-4。
    expect(
      resolveNegativeOutcome({ positive: 'passed', production: 'rejected', fallback: 'unreachable' }),
    ).toBe('rejected');
    expect(
      resolveNegativeOutcome({ positive: 'passed', production: 'accepted', fallback: 'unreachable' }),
    ).toBe('accepted');
  });

  it('🔴 exit code: 素通り=1 / 判定不能=3 / それ以外=0（測れなかったで 0 を返さない）', () => {
    expect(exitCodeFor(['verified', 'verified'])).toBe(0);
    expect(exitCodeFor(['verified', 'unavailable'])).toBe(0);
    expect(exitCodeFor(['verified', 'inconclusive'])).toBe(3);
    expect(exitCodeFor(['permissive', 'inconclusive'])).toBe(1);
    expect(exitCodeFor(['inconclusive', 'permissive'])).toBe(1);
  });
});

describe('代替の呼び方を試す条件', () => {
  it('🔴 本番の呼び方で正の対照が落ちたら試す（M3 の再発を止める要）', () => {
    // レビュー round2: この条件は script 側に手書きされており、反転させても
    // 全テストが緑のままだった（Moto が ⛔ へ化ける M3 の再発形）。
    for (const positive of ['failed', 'unreachable'] as const) {
      expect(shouldTryFallbackNegative({ positive, production: 'rejected' })).toBe(true);
      expect(shouldTryFallbackNegative({ positive, production: 'unreachable' })).toBe(true);
    }
  });

  it('正の対照が通っているなら、本番の呼び方の測定をそのまま使う', () => {
    expect(shouldTryFallbackNegative({ positive: 'passed', production: 'rejected' })).toBe(false);
  });

  it('既に素通りが分かっているならやり直さない', () => {
    for (const positive of ['passed', 'failed', 'unreachable'] as const) {
      expect(shouldTryFallbackNegative({ positive, production: 'accepted' })).toBe(false);
    }
  });
});

describe('負の対照の決定（fallback の起動判断ごと）', () => {
  it('🔴 正の対照が落ちたら fallback を実際に呼ぶ', async () => {
    let called = 0;
    const out = await decideNegativeOutcome({
      positive: 'failed',
      production: 'rejected',
      tryFallback: async () => {
        called += 1;
        return 'accepted';
      },
    });
    expect(called).toBe(1);
    expect(out).toBe('accepted');
  });

  it('正の対照が通っていれば fallback を呼ばず、実測した値を返す', async () => {
    let called = 0;
    const out = await decideNegativeOutcome({
      positive: 'passed',
      production: 'rejected',
      tryFallback: async () => {
        called += 1;
        return 'accepted';
      },
    });
    expect(called).toBe(0);
    expect(out).toBe('rejected');
  });

  it('🔴 fallback が素通りを見つけられなくても、信用できない rejected を残さない', async () => {
    const out = await decideNegativeOutcome({
      positive: 'failed',
      production: 'rejected',
      tryFallback: async () => 'unreachable',
    });
    expect(out).toBe('unreachable');
  });
});
