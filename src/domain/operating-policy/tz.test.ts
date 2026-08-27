import { describe, expect, it } from 'vitest';
import {
  DEFAULT_TIMEZONE,
  addDaysToYmd,
  getZonedParts,
  isValidTimeZone,
  mmddKey,
  previousWeekday,
  weekdayPlusDays,
  ymdKey,
  zonedTimeToUtcMs,
} from './tz';

describe('isValidTimeZone', () => {
  it('既知の IANA タイムゾーンは true', () => {
    expect(isValidTimeZone('Asia/Tokyo')).toBe(true);
    expect(isValidTimeZone('UTC')).toBe(true);
  });

  it('不正な文字列や空文字は false', () => {
    expect(isValidTimeZone('Not/A/Zone')).toBe(false);
    expect(isValidTimeZone('')).toBe(false);
  });

  /**
   * 🔴 **生のオフセット文字列を受理しない** (#800)。
   *
   * `Intl.DateTimeFormat` は Node 22 / ES2024 で `±23:59` までの生オフセットを**受理する**
   * （実測済み）。だが営業時間の判定は**名前付きゾーンであること**を前提にしている:
   *
   * - **DST が無い。** `America/Los_Angeles` の拠点が `-08:00` で保存されると夏の間ずっと 1h ずれる
   * - **曜日の境界がずれる。** `evaluateOperatingStatus` は現地日付から曜日を引く
   * - **判定不能の窓が倍になる。** `TIMEZONE_BOUNDS` が ±23:59 まで広がる（26h → 48h）
   */
  it('🔴 生のオフセット文字列は false（DST が効かないので営業時間の前提が壊れる）', () => {
    for (const raw of ['+09:00', '-08:00', '+18:00', '-23:59', '+00:00', '-05:30', '+0900', '09:00']) {
      expect(isValidTimeZone(raw), `${raw} を受理してはいけない`).toBe(false);
    }
  });

  /**
   * **通すべきものを通す。** 名前付きゾーンを巻き込むと、拠点が営業ポリシーを保存できなくなる。
   *
   * ここが実質の難所だった: `Intl.supportedValuesOf('timeZone')` による許可リストは
   * **`UTC` も `Etc/*` も小文字形も含まない**（実測: 418 件のうち `UTC` は無い）。
   * 許可リストで実装すると、**今日 `Intl` が受理していて既に保存されうる値**を弾く。
   * だから「`UTC` か、`/` を含む実在ゾーン」で判定する。
   */
  it('名前付きゾーンは通す（許可リスト方式だと弾かれるものを含む）', () => {
    for (const named of [
      'Asia/Tokyo',
      'America/Los_Angeles',
      'UTC',
      'Etc/UTC', // supportedValuesOf に無い
      'Etc/GMT+5', // 同上。名前付きだが固定オフセット
      'asia/tokyo', // Intl は大小文字を問わない。既存レコードにありうる
    ]) {
      expect(isValidTimeZone(named), `${named} は通すべき`).toBe(true);
    }
  });

  /**
   * 生オフセットを弾く実装が **`/` の有無だけ**を見ていないこと。
   * `Not/A/Zone` は既に上で見ているが、**オフセットに `/` を混ぜた形**も塞ぐ。
   */
  it('`/` を含んでいても実在しないゾーンは false', () => {
    expect(isValidTimeZone('+09:00/Tokyo')).toBe(false);
    expect(isValidTimeZone('Etc/+09:00')).toBe(false);
  });
});

describe('getZonedParts', () => {
  it('UTC の深夜0時を Asia/Tokyo の午前9時（同日）へ変換する', () => {
    // 2026-07-22T00:00:00Z は Asia/Tokyo(+09:00) で 2026-07-22 09:00:00 (水)
    const ms = Date.UTC(2026, 6, 22, 0, 0, 0);
    const zoned = getZonedParts(ms, 'Asia/Tokyo');
    expect(zoned).toEqual({ year: 2026, month: 7, day: 22, hour: 9, minute: 0, second: 0, weekday: 'wed' });
  });

  it('日跨ぎ: UTC 15:30 は Asia/Tokyo で翌日 0:30', () => {
    // 2026-07-22T15:30:00Z → 2026-07-23 00:30:00 (木)
    const ms = Date.UTC(2026, 6, 22, 15, 30, 0);
    const zoned = getZonedParts(ms, 'Asia/Tokyo');
    expect(zoned).toEqual({ year: 2026, month: 7, day: 23, hour: 0, minute: 30, second: 0, weekday: 'thu' });
  });
});

describe('zonedTimeToUtcMs', () => {
  it('Asia/Tokyo 現地 09:00 を UTC epoch へ変換する（往復一致）', () => {
    const ms = zonedTimeToUtcMs({ year: 2026, month: 7, day: 22, hour: 9, minute: 0 }, 'Asia/Tokyo');
    expect(ms).toBe(Date.UTC(2026, 6, 22, 0, 0, 0));
  });

  it('変換結果を再度 getZonedParts すると同じ現地日時に戻る（往復整合）', () => {
    const local = { year: 2026, month: 1, day: 1, hour: 0, minute: 0 };
    const ms = zonedTimeToUtcMs(local, 'Asia/Tokyo');
    const back = getZonedParts(ms, 'Asia/Tokyo');
    expect(back).toMatchObject(local);
  });
});

describe('addDaysToYmd', () => {
  it('月またぎを正しく繰り上げる', () => {
    expect(addDaysToYmd({ year: 2026, month: 1, day: 31 }, 1)).toEqual({ year: 2026, month: 2, day: 1 });
  });

  it('年またぎ（年末年始）を正しく繰り上げる', () => {
    expect(addDaysToYmd({ year: 2025, month: 12, day: 31 }, 1)).toEqual({ year: 2026, month: 1, day: 1 });
  });

  it('負の delta で前日へ戻せる', () => {
    expect(addDaysToYmd({ year: 2026, month: 3, day: 1 }, -1)).toEqual({ year: 2026, month: 2, day: 28 });
  });
});

describe('previousWeekday / weekdayPlusDays', () => {
  it('previousWeekday は巡回する（mon の前日は sun）', () => {
    expect(previousWeekday('mon')).toBe('sun');
    expect(previousWeekday('wed')).toBe('tue');
  });

  it('weekdayPlusDays は 7 日で一周する', () => {
    expect(weekdayPlusDays('mon', 7)).toBe('mon');
    expect(weekdayPlusDays('fri', 3)).toBe('mon');
  });
});

describe('ymdKey / mmddKey', () => {
  it('0埋めした YYYY-MM-DD / MM-DD を返す', () => {
    expect(ymdKey({ year: 2026, month: 1, day: 3 })).toBe('2026-01-03');
    expect(mmddKey({ year: 2026, month: 1, day: 3 })).toBe('01-03');
  });
});

it('DEFAULT_TIMEZONE は Asia/Tokyo', () => {
  expect(DEFAULT_TIMEZONE).toBe('Asia/Tokyo');
});
