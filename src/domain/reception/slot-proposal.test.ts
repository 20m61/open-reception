import { describe, expect, it } from 'vitest';
import type { Department } from '@/domain/department/types';
import type { Staff } from '@/domain/staff/types';
import {
  DEFAULT_SLOT_PROPOSAL_RESOLUTION_POLICY,
  resolveReceptionSlotProposal,
  type ReceptionSlotProposal,
  type ResolveSlotProposalOptions,
} from './slot-proposal';
import { normalizeConversationDraft } from './conversation-draft';
import { VISITOR_NAME_MAX_LENGTH } from './session';
import {
  DEFAULT_ENTITY_RESOLUTION_THRESHOLDS,
  type EntityDirectory,
} from '@/domain/voice-stt/entity-resolver';

function staff(
  id: string,
  displayName: string,
  kana: string,
  departmentId = 'dept-sales',
): Staff {
  return {
    id,
    displayName,
    kana,
    aliases: [],
    departmentId,
    enabled: true,
    available: true,
    callTargets: [],
    fallbackStaffIds: [],
  };
}

const departments: Department[] = [
  {
    id: 'dept-sales',
    name: '営業部',
    kana: 'えいぎょうぶ',
    displayOrder: 0,
    enabled: true,
  },
];

const directory: EntityDirectory = {
  staff: [
    staff('staff-suzuki', '鈴木 一郎', 'すずき いちろう'),
    staff('staff-sato', '佐藤 花子', 'さとう はなこ'),
  ],
  departments,
};

const resolve = (
  proposal: ReceptionSlotProposal,
  sttConfidence = 0.95,
  extra: Partial<ResolveSlotProposalOptions> = {},
) =>
  resolveReceptionSlotProposal(proposal, {
    directory,
    sttConfidence,
    ...extra,
  });

const STT_FLOOR = DEFAULT_ENTITY_RESOLUTION_THRESHOLDS.minSttConfidence;
const PROPOSAL_FLOOR = DEFAULT_SLOT_PROPOSAL_RESOLUTION_POLICY.minProposalConfidence;
const EPS = 1e-6;

