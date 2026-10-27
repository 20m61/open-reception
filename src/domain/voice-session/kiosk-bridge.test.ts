import { describe, expect, it } from 'vitest';
import { bridgeCommittedTurn } from './kiosk-bridge';
import { resolveEntities } from '@/domain/voice-stt/entity-resolver';
import type { Staff } from '@/domain/staff/types';
import type { Department } from '@/domain/department/types';

function staff(id: string, displayName: string, kana: string): Staff {
  return {
    id,
    displayName,
    kana,
    aliases: [],
    departmentId: 'd1',
    enabled: true,
    available: true,
    callTargets: [],
    fallbackStaffIds: [],
  };
}

const departments: Department[] = [
  { id: 'd1', name: '総務部', kana: 'そうむぶ', displayOrder: 0, enabled: true },
];

const directory = {
  staff: [staff('s1', '佐藤', 'さとう'), staff('s2', '鈴木', 'すずき'), staff('s3', '佐野', 'さの')],
  departments,
};

describe('bridgeCommittedTurn (#364 発話確定 → #370 Entity 解決への橋渡し)', () => {
  it('高信頼・完全一致は復唱を挟まず自動採用（heardAccepted）し、対象を解決する', () => {
    const result = bridgeCommittedTurn({ text: 'さとう', directory, sttConfidence: 0.95, t: 10 });
    expect(result.event).toEqual({ type: 'heardAccepted' });
    expect(result.resolved?.id).toBe('s1');
  });

  it('STT confidence が低いと候補が明確でも復唱確認（low_stt_confidence）へ回す', () => {
    const result = bridgeCommittedTurn({ text: 'さとう', directory, sttConfidence: 0.3, t: 20 });
    expect(result.event).toMatchObject({
      type: 'heardNeedsConfirmation',
      displayName: '佐藤',
      reason: 'low_stt_confidence',
    });
    // 「はい」で確定できるよう、解決済み候補を持ち回す
    expect(result.resolved?.id).toBe('s1');
  });

  it('候補が全く無い（解決不能）ときは復唱せず聞き直し（listenStart）を返す', () => {
    const result = bridgeCommittedTurn({ text: 'まったく無関係な語', directory, sttConfidence: 0.9, t: 30 });
    expect(result.event).toEqual({ type: 'listenStart' });
    expect(result.resolved).toBeNull();
  });

  it('低 Entity 信頼（あいまい一致のみ）は復唱確認へ回す', () => {
    // 曖昧な部分一致だけがヒットする語で entityConfidence を下げる
    const result = bridgeCommittedTurn({ text: 'さ', directory, sttConfidence: 0.95, t: 40 });
    expect(result.event.type).toBe('heardNeedsConfirmation');
    expect(result.resolved).not.toBeNull();
  });

  it('復唱イベントに候補種別を持たせる（issue #361 申し送り: 部署復唱テンプレート分離）', () => {
    const staffResult = bridgeCommittedTurn({ text: 'さとう', directory, sttConfidence: 0.3, t: 45 });
    expect(staffResult.event).toMatchObject({ type: 'heardNeedsConfirmation', kind: 'staff' });

    const deptResult = bridgeCommittedTurn({ text: '総務', directory, sttConfidence: 0.3, t: 46 });
    expect(deptResult.event).toMatchObject({
      type: 'heardNeedsConfirmation',
      displayName: '総務部',
      kind: 'department',
    });
  });

  it('PII を返り値へ埋め込まない（resolved は組織辞書の担当者/部門のみ・displayName は表示名）', () => {
    const result = bridgeCommittedTurn({ text: 'さとう', directory, sttConfidence: 0.3, t: 50 });
    // 返り値は担当者辞書由来の値のみ（来訪者の自由入力は含まれない）
    const event = result.event;
    if (event.type === 'heardNeedsConfirmation') {
      const displayName = event.displayName;
      expect(directory.staff.some((s) => s.displayName === displayName)).toBe(true);
    }
  });
});

/**
 * 不在の担当者と同じ姓の在席者を、復唱なしで自動確定しない（#1284）。
 *
 * 在席の辞書だけで曖昧さを判定すると、不在の人が「近い候補」の比較相手から消え、
 * 在席の同姓の人が単独の高信頼候補として自動採用されていた（誤接続）。
 */
