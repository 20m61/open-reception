/**
 * アップデート実行/ロールバックの純ロジック（plan・遷移）テスト (#290 item1)。
 *
 * 実デプロイ（#195/#65 外部待ち）は interface+mock 先行のため、本ドメインは「実行が許されるかの
 * 検証」と「デプロイ結果からの状態遷移」だけを純関数で固める（I/O・mock は lib 側）。
 */
import { describe, expect, it } from 'vitest';
import type { UpdateStatus } from './update-status';
import { planUpdateExecution, resultingUpdateStatus } from './update-execution';

const status = (over: Partial<UpdateStatus> = {}): UpdateStatus => ({
  id: 'up-1',
  scope: 'tenant',
  tenantId: 'acme',
  component: 'kiosk-app',
  currentVersion: '1.0.0',
  latestVersion: '1.1.0',
  state: 'update_available',
  checkedAt: '2026-07-01T00:00:00.000Z',
  updatedBy: 'platform:op',
  ...over,
});

const NOW = new Date('2026-07-02T00:00:00.000Z');

describe('planUpdateExecution — apply', () => {
  it('update_available は latestVersion への apply を計画する', () => {
    const r = planUpdateExecution(status(), 'apply');
    expect(r).toEqual({
      ok: true,
      plan: { id: 'up-1', action: 'apply', component: 'kiosk-app', fromVersion: '1.0.0', toVersion: '1.1.0' },
    });
  });

  it('failed からの再 apply も許す（latestVersion へ）', () => {
    expect(planUpdateExecution(status({ state: 'failed' }), 'apply').ok).toBe(true);
  });

  it('up_to_date は apply 不可', () => {
    const r = planUpdateExecution(status({ state: 'up_to_date', currentVersion: '1.1.0' }), 'apply');
    expect(r.ok).toBe(false);
  });

  it('updating 中は実行不可（apply も rollback も）', () => {
    expect(planUpdateExecution(status({ state: 'updating' }), 'apply').ok).toBe(false);
    expect(planUpdateExecution(status({ state: 'updating' }), 'rollback', { toVersion: '0.9.0' }).ok).toBe(false);
  });
});

describe('planUpdateExecution — rollback', () => {
  it('toVersion 指定で現行と異なれば rollback を計画する', () => {
    const r = planUpdateExecution(status(), 'rollback', { toVersion: '0.9.0' });
    expect(r).toEqual({
      ok: true,
      plan: { id: 'up-1', action: 'rollback', component: 'kiosk-app', fromVersion: '1.0.0', toVersion: '0.9.0' },
    });
  });

  it('toVersion 未指定は不可', () => {
    expect(planUpdateExecution(status(), 'rollback').ok).toBe(false);
  });

  it('toVersion が現行と同じは不可', () => {
    expect(planUpdateExecution(status(), 'rollback', { toVersion: '1.0.0' }).ok).toBe(false);
  });
});

describe('resultingUpdateStatus', () => {
  it('apply 成功で currentVersion=latest・state=up_to_date へ遷移', () => {
    const s = status();
    const plan = { id: 'up-1', action: 'apply' as const, component: 'kiosk-app', fromVersion: '1.0.0', toVersion: '1.1.0' };
    const next = resultingUpdateStatus(s, plan, { ok: true }, { now: NOW, operator: 'dev@example.com' });
    expect(next).toMatchObject({
      currentVersion: '1.1.0',
      state: 'up_to_date',
      checkedAt: '2026-07-02T00:00:00.000Z',
      updatedBy: 'dev@example.com',
    });
  });

  it('rollback 成功で latest 未満なら state=update_available（更新可能へ戻る）', () => {
    const s = status();
    const plan = { id: 'up-1', action: 'rollback' as const, component: 'kiosk-app', fromVersion: '1.0.0', toVersion: '0.9.0' };
    const next = resultingUpdateStatus(s, plan, { ok: true }, { now: NOW, operator: 'dev@example.com' });
    expect(next).toMatchObject({ currentVersion: '0.9.0', state: 'update_available' });
  });

  it('デプロイ失敗は state=failed（version は据え置き）', () => {
    const s = status();
    const plan = { id: 'up-1', action: 'apply' as const, component: 'kiosk-app', fromVersion: '1.0.0', toVersion: '1.1.0' };
    const next = resultingUpdateStatus(s, plan, { ok: false }, { now: NOW, operator: 'dev@example.com' });
    expect(next).toMatchObject({ currentVersion: '1.0.0', state: 'failed' });
  });
});
