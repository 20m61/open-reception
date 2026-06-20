import { describe, expect, it } from 'vitest';
import { extractReservationToken } from './payload';

describe('extractReservationToken (issue #98)', () => {
  it('#97 の checkin URL から token を取り出す', () => {
    const t = extractReservationToken('https://example.com/kiosk/checkin?rt=abc-123_XYZ');
    expect(t).toBe('abc-123_XYZ');
  });

  it('生の base64url token を受け付ける', () => {
    expect(extractReservationToken('abcDEF123-_')).toBe('abcDEF123-_');
  });

  it('前後の空白を除去する', () => {
    expect(extractReservationToken('  tok123  ')).toBe('tok123');
  });

  it('空文字・空白のみは null', () => {
    expect(extractReservationToken('')).toBeNull();
    expect(extractReservationToken('   ')).toBeNull();
  });

  it('rt クエリの無い URL は null（不正 QR）', () => {
    expect(extractReservationToken('https://example.com/kiosk/checkin')).toBeNull();
    expect(extractReservationToken('https://evil.example.com/?foo=bar')).toBeNull();
  });

  it('token に記号が混入したら null', () => {
    expect(extractReservationToken('tok!@#')).toBeNull();
    expect(extractReservationToken('tok with space')).toBeNull();
  });

  it('URL らしき生文字列（rt なし）は token として扱わない', () => {
    expect(extractReservationToken('foo/bar')).toBeNull();
    expect(extractReservationToken('a?b')).toBeNull();
  });
});
