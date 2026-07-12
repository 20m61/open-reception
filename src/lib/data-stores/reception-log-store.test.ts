import { beforeEach, describe, expect, it } from 'vitest';
import {
  __resetStore,
  cancelReception,
  completeReception,
  createReception,
  recordFallback,
  startCall,
} from './reception-store';
import {
  __resetLogStore,
  appendAdminAudit,
  listAuditLogs,
  listReceptionLogs,
  recordSatisfactionFeedback,
} from './reception-log-store';

const baseInput = {
  kioskId: 'kiosk-1',
  purpose: 'meeting',
  targetType: 'staff' as const,
  targetId: 'staff-sato',
  targetLabel: '佐藤 太郎',
  visitor: { name: '来客 一郎', company: 'ACME', note: '内密の用件' },
};

beforeEach(async () => {
  await __resetStore();
  await __resetLogStore();
});

async function runReception(targetId: string, targetLabel: string) {
  const created = await createReception({ ...baseInput, targetId, targetLabel });
  if (!created.ok) throw new Error('create failed');
  await startCall(created.value.id);
  return created.value.id;
}

describe('reception history logging (#19)', () => {
  it('未応答を受付履歴に記録する', async () => {
    await runReception('staff-suzuki', '鈴木 花子');
    const logs = await listReceptionLogs();
    expect(logs).toHaveLength(1);
    expect(logs[0]?.outcome).toBe('timeout');
  });

  it('失敗を受付履歴に記録し失敗理由を残す', async () => {
    await runReception('staff-takahashi', '高橋 健');
    const logs = await listReceptionLogs();
    expect(logs[0]?.outcome).toBe('failed');
    expect(logs[0]?.failureReason).toBe('call_failed');
  });

  it('成功は完了時に記録する', async () => {
    const id = await runReception('staff-sato', '佐藤 太郎');
    expect(await listReceptionLogs()).toHaveLength(0); // connected だけではまだ履歴化しない
    await completeReception(id);
    const logs = await listReceptionLogs();
    expect(logs).toHaveLength(1);
    expect(logs[0]?.outcome).toBe('connected');
  });

  it('キャンセルを記録する', async () => {
    const created = await createReception(baseInput);
    if (!created.ok) return;
    await cancelReception(created.value.id);
    expect((await listReceptionLogs())[0]?.outcome).toBe('cancelled');
  });

  it('受付履歴に来訪者の個人情報を含めない', async () => {
    await runReception('staff-suzuki', '鈴木 花子');
    const serialized = JSON.stringify(await listReceptionLogs());
    expect(serialized).not.toContain('来客 一郎');
    expect(serialized).not.toContain('ACME');
    expect(serialized).not.toContain('内密の用件');
  });

  it('所要時間を記録する', async () => {
    await runReception('staff-suzuki', '鈴木 花子');
    expect((await listReceptionLogs())[0]?.durationMs).toBeGreaterThanOrEqual(0);
  });

  it('代替導線の利用を記録する', async () => {
    const id = await runReception('staff-suzuki', '鈴木 花子');
    const r = await recordFallback(id);
    expect(r.ok && r.value.state).toBe('fallback');
    expect((await listReceptionLogs())[0]?.fallbackUsed).toBe(true);
  });

  it('監査ログに受付イベントを残す', async () => {
    await runReception('staff-suzuki', '鈴木 花子');
    const audit = await listAuditLogs();
    expect(audit.some((a) => a.action === 'reception.timeout')).toBe(true);
    expect(audit[0]?.actor).toBe('kiosk:kiosk-1');
  });

  it('監査ログのメタデータに来訪目的を残す（PII ではないカテゴリ）(#100)', async () => {
    await runReception('staff-suzuki', '鈴木 花子');
    const entry = (await listAuditLogs()).find((a) => a.action === 'reception.timeout');
    expect(entry?.metadata?.purpose).toBe('meeting');
  });

  it('完了イベントを監査ログに残す', async () => {
    const id = await runReception('staff-sato', '佐藤 太郎');
    await completeReception(id);
    const audit = await listAuditLogs();
    expect(audit.some((a) => a.action === 'reception.completed')).toBe(true);
  });

  it('管理操作を監査ログに残す（actor=admin）', async () => {
    await appendAdminAudit('department.created', { type: 'department', id: 'dept-x' });
    const entry = (await listAuditLogs())[0];
    expect(entry?.action).toBe('department.created');
    expect(entry?.actor).toBe('admin');
    expect(entry?.targetId).toBe('dept-x');
  });
});

