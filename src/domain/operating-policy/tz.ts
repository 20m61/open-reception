/**
 * タイムゾーン変換の純ヘルパ (issue #367)。
 *
 * `ServiceOperatingPolicy` は「テナント/サイトの現地時刻」で曜日別営業時間を表現するため、
 * UTC epoch ↔ IANA タイムゾーンの現地日時を相互変換する必要がある。外部ライブラリ
 * （date-fns-tz 等）は追加せず、Node/ブラウザ標準の `Intl.DateTimeFormat` だけで実装する
 * （#105 ライセンス/依存追加チェックを避ける）。
 *
 * `zonedTimeToUtcMs` は「未知オフセットの現地時刻 → UTC」変換で、素朴には反復法が要る問題を
 * 2 回の往復（guess → 実際のオフセットで補正）で解く一般的な手法。Asia/Tokyo は DST が無いため
 * 1 回の補正で厳密に正しいが、他タイムゾーンでの将来利用に備えて 2 回目の検算を行う。
 */

export type Weekday = 'mon' | 'tue' | 'wed' | 'thu' | 'fri' | 'sat' | 'sun';

/** 月曜始まり。曜日インデックス計算はこの並びに依存する。 */
export const WEEKDAYS: readonly Weekday[] = ['mon', 'tue', 'wed', 'thu', 'fri', 'sat', 'sun'];

/** 既定タイムゾーン（issue #367 の受け入れ条件）。 */
export const DEFAULT_TIMEZONE = 'Asia/Tokyo';

export type ZonedParts = {
  year: number;
  month: number; // 1-12
  day: number; // 1-31
  hour: number; // 0-23
  minute: number;
  second: number;
  weekday: Weekday;
};

type YearMonthDay = { year: number; month: number; day: number };

const WEEKDAY_MAP: Record<string, Weekday> = {
  Mon: 'mon',
  Tue: 'tue',
  Wed: 'wed',
  Thu: 'thu',
  Fri: 'fri',
  Sat: 'sat',
  Sun: 'sun',
};

/** 指定 IANA タイムゾーン名が `Intl` で解決できるか。 */
export function isValidTimeZone(timeZone: string): boolean {
  if (typeof timeZone !== 'string' || timeZone.trim() === '') return false;
  try {
    new Intl.DateTimeFormat('en-US', { timeZone });
    return true;
  } catch {
    return false;
  }
}

function part(parts: Intl.DateTimeFormatPart[], type: Intl.DateTimeFormatPartTypes): string {
  return parts.find((p) => p.type === type)?.value ?? '';
}

/** epoch ms を指定タイムゾーンの現地日時（曜日込み）へ分解する。 */
export function getZonedParts(ms: number, timeZone: string): ZonedParts {
  const dtf = new Intl.DateTimeFormat('en-US', {
    timeZone,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
    weekday: 'short',
    hour12: false,
  });
  const parts = dtf.formatToParts(new Date(ms));
  // hour12:false でも実装によっては深夜 0 時を "24" と表す場合がある（正規化する）。
  let hour = Number(part(parts, 'hour'));
  if (hour === 24) hour = 0;
  const weekdayRaw = part(parts, 'weekday');
  return {
    year: Number(part(parts, 'year')),
    month: Number(part(parts, 'month')),
    day: Number(part(parts, 'day')),
    hour,
    minute: Number(part(parts, 'minute')),
    second: Number(part(parts, 'second')),
    weekday: WEEKDAY_MAP[weekdayRaw] ?? 'mon',
  };
}

/**
 * 「タイムゾーン timeZone における現地日時」を UTC epoch ms へ変換する。
 * オフセット未知のため、まず UTC とみなした暫定値を作り、その暫定値が実際に timeZone で
 * どの現地日時になるかを見て差分だけ補正する（2 回目は検算）。
 */
export function zonedTimeToUtcMs(
  local: { year: number; month: number; day: number; hour: number; minute: number },
  timeZone: string,
): number {
  const guess = Date.UTC(local.year, local.month - 1, local.day, local.hour, local.minute, 0);
  // ms 時点の実オフセット（UTC からの差分, 東側が正）を求める。
  const offsetAt = (ms: number): number => {
    const zoned = getZonedParts(ms, timeZone);
    const zonedAsUtc = Date.UTC(zoned.year, zoned.month - 1, zoned.day, zoned.hour, zoned.minute, 0);
    return zonedAsUtc - ms;
  };
  // 1st pass: guess 時点のオフセットで補正した候補。
  const candidate = guess - offsetAt(guess);
  // 2nd pass: 候補時点（DST 境界をまたぐ可能性がある）のオフセットで再補正する。
  // Asia/Tokyo のような無 DST タイムゾーンでは offsetAt(guess) と一致し不変。
  return guess - offsetAt(candidate);
}

/** 暦日の加算（年月日のみ。UTC の暦計算を使い、実在時刻の DST 等には依存しない）。 */
export function addDaysToYmd(ymd: YearMonthDay, deltaDays: number): YearMonthDay {
  const t = Date.UTC(ymd.year, ymd.month - 1, ymd.day) + deltaDays * 86_400_000;
  const d = new Date(t);
  return { year: d.getUTCFullYear(), month: d.getUTCMonth() + 1, day: d.getUTCDate() };
}

/** 前日の曜日（WEEKDAYS の並びに沿った巡回）。 */
export function previousWeekday(weekday: Weekday): Weekday {
  const idx = WEEKDAYS.indexOf(weekday);
  return WEEKDAYS[(idx + WEEKDAYS.length - 1) % WEEKDAYS.length]!;
}

/** n 日後の曜日。 */
export function weekdayPlusDays(weekday: Weekday, days: number): Weekday {
  const idx = WEEKDAYS.indexOf(weekday);
  return WEEKDAYS[(idx + days) % WEEKDAYS.length]!;
}

function pad2(n: number): string {
  return String(n).padStart(2, '0');
}

/** "YYYY-MM-DD" 表現（exceptionDates のキー一致に使う）。 */
export function ymdKey(ymd: YearMonthDay): string {
  return `${ymd.year}-${pad2(ymd.month)}-${pad2(ymd.day)}`;
}

/** "MM-DD" 表現（fixedHolidays の毎年一致に使う）。 */
export function mmddKey(ymd: YearMonthDay): string {
  return `${pad2(ymd.month)}-${pad2(ymd.day)}`;
}
