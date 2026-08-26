/**
 * ServiceOperatingPolicy の純ロジック (issue #367)。
 *
 *   - `validatePolicyInput`: 信頼できない入力（admin API body）を検証し、保存可能な形へ正規化する。
 *     不正時間帯（逆転区間・不正フォーマット・矛盾する休業指定）は invalid_input として拒否する。
 *   - `evaluateOperatingStatus`: 指定時刻の open/closed と次回再開時刻（reopenAt）を返す純関数。
 *     曜日別営業時間・固定/単発休業日・タイムゾーンを考慮し、日跨ぎ区間（crossesMidnight）も扱う。
 *   - `resolveKioskOperatingStatus`: 評価結果を kiosk 契約（`@/domain/kiosk/operating-status`）の
 *     `KioskOperatingStatus` 形へ写像する。
 *
 * I/O は持たない。永続化・認可・監査は `src/lib/operating-policy/*` に委譲する。
 */
import type { KioskOperatingStatus } from '@/domain/kiosk/operating-status';
import {
  DEFAULT_TIMEZONE,
  WEEKDAYS,
  addDaysToYmd,
  getZonedParts,
  isValidTimeZone,
  mmddKey,
  previousWeekday,
  ymdKey,
  zonedTimeToUtcMs,
  type Weekday,
} from './tz';
import type { OperatingEvaluation, OperatingException, PolicyValidationIssue, ServiceOperatingPolicy, TimeRange } from './types';

export type StoredPolicyFields = Pick<
  ServiceOperatingPolicy,
  'timezone' | 'weeklySchedule' | 'fixedHolidays' | 'exceptionDates' | 'emergencyContactLabel'
>;

export type ValidationResult =
  | { ok: true; value: StoredPolicyFields }
  | { ok: false; error: { code: 'invalid_input'; message: string; issues: PolicyValidationIssue[] } };

const TIME_RE = /^([01]\d|2[0-3]):([0-5]\d)$/;
const MMDD_RE = /^(0[1-9]|1[0-2])-(0[1-9]|[12]\d|3[01])$/;
const YMD_RE = /^\d{4}-(0[1-9]|1[0-2])-(0[1-9]|[12]\d|3[01])$/;
const MAX_LABEL_LEN = 100;
const MAX_RANGES_PER_DAY = 12;
const MAX_EXCEPTIONS = 366;
const MAX_FIXED_HOLIDAYS = 366;

function isLeapYear(year: number): boolean {
  return year % 400 === 0 || (year % 4 === 0 && year % 100 !== 0);
}

/**
 * `YYYY-MM-DD` が書式だけでなく Gregorian calendar 上で実在するか。
 *
 * `new Date(...)` / `Date.UTC(...)` へ丸投げしない。JavaScript は不正日付を翌月へ
 * rollover し、0〜99 年には 1900 offset という別契約もあるため、入力検証の正本として
 * 使うと「書いた値」と「検証した値」がずれる。
 */
function isValidCalendarDate(value: string): boolean {
  if (!YMD_RE.test(value)) return false;
  const [yearText, monthText, dayText] = value.split('-');
  const year = Number(yearText);
  const month = Number(monthText);
  const day = Number(dayText);
  const daysInMonth = [31, isLeapYear(year) ? 29 : 28, 31, 30, 31, 30, 31, 31, 30, 31, 30, 31];
  return day <= daysInMonth[month - 1]!;
}

function parseTimeToMinutes(t: string): number | null {
  const m = TIME_RE.exec(t);
  if (!m) return null;
  return Number(m[1]) * 60 + Number(m[2]);
}