describe('受付体験メトリクスの終端ログ引き継ぎ (#319)', () => {
  const experience = {
    stepDurations: { selectingPurpose: 1200, selectingTarget: 3400, confirming: 800, calling: 100 },
    timeToCallMs: 12000,
    backCount: 1,
    inputMethod: 'stt' as const,
  };

  it('作成時の experience を終端 ReceptionLog へ引き継ぐ（30 秒/ファネル/入力手段）', async () => {
    const created = await createReception({ ...baseInput, experience });
    if (!created.ok) throw new Error('create failed');
    // create 時点でセッションに保持されている。
    expect(created.value.experience).toEqual(experience);
    await cancelReception(created.value.id);
    const log = (await listReceptionLogs())[0];
    expect(log?.experience).toEqual(experience);
    // 30 秒 KPI・ファネル・入力手段が読める。
    expect(log?.experience?.timeToCallMs).toBe(12000);
    expect(log?.experience?.stepDurations?.selectingTarget).toBe(3400);
    expect(log?.experience?.inputMethod).toBe('stt');
  });

  it('experience 無しでも作成・記録できる（後方互換）', async () => {
    const created = await createReception(baseInput);
    if (!created.ok) throw new Error('create failed');
    expect(created.value.experience).toBeUndefined();
    await cancelReception(created.value.id);
    expect((await listReceptionLogs())[0]?.experience).toBeUndefined();
  });

  it('未知キー・PII を含む experience はサニタイズされ、そのまま保存されない', async () => {
    const created = await createReception({
      ...baseInput,
      experience: {
        timeToCallMs: 9000,
        inputMethod: 'touch',
        // 以下は破棄されるべき: 未知キー・PII・不正値。
        visitorName: '来客 一郎',
        company: 'ACME',
        note: '内密の用件',
        cancelCount: -5,
        inputMethodExtra: 'keyboard',
        stepDurations: { selectingPurpose: 500, bogusStep: 999 },
      } as unknown as Record<string, unknown>,
    });
    if (!created.ok) throw new Error('create failed');
    await cancelReception(created.value.id);
    const log = (await listReceptionLogs())[0];
    expect(log?.experience).toEqual({
      timeToCallMs: 9000,
      inputMethod: 'touch',
      stepDurations: { selectingPurpose: 500 },
    });
    // PII・未知キーは受付履歴に一切残らない。
    const serialized = JSON.stringify(await listReceptionLogs());
    expect(serialized).not.toContain('来客 一郎');
    expect(serialized).not.toContain('ACME');
    expect(serialized).not.toContain('内密の用件');
    expect(serialized).not.toContain('bogusStep');
    expect(serialized).not.toContain('keyboard');
  });
});

describe('ワンタップ満足度フィードバック (#320)', () => {
  it('評価値のみを記録できる', async () => {
    const id = await runReception('staff-sato', '佐藤 太郎');
    await completeReception(id);
    const result = await recordSatisfactionFeedback(id, 'kiosk-1', { rating: 'happy' });
    expect(result.ok).toBe(true);
    const log = (await listReceptionLogs())[0];
    expect(log?.satisfactionRating).toBe('happy');
    expect(log?.feedbackReasonCodes).toBeUndefined();
  });

  it('評価値 + 理由コードを記録できる', async () => {
    const id = await runReception('staff-suzuki', '鈴木 花子'); // timeout
    const result = await recordSatisfactionFeedback(id, 'kiosk-1', {
      rating: 'unhappy',
      reasonCodes: ['waitTooLong', 'staffUnavailable'],
    });
    expect(result.ok).toBe(true);
    const log = (await listReceptionLogs())[0];
    expect(log?.satisfactionRating).toBe('unhappy');
    expect(log?.feedbackReasonCodes).toEqual(['waitTooLong', 'staffUnavailable']);
  });

  it('監査ログに評価値・理由コードのみを残す（PII なし）', async () => {
    const id = await runReception('staff-sato', '佐藤 太郎');
    await completeReception(id);
    await recordSatisfactionFeedback(id, 'kiosk-1', { rating: 'neutral', reasonCodes: ['hardToOperate'] });
    const entry = (await listAuditLogs()).find((a) => a.action === 'reception.feedback_submitted');
    expect(entry).toBeDefined();
    expect(entry?.actor).toBe('kiosk:kiosk-1');
    expect(entry?.metadata?.rating).toBe('neutral');
    expect(entry?.metadata?.reasonCodes).toBe('hardToOperate');
    const serialized = JSON.stringify(await listAuditLogs());
    expect(serialized).not.toContain('来客 一郎');
  });

  it('不正な入力（評価値なし・未知列挙）は invalid_input で拒否し記録しない', async () => {
    const id = await runReception('staff-sato', '佐藤 太郎');
    await completeReception(id);
    const result = await recordSatisfactionFeedback(id, 'kiosk-1', { rating: 'very happy' });
    expect(result).toEqual({ ok: false, error: 'invalid_input' });
    expect((await listReceptionLogs())[0]?.satisfactionRating).toBeUndefined();
  });

  it('存在しない receptionId は not_found', async () => {
    const result = await recordSatisfactionFeedback('no-such-reception', 'kiosk-1', { rating: 'happy' });
    expect(result).toEqual({ ok: false, error: 'not_found' });
  });

  it('別 kiosk からのフィードバックは forbidden（所有権チェック）', async () => {
    const id = await runReception('staff-sato', '佐藤 太郎');
    await completeReception(id);
    const result = await recordSatisfactionFeedback(id, 'kiosk-2', { rating: 'happy' });
    expect(result).toEqual({ ok: false, error: 'forbidden' });
    expect((await listReceptionLogs())[0]?.satisfactionRating).toBeUndefined();
  });
});
