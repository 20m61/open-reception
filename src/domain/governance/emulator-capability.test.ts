import { describe, expect, it } from 'vitest';
import {
  CAPABILITY_VERDICTS,
  classifyCapability,
  matrixMark,
  negativeFromLoginResult,
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
  });

  it('🔴 rejected を返すのは invalid_credentials だけ（他の理由を足しても安全側へ倒れる）', () => {
    const reasons = ['invalid_credentials', 'password_change_required', 'challenge_required', 'error'] as const;
    const rejected = reasons.filter(
      (reason) => negativeFromLoginResult({ ok: false, reason }) === 'rejected',
    );
    expect(rejected).toEqual(['invalid_credentials']);
  });
});
