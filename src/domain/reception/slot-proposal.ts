import { isReceptionPurposeId, type ReceptionPurposeId } from './session';
import {
  type ConversationDraft,
  type ConversationSlot,
  type ConversationTarget,
  type RequiredConversationSlot,
} from './conversation-draft';
import {
  decideEntityConfirmation,
  resolveEntities,
  type EntityCandidate,
  type EntityDirectory,
  type EntityResolutionThresholds,
} from '@/domain/voice-stt/entity-resolver';

/**
 * 自然発話 extractor の出力境界 (#1081)。
 *
 * extractor / LLM はあくまで「候補を提案する」だけで、ReceptionState を進めない。
 * target は staff id を直接返さず query だけを返し、必ず既存 directory resolver を通す。
 */
export type ProposedValue<T> = {
  value: T;
  /** extractor 自身の確信度。STT confidence / entity confidence とは別軸。 */
  confidence: number;
};

export type ReceptionSlotProposal = {
  purpose?: ProposedValue<ReceptionPurposeId>;
  /** 担当者/部署の自然言語表現。実体IDは extractor に生成させない。 */
  targetQuery?: ProposedValue<string>;
  visitorName?: ProposedValue<string>;
  /** optional。通常journeyでは要求しない。自然発話に含まれたときだけ提案してよい。 */
  company?: ProposedValue<string>;
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
  /** 発話全体の final STT confidence。target entity解決の既存確認判定へ渡す。 */
  sttConfidence: number;
  policy?: SlotProposalResolutionPolicy;
  entityThresholds?: EntityResolutionThresholds;
};

function normalizedConfidence(value: number): number {
  if (!Number.isFinite(value)) return 0;
  return Math.max(0, Math.min(1, value));
}

function isProposalHigh(
  value: ProposedValue<unknown>,
  policy: SlotProposalResolutionPolicy,
): boolean {
  return normalizedConfidence(value.confidence) >= policy.minProposalConfidence;
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

function candidateToTarget(candidate: EntityCandidate): ConversationTarget | null {
  if (candidate.kind !== 'staff' && candidate.kind !== 'department') return null;
  return {
    type: candidate.kind,
    id: candidate.id,
    label: candidate.displayName,
  };
}

function resolvePurposeProposal(
  proposal: ProposedValue<ReceptionPurposeId> | undefined,
  policy: SlotProposalResolutionPolicy,
): ConversationDraft['purpose'] {
  if (!proposal || !isReceptionPurposeId(proposal.value)) return undefined;
  return isProposalHigh(proposal, policy)
    ? resolvedVoice(proposal.value)
    : ambiguousVoice([proposal.value]);
}

function resolveTextProposal(
  proposal: ProposedValue<string> | undefined,
  policy: SlotProposalResolutionPolicy,
): ConversationSlot<string> | undefined {
  if (!proposal) return undefined;
  const value = proposal.value.trim();
  if (value === '') return undefined;
  return isProposalHigh(proposal, policy)
    ? resolvedVoice(value)
    : ambiguousVoice([value]);
}

function resolveTargetProposal(
  proposal: ProposedValue<string> | undefined,
  options: ResolveSlotProposalOptions,
  policy: SlotProposalResolutionPolicy,
): ConversationDraft['target'] {
  if (!proposal) return undefined;
  const query = proposal.value.trim();
  if (query === '') return undefined;

  const resolution = resolveEntities(options.directory, query);
  if (!resolution.top1) return undefined;

  const targets = resolution.top3
    .map(candidateToTarget)
    .filter((value): value is ConversationTarget => value !== null);
  if (targets.length === 0) return undefined;

  const entityConfirmation = decideEntityConfirmation(
    normalizedConfidence(options.sttConfidence),
    resolution.top3,
    options.entityThresholds,
    0,
  );

  // extractor自身が曖昧、STTが低信頼、entity名寄せが曖昧のどれか1つでも残るなら
  // 自動resolvedにせず、実在entity候補を来訪者のrepair対象へ渡す。
  if (!isProposalHigh(proposal, policy) || entityConfirmation !== null) {
    return ambiguousVoice(targets);
  }

  return resolvedVoice(targets[0]!);
}

/**
 * extractor proposal を ConversationDraft へ変換する純関数。
 *
 * 安全境界:
 * - state transition / dispatch / CONFIRM を行わない
 * - target id は extractor の出力ではなく、必ず実 directory resolver 由来
 * - low-confidence は resolved にせず ambiguous として planner に修復させる
 * - 空文字は捨てる
 * - transcript や氏名をログへ送る副作用を持たない
 */
export function resolveReceptionSlotProposal(
  proposal: ReceptionSlotProposal,
  options: ResolveSlotProposalOptions,
): Partial<ConversationDraft> {
  const policy = options.policy ?? DEFAULT_SLOT_PROPOSAL_RESOLUTION_POLICY;
  const purpose = resolvePurposeProposal(proposal.purpose, policy);
  const target = resolveTargetProposal(proposal.targetQuery, options, policy);
  const visitorName = resolveTextProposal(proposal.visitorName, policy);
  const company = resolveTextProposal(proposal.company, policy);

  return {
    ...(purpose ? { purpose } : {}),
    ...(target ? { target } : {}),
    ...(visitorName ? { visitorName } : {}),
    ...(company ? { company } : {}),
  };
}