describe('resolveReceptionSlotProposal (#1081)', () => {
  it('一発話からactual targetとvisitorNameを同時にdraft候補へ変換する', () => {
    const result = resolve({
      targetQuery: { value: '鈴木 一郎', confidence: 0.95 },
      visitorName: { value: ' 張 ', confidence: 0.95 },
    });

    expect(result).toEqual({
      target: {
        kind: 'resolved',
        value: { type: 'staff', id: 'staff-suzuki', label: '鈴木 一郎', sublabel: '営業部' },
        evidence: { source: 'voice', certainty: 'high' },
      },
      // high でも confirmed にはしない。planner が復唱する（ADR 0011 §3-b）。
      visitorName: {
        kind: 'resolved',
        value: '張',
        evidence: { source: 'voice', certainty: 'high' },
      },
    });
  });

  it('extractorがtarget idを出せずqueryだけでも、directory resolverで実在entityへ結びつく', () => {
    const result = resolve({
      targetQuery: { value: '営業部', confidence: 0.95 },
    });

    expect(result.target).toEqual({
      kind: 'resolved',
      value: { type: 'department', id: 'dept-sales', label: '営業部' },
      evidence: { source: 'voice', certainty: 'high' },
    });
  });

  it('directoryに存在しないtarget queryから架空IDを生成しない', () => {
    const result = resolve({
      targetQuery: { value: '存在しない宇宙開発部', confidence: 0.99 },
    });
    expect(result.target).toBeUndefined();
  });

  it('extractor confidenceが低ければ、一意候補でもresolvedにせずrepair対象にする', () => {
    const result = resolve({
      targetQuery: { value: '鈴木 一郎', confidence: 0.4 },
    });
    expect(result.target).toEqual({
      kind: 'ambiguous',
      candidates: [{ type: 'staff', id: 'staff-suzuki', label: '鈴木 一郎', sublabel: '営業部' }],
      evidence: { source: 'voice', certainty: 'ambiguous' },
    });
  });

  it('target: extractor confidence の境界は floor ちょうどで resolved、floor 未満で ambiguous', () => {
    const at = resolve({ targetQuery: { value: '鈴木 一郎', confidence: PROPOSAL_FLOOR } });
    const below = resolve({ targetQuery: { value: '鈴木 一郎', confidence: PROPOSAL_FLOOR - EPS } });
    expect(at.target?.kind).toBe('resolved');
    expect(below.target?.kind).toBe('ambiguous');
  });

  it('STT confidenceが低ければ、extractorが高信頼でもtargetをrepair対象にする', () => {
    const result = resolve(
      { targetQuery: { value: '鈴木 一郎', confidence: 0.95 } },
      0.3,
    );
    expect(result.target?.kind).toBe('ambiguous');
  });

  it('target: 呼び出し側の policy / entityThresholds を使う（既定値に固定しない）', () => {
    const q = { targetQuery: { value: '鈴木 一郎', confidence: 0.95 } };
    expect(resolve(q, 0.95).target?.kind).toBe('resolved');
    expect(resolve(q, 0.95, { policy: { minProposalConfidence: 0.99 } }).target?.kind).toBe('ambiguous');
    expect(
      resolve(q, 0.95, {
        entityThresholds: { ...DEFAULT_ENTITY_RESOLUTION_THRESHOLDS, minSttConfidence: 0.99 },
      }).target?.kind,
    ).toBe('ambiguous');
    // 既定より緩い閾値なら、既定では ambiguous になる入力が resolved になる。
    expect(
      resolve({ targetQuery: { value: '鈴木 一郎', confidence: 0.5 } }, 0.5, {
        policy: { minProposalConfidence: 0.4 },
        entityThresholds: { ...DEFAULT_ENTITY_RESOLUTION_THRESHOLDS, minSttConfidence: 0.4 },
      }).target?.kind,
    ).toBe('resolved');
  });

  it('entity の名寄せが弱い（あいまい一致だけ）、または別の姓の 2 人が僅差なら自動確定しない', () => {
    const twoIchiro: EntityDirectory = {
      staff: [
        staff('staff-suzuki', '鈴木 一郎', 'すずき いちろう'),
        staff('staff-takahashi', '高橋 一郎', 'たかはし いちろう'),
      ],
      departments,
    };
    const run = (value: string) =>
      resolveReceptionSlotProposal(
        { targetQuery: { value, confidence: 0.95 } },
        { directory: twoIchiro, sttConfidence: 0.95 },
      ).target;
    // 読みの濁点違い（あいまい一致）だけ。
    expect(run('すすき')).toEqual({
      kind: 'ambiguous',
      candidates: [{ type: 'staff', id: 'staff-suzuki', label: '鈴木 一郎', sublabel: '営業部' }],
      evidence: { source: 'voice', certainty: 'ambiguous' },
    });
    // 名だけ。姓は違うので同姓の規則には当たらず、確信度の僅差だけが止める。
    const byGivenName = run('一郎');
    expect(byGivenName?.kind).toBe('ambiguous');
    // 下界: 姓と名を言えば自動確定する。
    expect(run('鈴木 一郎')?.kind).toBe('resolved');
  });

  it('自動確定するのは top1 の人（近い部署名が 2 位にいても取り違えない）', () => {
    const withLab: EntityDirectory = {
      staff: [staff('staff-suzuki', '鈴木 一郎', 'すずき いちろう')],
      departments: [
        ...departments,
        { id: 'dept-lab', name: '鈴木一郎研究室', kana: 'すずきいちろうけんきゅうしつ', displayOrder: 1, enabled: true },
      ],
    };
    const result = resolveReceptionSlotProposal(
      { targetQuery: { value: '鈴木 一郎', confidence: 0.95 } },
      { directory: withLab, sttConfidence: 0.95 },
    );
    expect(result.target).toEqual({
      kind: 'resolved',
      value: { type: 'staff', id: 'staff-suzuki', label: '鈴木 一郎', sublabel: '営業部' },
      evidence: { source: 'voice', certainty: 'high' },
    });
  });

  it('同名に近い複数候補は実在entity候補のままambiguousにする（部署名で区別できる）', () => {
    const sameNameDirectory: EntityDirectory = {
      staff: [
        staff('staff-sato-sales', '佐藤', 'さとう', 'dept-sales'),
        staff('staff-sato-dev', '佐藤', 'さとう', 'dept-dev'),
      ],
      departments: [
        ...departments,
        {
          id: 'dept-dev',
          name: '開発部',
          kana: 'かいはつぶ',
          displayOrder: 1,
          enabled: true,
        },
      ],
    };

    const result = resolveReceptionSlotProposal(
      { targetQuery: { value: '佐藤', confidence: 0.95 } },
      { directory: sameNameDirectory, sttConfidence: 0.95 },
    );

    expect(result.target).toEqual({
      kind: 'ambiguous',
      candidates: [
        { type: 'staff', id: 'staff-sato-sales', label: '佐藤', sublabel: '営業部' },
        { type: 'staff', id: 'staff-sato-dev', label: '佐藤', sublabel: '開発部' },
      ],
      evidence: { source: 'voice', certainty: 'ambiguous' },
    });
  });
});