/** 1 レンジを検証する。issues に追記し、有効なら正規化済み値を返す。 */
function validateOneRange(raw: unknown, field: string, issues: PolicyValidationIssue[]): TimeRange | null {
  if (typeof raw !== 'object' || raw === null) {
    issues.push({ field, message: 'range must be an object' });
    return null;
  }
  const o = raw as Record<string, unknown>;
  const start = typeof o.start === 'string' ? o.start : '';
  const end = typeof o.end === 'string' ? o.end : '';
  const crossesMidnight = o.crossesMidnight === true;
  const startMin = parseTimeToMinutes(start);
  const endMin = parseTimeToMinutes(end);
  if (startMin === null || endMin === null) {
    issues.push({ field, message: 'start/end must be "HH:mm" (00:00-23:59)' });
    return null;
  }
  if (crossesMidnight) {
    if (endMin >= startMin) {
      issues.push({ field, message: 'crossesMidnight requires end < start (次日側の終了時刻)' });
      return null;
    }
  } else if (endMin <= startMin) {
    // 逆転区間（end <= start）。日跨ぎにしたい場合は crossesMidnight を明示する。
    issues.push({ field, message: 'end must be after start（逆転区間は crossesMidnight で明示すること）' });
    return null;
  }
  return { start, end, ...(crossesMidnight ? { crossesMidnight: true } : {}) };
}

/** 「今日側の区間」に射影した [start,end) で重複が無いかを検査する（crossesMidnight は end=1440 とみなす簡易判定）。 */
function hasOverlap(ranges: TimeRange[]): boolean {
  const spans = ranges
    .map((r) => {
      const s = parseTimeToMinutes(r.start)!;
      const e = r.crossesMidnight ? 1440 : parseTimeToMinutes(r.end)!;
      return [s, e] as const;
    })
    .sort((a, b) => a[0] - b[0]);
  for (let i = 1; i < spans.length; i++) {
    if (spans[i]![0] < spans[i - 1]![1]) return true;
  }
  return false;
}

function validateRangeList(raw: unknown, field: string, issues: PolicyValidationIssue[]): TimeRange[] | null {
  if (!Array.isArray(raw)) {
    issues.push({ field, message: 'must be an array of time ranges' });
    return null;
  }
  if (raw.length > MAX_RANGES_PER_DAY) {
    issues.push({ field, message: `too many ranges (max ${MAX_RANGES_PER_DAY})` });
    return null;
  }
  const before = issues.length;
  const parsed = raw.map((r, i) => validateOneRange(r, `${field}[${i}]`, issues));
  if (issues.length > before) return null;
  const ranges = parsed as TimeRange[];
  if (hasOverlap(ranges)) {
    issues.push({ field, message: 'time ranges overlap' });
    return null;
  }
  return ranges;
}

function validateWeeklySchedule(
  raw: unknown,
  issues: PolicyValidationIssue[],
): Partial<Record<Weekday, TimeRange[]>> | null {
  if (raw === undefined) return {};
  if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) {
    issues.push({ field: 'weeklySchedule', message: 'must be an object keyed by weekday' });
    return null;
  }
  const out: Partial<Record<Weekday, TimeRange[]>> = {};
  for (const [key, value] of Object.entries(raw as Record<string, unknown>)) {
    if (!WEEKDAYS.includes(key as Weekday)) {
      issues.push({ field: `weeklySchedule.${key}`, message: 'unknown weekday key' });
      continue;
    }
    const ranges = validateRangeList(value, `weeklySchedule.${key}`, issues);
    if (ranges !== null) out[key as Weekday] = ranges;
  }
  return issues.length === 0 ? out : null;
}

function validateFixedHolidays(raw: unknown, issues: PolicyValidationIssue[]): string[] | null {
  if (raw === undefined) return [];
  if (!Array.isArray(raw)) {
    issues.push({ field: 'fixedHolidays', message: 'must be an array of "MM-DD" strings' });
    return null;
  }
  if (raw.length > MAX_FIXED_HOLIDAYS) {
    issues.push({ field: 'fixedHolidays', message: `too many entries (max ${MAX_FIXED_HOLIDAYS})` });
    return null;
  }
  const out: string[] = [];
  raw.forEach((v, i) => {
    if (typeof v !== 'string' || !MMDD_RE.test(v)) {
      issues.push({ field: `fixedHolidays[${i}]`, message: 'must be "MM-DD"' });
      return;
    }
    out.push(v);
  });
  return issues.length === 0 ? out : null;
}