describe('bridgeCommittedTurn: 不在者と近い在席者を自動確定しない (#1284)', () => {
  const away = (id: string, displayName: string, kana: string): Staff => ({
    ...staff(id, displayName, kana),
    available: false,
  });
  const dir = (s: Staff[]) => ({ staff: s, departments: [] as Department[] });
  const T = { minSttConfidence: 0.6, minEntityConfidence: 0.5, minMarginOverSecond: 0.1 };

  it('同じ姓: 在席の田中花子と不在の田中太郎がいて「田中」なら、自動確定せず復唱確認へ回す', () => {
    const result = bridgeCommittedTurn({
      text: '田中',
      directory: dir([staff('h', '田中花子', 'たなかはなこ')]),
      unavailableDirectory: dir([away('t', '田中太郎', 'たなかたろう')]),
      sttConfidence: 0.95,
      thresholds: T,
      t: 0,
    });
    expect(result.event.type).toBe('heardNeedsConfirmation');
    expect(result.event).toMatchObject({ reason: 'ambiguous_candidates' });
  });

  it('不在の人の方がはっきり一致するなら、在席の別人を選ばない（「田中太郎」と、在席の田中太郎丸）', () => {
    const result = bridgeCommittedTurn({
      text: '田中太郎',
      directory: dir([staff('m', '田中太郎丸', 'たなかたろうまる')]),
      unavailableDirectory: dir([away('t', '田中太郎', 'たなかたろう')]),
      sttConfidence: 0.95,
      thresholds: T,
      t: 0,
    });
    expect(result.resolved).toBeNull();
    expect(result.event).toEqual({ type: 'heardUnavailable', displayName: '田中太郎' });
  });

  /*
   * 不変条件を総当たりで縛る。在席・不在に置く名前と発話の組み合わせを全部試す。
   * 主張は 2 つの向き:
   *  - 自動採用（heardAccepted）したなら、採用した人は、どの不在候補よりも margin 以上高い
   *  - 不在候補が在席のどの候補よりも高いなら、在席の人を選ばない（resolved は null）
   * 下界: 不在の辞書に一致が無いなら、不在の辞書を渡さないときと同じ結果になる
   *（＝この修正が自動採用そのものを止めて、空虚に満たしていないこと）。
   */
  const NAMES: Array<[string, string]> = [
    ['田中太郎', 'たなかたろう'],
    ['田中花子', 'たなかはなこ'],
    ['田中太郎丸', 'たなかたろうまる'],
    ['佐藤', 'さとう'],
    ['田中', 'たなか'],
  ];
  const QUERIES = ['田中', '田中太郎', '田中花子', '佐藤', 'たなか', '鈴木'];
  const score = (d: ReturnType<typeof dir>, q: string, id: string) =>
    resolveEntities(d, q).top3.find((c) => c.id === id)?.entityConfidence ?? 0;

  it('総当たり: 自動採用は不在候補より margin 以上高いときだけ、不在が上回れば在席を選ばない', () => {
    let accepted = 0;
    for (const [an, ak] of NAMES) {
      for (const [bn, bk] of NAMES) {
        if (an === bn) continue;
        for (const q of QUERIES) {
          const present = dir([staff('present', an, ak)]);
          const absent = dir([away('absent', bn, bk)]);
          const result = bridgeCommittedTurn({
            text: q,
            directory: present,
            unavailableDirectory: absent,
            sttConfidence: 0.95,
            thresholds: T,
            t: 0,
          });
          const p = score(present, q, 'present');
          const a = score(absent, q, 'absent');
          const label = `${q} / 在席 ${an} / 不在 ${bn}`;
          if (result.event.type === 'heardAccepted') {
            accepted += 1;
            expect(p - a, label).toBeGreaterThanOrEqual(T.minMarginOverSecond);
          }
          if (a > p) expect(result.resolved, label).toBeNull();
        }
      }
    }
    // 下界: 自動採用が一度も起きないなら、上の主張は空虚に満たされる。
    expect(accepted).toBeGreaterThan(0);
  });

  it('下界: 不在の辞書に一致が無ければ、渡さないときと結果が同じ（自動採用は続く）', () => {
    for (const [an, ak] of NAMES) {
      for (const q of QUERIES) {
        const present = dir([staff('present', an, ak)]);
        const absent = dir([away('absent', '鈴木', 'すずき')]);
        if (score(absent, q, 'absent') > 0) continue;
        const base = { text: q, directory: present, sttConfidence: 0.95, thresholds: T, t: 0 };
        expect(bridgeCommittedTurn({ ...base, unavailableDirectory: absent }), `${q} / ${an}`).toEqual(
          bridgeCommittedTurn(base),
        );
      }
    }
    expect(
      bridgeCommittedTurn({
        text: '田中花子',
        directory: dir([staff('h', '田中花子', 'たなかはなこ')]),
        unavailableDirectory: dir([away('s', '鈴木', 'すずき')]),
        sttConfidence: 0.95,
        thresholds: T,
        t: 0,
      }).event.type,
    ).toBe('heardAccepted');
  });
});