describe('visitorName: STT と extractor の両方の下限 (ADR 0011 §3-a)', () => {
  const levels = (floor: number) => [0, floor - EPS, floor, 0.95, 1];

  it('総当たり: 両方が floor 以上のときだけ resolved/high、どちらかが下回れば slot 自体を出さない（ambiguous にもしない）', () => {
    let resolvedCount = 0;
    for (const stt of levels(STT_FLOOR)) {
      for (const extractor of levels(PROPOSAL_FLOOR)) {
        const result = resolve({ visitorName: { value: '山田', confidence: extractor } }, stt);
        const bothHigh = stt >= STT_FLOOR && extractor >= PROPOSAL_FLOOR;
        if (bothHigh) {
          resolvedCount += 1;
          expect(result.visitorName).toEqual({
            kind: 'resolved',
            value: '山田',
            evidence: { source: 'voice', certainty: 'high' },
          });
        } else {
          expect(result.visitorName).toBeUndefined();
        }
      }
    }
    // 下界: 3 × 3 = 9 組は resolved（全部を捨てる実装で空虚に満たさない）。
    expect(resolvedCount).toBe(9);
  });

  it('レビュー実測: sttConfidence 0.1 なら extractor 0.9 でも氏名を出さない', () => {
    expect(resolve({ visitorName: { value: 'ヤマダ', confidence: 0.9 } }, 0.1).visitorName).toBeUndefined();
  });

  it('呼び出し側の policy / entityThresholds の下限を使う（既定値に固定しない）', () => {
    const name = { visitorName: { value: '山田', confidence: 0.85 } };
    expect(resolve(name, 0.85).visitorName?.kind).toBe('resolved');
    expect(resolve(name, 0.85, { policy: { minProposalConfidence: 0.9 } }).visitorName).toBeUndefined();
    expect(
      resolve(name, 0.85, {
        entityThresholds: { ...DEFAULT_ENTITY_RESOLUTION_THRESHOLDS, minSttConfidence: 0.9 },
      }).visitorName,
    ).toBeUndefined();
    const loose = { visitorName: { value: '山田', confidence: 0.3 } };
    expect(resolve(loose, 0.3).visitorName).toBeUndefined();
    expect(
      resolve(loose, 0.3, {
        policy: { minProposalConfidence: 0.2 },
        entityThresholds: { ...DEFAULT_ENTITY_RESOLUTION_THRESHOLDS, minSttConfidence: 0.2 },
      }).visitorName?.kind,
    ).toBe('resolved');
  });

  it('範囲外・非有限の confidence は 0 とみなす（5 を 1 に切り詰めて resolved にしない）', () => {
    for (const bad of [Number.NaN, Number.POSITIVE_INFINITY, Number.NEGATIVE_INFINITY, 5, 1 + EPS, -0.5]) {
      expect(resolve({ visitorName: { value: '山田', confidence: bad } }).visitorName).toBeUndefined();
      expect(resolve({ visitorName: { value: '山田', confidence: 0.95 } }, bad).visitorName).toBeUndefined();
      expect(resolve({ targetQuery: { value: '鈴木 一郎', confidence: bad } }).target?.kind).toBe('ambiguous');
      expect(resolve({ targetQuery: { value: '鈴木 一郎', confidence: 0.95 } }, bad).target?.kind).toBe(
        'ambiguous',
      );
    }
  });

  it('空文字の氏名・target query は slot を作らない', () => {
    const result = resolve({
      targetQuery: { value: ' ', confidence: 1 },
      visitorName: { value: ' ', confidence: 1 },
    });
    expect(result).toEqual({});
  });
});

