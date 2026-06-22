import { describe, expect, it } from 'vitest';
import {
  auditActionForLifecycle,
  isTenantLifecycleAction,
  statusForLifecycleAction,
} from './tenant-lifecycle';

describe('tenant-lifecycle (#90)', () => {
  it('有効なアクションのみ受け付ける', () => {
    expect(isTenantLifecycleAction('suspend')).toBe(true);
    expect(isTenantLifecycleAction('activate')).toBe(true);
    expect(isTenantLifecycleAction('delete')).toBe(false);
    expect(isTenantLifecycleAction(undefined)).toBe(false);
  });

  it('アクション → 状態 を写像する', () => {
    expect(statusForLifecycleAction('suspend')).toBe('suspended');
    expect(statusForLifecycleAction('activate')).toBe('active');
  });

  it('アクション → 監査アクション を写像する', () => {
    expect(auditActionForLifecycle('suspend')).toBe('tenant.suspended');
    expect(auditActionForLifecycle('activate')).toBe('tenant.activated');
  });
});
