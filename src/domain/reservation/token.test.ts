import { describe, expect, it } from 'vitest';
import {
  RESERVATION_TOKEN_BYTES,
  RESERVATION_TOKEN_QUERY,
  buildReservationCheckinUrl,
  generateReservationToken,
  parseReservationCheckinUrl,
} from './token';

describe('generateReservationToken (#97)', () => {
  it('base64url で十分な長さ（256bit → 43 文字）を持つ', () => {
    const token = generateReservationToken();
    // 32 バイトの base64url はパディングなしで 43 文字。
    expect(token).toHaveLength(43);
    expect(token).toMatch(/^[A-Za-z0-9_-]+$/);
    expect(RESERVATION_TOKEN_BYTES).toBe(32);
  });

  it('一意性: 多数生成しても衝突しない', () => {
    const set = new Set<string>();
    for (let i = 0; i < 10_000; i++) set.add(generateReservationToken());
    expect(set.size).toBe(10_000);
  });

  it('個人情報を含まない（ランダム英数字のみ）', () => {
    const token = generateReservationToken();
    expect(token).not.toContain('@');
    expect(token).not.toMatch(/\s/);
  });
});

describe('QR payload URL (#97)', () => {
  it('token のみを参照する URL を組み立てる（PII を載せない）', () => {
    const token = generateReservationToken();
    const url = buildReservationCheckinUrl('https://reception.example.com/', token);
    expect(url).toBe(`https://reception.example.com/kiosk/checkin?${RESERVATION_TOKEN_QUERY}=${token}`);
    expect(url).not.toContain('//kiosk');
  });

  it('URL から token を復元できる', () => {
    const token = generateReservationToken();
    const url = buildReservationCheckinUrl('https://x.example', token);
    expect(parseReservationCheckinUrl(url)).toBe(token);
  });

  it('不正な URL は null', () => {
    expect(parseReservationCheckinUrl('not a url')).toBeNull();
    expect(parseReservationCheckinUrl('https://x.example/kiosk/checkin')).toBeNull();
  });
});