describe('visitorName: 長さの上限 (ADR 0011 §3-e / #1090 MINOR-4)', () => {
  it('上限ちょうどは候補にし、1 文字でも超えたら slot を出さない（前後の空白は数えない）', () => {
    const atLimit = '山'.repeat(VISITOR_NAME_MAX_LENGTH);
    expect(resolve({ visitorName: { value: ` ${atLimit} `, confidence: 0.95 } }).visitorName).toEqual({
      kind: 'resolved',
      value: atLimit,
      evidence: { source: 'voice', certainty: 'high' },
    });
    expect(
      resolve({ visitorName: { value: `${atLimit}山`, confidence: 0.95 } }).visitorName,
    ).toBeUndefined();
    expect(resolve({ visitorName: { value: '山'.repeat(5000), confidence: 0.95 } }).visitorName).toBeUndefined();
  });

  it('上限は UTF-16 の長さではなく文字数で数える（サロゲートペアの氏名を落とさない）', () => {
    const atLimit = '𠮷'.repeat(VISITOR_NAME_MAX_LENGTH);
    expect(resolve({ visitorName: { value: atLimit, confidence: 0.95 } }).visitorName?.kind).toBe('resolved');
    expect(resolve({ visitorName: { value: `${atLimit}𠮷`, confidence: 0.95 } }).visitorName).toBeUndefined();
  });
});

describe('音声から purpose / company を作らない (ADR 0011 §1・§5)', () => {
  it('extractor が purpose / company を返しても（型の外から来ても）出力に載せない', () => {
    // 実行時には LLM 由来の任意の形が来うるので、型を外して渡す。
    const raw = {
      purpose: { value: 'meeting', confidence: 0.99 },
      company: { value: '株式会社サンプル', confidence: 0.99 },
      targetQuery: { value: '鈴木 一郎', confidence: 0.99 },
      visitorName: { value: '山田', confidence: 0.99 },
    } as unknown as ReceptionSlotProposal;
    const result = resolve(raw, 0.99);
    expect(Object.keys(result).sort()).toEqual(['target', 'visitorName']);
  });

  it('不変条件: 出力は planner の正規化で何も落とされない（planner が捨てる slot を作らない）', () => {
    const proposals: ReceptionSlotProposal[] = [];
    for (const extractor of [0.1, PROPOSAL_FLOOR, 0.99]) {
      // 見えない文字だけの氏名（ゼロ幅空白・結合子・語結合子・ソフトハイフン・モンゴル母音区切り）も含める。
      for (const name of [
        '山田',
        ' ',
        '\u200B',
        '\u200B\u200C',
        '\u2060',
        '\u00AD',
        '\u3000\u200B',
        '\u180E',
        '山'.repeat(VISITOR_NAME_MAX_LENGTH + 1),
      ]) {
        for (const query of ['鈴木 一郎', '佐藤', '営業部', '無関係']) {
          proposals.push({
            visitorName: { value: name, confidence: extractor },
            targetQuery: { value: query, confidence: extractor },
          });
        }
      }
    }
    let nonEmpty = 0;
    for (const proposal of proposals) {
      for (const stt of [0.1, STT_FLOOR, 0.99]) {
        const result = resolve(proposal, stt);
        expect(normalizeConversationDraft(result)).toEqual(result);
        if (result.visitorName !== undefined) nonEmpty += 1;
      }
    }
    expect(nonEmpty).toBeGreaterThan(0);
  });
});
