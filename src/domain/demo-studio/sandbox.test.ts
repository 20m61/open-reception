import { describe, expect, it } from 'vitest';
import {
  DemoSandboxViolation,
  assertDemoRequestAllowed,
  isDemoAllowedUrl,
} from './sandbox';

const ORIGIN = 'https://kiosk.example.com';

describe('デモ sandbox 境界 (issue #363 最重要 AC: 本番 API/Vonage/集計を呼ばない)', () => {
  it('同一オリジンの /api/kiosk/* は許可し pathname+search を返す', () => {
    expect(assertDemoRequestAllowed('/api/kiosk/heartbeat?kioskId=x', ORIGIN)).toBe(
      '/api/kiosk/heartbeat?kioskId=x',
    );
    expect(assertDemoRequestAllowed(`${ORIGIN}/api/kiosk/receptions`, ORIGIN)).toBe(
      '/api/kiosk/receptions',
    );
  });

  it('本番集計・管理 API（/api/admin/* /api/platform/*）を遮断する', () => {
    for (const path of [
      '/api/admin/usage',
      '/api/admin/costs',
      '/api/admin/dashboard',
      '/api/platform/tenants',
    ]) {
      expect(() => assertDemoRequestAllowed(path, ORIGIN)).toThrow(DemoSandboxViolation);
    }
  });

  it('Vonage 等クロスオリジンの本番発信先を遮断する', () => {
    for (const url of [
      'https://api.nexmo.com/v1/calls',
      'https://api-eu.vonage.com/v0.1/calls',
      'http://kiosk.example.com/api/kiosk/heartbeat', // 別スキーム→別オリジン
      'https://evil.example.com/api/kiosk/heartbeat',
    ]) {
      expect(() => assertDemoRequestAllowed(url, ORIGIN)).toThrow(DemoSandboxViolation);
    }
  });

  it('kiosk 以外の同一オリジン API・パストラバーサルを遮断する', () => {
    expect(() => assertDemoRequestAllowed('/api/other', ORIGIN)).toThrow(DemoSandboxViolation);
    expect(() => assertDemoRequestAllowed('/api/kiosk/../admin/usage', ORIGIN)).toThrow(
      DemoSandboxViolation,
    );
  });

  it('isDemoAllowedUrl は throw せず boolean を返す', () => {
    expect(isDemoAllowedUrl('/api/kiosk/voice', ORIGIN)).toBe(true);
    expect(isDemoAllowedUrl('https://api.nexmo.com/v1/calls', ORIGIN)).toBe(false);
    expect(isDemoAllowedUrl('/api/admin/usage', ORIGIN)).toBe(false);
  });

  it('DemoSandboxViolation はブロックした URL を message に残す（機微値なし）', () => {
    try {
      assertDemoRequestAllowed('https://api.nexmo.com/v1/calls', ORIGIN);
      throw new Error('should have thrown');
    } catch (e) {
      expect(e).toBeInstanceOf(DemoSandboxViolation);
      expect((e as DemoSandboxViolation).blockedUrl).toBe('https://api.nexmo.com/v1/calls');
    }
  });
});
