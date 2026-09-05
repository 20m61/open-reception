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

  /**
   * 🔴 **`Intl.DateTimeFormat` の構築はタイムゾーンごとに 1 度だけ (#952)。**
   *
   * 構築は `formatToParts` の **13 倍**重い（実測 115.4µs vs 8.7µs / 呼び出し）。
   * `zonedTimeToUtcMs` は 1 変換につき `getZonedParts` を 2 回呼ぶので、営業時間の判定は
   * 呼び出しのたびにこれを払っていた。結果、`src/lib/runtime-policy/store.test.ts` の
   * 総当たり 1 本（`resolveServiceStates` を約 1,958 回叩く）が **3,743ms** に達し、
   * vitest 既定の `testTimeout: 5000ms` に対して余裕が 25% しか無くなって、
   * ローカル macOS では負荷次第で**アサーションに到達する前に落ちて**いた。
   *
   * **壁時計をアサートしない**（負荷に依存して flaky になる）。代わりに、遅さの
   * **原因である構築回数**を数える —— こちらは負荷に依らない事実である。
   */
  it('同じタイムゾーンへの繰り返し呼び出しで Intl.DateTimeFormat を作り直さない (#952)', () => {
    const Original = Intl.DateTimeFormat;
    let constructed = 0;
    const spy = function (this: unknown, ...args: ConstructorParameters<typeof Intl.DateTimeFormat>) {
      constructed += 1;
      return new Original(...args);
    } as unknown as typeof Intl.DateTimeFormat;
    spy.supportedLocalesOf = Original.supportedLocalesOf;
    Intl.DateTimeFormat = spy;
    try {
      for (let i = 0; i < 50; i++) getZonedParts(Date.UTC(2026, 6, 22, i % 24, 0, 0), 'Asia/Tokyo');
      expect(constructed).toBeLessThanOrEqual(1);
      // **下界**: 別のタイムゾーンには別の formatter が要る。`constructed` を常に 0 に
      // する変異（＝何も構築しない＝壊れている）をここで落とす。
      const before = constructed;
      getZonedParts(Date.UTC(2026, 6, 22, 0, 0, 0), 'America/Los_Angeles');
      expect(constructed).toBe(before + 1);
    } finally {
      Intl.DateTimeFormat = Original;
    }
  });

  /**
   * 🔴 **キャッシュは上限を持つ (#952)。**
   *
   * `timeZone` は保存済みのテナント設定から来る文字列で、`getZonedParts` 自身は検証しない
   * （`isValidTimeZone` を通らない生オフセットも到達する）。上限が無いと長命な Lambda で
   * **入力の異なり数だけ増え続ける**。上限そのものをテストしないと、次に触る人が黙って
   * 外せてしまう —— 効果が「メモリが増える」だけで、どのテストも赤くならないからである。
   */
  it('キャッシュは無制限に増えない（上限を超えたら捨てる）(#952)', () => {
    const Original = Intl.DateTimeFormat;
    let constructed = 0;
    const spy = function (this: unknown, ...args: ConstructorParameters<typeof Intl.DateTimeFormat>) {
      constructed += 1;
      return new Original(...args);
    } as unknown as typeof Intl.DateTimeFormat;
    spy.supportedLocalesOf = Original.supportedLocalesOf;
    Intl.DateTimeFormat = spy;
    try {
      const ms = Date.UTC(2026, 6, 22, 0, 0, 0);
      // `Intl` は生オフセットを ±23:59 まで受理する。異なりを 70 個作って上限を越えさせる。
      const first = '+00:01';
      getZonedParts(ms, first);
      for (let i = 2; i <= 70; i++) {
        getZonedParts(ms, `+${String(Math.floor(i / 60)).padStart(2, '0')}:${String(i % 60).padStart(2, '0')}`);
      }
      const before = constructed;
      // 上限で捨てられているので、最初のゾーンは作り直しになる。
      getZonedParts(ms, first);
      expect(constructed).toBe(before + 1);
    } finally {
      Intl.DateTimeFormat = Original;
    }
  });

  /**
   * 🔴 **キャッシュしてよいのは formatter であって、結果ではない。**
   *
   * `Intl.DateTimeFormat` は瞬間を保持せず、瞬間は `formatToParts` の引数で渡る。
   * よってゾーンごとに使い回して安全である。**分解結果をキャッシュすると DST が壊れる** ——
   * その変異をここで落とす（同じゾーンでも夏と冬でオフセットが違う）。
   */
  it('formatter を使い回しても DST の切り替わりを取りこぼさない (#952)', () => {
    // America/Los_Angeles: 1 月は PST(-08:00)、7 月は PDT(-07:00)。
    const winter = getZonedParts(Date.UTC(2026, 0, 15, 20, 0, 0), 'America/Los_Angeles');
    const summer = getZonedParts(Date.UTC(2026, 6, 15, 20, 0, 0), 'America/Los_Angeles');
    expect(winter.hour).toBe(12);
    expect(summer.hour).toBe(13);
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

  /**
   * 🔴 **2nd pass（DST 境界の再補正）を縛る。**
   *
   * #952 の変異検証で**元から生存していた**穴。`return guess - offsetAt(candidate)` を
   * `return candidate` へ変えても、`src/domain/operating-policy/` と
   * `src/lib/runtime-policy/` の **149 本が全部緑のまま**だった（実測）。
   * 無 DST の `Asia/Tokyo` では 1st pass と 2nd pass が一致するので、
   * 既存のケースでは原理的に検出できない。
   *
   * 実害の経路: `expiresAtMs` → 一時 override の失効判定。DST 境界の前後 1 時間、
   * 「まだ有効」と「もう失効」が入れ替わる。
   *
   * America/Los_Angeles の 2026 年夏時間は 3/8 02:00 に PST(-08:00) → PDT(-07:00)。
   * 現地 03:00 は PDT なので UTC 10:00。1st pass は guess(03:00Z) 時点の PST を見て
   * 11:00Z を出すため、2nd pass が無いと 1 時間ずれる。
   */
  it('DST 開始日の現地時刻を、切り替わり後のオフセットで解決する', () => {
    const ms = zonedTimeToUtcMs(
      { year: 2026, month: 3, day: 8, hour: 3, minute: 0 },
      'America/Los_Angeles',
    );
    expect(ms).toBe(Date.UTC(2026, 2, 8, 10, 0, 0));
    // 対: 切り替わり前（同じ日の 01:00 は PST のまま）。片側だけ合う変異を落とす。
    expect(
      zonedTimeToUtcMs({ year: 2026, month: 3, day: 8, hour: 1, minute: 0 }, 'America/Los_Angeles'),
    ).toBe(Date.UTC(2026, 2, 8, 9, 0, 0));
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
