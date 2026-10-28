import { describe, expect, it } from 'vitest';
import type { Department } from '@/domain/department/types';
import type { Staff } from '@/domain/staff/types';
import type { EntityDirectory } from '@/domain/voice-stt/entity-resolver';
import { resolveReceptionSlotProposal } from './slot-proposal';

type StaffSpec = {
  id: string;
  displayName: string;
  kana?: string;
  available?: boolean;
  enabled?: boolean;
};

function staff(spec: StaffSpec): Staff {
  return {
    id: spec.id,
    displayName: spec.displayName,
    ...(spec.kana === undefined ? {} : { kana: spec.kana }),
    aliases: [],
    departmentId: 'dept-sales',
    enabled: spec.enabled ?? true,
    available: spec.available ?? true,
    callTargets: [],
    fallbackStaffIds: [],
  };
}

const departments: Department[] = [
  { id: 'dept-sales', name: '営業部', kana: 'えいぎょうぶ', displayOrder: 0, enabled: true },
];

function resolveTarget(staffSpecs: readonly StaffSpec[], query: string) {
  const directory: EntityDirectory = { staff: staffSpecs.map(staff), departments };
  return resolveReceptionSlotProposal(
    { targetQuery: { value: query, confidence: 0.99 } },
    { directory, sttConfidence: 0.99 },
  ).target;
}

describe('voice target availability (#1081 / #1082)', () => {
  it('不在担当者をhigh-confidence resolved targetとして通さない', () => {
    const target = resolveTarget([{ id: 'staff-suzuki', displayName: '鈴木', kana: 'すずき', available: false }], '鈴木');
    expect(target).toBeUndefined();
  });

  it('同じ姓の不在者がいれば、在席の同姓者を自動確定せず、在席候補だけをrepair候補へ残す (#1090 MAJOR-1)', () => {
    // 以前はこのケースで在席の「佐藤」を resolved/high にしていた（別人を呼ぶ誤接続を正解として縛っていた）。
    const target = resolveTarget(
      [
        { id: 'staff-sato-away', displayName: '佐藤', kana: 'さとう', available: false },
        { id: 'staff-sato-here', displayName: '佐藤', kana: 'さとう', available: true },
      ],
      '佐藤',
    );
    expect(target).toEqual({
      kind: 'ambiguous',
      candidates: [{ type: 'staff', id: 'staff-sato-here', label: '佐藤', sublabel: '営業部' }],
      evidence: { source: 'voice', certainty: 'ambiguous' },
    });
  });
});

/*
 * ADR 0011 §3-f の正解表（owner の決定）。期待値は実装の述語（`sharesSurname`）から導かず、
 * 行ごとに手で書く。`autoId` が null の行は「誰にも自動確定してはならない」、文字列の行は
 * 「その人へ自動確定しなければならない」（下界。全部を曖昧にすれば満たせる空虚さを防ぐ）。
 * `neverIds` は、resolved でも ambiguous 候補でも出してはならない人（不在・無効）。
 */
type Row = {
  name: string;
  staff: StaffSpec[];
  query: string;
  autoId: string | null;
  neverIds?: string[];
};

