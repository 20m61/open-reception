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

/**
 * 指定値が**名前付き** IANA タイムゾーンとして解決できるか (#367 / #800)。
 *
 * 🔴 **`Intl` が通ることだけでは足りない。** Node 22 / ES2024 の `Intl.DateTimeFormat` は
 * **生のオフセット文字列（`±23:59` まで）も受理する**（実測）。営業時間の判定は
 * 名前付きゾーンであることを前提にしているので、生オフセットが保存されると壊れる:
 *
 * - **DST が無い。** `America/Los_Angeles` の拠点が `-08:00` で保存されると夏の間ずっと 1h ずれる
 * - **曜日の境界がずれる。** `evaluateOperatingStatus` は現地日付から曜日を引く
 * - **判定不能の窓が倍になる。** `src/lib/runtime-policy/store.ts` の `TIMEZONE_BOUNDS` は
 *   拠点 TZ の取りうる範囲を両端で近似しており、生オフセットを許すと ±23:59 まで広がる
 *
 * ## なぜ許可リストで実装しないか
 *
 * `Intl.supportedValuesOf('timeZone')` は**正準名だけ**を返す。実測すると 418 件の中に
 * **`UTC` が無く**、`Etc/*` も無く、`asia/tokyo` のような小文字形も無い。許可リストにすると
 * **今日 `Intl` が受理していて、既に保存されうる値**を弾いてしまう。加えて中身は ICU の
 * バージョンに依るので、環境によって判定が変わる。
 *
 * よって「**`UTC`、または `/` を含み、かつ `Intl` が実在ゾーンとして受理するもの**」で判定する。
 * 生オフセットは `/` を含まないので確実に落ち、`Foo/Bar` のような偽物は `Intl` が弾く。
 */
export function isValidTimeZone(timeZone: string): boolean {
  if (typeof timeZone !== 'string' || timeZone.trim() === '') return false;
  // 名前付きの形をしているか。`UTC` だけは `/` を持たない例外として明示的に通す
  // （`Intl` は大小文字を問わないので、こちらも問わない）。
  const named = timeZone.includes('/') || timeZone.toUpperCase() === 'UTC';
  if (!named) return false;
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

const ZONED_PARTS_FORMAT: Intl.DateTimeFormatOptions = {
  year: 'numeric',
  month: '2-digit',
  day: '2-digit',
  hour: '2-digit',
  minute: '2-digit',
  second: '2-digit',
  weekday: 'short',
  hour12: false,
};

/**
 * タイムゾーンごとの formatter キャッシュ (#952)。
 *
 * **キャッシュしてよいのは formatter だけで、分解結果ではない。** `Intl.DateTimeFormat` は
 * 瞬間を保持せず、瞬間は `formatToParts` の引数で渡るので、ゾーンごとに使い回して安全である
 * （結果をキャッシュすると DST が壊れる。`tz.test.ts` が両方を縛っている）。
 *
 * 🔴 **上限を持たせる。** `timeZone` は保存済みのテナント設定から来る文字列で、
 * `getZonedParts` 自身は検証しない（`isValidTimeZone` を通らない生オフセットも到達する。
 * 実際 `store.test.ts` は `±23:59` を流している）。長命な Lambda で無制限に生やすと
 * **入力次第で増え続ける**ので、超えたら丸ごと捨てる。LRU にしないのは、実運用の異なり数が
 * 数個で、溢れること自体が想定外だから —— 複雑な追い出し規則を持つほうが壊れやすい。
 */
const CACHE_LIMIT = 64;
const zonedPartsFormatters = new Map<string, Intl.DateTimeFormat>();

function zonedPartsFormatter(timeZone: string): Intl.DateTimeFormat {
  const cached = zonedPartsFormatters.get(timeZone);
  if (cached !== undefined) return cached;
  // 不正なゾーンはここで throw する（キャッシュ前なので、失敗を覚え込まない）。
  const dtf = new Intl.DateTimeFormat('en-US', { timeZone, ...ZONED_PARTS_FORMAT });
  if (zonedPartsFormatters.size >= CACHE_LIMIT) zonedPartsFormatters.clear();
  zonedPartsFormatters.set(timeZone, dtf);
  return dtf;
}

/** epoch ms を指定タイムゾーンの現地日時（曜日込み）へ分解する。 */
export function getZonedParts(ms: number, timeZone: string): ZonedParts {
  const parts = zonedPartsFormatter(timeZone).formatToParts(new Date(ms));
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
