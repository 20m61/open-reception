/**
 * 受付セッションの in-memory mock backend (issue #16)。
 * 本番 DB 連携前に、e2e/開発で受付セッションを扱えるようにする。
 *
 * NOTE: プロセス内 Map のため単一インスタンス前提。本番では永続化層へ置換する。
 */
import { randomUUID } from 'node:crypto';
import {
  isReceptionPurposeId,
  type ReceptionPurposeId,
  type ReceptionSession,
  type ReceptionTargetType,
  type VisitorInfo,
} from '@/domain/reception/session';
import { transition, type ReceptionEvent } from '@/domain/reception/state';
import { MockCallAdapter } from '@/adapters/call/mock';
import { MOCK_STAFF } from '@/domain/staff/mock-data';
import type { CallResult } from '@/adapters/call/types';

export type CreateReceptionInput = {
  kioskId: string;
  purpose: ReceptionPurposeId;
  targetType: ReceptionTargetType;
  targetId: string;
  targetLabel: string;
  visitor: VisitorInfo;
};

export type StoreError = { code: 'not_found' | 'invalid_input' | 'invalid_transition'; message: string };

export type StoreResult<T> = { ok: true; value: T } | { ok: false; error: StoreError };

const sessions = new Map<string, ReceptionSession>();
const callAdapter = new MockCallAdapter(MOCK_STAFF);

function now(): string {
  return new Date().toISOString();
}

function validateCreateInput(input: unknown): StoreResult<CreateReceptionInput> {
  if (typeof input !== 'object' || input === null) {
    return { ok: false, error: { code: 'invalid_input', message: 'body must be an object' } };
  }
  const o = input as Record<string, unknown>;
  if (typeof o.kioskId !== 'string' || o.kioskId.trim() === '') {
    return { ok: false, error: { code: 'invalid_input', message: 'kioskId is required' } };
  }
  if (!isReceptionPurposeId(o.purpose)) {
    return { ok: false, error: { code: 'invalid_input', message: 'purpose is invalid' } };
  }
  if (o.targetType !== 'staff' && o.targetType !== 'department') {
    return { ok: false, error: { code: 'invalid_input', message: 'targetType is invalid' } };
  }
  if (typeof o.targetId !== 'string' || o.targetId.trim() === '') {
    return { ok: false, error: { code: 'invalid_input', message: 'targetId is required' } };
  }
  if (typeof o.targetLabel !== 'string' || o.targetLabel.trim() === '') {
    return { ok: false, error: { code: 'invalid_input', message: 'targetLabel is required' } };
  }
  const visitor = o.visitor as Record<string, unknown> | undefined;
  if (typeof visitor !== 'object' || visitor === null || typeof visitor.name !== 'string' || visitor.name.trim() === '') {
    return { ok: false, error: { code: 'invalid_input', message: 'visitor.name is required' } };
  }
  return {
    ok: true,
    value: {
      kioskId: o.kioskId,
      purpose: o.purpose,
      targetType: o.targetType,
      targetId: o.targetId,
      targetLabel: o.targetLabel,
      visitor: {
        name: visitor.name,
        company: typeof visitor.company === 'string' ? visitor.company : undefined,
        note: typeof visitor.note === 'string' ? visitor.note : undefined,
      },
    },
  };
}

/** 受付セッションを作成する。全情報が揃った confirming 状態で開始する。 */
export function createReception(input: unknown): StoreResult<ReceptionSession> {
  const validated = validateCreateInput(input);
  if (!validated.ok) {
    return validated;
  }
  const v = validated.value;
  const ts = now();
  const session: ReceptionSession = {
    id: randomUUID(),
    kioskId: v.kioskId,
    state: 'confirming',
    purpose: v.purpose,
    targetType: v.targetType,
    targetId: v.targetId,
    targetLabel: v.targetLabel,
    visitor: v.visitor,
    startedAt: ts,
    updatedAt: ts,
  };
  sessions.set(session.id, session);
  return { ok: true, value: session };
}

export function getReception(id: string): StoreResult<ReceptionSession> {
  const session = sessions.get(id);
  if (!session) {
    return { ok: false, error: { code: 'not_found', message: 'reception not found' } };
  }
  return { ok: true, value: session };
}

function applyEvent(session: ReceptionSession, event: ReceptionEvent): StoreResult<ReceptionSession> {
  const next = transition(session.state, event);
  if (next === null) {
    return {
      ok: false,
      error: { code: 'invalid_transition', message: `cannot ${event} from ${session.state}` },
    };
  }
  const updated: ReceptionSession = { ...session, state: next, updatedAt: now() };
  sessions.set(updated.id, updated);
  return { ok: true, value: updated };
}

/** 呼び出しを開始し、mock adapter の結果でセッション状態を確定する。 */
export async function startCall(id: string): Promise<StoreResult<ReceptionSession>> {
  const found = getReception(id);
  if (!found.ok) return found;

  const calling = applyEvent(found.value, 'CONFIRM');
  if (!calling.ok) return calling;

  const result: CallResult = await callAdapter.call({
    receptionId: calling.value.id,
    targetType: calling.value.targetType!,
    targetId: calling.value.targetId!,
  });

  const event: ReceptionEvent =
    result.status === 'connected'
      ? 'CALL_CONNECTED'
      : result.status === 'timeout'
        ? 'CALL_TIMEOUT'
        : 'CALL_FAILED';

  const resolved = applyEvent(calling.value, event);
  if (!resolved.ok) return resolved;

  const withOutcome: ReceptionSession = {
    ...resolved.value,
    callOutcome: result.status,
    failureReason: result.reason,
    completedAt: result.status === 'connected' ? undefined : now(),
  };
  sessions.set(withOutcome.id, withOutcome);
  return { ok: true, value: withOutcome };
}

export function cancelReception(id: string): StoreResult<ReceptionSession> {
  const found = getReception(id);
  if (!found.ok) return found;
  const result = applyEvent(found.value, 'CANCEL');
  if (result.ok && result.value.state === 'cancelled') {
    result.value.callOutcome = 'cancelled';
    result.value.completedAt = now();
  }
  return result;
}

export function completeReception(id: string): StoreResult<ReceptionSession> {
  const found = getReception(id);
  if (!found.ok) return found;
  const result = applyEvent(found.value, 'COMPLETE');
  if (result.ok) {
    sessions.set(result.value.id, { ...result.value, completedAt: now() });
    return getReception(id);
  }
  return result;
}

/** テスト用: ストアを初期化する。 */
export function __resetStore(): void {
  sessions.clear();
}
