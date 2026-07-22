import { describe, expect, it } from 'vitest';
import {
  operatingStateOf,
  parseReopenAt,
  type KioskOperatingStatus,
} from './operating-status';

describe('operatingStateOf (#367 営業時間外の受け口)', () => {
  it('未注入(undefined)は状態不明として undefined を返す（fail-open の判定材料）', () => {
    expect(operatingStateOf(undefined)).toBeUndefined();
  });

  it('open/closed をそのまま返す', () => {
    expect(operatingStateOf({ state: 'open' })).toBe('open');
    expect(operatingStateOf({ state: 'closed' })).toBe('closed');
  });

  it('不正な state は undefined へ倒す（fail-open: 判定不能は通常受付へ）', () => {
    const bad = { state: 'sleeping' } as unknown as KioskOperatingStatus;
    expect(operatingStateOf(bad)).toBeUndefined();
  });
});

describe('parseReopenAt (#367 再開時刻表示枠の入力整形)', () => {
  it('ISO8601 を epoch ms へ変換する', () => {
    expect(parseReopenAt('2026-07-22T09:00:00.000Z')).toBe(
      Date.parse('2026-07-22T09:00:00.000Z'),
    );
  });

  it('未設定・空・不正文字列は null（汎用文言へフォールバックさせる）', () => {
    expect(parseReopenAt(undefined)).toBeNull();
    expect(parseReopenAt('')).toBeNull();
    expect(parseReopenAt('   ')).toBeNull();
    expect(parseReopenAt('not-a-date')).toBeNull();
  });
});