function validateExceptionDates(raw: unknown, issues: PolicyValidationIssue[]): OperatingException[] | null {
  if (raw === undefined) return [];
  if (!Array.isArray(raw)) {
    issues.push({ field: 'exceptionDates', message: 'must be an array' });
    return null;
  }
  if (raw.length > MAX_EXCEPTIONS) {
    issues.push({ field: 'exceptionDates', message: `too many exception dates (max ${MAX_EXCEPTIONS})` });
    return null;
  }
  /*
   * 🔴 **同じ日付を 2 件通さない。** 解決（`resolveDayRanges`）は `find` で**先勝ち**なので、
   * 重複があると後の行が黙って無視され、しかも**配列の順序で結果が変わる**。
   * 「9/1 は 10:00-12:00 だけ臨時営業」と設定しても、同じ日の休業行が先にあれば
   * 来訪者から見て受付が開かない——画面上は両方とも設定済みに見える。
   * 名指しするのは**後ろ**の要素（先頭を指すと「消したのにまだ怒られる」になる）。
   */
  const seenDates = new Set<string>();
  const out: OperatingException[] = [];
  raw.forEach((v, i) => {
    const field = `exceptionDates[${i}]`;
    if (typeof v !== 'object' || v === null) {
      issues.push({ field, message: 'must be an object' });
      return;
    }
    const o = v as Record<string, unknown>;
    const date = typeof o.date === 'string' ? o.date : '';
    if (!YMD_RE.test(date)) {
      issues.push({ field: `${field}.date`, message: 'must be "YYYY-MM-DD"' });
      return;
    }
    if (!isValidCalendarDate(date)) {
      issues.push({
        field: `${field}.date`,
        message: 'must be an existing Gregorian calendar date in "YYYY-MM-DD"',
      });
      return;
    }
    if (seenDates.has(date)) {
      /*
       * 🔴 **救済策を書く。** 「1 件だけ」としか言わないと、運用者の合理的な反応は
       * 「片方の行を消す」＝**受付可能時間を自分で削る**。同じ日に複数の時間帯を設定する
       * 正しい書き方（1 行にカンマ区切り）を message に載せる。
       */
      issues.push({
        field,
        message: `duplicate exception date '${date}': 同じ日に複数の時間帯を設定するには 1 行にまとめてカンマで区切る（例 10:00-12:00, 14:00-16:00）`,
      });
      return;
    }
    seenDates.add(date);
    const closed = o.closed === true;
    if (closed) {
      if (Array.isArray(o.ranges) && o.ranges.length > 0) {
        issues.push({ field, message: 'closed=true と ranges は同時指定できない' });
        return;
      }
      out.push({ date, closed: true });
      return;
    }
    // closed=false: 臨時営業/短縮営業として ranges を要求する（無ければ何のための例外か不明のため拒否）。
    const ranges = validateRangeList(o.ranges, `${field}.ranges`, issues);
    if (ranges === null) return;
    if (ranges.length === 0) {
      issues.push({ field, message: 'closed=false は ranges が最低1件必要' });
      return;
    }
    out.push({ date, closed: false, ranges });
  });
  return issues.length === 0 ? out : null;
}

function validateEmergencyContactLabel(raw: unknown, issues: PolicyValidationIssue[]): string | undefined {
  if (raw === undefined || raw === null) return undefined;
  if (typeof raw !== 'string') {
    issues.push({ field: 'emergencyContactLabel', message: 'must be a string' });
    return undefined;
  }
  const trimmed = raw.trim();
  if (trimmed === '') return undefined;
  if (trimmed.length > MAX_LABEL_LEN) {
    issues.push({ field: 'emergencyContactLabel', message: `too long (max ${MAX_LABEL_LEN})` });
    return undefined;
  }
  return trimmed;
}

/**
 * admin API body（信頼できない入力）を検証し、保存可能な `StoredPolicyFields` へ正規化する。
 * 逆転区間・オーバーラップ・不正フォーマット・矛盾する休業指定は issues に集約して invalid_input を返す。
 */
