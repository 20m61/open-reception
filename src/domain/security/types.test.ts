import { describe, expect, it } from 'vitest';
import { isIpAllowed, resolveKioskAccess } from './types';

describe('resolveKioskAccess (#23)', () => {
  it('失効端末は revoked', () => {
    expect(resolveKioskAccess({ active: false, pinRequired: true, authorized: false })).toBe('revoked');
  });
  it('PIN 必須かつ未認可は authorize', () => {
    expect(resolveKioskAccess({ active: true, pinRequired: true, authorized: false })).toBe('authorize');
  });
  it('PIN 認可済みは ready', () => {
    expect(resolveKioskAccess({ active: true, pinRequired: true, authorized: true })).toBe('ready');
  });
  it('PIN 不要は ready', () => {
    expect(resolveKioskAccess({ active: true, pinRequired: false, authorized: false })).toBe('ready');
  });
});

describe('isIpAllowed (#23)', () => {
  it('空リストは全許可', () => {
    expect(isIpAllowed('1.2.3.4', [])).toBe(true);
  });
  it('リスト内は許可', () => {
    expect(isIpAllowed('10.0.0.1', ['10.0.0.1'])).toBe(true);
  });
  it('リスト外は拒否', () => {
    expect(isIpAllowed('10.0.0.2', ['10.0.0.1'])).toBe(false);
  });
});