const rows: Row[] = [
  {
    name: '別の姓だけなら、完全一致は自動確定する',
    staff: [
      { id: 'tanaka-taro', displayName: '田中 太郎', kana: 'たなか たろう' },
      { id: 'suzuki-hanako', displayName: '鈴木 花子', kana: 'すずき はなこ' },
    ],
    query: '田中 太郎',
    autoId: 'tanaka-taro',
  },
  {
    name: '同じ姓の在席者がもう 1 人いれば、完全一致でも自動確定しない',
    staff: [
      { id: 'tanaka-taro', displayName: '田中 太郎', kana: 'たなか たろう' },
      { id: 'tanaka-hanako', displayName: '田中 花子', kana: 'たなか はなこ' },
    ],
    query: '田中 太郎',
    autoId: null,
  },
  {
    name: '同じ姓の不在者がいれば、完全一致でも自動確定しない',
    staff: [
      { id: 'tanaka-taro', displayName: '田中 太郎', kana: 'たなか たろう' },
      { id: 'tanaka-hanako', displayName: '田中 花子', kana: 'たなか はなこ', available: false },
    ],
    query: '田中 太郎',
    autoId: null,
    neverIds: ['tanaka-hanako'],
  },
  {
    name: '「田中」: 田中 太郎（不在）と田中 花子（在席）→ 田中 花子へ自動確定しない（レビュー実測 1）',
    staff: [
      { id: 'tanaka-taro', displayName: '田中 太郎', kana: 'たなか たろう', available: false },
      { id: 'tanaka-hanako', displayName: '田中 花子', kana: 'たなか はなこ' },
    ],
    query: '田中',
    autoId: null,
    neverIds: ['tanaka-taro'],
  },
  {
    name: '「田中」: 田中（不在・完全一致）と田中山（在席・前方一致）→ 田中山へ自動確定しない（レビュー実測 2）',
    staff: [
      { id: 'tanaka', displayName: '田中', kana: 'たなか', available: false },
      { id: 'tanakayama', displayName: '田中山', kana: 'たなかやま' },
    ],
    query: '田中',
    autoId: null,
    neverIds: ['tanaka'],
  },
  {
    name: '「田中太郎」: 田中太郎（不在）と田中太郎丸（在席）→ 田中太郎丸へ自動確定しない（レビュー実測 3）',
    staff: [
      { id: 'taro', displayName: '田中太郎', kana: 'たなかたろう', available: false },
      { id: 'taromaru', displayName: '田中太郎丸', kana: 'たなかたろうまる' },
    ],
    query: '田中太郎',
    autoId: null,
    neverIds: ['taro'],
  },
  {
    name: '異体字の同じ姓（渡邊 と 渡辺）は同じ姓として自動確定しない',
    staff: [
      { id: 'watanabe-taro', displayName: '渡辺 太郎', kana: 'わたなべ たろう' },
      { id: 'watanabe-hanako', displayName: '渡邊 花子', kana: 'わたなべ はなこ', available: false },
    ],
    query: '渡辺 太郎',
    autoId: null,
  },
  {
    name: '読みの無い担当者が 1 人でもいれば（不在でも）、別の姓の人でも自動確定しない',
    staff: [
      { id: 'tanaka-taro', displayName: '田中 太郎', kana: 'たなか たろう' },
      { id: 'suzuki-hanako', displayName: '鈴木 花子', available: false },
    ],
    query: '田中 太郎',
    autoId: null,
  },
  {
    name: '「-」だけの読みも読みが無いものとして扱う',
    staff: [
      { id: 'tanaka-taro', displayName: '田中 太郎', kana: 'たなか たろう' },
      { id: 'suzuki-hanako', displayName: '鈴木 花子', kana: '-' },
    ],
    query: '田中 太郎',
    autoId: null,
  },
  {
    name: '下界: 無効（disabled）の同姓者・読みの無い人は数えない',
    staff: [
      { id: 'tanaka-taro', displayName: '田中 太郎', kana: 'たなか たろう' },
      { id: 'tanaka-hanako', displayName: '田中 花子', kana: 'たなか はなこ', enabled: false },
      { id: 'suzuki-hanako', displayName: '鈴木 花子', enabled: false },
    ],
    query: '田中 太郎',
    autoId: 'tanaka-taro',
    neverIds: ['tanaka-hanako', 'suzuki-hanako'],
  },
  {
    name: '下界: 部署は姓を持たないので、読みの無い担当者がいても部署は自動確定する',
    staff: [{ id: 'suzuki-hanako', displayName: '鈴木 花子' }],
    query: '営業部',
    autoId: 'dept-sales',
  },
];

describe('voice target: 同じ姓の担当者がいれば自動確定しない (ADR 0011 §3-f / #1284)', () => {
  it.each(rows)('$name', (row) => {
    const target = resolveTarget(row.staff, row.query);
    if (row.autoId === null) {
      expect(target?.kind).not.toBe('resolved');
    } else {
      expect(target).toMatchObject({
        kind: 'resolved',
        value: { id: row.autoId },
        evidence: { source: 'voice', certainty: 'high' },
      });
    }
    const offered =
      target === undefined ? [] : target.kind === 'resolved' ? [target.value] : target.candidates;
    for (const id of row.neverIds ?? []) {
      expect(offered.map((t) => t.id)).not.toContain(id);
    }
  });

  it('不変条件: 在席・不在・無効をどう入れ替えても、不在／無効の人は resolved にも候補にも出ない', () => {
    const people: StaffSpec[] = [
      { id: 'a', displayName: '田中 太郎', kana: 'たなか たろう' },
      { id: 'b', displayName: '田中 花子', kana: 'たなか はなこ' },
      { id: 'c', displayName: '鈴木 一郎', kana: 'すずき いちろう' },
    ];
    const states = ['here', 'away', 'disabled'] as const;
    let autoResolved = 0;
    for (const sa of states) {
      for (const sb of states) {
        for (const sc of states) {
          const assigned = people.map((p, i) => {
            const s = [sa, sb, sc][i]!;
            return { ...p, available: s === 'here', enabled: s !== 'disabled' };
          });
          for (const query of ['田中', '田中 太郎', '鈴木 一郎']) {
            const target = resolveTarget(assigned, query);
            const offered =
              target === undefined ? [] : target.kind === 'resolved' ? [target.value] : target.candidates;
            for (const t of offered) {
              const person = assigned.find((p) => p.id === t.id)!;
              expect(person.available && person.enabled).toBe(true);
            }
            // 田中が 2 人とも有効（在席か不在）なら、田中 太郎／田中 花子への自動確定は起きない。
            const bothTanakaEnabled = sa !== 'disabled' && sb !== 'disabled';
            if (bothTanakaEnabled && target?.kind === 'resolved') {
              expect(['a', 'b']).not.toContain(target.value.id);
            }
            if (target?.kind === 'resolved') autoResolved += 1;
          }
        }
      }
    }
    // 下界: 全部を曖昧にする実装で空虚に満たさない（鈴木が在席なら「鈴木 一郎」は自動確定しうる）。
    expect(autoResolved).toBeGreaterThan(0);
  });
});
