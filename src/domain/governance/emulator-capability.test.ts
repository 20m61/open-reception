import { describe, expect, it } from 'vitest';
import {
  CAPABILITY_VERDICTS,
  classifyCapability,
  matrixMark,
  type CapabilityVerdict,
  type NegativeOutcome,
  type PositiveOutcome,
} from './emulator-capability';

const POSITIVES: ReadonlyArray<PositiveOutcome> = ['passed', 'failed'];
const NEGATIVES: ReadonlyArray<NegativeOutcome> = ['rejected', 'accepted', 'unreachable'];

describe('エミュレータ能力の判定', () => {
  it('🔴 負の対照が通ってしまった能力は、正の対照が何であっても verified にならない', () => {
    // #1103 実測: MiniStack の Cognito は誤ったパスワードでもトークンを発行した。
    // 「positive が通った」だけを見る判定器は、これを ✅ と報告してしまう。
    for (const positive of POSITIVES) {
      expect(classifyCapability({ positive, negative: 'accepted' })).not.toBe('verified');
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

  it('正の対照が落ちた能力は、負の対照が何であっても unavailable', () => {
    for (const negative of NEGATIVES) {
      expect(classifyCapability({ positive: 'failed', negative })).toBe('unavailable');
    }
  });

  it('🔴 負の対照を走らせられなかった能力は permissive と区別して inconclusive にする', () => {
    // 「測れなかった」を「通った」にも「壊れていた」にも倒さない。
    expect(classifyCapability({ positive: 'passed', negative: 'unreachable' })).toBe('inconclusive');
  });

  it('負の対照が拒否された能力だけが permissive ではない', () => {
    expect(classifyCapability({ positive: 'passed', negative: 'accepted' })).toBe('permissive');
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
