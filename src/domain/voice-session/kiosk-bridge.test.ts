import { describe, expect, it } from 'vitest';
import { bridgeCommittedTurn, sharesSurname } from './kiosk-bridge';
import { resolveEntities } from '@/domain/voice-stt/entity-resolver';
import type { Staff } from '@/domain/staff/types';
import type { Department } from '@/domain/department/types';

function staff(id: string, displayName: string, kana?: string): Staff {
  return {
    id,
    displayName,
    ...(kana === undefined ? {} : { kana }),
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
    // 「佐藤」と「佐野」は、表示名にも読みにも区切りが無いので同じ姓とみなす（owner の判断）。別の姓の鈴木で見る。
    const result = bridgeCommittedTurn({ text: 'すずき', directory, sttConfidence: 0.95, t: 10 });
    expect(result.event).toEqual({ type: 'heardAccepted' });
    expect(result.resolved?.id).toBe('s2');
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
  const away = (id: string, displayName: string, kana?: string): Staff => ({
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
    expect(result.event).toMatchObject({ reason: 'ambiguous_candidates', displayName: '田中花子' });
    // 同点は不在へ倒さない: 在席者を呼びたい来訪者に「不在です」と言わず、在席者を復唱する。
    expect(result.event).not.toHaveProperty('unavailable');
    expect(result.resolved).toMatchObject({ id: 'h' });
  });

  it('不在の断定にも在席の候補を比較相手に入れる（近ければ「不在です」と断定せず復唱する）', () => {
    // 完全一致（1.0）と前方一致（0.8）の差 0.2 が、この margin（0.3）より小さい。
    const result = bridgeCommittedTurn({
      text: '田中太郎',
      directory: dir([staff('m', '田中太郎丸', 'たなかたろうまる')]),
      unavailableDirectory: dir([away('t', '田中太郎', 'たなかたろう')]),
      sttConfidence: 0.95,
      thresholds: { ...T, minMarginOverSecond: 0.3 },
      t: 0,
    });
    expect(result.resolved).toBeNull();
    expect(result.event).toMatchObject({
      type: 'heardNeedsConfirmation',
      displayName: '田中太郎',
      reason: 'ambiguous_candidates',
      unavailable: true,
    });
  });

  it('不在の人の方がはっきり一致するなら、在席の別人を選ばない（同じ姓なので「不在です」と断定もしない）', () => {
    const result = bridgeCommittedTurn({
      text: '田中太郎',
      directory: dir([staff('m', '田中太郎丸', 'たなかたろうまる')]),
      unavailableDirectory: dir([away('t', '田中太郎', 'たなかたろう')]),
      sttConfidence: 0.95,
      thresholds: T,
      t: 0,
    });
    expect(result.resolved).toBeNull();
    // 田中太郎丸と同じ姓なので、不在の告知も断定せず復唱する（owner の判断、2026-10-28）。
    expect(result.event).toMatchObject({
      type: 'heardNeedsConfirmation',
      displayName: '田中太郎',
      unavailable: true,
    });
  });

  it('同じ姓の別人がいなければ、不在の人ははっきり告知する（#803 を保つ）', () => {
    const result = bridgeCommittedTurn({
      text: '田中太郎',
      directory: dir([staff('s', '佐藤', 'さとう')]),
      unavailableDirectory: dir([away('t', '田中太郎', 'たなかたろう')]),
      sttConfidence: 0.95,
      thresholds: T,
      t: 0,
    });
    expect(result).toEqual({ event: { type: 'heardUnavailable', displayName: '田中太郎' }, resolved: null });
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

  it('在席が 2 人以上でも、不在の辞書（空を含む）を渡したことで在席どうしの曖昧さを失わない', () => {
    // 本番の KioskFlow は、不在が 0 人でも空の不在辞書を必ず渡す。その構成でだけ曖昧さの判定が
    // 縮む（在席の top1 だけになる等）と、在席の同姓 2 人のうち 1 人が復唱なしで確定する。
    NAMES.forEach(([n1, k1], i) => {
      NAMES.slice(i + 1).forEach(([n2, k2]) => {
        const present = dir([staff('p1', n1, k1), staff('p2', n2, k2)]);
        for (const q of QUERIES) {
          const base = { text: q, directory: present, sttConfidence: 0.95, thresholds: T, t: 0 };
          expect(
            bridgeCommittedTurn({ ...base, unavailableDirectory: dir([]) }),
            `${q} / 在席 ${n1}・${n2}`,
          ).toEqual(bridgeCommittedTurn(base));
        }
      });
    });
    const result = bridgeCommittedTurn({
      text: '田中',
      directory: dir([staff('h', '田中花子', 'たなかはなこ'), staff('j', '田中次郎', 'たなかじろう')]),
      unavailableDirectory: dir([away('t', '田中太郎', 'たなかたろう')]),
      sttConfidence: 0.95,
      thresholds: T,
      t: 0,
    });
    expect(result.event).toMatchObject({ type: 'heardNeedsConfirmation', reason: 'ambiguous_candidates' });
    expect(result.event).not.toHaveProperty('unavailable');
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

/**
 * 同じ姓の人が 2 人以上いるときは、完全一致の人が 1 人だけでも自動で確定しない
 * （owner の判断、2026-10-28 / #1284）。表示名が姓だけの人がいる場合も同じ。
 */
describe('bridgeCommittedTurn: 同じ姓の別人がいれば必ず復唱する (#1284)', () => {
  const away = (id: string, displayName: string, kana?: string): Staff => ({
    ...staff(id, displayName, kana),
    available: false,
  });
  const dir = (s: Staff[]) => ({ staff: s, departments: [] as Department[] });
  const T = { minSttConfidence: 0.6, minEntityConfidence: 0.5, minMarginOverSecond: 0.1 };
  const turn = (text: string, present: Staff[], absent: Staff[] = []) =>
    bridgeCommittedTurn({
      text,
      directory: dir(present),
      unavailableDirectory: dir(absent),
      sttConfidence: 0.95,
      thresholds: T,
      t: 0,
    });

  it('完全一致でも、同じ姓の在席者が他にいれば自動確定しない', () => {
    const result = turn('田中花子', [staff('h', '田中花子', 'たなかはなこ'), staff('t', '田中太郎', 'たなかたろう')]);
    expect(result.event).toMatchObject({ type: 'heardNeedsConfirmation', displayName: '田中花子' });
    expect(result.resolved).toMatchObject({ id: 'h' });
  });

  it('完全一致でも、同じ姓の不在者がいれば自動確定しない', () => {
    const result = turn('田中花子', [staff('h', '田中花子', 'たなかはなこ')], [away('t', '田中太郎', 'たなかたろう')]);
    expect(result.event.type).toBe('heardNeedsConfirmation');
  });

  it('表示名が姓だけの人がいる場合も同じ（「田中」と「田中 花子」）', () => {
    const exactSurnameOnly = turn('田中', [staff('a', '田中', 'たなか'), staff('h', '田中 花子', 'たなか はなこ')]);
    expect(exactSurnameOnly.event.type).toBe('heardNeedsConfirmation');
    const fullName = turn('田中 花子', [staff('a', '田中', 'たなか'), staff('h', '田中 花子', 'たなか はなこ')]);
    expect(fullName.event.type).toBe('heardNeedsConfirmation');
  });

  it('部署は姓を持たないので、名前の先頭が担当者と重なっても部署の自動確定は止めない', () => {
    const result = bridgeCommittedTurn({
      text: '総務部',
      directory: { staff: [staff('s', '総務 太郎', 'そうむ たろう')], departments },
      unavailableDirectory: dir([]),
      sttConfidence: 0.95,
      thresholds: T,
      t: 0,
    });
    expect(result.event.type).toBe('heardAccepted');
    expect(result.resolved).toMatchObject({ kind: 'department', id: 'd1' });
  });

  it('下界: 同じ姓の別人がいなければ、完全一致は従来どおり自動確定する', () => {
    const result = turn('田中花子', [staff('h', '田中花子', 'たなかはなこ'), staff('s', '佐藤', 'さとう')], [
      away('z', '鈴木', 'すずき'),
    ]);
    expect(result).toEqual({
      event: { type: 'heardAccepted' },
      resolved: expect.objectContaining({ id: 'h' }),
    });
  });

  /*
   * 不変条件は、実装の述語（sharesSurname）ではなく**テスト側で持つ姓の正解表**で判定する。
   * 実装の述語で判定すると、述語の見落とし（1 文字の姓など）がそのまま素通りする。
   */
  const PEOPLE: Array<{ name: string; kana?: string; surname: string }> = [
    { name: '田中太郎', kana: 'たなかたろう', surname: '田中' },
    { name: '田中 花子', kana: 'たなか はなこ', surname: '田中' },
    { name: '田中', kana: 'たなか', surname: '田中' },
    { name: '田中島 一郎', kana: 'たなかじま いちろう', surname: '田中島' },
    { name: '林太郎', kana: 'はやしたろう', surname: '林' },
    { name: '林 花子', kana: 'はやし はなこ', surname: '林' },
    { name: '森', kana: 'もり', surname: '森' },
    { name: '森花子', kana: 'もりはなこ', surname: '森' },
    { name: '東 太郎', kana: 'ひがし たろう', surname: '東' },
    { name: '東山 花子', kana: 'ひがしやま はなこ', surname: '東山' },
    { name: 'タナカ ジロウ', kana: 'たなか じろう', surname: '田中' },
    { name: '佐藤', kana: 'さとう', surname: '佐藤' },
    { name: '佐野', kana: 'さの', surname: '佐野' },
    { name: '鈴木 一郎', kana: 'すずき いちろう', surname: '鈴木' },
    // 読みは任意（管理画面）。読みの無い担当者でも、同じ姓を見落とさない。
    { name: '林花子', surname: '林' },
    { name: '森太郎', surname: '森' },
    { name: 'タナカ', surname: '田中' },
    // 文字の系統が違う組（漢字の「鈴木」とラテン文字の「Suzuki」）は拾えない型（`docs/adr/0011` 3-f）なので、
    // この表でも別の姓として扱う。ラテン文字どうしは同じ姓として拾う。
    { name: 'Taro Suzuki', surname: 'Suzuki' },
    { name: 'Hanako Suzuki', surname: 'Suzuki' },
    { name: '佐々木', surname: '佐々木' },
    { name: '井太郎', kana: 'いたろう', surname: '井' },
    { name: '井花子', kana: 'いはなこ', surname: '井' },
    { name: '東花子', kana: 'あずまはなこ', surname: '東' },
    { name: '渡辺 一郎', surname: '渡辺' },
    { name: '渡邊 花子', surname: '渡辺' },
    { name: '髙橋 次郎', surname: '高橋' },
    { name: '高橋 花子', kana: 'たかはし はなこ', surname: '高橋' },
    { name: 'Smith', surname: 'Smith' },
    { name: 'John Smith', surname: 'Smith' },
  ];

  it('不変条件: 自動確定・不在の断定をした相手には、どちらの辞書にも同じ姓の別人がいない（姓の正解表で判定）', () => {
    const QUERIES = [...PEOPLE.map((p) => p.name), '田中', 'たなか', '林', 'はやし', '森', '東'];
    let decided = 0;
    PEOPLE.forEach((p, i) => {
      PEOPLE.forEach((a, j) => {
        if (i === j) return;
        for (const q of QUERIES) {
          const result = turn(q, [staff('p', p.name, p.kana)], [away('a', a.name, a.kana)]);
          const label = `${q} / 在席 ${p.name} / 不在 ${a.name}`;
          if (result.event.type === 'heardAccepted' || result.event.type === 'heardUnavailable') {
            decided += 1;
            expect(p.surname === a.surname, label).toBe(false);
          }
        }
      });
    });
    // 下界: 自動の判断が一度も起きないなら、上の主張は空虚に満たされる。
    expect(decided).toBeGreaterThan(0);
  });

  it('1 文字の姓: 林太郎と林花子、森（姓だけ）と森花子でも自動で確定・断定しない', () => {
    expect(
      turn('林太郎', [staff('t', '林太郎', 'はやしたろう')], [away('h', '林花子', 'はやしはなこ')]).event.type,
    ).toBe('heardNeedsConfirmation');
    expect(
      turn('林 太郎', [staff('t', '林 太郎', 'はやし たろう')], [away('h', '林花子', 'はやしはなこ')]).event.type,
    ).toBe('heardNeedsConfirmation');
    const mori = turn('森', [staff('h', '森花子', 'もりはなこ')], [away('m', '森', 'もり')]);
    expect(mori.event).toMatchObject({ type: 'heardNeedsConfirmation', unavailable: true });
  });

  it('読みの無い 1 文字の姓: 林太郎と林花子（読みなし）でも自動で確定・断定しない', () => {
    expect(turn('林太郎', [staff('t', '林太郎')], [away('h', '林花子')]).event.type).toBe('heardNeedsConfirmation');
    expect(turn('林太郎', [staff('t', '林太郎')], [away('h', '林花子', 'はやしはなこ')]).event.type).toBe(
      'heardNeedsConfirmation',
    );
    expect(turn('林花子', [staff('t', '林太郎', 'はやしたろう')], [away('h', '林花子')]).event).toMatchObject({
      type: 'heardNeedsConfirmation',
      unavailable: true,
    });
  });

  it('表記の違う同じ姓（タナカ と 田中 花子）は、読みの無い側の表示名を読みとして比べる', () => {
    const result = turn('田中花子', [staff('h', '田中 花子', 'たなか はなこ')], [away('t', 'タナカ')]);
    expect(result.event.type).toBe('heardNeedsConfirmation');
  });

  it('姓の違う 2 人の別名が同点なら、不在の側も比較に入れて曖昧として復唱する（#1284 の合算）', () => {
    const withAlias = (s: Staff): Staff => ({ ...s, aliases: ['部長'] });
    const result = turn('部長', [withAlias(staff('s', '鈴木 一郎', 'すずき いちろう'))], [
      withAlias(away('a', '佐藤 花子', 'さとう はなこ')),
    ]);
    expect(result.event).toMatchObject({ type: 'heardNeedsConfirmation', reason: 'ambiguous_candidates' });
    // 下界: 不在の側がいなければ、同じ別名でも自動で確定する（合算の効果だけを見ている）。
    expect(turn('部長', [withAlias(staff('s', '鈴木 一郎', 'すずき いちろう'))]).event.type).toBe('heardAccepted');
  });

  it('不在の名指しでも、在席の候補を比較に入れて「不在です」と断定しない（不在側の合算）', () => {
    // 部署は姓の規則の対象外なので、合算の top3 だけで決まる。差 0.2 は既定の 0.1 では明確、0.3 では曖昧。
    const unit = (minMarginOverSecond: number) =>
      bridgeCommittedTurn({
        text: 'さとう',
        directory: {
          staff: [],
          departments: [{ id: 'g', name: '佐藤商事部', kana: 'さとうしょうじぶ', displayOrder: 0, enabled: true }],
        },
        unavailableDirectory: dir([away('a', '佐藤', 'さとう')]),
        sttConfidence: 0.95,
        thresholds: { ...T, minMarginOverSecond },
        t: 0,
      }).event;
    expect(unit(0.3)).toMatchObject({ type: 'heardNeedsConfirmation', unavailable: true });
    // 下界: 差が閾値より大きければ、従来どおり不在と断定する。
    expect(unit(0.1)).toEqual({ type: 'heardUnavailable', displayName: '佐藤' });
  });

  it('下界: ラテン文字・かなの名前の人が 1 人いても、全員に読みがあれば、ほかの担当者の自動確定は止めない', () => {
    const latin = turn('鈴木一郎', [
      staff('s', '鈴木一郎', 'すずきいちろう'),
      staff('h', '佐藤 花子', 'さとう はなこ'),
      staff('j', 'John Smith', 'じょん すみす'),
    ]);
    expect(latin.event.type).toBe('heardAccepted');
    const kana = turn('鈴木一郎', [
      staff('s', '鈴木一郎', 'すずきいちろう'),
      staff('h', '佐藤花子', 'さとうはなこ'),
      staff('g', 'グエン ヴァン アン', 'ぐえん ゔぁん あん'),
    ]);
    expect(kana.event.type).toBe('heardAccepted');
  });

  /*
   * owner の判断（2026-10-28）: 読みを登録していない担当者が 1 人でもいる名簿では、姓を推定しきれないので、
   * 担当者を自動で確定せず（不在の断定もせず）、常に復唱する。
   */
  describe('読みの無い担当者がいる名簿', () => {
    const roster = (extra: Staff[]) => [
      staff('s', '鈴木 一郎', 'すずき いちろう'),
      staff('h', '佐藤 花子', 'さとう はなこ'),
      ...extra,
    ];

    it('在席に読みの無い人がいれば、別の姓の人でも自動で確定しない', () => {
      const result = turn('鈴木一郎', roster([staff('x', '山田 太郎')]));
      expect(result.event).toMatchObject({ type: 'heardNeedsConfirmation', reason: 'ambiguous_candidates' });
      expect(result.resolved).toMatchObject({ id: 's' });
    });

    it('不在に読みの無い人がいても同じ。不在の名指しも断定しない', () => {
      expect(turn('鈴木一郎', roster([]), [away('x', '山田 太郎')]).event.type).toBe('heardNeedsConfirmation');
      expect(turn('佐藤花子', [staff('s', '鈴木 一郎', 'すずき いちろう')], [
        away('h', '佐藤 花子', 'さとう はなこ'),
        away('x', '山田 太郎'),
      ]).event).toMatchObject({ type: 'heardNeedsConfirmation', unavailable: true });
    });

    it('空の読み（空白だけ、記号や注記だけ）も、読みが無いものとして扱う', () => {
      for (const kana of ['　 ', '・', '（えいぎょう）', '-', 'ー', '－', '―', '〜', '※', '?', '.']) {
        expect(turn('鈴木一郎', roster([staff('x', '山田 太郎', kana)])).event.type, kana).toBe('heardNeedsConfirmation');
      }
    });

    it('下界: 全員に読みがあれば、従来どおり自動で確定する', () => {
      const result = turn('鈴木一郎', roster([staff('x', '山田 太郎', 'やまだ たろう')]));
      expect(result).toEqual({ event: { type: 'heardAccepted' }, resolved: expect.objectContaining({ id: 's' }) });
      expect(turn('佐藤花子', [staff('s', '鈴木 一郎', 'すずき いちろう')], [away('h', '佐藤 花子', 'さとう はなこ')]).event)
        .toEqual({ type: 'heardUnavailable', displayName: '佐藤 花子' });
    });

    it('無効の担当者（enabled: false）は、読みが無くても数えない', () => {
      const disabled = { ...staff('x', '山田 太郎'), enabled: false };
      expect(turn('鈴木一郎', roster([disabled])).event.type).toBe('heardAccepted');
    });

    it('部署は姓を持たないので、読みの無い担当者がいても部署の自動確定は止めない', () => {
      const result = bridgeCommittedTurn({
        text: '総務部',
        directory: { staff: [staff('x', '山田 太郎')], departments },
        sttConfidence: 0.95,
        thresholds: T,
        t: 0,
      });
      expect(result.event.type).toBe('heardAccepted');
    });
  });

  it('無効になった担当者（enabled: false）は、同じ姓の比較の相手に入れない', () => {
    const disabled = { ...staff('x', '田中 太郎', 'たなか たろう'), enabled: false };
    expect(turn('田中花子', [staff('h', '田中花子', 'たなかはなこ'), disabled]).event.type).toBe('heardAccepted');
  });

  it('在席の 2 つが近く、不在の一致は遠い（0 ではない）ときも、曖昧さを失わない', () => {
    // 部署は姓の規則の対象外なので、曖昧さの判定（合算の top3）そのものを見られる。
    const result = bridgeCommittedTurn({
      text: '総務',
      directory: {
        staff: [],
        departments: [
          { id: 'g1', name: '総務部', displayOrder: 0, enabled: true },
          { id: 'g2', name: '総務課', displayOrder: 1, enabled: true },
        ],
      },
      unavailableDirectory: dir([away('z', '山総務', 'やまそうむ')]),
      sttConfidence: 0.95,
      thresholds: T,
      t: 0,
    });
    expect(result.event).toMatchObject({ type: 'heardNeedsConfirmation', reason: 'ambiguous_candidates' });
  });
});

describe('sharesSurname', () => {
  const n = (displayName: string, kana?: string) => ({ displayName, kana });
  it.each([
    [n('田中 花子'), n('田中 太郎'), true],
    [n('田中　花子'), n('田中 太郎'), true],
    [n('田中'), n('田中 花子'), true],
    [n('田中花子'), n('田中太郎'), true],
    [n('田中花子'), n('田中 太郎'), true],
    [n('田中'), n('田中太郎'), true],
    [n('林 太郎'), n('林花子'), true],
    [n('森'), n('森花子'), true],
    [n('林太郎', 'はやしたろう'), n('林花子', 'はやしはなこ'), true],
    // 区切りも読みも無いと姓の長さが分からないので、先頭 1 文字の一致で同じ姓とみなす（安全側。増えるのは復唱だけ）。
    [n('林太郎'), n('林花子'), true],
    [n('林太郎'), n('林花子', 'はやしはなこ'), true],
    [n('佐藤'), n('佐野'), true],
    [n('タナカ'), n('田中 花子', 'たなか はなこ'), true],
    [n('ﾀﾅｶ ｼﾞﾛｳ'), n('田中 花子', 'たなか はなこ'), true],
    [n('Taro Tanaka'), n('Hanako Tanaka'), true],
    [n('TANAKA, Jiro'), n('Tanaka Hanako'), true],
    [n('田中・花子'), n('田中 太郎'), true],
    // 読みの姓が 2 音（もり）、1 音（い）でも拾う。
    [n('森花子', 'もりはなこ'), n('森太郎', 'もりたろう'), true],
    [n('井', 'い'), n('井太郎', 'いたろう'), true],
    // 異体字（渡辺と渡邊、高橋と髙橋、山崎と山﨑、斉藤と斎藤）は、区切りがあって読みが無くても同じ姓とみなす。
    [n('渡辺 太郎'), n('渡邊 花子'), true],
    [n('渡辺 太郎'), n('渡邉 花子', 'わたなべ はなこ'), true],
    [n('髙橋 太郎'), n('高橋 花子'), true],
    [n('山崎 太郎'), n('山﨑 花子'), true],
    [n('斉藤 太郎'), n('斎藤 花子'), true],
    [n('斉藤 太郎'), n('齋藤 花子'), true],
    // 下界: 読みに区切りがあれば、それで姓の長さが分かる。
    [n('山田太郎', 'やまだ たろう'), n('山本花子', 'やまもと はなこ'), false],
    // ラテン文字の姓だけの表示名と、名・姓の順の名前。
    [n('Smith'), n('John Smith'), true],
    [n('Tanaka'), n('Hanako Tanaka'), true],
    [n('Smith'), n('John Brown'), false],
    // 括弧の注記は姓に含めない。
    [n('田中（営業） 花子'), n('田中 太郎'), true],
    [n('田中(営業) 花子'), n('鈴木 太郎'), false],
    // 姓が違えば同じ姓としない（読みの無い側があっても、比べられる組は比べる）。
    [n('鈴木太郎'), n('田中 花子', 'たなか はなこ'), false],
    // 文字の系統が違う組は、同じ姓とみなさない（拾えない型。`docs/adr/0011` 3-f）。
    // 同じ姓とみなすと、ラテン文字・かなの名前の人が 1 人いるだけで全員の自動確定が止まる。
    [n('鈴木 太郎'), n('Tanaka Taro'), false],
    [n('鈴木 太郎', 'すずき たろう'), n('John Smith'), false],
    // 異体字セレクタ（IVS）は取り除いてから比べる。
    [n('渡邉\u{E0102} 花子'), n('渡辺 太郎'), true],
    [n('辻\u{E0100} 花子'), n('辻 太郎'), true],
    [n('𠮷田 花子'), n('吉田 太郎'), true],
    [n('曾根 花子'), n('曽根 太郎'), true],
    [n('峯岸 花子'), n('峰岸 太郎'), true],
    [n('北條 花子'), n('北条 太郎'), true],
    [n('淵上 花子'), n('渕上 太郎'), true],
    [n('檜山 花子'), n('桧山 太郎'), true],
    [n('關 花子'), n('関 太郎'), true],
    [n('榮 花子'), n('栄 太郎'), true],
    [n('高槗 花子'), n('高橋 太郎'), true],
    [n('桒原 花子'), n('桑原 太郎'), true],
    [n('藏本 花子'), n('蔵本 太郎'), true],
    // 表に無い異体字（邨）でも、読みが両方にあれば読みの先頭 2 音で拾う。
    [n('邨 花子', 'むらはなこ'), n('村 太郎', 'むらたろう'), true],
    // 標準の異体字セレクタ（SVS）も取り除く。
    [n('葛\uFE00城 花子'), n('葛城 太郎'), true],
    // 範囲の両端も取り除く（範囲を狭める変更を見逃さないため）。
    [n('葛\uFE0F城 花子'), n('葛城 太郎'), true],
    [n('葛\u{E01EF}城 花子'), n('葛城 太郎'), true],
    // 丸括弧以外の注記も姓に含めない。
    [n('【営業】田中 花子'), n('田中 太郎'), true],
    [n('田中［営業］ 花子'), n('田中 太郎'), true],
    [n('田中〔営業〕 花子'), n('田中 太郎'), true],
    [n('「営業」田中 花子'), n('田中 太郎'), true],
    // 注記の付いたかなの表示名も、注記を除いてから読みとして使う。
    [n('タナカ（営業）'), n('田中 花子', 'たなか はなこ'), true],
    // アクセント記号のついたラテン文字。
    [n('García'), n('José García'), true],
    [n('Müller'), n('Anna Müller'), true],
    [n('タナカ'), n('たなか はなこ'), true],
    [n('Tanaka Hanako'), n('tanaka Taro'), true],
    [n('ＴＡＮＡＫＡ'), n('TANAKA Taro'), true],
    // 表示名にも読みにも区切りが無ければ、表示名の先頭 1 文字で判定する（owner の判断。1 文字・1 音の姓を拾う）。
    [n('佐藤', 'さとう'), n('佐野', 'さの'), true],
    [n('井太郎', 'いたろう'), n('井花子', 'いはなこ'), true],
    [n('東太郎', 'あずまたろう'), n('東花子', 'ひがしはなこ'), true],
    // 下界: 表示名か読みのどちらかに区切りがあれば、それで姓が分かるので先頭 1 文字では判定しない。
    [n('佐藤 花子', 'さとう はなこ'), n('佐野 太郎', 'さの たろう'), false],
    [n('佐藤花子', 'さとう はなこ'), n('佐野太郎', 'さの たろう'), false],
    [n('佐藤 花子', 'さとうはなこ'), n('佐野 太郎', 'さのたろう'), false],
    // 4 つ（表示名 2・読み 2）のうち 1 つだけに区切りがあっても、姓は分かる。
    [n('佐藤花子', 'さとう はなこ'), n('佐野太郎', 'さのたろう'), false],
    [n('佐藤花子', 'さとうはなこ'), n('佐野太郎', 'さの たろう'), false],
    [n('佐藤 花子', 'さとうはなこ'), n('佐野太郎', 'さのたろう'), false],
    [n('佐藤花子', 'さとうはなこ'), n('佐野 太郎', 'さのたろう'), false],
    // 姓だけの 1 文字の表示名は、同じ字で始まる表示名と同じ姓（読みが違っても。STT は字で返す）。
    [n('東', 'あずま'), n('東太郎', 'ひがし たろう'), true],
    [n('森', 'mori'), n('森花子', 'もり はなこ'), true],
    // 文字を含まない読み（記号だけ）は、読みが無いものとして扱い、表示名で判定する。
    [n('林太郎', '・'), n('林花子', 'はやしはなこ'), true],
    [n('林太郎', '-'), n('林花子', 'はやしはなこ'), true],
    [n('田中 花子'), n('田村 花子'), false],
    [n('田中 花子'), n('鈴木 花子'), false],
    [n('東'), n('東山 花子'), false],
    // 区切りがあれば先頭の語で比べる（先頭 2 文字が同じでも別の姓）。全角の空白も区切りとして扱う。
    [n('田中 花子'), n('田中島 太郎'), false],
    [n('田中　花子'), n('田中島　太郎'), false],
    [n(''), n('田中'), false],
  ])('%o と %o → %s', (a, b, expected) => {
    expect(sharesSurname(a, b)).toBe(expected);
    expect(sharesSurname(b, a)).toBe(expected);
  });
});
