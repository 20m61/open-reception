/**
 * 体験設計と実装の対応表の機械検証 (issue #422)。
 *
 * 対応表を文書だけに置くと必ず腐るので、**乖離をテストで落とす**:
 *   - 実装の状態が増えたら対応を書かずには通らない（`Record` の網羅は型が担保、実体はここ）
 *   - 未実装の体験状態を実装したら、未実装リストから外さないと落ちる
 *   - Journey のステップが未定義の状態を指していたら落ちる
 */
import { describe, expect, it } from 'vitest';
import { RECEPTION_STATES } from '@/domain/reception/state';
import { KIOSK_MODES } from '@/domain/kiosk/mode';
import { PRESENCE_STATES } from '@/domain/presence/state';
import { VOICE_KIOSK_MODES } from '@/domain/voice-session/kiosk-view';
import {
  EXPERIENCE_EXCEPTION_STATES,
  EXPERIENCE_STATES,
  JOURNEYS,
  KIOSK_MODE_TO_EXPERIENCE,
  PRESENCE_STATE_TO_EXPERIENCE,
  RECEPTION_STATE_TO_EXPERIENCE,
  VOICE_LISTENING_STAGE_TO_EXPERIENCE,
  UNIMPLEMENTED_EXPERIENCE_STATES,
  VOICE_MODE_TO_EXPERIENCE,
  mappedExperienceStates,
  type AnyExperienceState,
} from './journey-map';

const ALL_EXPERIENCE_STATES: readonly AnyExperienceState[] = [
  ...EXPERIENCE_STATES,
  ...EXPERIENCE_EXCEPTION_STATES,
];

describe('実装の状態語彙をすべて対応づけている', () => {
  it('全 ReceptionState に対応が書かれている', () => {
    for (const state of RECEPTION_STATES) {
      expect(Object.hasOwn(RECEPTION_STATE_TO_EXPERIENCE, state)).toBe(true);
    }
    // 余計なキーが残っていない（状態を消したのに対応表が残る、を防ぐ）。
    expect(Object.keys(RECEPTION_STATE_TO_EXPERIENCE).sort()).toEqual([...RECEPTION_STATES].sort());
  });

  it('全 VoiceKioskMode に対応が書かれている', () => {
    expect(Object.keys(VOICE_MODE_TO_EXPERIENCE).sort()).toEqual([...VOICE_KIOSK_MODES].sort());
  });

  it('全 KioskMode に対応が書かれている', () => {
    expect(Object.keys(KIOSK_MODE_TO_EXPERIENCE).sort()).toEqual([...KIOSK_MODES].sort());
  });

  it('全 PresenceState に対応が書かれている（来訪検知は独立した状態機械）', () => {
    expect(Object.keys(PRESENCE_STATE_TO_EXPERIENCE).sort()).toEqual([...PRESENCE_STATES].sort());
  });

  it('聞き取り段階の 2 値に対応が書かれている', () => {
    expect(Object.keys(VOICE_LISTENING_STAGE_TO_EXPERIENCE).sort()).toEqual(['idle', 'speech']);
  });

  it('対応先はすべて体験設計に定義された状態', () => {
    const known = new Set<string>(ALL_EXPERIENCE_STATES);
    for (const table of [
      RECEPTION_STATE_TO_EXPERIENCE,
      VOICE_MODE_TO_EXPERIENCE,
      VOICE_LISTENING_STAGE_TO_EXPERIENCE,
      KIOSK_MODE_TO_EXPERIENCE,
      PRESENCE_STATE_TO_EXPERIENCE,
    ]) {
      for (const value of Object.values(table)) {
        if (value !== null) expect(known.has(value)).toBe(true);
      }
    }
  });
});

describe('未実装の体験状態', () => {
  it('未実装リストと実際の未対応集合が一致する（実装したら外し忘れで落ちる）', () => {
    const mapped = mappedExperienceStates();
    const actuallyUnmapped = ALL_EXPERIENCE_STATES.filter((s) => !mapped.has(s)).sort();
    expect(actuallyUnmapped).toEqual([...UNIMPLEMENTED_EXPERIENCE_STATES].sort());
  });

  it('未実装リストに載るのは体験設計に定義された状態だけ', () => {
    const known = new Set<string>(ALL_EXPERIENCE_STATES);
    for (const state of UNIMPLEMENTED_EXPERIENCE_STATES) {
      expect(known.has(state)).toBe(true);
    }
  });

  it('来訪検知・認識中は実装済み（第 34 wave の分析誤りの再発防止）', () => {
    // 第 34 wave は「状態語彙に無い」としたが、PresenceState と voiceListeningStage に在った。
    const mapped = mappedExperienceStates();
    expect(mapped.has('visitor_detected')).toBe(true);
    expect(mapped.has('recognizing')).toBe(true);
  });

  it('主要な受付導線（正常系の骨格）は実装済みであること', () => {
    // ここが未実装に落ちたら受付が成立しない。回帰の番人として明示的に固定する。
    const mapped = mappedExperienceStates();
    for (const state of ['idle', 'confirming', 'contacting', 'connected', 'completed'] as const) {
      expect(mapped.has(state)).toBe(true);
    }
  });
});

describe('Journey 定義', () => {
  it('5 つの Journey がすべて定義されている', () => {
    expect(JOURNEYS.map((j) => j.id)).toEqual([
      'J-OR-01',
      'J-OR-02',
      'J-OR-03',
      'J-OR-04',
      'J-OR-05',
    ]);
  });

  it('各 Journey のステップは体験設計に定義された状態のみを指す', () => {
    const known = new Set<string>(ALL_EXPERIENCE_STATES);
    for (const journey of JOURNEYS) {
      expect(journey.steps.length).toBeGreaterThan(0);
      for (const step of journey.steps) {
        expect(known.has(step)).toBe(true);
      }
    }
  });

  it('実装済みと宣言した Journey のステップに未実装状態が混ざっていない', () => {
    const unimplemented = new Set<string>(UNIMPLEMENTED_EXPERIENCE_STATES);
    for (const journey of JOURNEYS.filter((j) => j.implementation === 'implemented')) {
      for (const step of journey.steps) {
        expect(unimplemented.has(step)).toBe(false);
      }
    }
  });
});
