import { isVisitorNameWithinLimit } from './session';
import {
  normalizeConversationDraft,
  type ConversationDraft,
  type ConversationSlot,
  type ConversationTarget,
  type RequiredConversationSlot,
} from './conversation-draft';
import {
  DEFAULT_ENTITY_RESOLUTION_THRESHOLDS,
  resolveEntities,
  type EntityCandidate,
  type EntityDirectory,
  type EntityResolutionThresholds,
} from '@/domain/voice-stt/entity-resolver';
import { bridgeCommittedTurn } from '@/domain/voice-session/kiosk-bridge';

/**
 * 自然発話 extractor の出力境界 (#1081)。
 *
 * extractor / LLM はあくまで「候補を提案する」だけで、ReceptionState を進めない。
 * target は staff id を直接返さず query だけを返し、必ず既存 directory resolver を通す。
 *
 * 目的（purpose）と会社名（company）は音声から扱わない（ADR 0011 §1・§5）ので、提案の型にも持たない。
 */
export type ProposedValue<T> = {
  value: T;
  /** extractor 自身の確信度。STT confidence / entity confidence とは別軸。 */
  confidence: number;
};

export type ReceptionSlotProposal = {
  /** 担当者/部署の自然言語表現。実体IDは extractor に生成させない。 */
  targetQuery?: ProposedValue<string>;
  visitorName?: ProposedValue<string>;
};

export type ReceptionUtteranceExtractionRequest = {
  transcript: string;
  /** 今の主質問。extra slot を受け取ってよいが、extractor の文脈として渡せる。 */
  focus?: RequiredConversationSlot;
};

export interface ReceptionUtteranceExtractor {
  extract(request: ReceptionUtteranceExtractionRequest): Promise<ReceptionSlotProposal>;
}

export type SlotProposalResolutionPolicy = {
  /** extractor confidence を provisional `high` とみなす閾値。 */
  minProposalConfidence: number;
};

export const DEFAULT_SLOT_PROPOSAL_RESOLUTION_POLICY: SlotProposalResolutionPolicy = {
  minProposalConfidence: 0.72,
};

export type ResolveSlotProposalOptions = {
  directory: EntityDirectory;
  /** 発話全体の final STT confidence。target の確認判定と、氏名の下限（ADR 0011 §3-a）に使う。 */
  sttConfidence: number;
  policy?: SlotProposalResolutionPolicy;
  entityThresholds?: EntityResolutionThresholds;
};

/**
 * 確信度を [0, 1] の値として読む。範囲外・非有限は 0（安全側）とみなす。
 * 切り詰め（5 → 1）にすると、壊れた入力が最高の確信度として通ってしまう（#1090 MINOR-4）。
 */
function confidenceOrZero(value: number): number {
  return Number.isFinite(value) && value >= 0 && value <= 1 ? value : 0;
}

function isProposalHigh(
  value: ProposedValue<unknown>,
  policy: SlotProposalResolutionPolicy,
): boolean {
  return confidenceOrZero(value.confidence) >= policy.minProposalConfidence;
}

function resolvedVoice<T>(value: T): ConversationSlot<T> {
  return {
    kind: 'resolved',
    value,
    evidence: { source: 'voice', certainty: 'high' },
  };
}

function ambiguousVoice<T>(candidates: readonly T[]): ConversationSlot<T> {
  return {
    kind: 'ambiguous',
    candidates,
    evidence: { source: 'voice', certainty: 'ambiguous' },
  };
}

/** 同じ姓・同じ表示名の担当者を画面で見分けられるよう、部署名を sublabel に付ける（#1090 MINOR-3）。 */
function candidateToTarget(
  candidate: EntityCandidate,
  directory: EntityDirectory,
): ConversationTarget | null {
  if (candidate.kind === 'department') {
    return { type: 'department', id: candidate.id, label: candidate.displayName };
  }
  if (candidate.kind !== 'staff') return null;
  const departmentId = directory.staff.find((s) => s.id === candidate.id)?.departmentId;
  const department = directory.departments.find((d) => d.id === departmentId);
  return {
    type: 'staff',
    id: candidate.id,
    label: candidate.displayName,
    ...(department ? { sublabel: department.name } : {}),
  };
}

/**
 * 氏名の提案（ADR 0011 §3-a・§3-e）。
 *
 * - STT の確信度が `minSttConfidence` 以上、**かつ** extractor の確信度が `minProposalConfidence`
 *   以上のときだけ候補にする。下回れば slot を作らない（`ambiguous` にもしない）。呼び出し側は聞き直す。
 * - 長さの上限（`VISITOR_NAME_MAX_LENGTH`）を超えたら候補にしない。
 * - 候補にしても `high` 止まり。確定（`confirmed`）は復唱への肯定だけが行う（§3-b、planner の `readback`）。
 */
