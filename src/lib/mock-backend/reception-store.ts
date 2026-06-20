/**
 * 受付セッションのストア (issue #16)。
 * 永続化は data backend（memory / dynamodb）に委譲する (docs/persistence-design.md)。
 * 受付セッションは短期失効（TTL）対象。
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
import { getCallAdapter } from '@/lib/call/adapter-factory';
import { getBackend } from '@/lib/data';
import { listStaff } from './directory-store';
import type { CallAdapter, CallResult } from '@/adapters/call/types';
import {
  markFallbackUsed,
  recordReceptionCompleted,
  recordReceptionOutcome,
} from './reception-log-store';

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

const DEFAULT_TTL_SEC = 24 * 60 * 60;

const sessions = () =>
  getBackend().collection<ReceptionSession>('reception', {
    ttlSeconds: Number(process.env.RECEPTION_SESSION_TTL_SEC) || DEFAULT_TTL_SEC,
  });

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
export async function createReception(input: unknown): Promise<StoreResult<ReceptionSession>> {
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
  await sessions().put(session);
  return { ok: true, value: session };
}

export async function getReception(id: string): Promise<StoreResult<ReceptionSession>> {
  const session = await sessions().get(id);
  if (!session) {
    return { ok: false, error: { code: 'not_found', message: 'reception not found' } };
  }
  return { ok: true, value: session };
}

async function applyEvent(
  session: ReceptionSession,
  event: ReceptionEvent,
): Promise<StoreResult<ReceptionSession>> {
  const next = transition(session.state, event);
  if (next === null) {
    return {
      ok: false,
      error: { code: 'invalid_transition', message: `cannot ${event} from ${session.state}` },
    };
  }
  const updated: ReceptionSession = { ...session, state: next, updatedAt: now() };
  await sessions().put(updated);
  return { ok: true, value: updated };
}

/**
 * 呼び出しを開始する。
 * 同期 adapter（Mock）は結果でセッション状態を確定する。
 * 非同期 adapter（Vonage）は calling のまま sessionId を紐づけ、応答は後続イベントで確定する。
 * adapter はテスト用に注入可能（既定は env に応じた getCallAdapter）。
 */
export async function startCall(id: string, adapter?: CallAdapter): Promise<StoreResult<ReceptionSession>> {
  const found = await getReception(id);
  if (!found.ok) return found;

  const calling = await applyEvent(found.value, 'CONFIRM');
  if (!calling.ok) return calling;

  // 既定は Mock。Vonage 有効時は本番 adapter（#4）。担当者は現在のディレクトリから構成。
  const callAdapter = adapter ?? getCallAdapter(await listStaff(true));
  const result: CallResult = await callAdapter.call({
    receptionId: calling.value.id,
    targetType: calling.value.targetType!,
    targetId: calling.value.targetId!,
  });

  // 非同期 adapter（Vonage）: セッション確立 → 応答待ち。calling のまま sessionId を紐づけ、
  // 応答/未応答は /connected・/timeout（markConnected/markTimeout）で確定する (increment 2)。
  if (result.status === 'calling') {
    const withSession: ReceptionSession = { ...calling.value, vonageSessionId: result.sessionId };
    await sessions().put(withSession);
    return { ok: true, value: withSession };
  }

  const event: ReceptionEvent =
    result.status === 'connected'
      ? 'CALL_CONNECTED'
      : result.status === 'timeout'
        ? 'CALL_TIMEOUT'
        : 'CALL_FAILED';

  const resolved = await applyEvent(calling.value, event);
  if (!resolved.ok) return resolved;

  const withOutcome: ReceptionSession = {
    ...resolved.value,
    callOutcome: result.status,
    failureReason: result.reason,
    completedAt: result.status === 'connected' ? undefined : now(),
  };
  await sessions().put(withOutcome);
  // 未応答/失敗はこの時点で結果が確定するため履歴化する (issue #19)。
  // 成功は完了時に履歴化する（completeReception）。
  if (result.status !== 'connected') {
    await recordReceptionOutcome(withOutcome);
  }
  return { ok: true, value: withOutcome };
}

export async function cancelReception(id: string): Promise<StoreResult<ReceptionSession>> {
  const found = await getReception(id);
  if (!found.ok) return found;
  const result = await applyEvent(found.value, 'CANCEL');
  if (result.ok && result.value.state === 'cancelled') {
    result.value.callOutcome = 'cancelled';
    result.value.completedAt = now();
    await sessions().put(result.value);
    await recordReceptionOutcome(result.value);
  }
  return result;
}

export async function completeReception(id: string): Promise<StoreResult<ReceptionSession>> {
  const found = await getReception(id);
  if (!found.ok) return found;
  const result = await applyEvent(found.value, 'COMPLETE');
  if (result.ok) {
    const completed = { ...result.value, completedAt: now() };
    await sessions().put(completed);
    // connected → completed の正常完了を履歴化する (issue #19)。
    if (completed.callOutcome === 'connected') {
      await recordReceptionOutcome(completed);
    }
    await recordReceptionCompleted(completed.id, completed.kioskId);
    return getReception(id);
  }
  return result;
}

/**
 * 非同期通話で担当者が応答したことを記録する（calling → connected）(issue #4 increment 2)。
 * 受付履歴は完了時に記録するため、ここでは状態と callOutcome のみ確定する。
 */
export async function markConnected(id: string): Promise<StoreResult<ReceptionSession>> {
  const found = await getReception(id);
  if (!found.ok) return found;
  const result = await applyEvent(found.value, 'CALL_CONNECTED');
  if (result.ok) {
    const connected: ReceptionSession = { ...result.value, callOutcome: 'connected' };
    await sessions().put(connected);
    return { ok: true, value: connected };
  }
  return result;
}

/**
 * 非同期通話の未応答を記録する（calling → timeout）(issue #4 increment 2)。
 * timeout は結果が確定するため受付履歴を記録する（同期 timeout と同じ扱い）。
 */
export async function markTimeout(id: string): Promise<StoreResult<ReceptionSession>> {
  const found = await getReception(id);
  if (!found.ok) return found;
  const result = await applyEvent(found.value, 'CALL_TIMEOUT');
  if (!result.ok) return result;
  const timed: ReceptionSession = { ...result.value, callOutcome: 'timeout', completedAt: now() };
  await sessions().put(timed);
  await recordReceptionOutcome(timed);
  return { ok: true, value: timed };
}

/** 失敗/未応答後の代替導線利用を記録する (issue #19)。状態は failed/timeout → fallback。 */
export async function recordFallback(id: string): Promise<StoreResult<ReceptionSession>> {
  const found = await getReception(id);
  if (!found.ok) return found;
  const result = await applyEvent(found.value, 'USE_FALLBACK');
  if (result.ok) {
    await markFallbackUsed(result.value.id, result.value.kioskId);
  }
  return result;
}

/** テスト用: ストアを初期化する。 */
export async function __resetStore(): Promise<void> {
  await sessions().reset();
}
