/**
 * 体験設計と実装の対応表の機械検証 (issue #422)。
 *
 * 対応表を文書だけに置くと必ず腐るので、**乖離をテストで落とす**:
 *   - 実装の状態が増えたら対応を書かずには通らない（`Record` の網羅は型が担保、実体はここ）
 *   - 未実装の体験状態を実装したら、未実装リストから外さないと落ちる
 *   - Journey のステップが未定義の状態を指していたら落ちる
 */
import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { RECEPTION_STATES } from '@/domain/reception/state';
import { KIOSK_MODES } from '@/domain/kiosk/mode';
import { CHECKIN_STATES } from '@/domain/checkin/state';
import { PRESENCE_STATES } from '@/domain/presence/state';
import { VOICE_KIOSK_MODES, VOICE_LISTENING_STAGES } from '@/domain/voice-session/kiosk-view';
import {
  CHECKIN_STATE_TO_EXPERIENCE,
  EXPERIENCE_EXCEPTION_STATES,
  EXPERIENCE_STATES,
  JOURNEYS,
  KIOSK_MODE_TO_EXPERIENCE,
  NOT_A_TIMELINE_VOCABULARY,
  PRESENCE_STATE_TO_EXPERIENCE,
  RECEPTION_STATE_TO_EXPERIENCE,
  SOURCE_VOCABULARIES,
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

/** `src/domain/**` から状態語彙らしき const 配列の名前を全部拾う。 */
function declaredVocabularies(dir: string, found: string[] = []): string[] {
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const path = join(dir, entry.name);
    if (entry.isDirectory()) {
      declaredVocabularies(path, found);
      continue;
    }
    if (!entry.name.endsWith('.ts') || entry.name.endsWith('.test.ts')) continue;
    const pattern = /export const ([A-Z][A-Z0-9_]*(?:STATES|MODES|STAGES|PHASES|STATUSES)) = \[/g;
    for (const match of readFileSync(path, 'utf8').matchAll(pattern)) {
      const [, name] = match;
      if (name) found.push(name);
    }
  }
  return found;
}

/**
 * **第 34 wave の誤りを構造的に止めるテスト**（第 37 wave）。
 *
 * 網羅テスト（下）が守れるのは**対応表に載せた語彙の内側**だけで、第 34 wave の誤りは
 * 「そもそも表に載せなかった語彙」で起きた。だから語彙の**存在**を検出する層をここに置く:
 * `src/domain/**` に状態語彙が生まれたら、採録するか「タイムライン語彙ではない」と
 * 理由付きで除外するかを**書かないと落ちる**。
 */
describe('状態語彙の取りこぼしを検出する', () => {
  it('domain の全状態語彙が、採録済みか除外理由付きで登録されている', () => {
    const declared = declaredVocabularies('src/domain').sort();
    const accounted = [
      ...SOURCE_VOCABULARIES,
      ...Object.keys(NOT_A_TIMELINE_VOCABULARY),
      // 体験設計側の語彙（写す先であって、写す元ではない）。
      'EXPERIENCE_STATES',
      'EXPERIENCE_EXCEPTION_STATES',
    ].sort();
    expect(declared).toEqual(accounted);
  });

  it('除外理由が空文字で誤魔化されていない', () => {
    for (const [name, reason] of Object.entries(NOT_A_TIMELINE_VOCABULARY)) {
      expect(reason.length, `${name} の除外理由`).toBeGreaterThan(10);
    }
  });
});

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
    expect(Object.keys(VOICE_LISTENING_STAGE_TO_EXPERIENCE).sort()).toEqual(
      [...VOICE_LISTENING_STAGES].sort(),
    );
  });

  it('全 CheckinState に対応が書かれている（QR 受付は独立した状態機械）', () => {
    expect(Object.keys(CHECKIN_STATE_TO_EXPERIENCE).sort()).toEqual([...CHECKIN_STATES].sort());
  });

  it('対応先はすべて体験設計に定義された状態', () => {
    const known = new Set<string>(ALL_EXPERIENCE_STATES);
    for (const table of [
      RECEPTION_STATE_TO_EXPERIENCE,
      VOICE_MODE_TO_EXPERIENCE,
      VOICE_LISTENING_STAGE_TO_EXPERIENCE,
      KIOSK_MODE_TO_EXPERIENCE,
      PRESENCE_STATE_TO_EXPERIENCE,
      CHECKIN_STATE_TO_EXPERIENCE,
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

  it('来訪検知・認識中・受付方法の選択は実装済み（第 34 wave の分析誤りの再発防止）', () => {
    // 第 34 wave は 3 つとも「状態語彙に無い」としたが、いずれも実在した。
    // **どの表の何に在るか**まで固定する（union で見ると別表へ書き換えても通ってしまう）。
    expect(PRESENCE_STATE_TO_EXPERIENCE.ATTRACT).toBe('visitor_detected');
    expect(VOICE_LISTENING_STAGE_TO_EXPERIENCE.speech).toBe('recognizing');
    expect(CHECKIN_STATE_TO_EXPERIENCE.selectingMethod).toBe('choosing_method');
  });

  it('主要な受付導線（正常系の骨格）は実装済みであること', () => {
    // ここが未実装に落ちたら受付が成立しない。回帰の番人として明示的に固定する。
    // union ではなく**受付状態機械の表**を直接見る（他系統が同じ体験状態を供給するため、
    // union で見ると受付側の対応を壊しても気づけない）。
    expect(RECEPTION_STATE_TO_EXPERIENCE.idle).toBe('idle');
    expect(RECEPTION_STATE_TO_EXPERIENCE.confirming).toBe('confirming');
    expect(RECEPTION_STATE_TO_EXPERIENCE.calling).toBe('contacting');
    expect(RECEPTION_STATE_TO_EXPERIENCE.connected).toBe('connected');
    expect(RECEPTION_STATE_TO_EXPERIENCE.completed).toBe('completed');
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
