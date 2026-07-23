/**
 * 受付セッションのストア (issue #16)。
 *
 * #274 ⑤ で §9 標準（docs/persistence-design.md）へ統合: 永続化は ReceptionSessionRepository
 * （./reception-repository.ts、getBackend() 委譲の単一実装）に閉じ、本ファイルはプロセス共有
 * ファクトリ（getReceptionSessionRepository）と互換 API（入力検証・状態機械・呼び出し
 * adapter・監査/履歴化）を担う。既存呼び出し側（/api/kiosk/receptions/*, /api/staff/calls/*）の
 * 変更は不要。受付セッションは短期失効（TTL）対象。
 */
import { randomUUID } from 'node:crypto';
import {
  isReceptionPurposeId,
  type ReceptionPurposeId,
  type ReceptionSession,
  type ReceptionTargetType,
  type VisitorInfo,
} from '@/domain/reception/session';
import {
  sanitizeReceptionExperience,
  type ReceptionExperience,
} from '@/domain/reception/log';
import { transition, type ReceptionEvent } from '@/domain/reception/state';
import {
  buildStaffResponseResult,
  type StaffResponseAction,
  type StaffResponseResult,
} from '@/domain/reception/staff-response';
import { resolveCallAdapter } from '@/lib/call/adapter-factory';
import { resolveDefaultScope } from '@/lib/tenant/default-scope';
import {
  DataBackedReceptionSessionRepository,
  type ReceptionSessionRepository,
} from './reception-repository';
import { listStaff } from './directory-store';
import type { CallAdapter, CallResult } from '@/adapters/call/types';
import {
  appendAuditLog,
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
  /** 受付端末が送る体験メトリクス (issue #319)。サニタイズ済み（PII なし）。省略可。 */
  experience?: ReceptionExperience;
};

export type StoreError = { code: 'not_found' | 'invalid_input' | 'invalid_transition'; message: string };

export type StoreResult<T> = { ok: true; value: T } | { ok: false; error: StoreError };

let repository: ReceptionSessionRepository | undefined;

/** プロセス共有の ReceptionSessionRepository（§9.2 のファクトリ）。 */
export function getReceptionSessionRepository(): ReceptionSessionRepository {
  if (!repository) {
    repository = new DataBackedReceptionSessionRepository();
  }
  return repository;
}

const sessions = () => getReceptionSessionRepository();

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
  // 体験メトリクス (issue #319) はホワイトリスト方式でサニタイズする（未知キー/PII は破棄）。
  // 有効値が無ければ undefined（experience キー自体を付けない）。
  const experience = sanitizeReceptionExperience(o.experience);
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
      ...(experience ? { experience } : {}),
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
    // サニタイズ済み体験メトリクス (issue #319)。終端で ReceptionLog へ引き継ぐ。未指定なら付けない。
    ...(v.experience ? { experience: v.experience } : {}),
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
 * adapter はテスト用に注入可能。未注入時はテナント設定から解決する（`resolveCallAdapter`）。
 * `tenantId` は呼び出し点（call ルート）の認可済みスコープ由来。未指定時は既定スコープへフォールバック。
 */
export async function startCall(
  id: string,
  adapter?: CallAdapter,
  tenantId: string = resolveDefaultScope().tenantId,
): Promise<StoreResult<ReceptionSession>> {
  const found = await getReception(id);
  if (!found.ok) return found;

  const calling = await applyEvent(found.value, 'CONFIRM');
  if (!calling.ok) return calling;

  // 既定は Mock。テナント設定が vonage+secret 完備なら本番 adapter（#4）。担当者は現在のディレクトリから構成。
  const callAdapter = adapter ?? (await resolveCallAdapter(tenantId, await listStaff(true)));
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
 * 受付履歴は完了時に記録するが、応答の瞬間は監査ログ（reception.answered）に残す
 * （connected/completed の監査とは別イベント）(issue #19, increment 2c)。
 */
export async function markConnected(
  id: string,
  actor?: string,
): Promise<StoreResult<ReceptionSession>> {
  const found = await getReception(id);
  if (!found.ok) return found;
  const result = await applyEvent(found.value, 'CALL_CONNECTED');
  if (result.ok) {
    const connected: ReceptionSession = { ...result.value, callOutcome: 'connected' };
    await sessions().put(connected);
    // 応答主体を監査に残す（担当者応答は 'staff'、受付端末検知は kiosk:<id>）。
    await appendAuditLog({
      action: 'reception.answered',
      actor: actor ?? `kiosk:${connected.kioskId}`,
      targetType: 'reception',
      targetId: connected.id,
    });
    return { ok: true, value: connected };
  }
  return result;
}

/** 担当者応答を記録できる受付状態（呼び出し中・応答済み）。終端状態には記録しない。 */
const STAFF_RESPONSE_ALLOWED_STATES: ReadonlySet<ReceptionSession['state']> = new Set([
  'calling',
  'connected',
]);

/**
 * 担当者の応答アクションを記録する (issue #99 increment 1)。
 *
 * 既存 (issue #4 2c) の markConnected（通話参加＝connected 確定）とは別レイヤ。
 * 来訪者向けメッセージを session.staffResponse に載せ、受付端末が短時間ポーリングで反映する。
 * 状態機械は壊さない: calling/connected の間だけ受け付け、最新応答で上書き（担当者が
 * 「5分お待ちください」→「今行きます」と更新できる）。
 *
 * 監査は事前定義済みの `reception.staff_responded` を使い、応答種別は metadata.action に持つ
 * （PII は残さない）。応答文言・来訪者情報は監査に書かない。
 */
export async function recordStaffResponse(
  id: string,
  action: StaffResponseAction,
  options?: { messageOverride?: string; respondedAt?: string },
): Promise<StoreResult<StaffResponseResult>> {
  const found = await getReception(id);
  if (!found.ok) return found;

  if (!STAFF_RESPONSE_ALLOWED_STATES.has(found.value.state)) {
    return {
      ok: false,
      error: {
        code: 'invalid_transition',
        message: `cannot record staff response from ${found.value.state}`,
      },
    };
  }

  const result = buildStaffResponseResult(
    action,
    options?.respondedAt ?? now(),
    options?.messageOverride,
  );
  const updated: ReceptionSession = { ...found.value, staffResponse: result, updatedAt: now() };
  await sessions().put(updated);

  // 応答種別のみを監査に残す（来訪者向け文言・PII は載せない）。
  await appendAuditLog({
    action: 'reception.staff_responded',
    actor: 'staff',
    targetType: 'reception',
    targetId: id,
    metadata: { action },
  });

  return { ok: true, value: result };
}

/**
 * 受付端末向けに、来訪者表示に必要な最小限の状態を返す (issue #99)。
 * PII（visitor.*）は返さない。担当者の最新応答と受付状態のみ。
 */
export async function getReceptionVisitorStatus(
  id: string,
): Promise<StoreResult<{ state: ReceptionSession['state']; staffResponse?: StaffResponseResult }>> {
  const found = await getReception(id);
  if (!found.ok) return found;
  return {
    ok: true,
    value: { state: found.value.state, staffResponse: found.value.staffResponse },
  };
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
