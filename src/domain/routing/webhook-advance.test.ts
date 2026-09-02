import { describe, expect, it } from 'vitest';
import type { RoutingPolicy } from './policy';
import { startRouting, type RoutingPosition } from './resumable';
import { advanceFromWebhook, type CallProgress } from './webhook-advance';

function step(id: string, endpointId: string, over: Partial<RoutingPolicy['steps'][number]> = {}) {
  return { id, endpointId, action: 'notify' as const, timeoutSeconds: 20, nextOn: {}, ...over };
}

const POLICY: RoutingPolicy = {
  id: 'p1',
  tenantId: 't1',
  name: 'TEST-policy',
  enabled: true,
  steps: [step('s1', 'e1'), step('s2', 'e2'), step('s3', 'e3')],
};
const POLICIES = [POLICY];
const CALL = 'TEST-call-uuid';

function firstPosition(): RoutingPosition {
  const start = startRouting(POLICIES, 'p1', CALL);
  if (start.kind !== 'dial') throw new Error('fixture: expected dial');
  return start.position;
}

function progress(over: Partial<CallProgress> = {}): CallProgress {
  return { position: firstPosition(), voiceState: 'queued', settled: false, eventCount: 0, ...over };
}

describe('advanceFromWebhook — webhook 1 件で取次を 1 歩進める (#4 Inc D-2)', () => {
  it('結果が未確定なら発信せず、通話状態だけ進める', () => {
    const r = advanceFromWebhook(progress(), { kind: 'status', status: 'ringing' }, 'ev-1', POLICIES);
    expect(r.kind).toBe('in_progress');
    if (r.kind !== 'in_progress') throw new Error('unreachable');
    expect(r.next.voiceState).toBe('ringing');
    // **位置を進めない。** 進めると鳴っている最中に次の人へ発信してしまう。
    expect(r.next.position).toEqual(progress().position);
  });

  it('未応答なら次の step を発信する', () => {
    const r = advanceFromWebhook(progress(), { kind: 'status', status: 'unanswered' }, 'ev-1', POLICIES);
    expect(r.kind).toBe('dial');
    if (r.kind !== 'dial') throw new Error('unreachable');
    expect(r.step.id).toBe('s2');
    expect(r.next.position.stepId).toBe('s2');
    expect(r.next.settled).toBe(false);
  });

  it('担当者が「向かう」と答えたら確定し、次を発信しない', () => {
    const r = advanceFromWebhook(progress(), { kind: 'dtmf', choice: 'coming' }, 'ev-1', POLICIES);
    expect(r.kind).toBe('settled');
    if (r.kind !== 'settled') throw new Error('unreachable');
    expect(r.result).toBe('staff_coming');
    expect(r.next.settled).toBe(true);
  });

  it('確定済みの相関はイベントを無視する（確定後に取次を進めない）', () => {
    // 🔴 これが無いと、確定後に遅れて届いた completed 等で取次が再開し、
    // 担当者が向かっているのに部門代表まで鳴る。
    const r = advanceFromWebhook(
      progress({ voiceState: 'staff_coming', settled: true }),
      { kind: 'status', status: 'completed' },
      'ev-late',
      POLICIES,
    );
    expect(r).toEqual({ kind: 'ignored', reason: 'already_settled' });
  });

  it('同じ provider イベントの再配信では位置を進めない', () => {
    // Vonage は at-least-once。二重配信で 1 手余計に進むと、応答していない担当者を
    // 飛ばして次の人へ発信してしまう。
    const first = advanceFromWebhook(progress(), { kind: 'status', status: 'unanswered' }, 'ev-1', POLICIES);
    if (first.kind !== 'dial') throw new Error('unreachable');
    const again = advanceFromWebhook(
      { ...progress(), position: first.next.position },
      { kind: 'status', status: 'unanswered' },
      'ev-1',
      POLICIES,
    );
    expect(again).toEqual({ kind: 'ignored', reason: 'duplicate' });
  });

  it('🔴 保存された通話状態から畳む（毎回 queued から畳み直さない）', () => {
    // これが #4 Inc D-1 時点の /events の欠陥そのもの。
    // 担当者が DTMF で応答して 'answered'（terminal）になった後、通話終了の
    // completed が届く。applyVoiceEvent は terminal を short-circuit するので
    // 保存状態から畳めば 'answered' のまま。'queued' から畳み直すと
    // **completed → no_answer** となり、応答済みなのに次の人へ発信してしまう。
    const r = advanceFromWebhook(
      progress({ voiceState: 'answered' }),
      { kind: 'status', status: 'completed' },
      'ev-2',
      POLICIES,
    );
    expect(r.kind).toBe('settled');
    if (r.kind !== 'settled') throw new Error('unreachable');
    expect(r.result).toBe('answered');
    expect(r.next.voiceState).toBe('answered');
  });

  it('応答後に遅れて届いた ringing で巻き戻さない', () => {
    const r = advanceFromWebhook(
      progress({ voiceState: 'awaiting_acceptance' }),
      { kind: 'status', status: 'ringing' },
      'ev-3',
      POLICIES,
    );
    expect(r.kind).toBe('in_progress');
    if (r.kind !== 'in_progress') throw new Error('unreachable');
    expect(r.next.voiceState).toBe('awaiting_acceptance');
  });

  it('冪等キーには渡された provider イベント ID を使う（別 ID なら重複にしない）', () => {
    // jti を渡していないと、どの ID でも同じ鍵になり全イベントが重複判定される
    // （＝取次が永久に進まない）か、逆に重複を検出できなくなる。
    const first = advanceFromWebhook(progress(), { kind: 'status', status: 'unanswered' }, 'jti-A', POLICIES);
    if (first.kind !== 'dial') throw new Error('unreachable');
    const other = advanceFromWebhook(
      { ...progress(), position: first.next.position },
      { kind: 'status', status: 'unanswered' },
      'jti-B',
      POLICIES,
    );
    expect(other.kind).toBe('dial');
  });

  it('hop 上限に達したら確定して鳴らし続けない', () => {
    const capped = advanceFromWebhook(
      progress(),
      { kind: 'status', status: 'unanswered' },
      'ev-1',
      POLICIES,
      { maxHops: 1 },
    );
    expect(capped.kind).toBe('settled');
    if (capped.kind !== 'settled') throw new Error('unreachable');
    expect(capped.reason).toBe('max_hops_exceeded');
    expect(capped.next.settled).toBe(true);
  });

  it('1 通話あたりのイベント数に上限を設ける（ledger の無制限な伸びを止める）', () => {
    // 署名が正当でも、同一通話へイベントを流し続けられると position.ledger が
    // 無制限に伸びる。ledger は相関ごと DynamoDB へ書かれるので item サイズ上限
    // （400KB）に向かって育ち、書き込みも 1 件ずつ発生する。上限で打ち切る。
    const r = advanceFromWebhook(
      progress({ eventCount: 100 }),
      { kind: 'status', status: 'ringing' },
      'ev-flood',
      POLICIES,
      { maxEvents: 100 },
    );
    expect(r).toEqual({ kind: 'ignored', reason: 'rate_limited' });
  });

  it('上限内なら処理し、イベント数を数える', () => {
    const r = advanceFromWebhook(
      progress({ eventCount: 3 }),
      { kind: 'status', status: 'ringing' },
      'ev-1',
      POLICIES,
      { maxEvents: 100 },
    );
    expect(r.kind).toBe('in_progress');
    if (r.kind !== 'in_progress') throw new Error('unreachable');
    // 数えていないと上限に永久に到達せず、制限が無いのと同じになる。
    expect(r.next.eventCount).toBe(4);
  });

  it('確定するイベントも数える（確定経路だけ数え漏らさない）', () => {
    const r = advanceFromWebhook(
      progress({ eventCount: 1 }),
      { kind: 'dtmf', choice: 'coming' },
      'ev-1',
      POLICIES,
    );
    expect(r.kind).toBe('settled');
    if (r.kind !== 'settled') throw new Error('unreachable');
    expect(r.next.eventCount).toBe(2);
  });
});
