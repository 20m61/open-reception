import { describe, expect, it } from 'vitest';
import {
  CAPABILITY_VERDICTS,
  classifyCapability,
  matrixMark,
  negativeFromLoginResult,
  positiveFromLoginResult,
  positiveFromBooleanProbe,
  negativeFromBooleanProbe,
  combineNegativeOutcomes,
  measureBooleanCapability,
  measureSrpCapability,
  summarizeMeasurements,
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




  it('🔴 exit code: 素通り=1 / 判定不能=3 / それ以外=0（測れなかったで 0 を返さない）', () => {
    expect(exitCodeFor(['verified', 'verified'])).toBe(0);
    expect(exitCodeFor(['verified', 'unavailable'])).toBe(0);
    expect(exitCodeFor(['verified', 'inconclusive'])).toBe(3);
    expect(exitCodeFor(['permissive', 'inconclusive'])).toBe(1);
    expect(exitCodeFor(['inconclusive', 'permissive'])).toBe(1);
  });
});


describe('2 つの呼び方の負の対照をまとめる', () => {
  it('🔴 どちらかが受理したら素通り（呼び方 1 つで崩れる保証を ✅ にしない）', () => {
    for (const positive of ['passed', 'failed', 'unreachable'] as const) {
      expect(combineNegativeOutcomes({ positive, production: 'accepted', alternate: 'rejected' })).toBe('accepted');
      expect(combineNegativeOutcomes({ positive, production: 'rejected', alternate: 'accepted' })).toBe('accepted');
    }
  });

  it('🔴 正の対照が通っていないときの rejected は信用しない', () => {
    expect(
      combineNegativeOutcomes({ positive: 'failed', production: 'rejected', alternate: 'unreachable' }),
    ).toBe('unreachable');
  });

  it('正の対照が通っていれば、本番の呼び方の測定を使う', () => {
    expect(
      combineNegativeOutcomes({ positive: 'passed', production: 'rejected', alternate: 'unreachable' }),
    ).toBe('rejected');
  });
});

describe('SRP 能力の測定（合成そのもの）', () => {
  const effects = (good: unknown, bad: unknown, alternate: unknown) => ({
    loginWithCorrectPassword: async () => good as never,
    loginWithWrongPassword: async () => bad as never,
    loginWithWrongPasswordAlternateShape: async () => alternate as never,
  });

  it('🔴 素通りするエミュレータは permissive（✅ にならない）', async () => {
    const r = await measureSrpCapability(
      effects({ ok: true, idToken: 'x' }, { ok: true, idToken: 'x' }, 'unreachable'),
    );
    expect(r).toEqual({ positive: 'passed', negative: 'accepted', verdict: 'permissive' });
  });

  it('🔴 本番の呼び方では拒否されるが別の呼び方で通るなら permissive', async () => {
    const r = await measureSrpCapability(
      effects({ ok: false, reason: 'invalid_credentials' }, { ok: false, reason: 'invalid_credentials' }, 'accepted'),
    );
    expect(r.verdict).toBe('permissive');
  });

  it('正しく検証するエミュレータだけが verified', async () => {
    const r = await measureSrpCapability(
      effects({ ok: true, idToken: 'x' }, { ok: false, reason: 'invalid_credentials' }, 'unreachable'),
    );
    expect(r).toEqual({ positive: 'passed', negative: 'rejected', verdict: 'verified' });
  });

  it('🔴 負の対照に正しいパスワードを使う配線は verified を作れない', async () => {
    // round3 W3: 負の対照が「正しい PW」で呼ばれると必ず成功 = accepted になり、
    // permissive へ倒れる（✅ にはならない）。
    const r = await measureSrpCapability(
      effects({ ok: true, idToken: 'x' }, { ok: true, idToken: 'x' }, 'unreachable'),
    );
    expect(r.verdict).not.toBe('verified');
  });
});

describe('測定結果の要約', () => {
  it('🔴 1 件も測れていないのを成功にしない（round3 W2）', () => {
    expect(summarizeMeasurements([]).code).toBe(3);
  });

  it('素通りがあれば 1、判定不能があれば 3', () => {
    expect(summarizeMeasurements(['permissive', 'verified']).code).toBe(1);
    expect(summarizeMeasurements(['inconclusive', 'verified']).code).toBe(3);
    expect(summarizeMeasurements(['verified', 'unavailable']).code).toBe(0);
  });
});

describe('真偽で測る能力の測定（合成そのもの）', () => {
  const eff = (p: unknown, n: unknown) => ({
    runPositive: async () => p as never,
    runNegative: async () => n as never,
  });

  it('🔴 負の対照が拒否しなければ permissive（✅ にならない）', async () => {
    expect((await measureBooleanCapability(eff(true, false))).verdict).toBe('permissive');
  });

  it('拒否されたときだけ verified', async () => {
    expect((await measureBooleanCapability(eff(true, true))).verdict).toBe('verified');
  });

  it('例外は判定不能（false と混ぜない）', async () => {
    expect((await measureBooleanCapability(eff(true, 'threw'))).verdict).toBe('inconclusive');
    expect((await measureBooleanCapability(eff('threw', true))).verdict).toBe('inconclusive');
  });
});
