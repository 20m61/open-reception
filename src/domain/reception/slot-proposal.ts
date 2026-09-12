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

export type ProposedValue<T> = {
  value: T;
  confidence: number;
};

export type ReceptionSlotProposal = {
  purpose?: ProposedValue<ReceptionPurposeId>;
  targetQuery?: ProposedValue<string>;
  visitorName?: ProposedValue<string>;
  company?: ProposedValue<string>;
};

export type ReceptionUtteranceExtractionRequest = {
  transcript: string;
  focus?: RequiredConversationSlot;
};

export interface ReceptionUtteranceExtractor {
  extract(request: ReceptionUtteranceExtractionRequest): Promise<ReceptionSlotProposal>;
}

export type SlotProposalResolutionPolicy = {
  minProposalConfidence: number;
};

export const DEFAULT_SLOT_PROPOSAL_RESOLUTION_POLICY: SlotProposalResolutionPolicy = {
  minProposalConfidence: 0.72,
};

export type ResolveSlotProposalOptions = {
  directory: EntityDirectory;
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

  const callableDirectory: EntityDirectory = {
    ...options.directory,
    staff: options.directory.staff.filter((staff) => staff.available),
  };
  const resolution = resolveEntities(callableDirectory, query);
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

  if (!isProposalHigh(proposal, policy) || entityConfirmation !== null) {
    return ambiguousVoice(targets);
  }

  return resolvedVoice(targets[0]!);
}

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