export function validatePolicyInput(raw: unknown): ValidationResult {
  const issues: PolicyValidationIssue[] = [];
  if (typeof raw !== 'object' || raw === null) {
    return { ok: false, error: { code: 'invalid_input', message: 'body must be an object', issues: [] } };
  }
  const o = raw as Record<string, unknown>;

  const timezoneRaw = typeof o.timezone === 'string' && o.timezone.trim() !== '' ? o.timezone.trim() : DEFAULT_TIMEZONE;
  if (!isValidTimeZone(timezoneRaw)) issues.push({ field: 'timezone', message: 'unknown IANA timezone' });

  const weeklySchedule = validateWeeklySchedule(o.weeklySchedule, issues);
  const fixedHolidays = validateFixedHolidays(o.fixedHolidays, issues);
  const exceptionDates = validateExceptionDates(o.exceptionDates, issues);
  const emergencyContactLabel = validateEmergencyContactLabel(o.emergencyContactLabel, issues);

  if (issues.length > 0 || weeklySchedule === null || fixedHolidays === null || exceptionDates === null) {
    return { ok: false, error: { code: 'invalid_input', message: 'operating policy is invalid', issues } };
  }

  return {
    ok: true,
    value: {
      timezone: timezoneRaw,
      weeklySchedule,
      fixedHolidays,
      exceptionDates,
      ...(emergencyContactLabel ? { emergencyContactLabel } : {}),
    },
  };
}

/**
 * 保存済みの例外日から**重複している日付**を返す（保存前の検証とは別に、既に入っている
 * データを運用者へ知らせるため）。
 *
 * 🔴 検証を足しても、**既に保存されている重複は直らない**。読み側は先勝ちのままなので、
 * 臨時営業日に受付が開かない状態が残り続ける。しかも運用者が気づく契機は「たまたま
 * その拠点の営業時間画面で保存を押したとき」だけで、そのときには当該の日は過ぎている。
 */
export function duplicateExceptionDates(exceptions: readonly OperatingException[]): string[] {
  const seen = new Set<string>();
  const duplicated = new Set<string>();
  for (const exception of exceptions) {
    if (seen.has(exception.date)) duplicated.add(exception.date);
    else seen.add(exception.date);
  }
  return [...duplicated];
}

type DayRanges = { ranges: TimeRange[] };

/** 指定暦日（テナントの現地日付）の有効な営業時間帯を解決する（優先順位: 単発例外 > 固定休業日 > 曜日別）。 */
function resolveDayRanges(
  policy: Pick<ServiceOperatingPolicy, 'weeklySchedule' | 'fixedHolidays' | 'exceptionDates'>,
  ymd: { year: number; month: number; day: number },
  weekday: Weekday,
): DayRanges {
  const dateKey = ymdKey(ymd);
  const exception = policy.exceptionDates.find((e) => e.date === dateKey);
  if (exception) {
    return { ranges: exception.closed ? [] : (exception.ranges ?? []) };
  }
  if (policy.fixedHolidays.includes(mmddKey(ymd))) return { ranges: [] };
  return { ranges: policy.weeklySchedule[weekday] ?? [] };
}

/** その日の「現地時刻・秒単位」で open となる区間（前日からの日跨ぎ持ち越し込み）。 */
function daySpansSeconds(today: DayRanges, yesterday: DayRanges): Array<readonly [number, number]> {
  const spans: Array<readonly [number, number]> = [];
  for (const r of today.ranges) {
    const s = parseTimeToMinutes(r.start)! * 60;
    const e = (r.crossesMidnight ? 24 * 60 : parseTimeToMinutes(r.end)!) * 60;
    spans.push([s, e]);
  }
  for (const r of yesterday.ranges) {
    if (r.crossesMidnight) spans.push([0, parseTimeToMinutes(r.end)! * 60]);
  }
  return spans;
}

const REOPEN_SEARCH_CAP_DAYS = 370;

