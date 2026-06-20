import { beforeEach, describe, expect, it } from 'vitest';
import { __resetSecurity, getSecuritySettings, updateSecuritySettings, verifyPin } from './security-store';

beforeEach(async () => {
  await __resetSecurity();
});

describe('security-store (#23 #29)', () => {
  it('既定では PIN 不要', async () => {
    expect((await getSecuritySettings()).pinRequired).toBe(false);
  });

  it('PIN 不要なら任意の入力で許可', async () => {
    expect(await verifyPin('')).toBe(true);
  });

  it('PIN 必須に変更し、一致のみ許可する', async () => {
    await updateSecuritySettings({ pinRequired: true, pin: '1234' });
    expect(await verifyPin('1234')).toBe(true);
    expect(await verifyPin('9999')).toBe(false);
  });

  it('IP 許可リストを更新できる', async () => {
    const updated = await updateSecuritySettings({ ipAllowlist: ['10.0.0.1', ' 10.0.0.2 '] });
    expect(updated.ipAllowlist).toEqual(['10.0.0.1', '10.0.0.2']);
  });

  it('緊急停止は既定 false、切り替えできる', async () => {
    expect((await getSecuritySettings()).emergencyStop).toBe(false);
    expect((await updateSecuritySettings({ emergencyStop: true })).emergencyStop).toBe(true);
  });
});