function resolveVisitorNameProposal(
  proposal: ProposedValue<string> | undefined,
  sttConfidence: number,
  policy: SlotProposalResolutionPolicy,
  thresholds: EntityResolutionThresholds,
): ConversationDraft['visitorName'] {
  if (!proposal) return undefined;
  const value = proposal.value.trim();
  if (value === '' || !isVisitorNameWithinLimit(value)) return undefined;
  if (confidenceOrZero(sttConfidence) < thresholds.minSttConfidence) return undefined;
  if (!isProposalHigh(proposal, policy)) return undefined;
  // planner（#1088）が使える値と判定しない氏名（見えない文字だけ等）は、候補として返さない。返すと merge で
  // 「言及なし」と読まれ、呼び出し側は言い直しの失敗に気づけない（前の氏名を消せない）。判定は planner と共有する。
  const slot = resolvedVoice(value);
  return normalizeConversationDraft({ visitorName: slot }).visitorName === undefined ? undefined : slot;
}

/**
 * 相手の提案。自動確定の判定は kiosk の音声経路と同じ `bridgeCommittedTurn` に任せる（#1284 / ADR 0011 §3-f）。
 *
 * 🔴 不在の担当者を辞書から先に外してから照合しない（#1090 MAJOR-1）。外すと、不在の人が
 * 「近い候補」「同じ姓の別人」の比較相手から消え、同じ姓の在席者が単独の高信頼候補として
 * 自動確定する（別人を呼ぶ誤接続）。在席者は選択肢、不在者は比較相手として bridge へ渡す。
 * 同じ姓の別人（在席・不在とも）、読みの無い担当者がいる名簿、低い STT・entity の確信度は、
 * どれも bridge が自動確定させない。そこへ extractor の確信度の下限を重ねる。
 */
function resolveTargetProposal(
  proposal: ProposedValue<string> | undefined,
  directory: EntityDirectory,
  sttConfidence: number,
  policy: SlotProposalResolutionPolicy,
  thresholds: EntityResolutionThresholds,
): ConversationDraft['target'] {
  if (!proposal) return undefined;
  const query = proposal.value.trim();
  if (query === '') return undefined;

  const callable: EntityDirectory = {
    staff: directory.staff.filter((staff) => staff.available),
    departments: directory.departments,
  };
  const unavailable: EntityDirectory = {
    staff: directory.staff.filter((staff) => !staff.available),
    departments: [],
  };
  const bridged = bridgeCommittedTurn({
    text: query,
    directory: callable,
    unavailableDirectory: unavailable,
    sttConfidence: confidenceOrZero(sttConfidence),
    thresholds,
    t: 0,
  });

  // 一致なし、または不在の人を名指しされた（在席の別人は選ばない）。
  // 不在の名指しを区別して返す型は ConversationDraft に無いので、ここでは slot を作らない。
  if (bridged.resolved === null) return undefined;

  const top1 = candidateToTarget(bridged.resolved, directory);
  if (top1 === null) return undefined;
  if (bridged.event.type === 'heardAccepted' && isProposalHigh(proposal, policy)) {
    return resolvedVoice(top1);
  }

  // 自動確定しない。在席の候補だけ（bridge の top1 を含む）を、来訪者が選ぶ修復の対象にする。
  const candidates = resolveEntities(callable, query)
    .top3.map((candidate) => candidateToTarget(candidate, directory))
    .filter((value): value is ConversationTarget => value !== null);
  return ambiguousVoice(candidates);
}

/**
 * extractor proposal を ConversationDraft へ変換する純関数。
 *
 * 安全境界:
 * - state transition / dispatch / CONFIRM を行わない
 * - purpose / company を作らない（ADR 0011 §1・§5。型の外から来ても読まない）
 * - target id は extractor の出力ではなく、必ず実 directory resolver 由来
 * - target の自動確定は kiosk の音声経路と同じ判定（同じ姓・読みの無い名簿・不在の比較相手）に従う
 * - 氏名は STT と extractor の両方の下限、長さの上限を満たすときだけ `high` で出す（確定は復唱）
 * - 空文字は捨てる
 * - transcript や氏名をログへ送る副作用を持たない
 */
export function resolveReceptionSlotProposal(
  proposal: ReceptionSlotProposal,
  options: ResolveSlotProposalOptions,
): Pick<ConversationDraft, 'target' | 'visitorName'> {
  const policy = options.policy ?? DEFAULT_SLOT_PROPOSAL_RESOLUTION_POLICY;
  const thresholds = options.entityThresholds ?? DEFAULT_ENTITY_RESOLUTION_THRESHOLDS;
  const target = resolveTargetProposal(
    proposal.targetQuery,
    options.directory,
    options.sttConfidence,
    policy,
    thresholds,
  );
  const visitorName = resolveVisitorNameProposal(
    proposal.visitorName,
    options.sttConfidence,
    policy,
    thresholds,
  );

  return {
    ...(target ? { target } : {}),
    ...(visitorName ? { visitorName } : {}),
  };
}