/** atMs より後で最も早い「営業開始」の絶対時刻(ms)を探す。見つからなければ undefined。 */
function findNextOpenInstant(
  policy: Pick<ServiceOperatingPolicy, 'weeklySchedule' | 'fixedHolidays' | 'exceptionDates'>,
  timezone: string,
  atMs: number,
): number | undefined {
  const start = getZonedParts(atMs, timezone);
  let weekday: Weekday = start.weekday;
  let ymd = { year: start.year, month: start.month, day: start.day };
  for (let k = 0; k <= REOPEN_SEARCH_CAP_DAYS; k++) {
    const day = resolveDayRanges(policy, ymd, weekday);
    const candidates = day.ranges
      .map((r) => {
        const mins = parseTimeToMinutes(r.start)!;
        return zonedTimeToUtcMs({ year: ymd.year, month: ymd.month, day: ymd.day, hour: Math.floor(mins / 60), minute: mins % 60 }, timezone);
      })
      .filter((ms) => ms > atMs);
    if (candidates.length > 0) return Math.min(...candidates);
    ymd = addDaysToYmd(ymd, 1);
    weekday = WEEKDAYS[(WEEKDAYS.indexOf(weekday) + 1) % WEEKDAYS.length]!;
  }
  return undefined;
}

/**
 * 指定時刻（既定: 現在時刻）の営業状態を判定する純関数 (issue #367)。
 * 優先順位: 単発例外日 (`exceptionDates`) > 固定休業日 (`fixedHolidays`) > 曜日別営業時間
 * (`weeklySchedule`)。日跨ぎ区間（`crossesMidnight`）は前日からの持ち越しとして評価する。
 * open/closed は [start, end) で判定する（開始時刻ちょうどは open・終了時刻ちょうどは closed）。
 */
export function evaluateOperatingStatus(
  policy: Pick<ServiceOperatingPolicy, 'timezone' | 'weeklySchedule' | 'fixedHolidays' | 'exceptionDates'>,
  atMs: number = Date.now(),
): OperatingEvaluation {
  const timezone = policy.timezone || DEFAULT_TIMEZONE;
  const now = getZonedParts(atMs, timezone);
  const today = resolveDayRanges(policy, { year: now.year, month: now.month, day: now.day }, now.weekday);
  const yesterdayYmd = addDaysToYmd(now, -1);
  const yesterday = resolveDayRanges(policy, yesterdayYmd, previousWeekday(now.weekday));

  const currentSec = now.hour * 3600 + now.minute * 60 + now.second;
  const spans = daySpansSeconds(today, yesterday);
  const isOpen = spans.some(([s, e]) => currentSec >= s && currentSec < e);
  if (isOpen) return { state: 'open' };

  const nextMs = findNextOpenInstant(policy, timezone, atMs);
  return { state: 'closed', ...(nextMs !== undefined ? { reopenAt: new Date(nextMs).toISOString() } : {}) };
}

/**
 * 評価結果を kiosk 契約（`@/domain/kiosk/operating-status`）の形へ写像する。
 * `timezone` を同梱する（#367 polish: 表示側が端末 TZ ではなくポリシーの TZ で reopenAt を
 * 整形できるようにする。端末が UTC のとき 09:00 JST が 0:00 と誤表示される問題の是正）。
 */
export function resolveKioskOperatingStatus(
  policy: Pick<ServiceOperatingPolicy, 'timezone' | 'weeklySchedule' | 'fixedHolidays' | 'exceptionDates' | 'emergencyContactLabel'>,
  atMs: number = Date.now(),
): KioskOperatingStatus {
  const evaluation = evaluateOperatingStatus(policy, atMs);
  return {
    state: evaluation.state,
    ...(evaluation.reopenAt ? { reopenAt: evaluation.reopenAt } : {}),
    ...(policy.emergencyContactLabel ? { emergencyContactLabel: policy.emergencyContactLabel } : {}),
    timezone: policy.timezone || DEFAULT_TIMEZONE,
  };
}