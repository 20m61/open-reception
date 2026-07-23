/**
 * 営業時間ポリシー admin UI 用の「文章形式」変換ヘルパ (issue #367)。
 *
 * 曜日別営業時間・単発例外日をテキスト入力（1行/カンマ区切り）で編集できるようにする往復変換。
 * 保存前の厳密な検証は `validatePolicyInput`（サーバ）に委ねる — ここでの parse は
 * 「入力から構造化データを組み立てる」だけで、不正値は極力そのまま構造化して渡し（例:
 * 不正な時刻文字列も `start`/`end` にそのまま入れる）、サーバの issues 表示で気付けるようにする。
 */
import type { OperatingException, TimeRange } from './types';

/** "09:00-18:00" / 日跨ぎは末尾に "*"（例: "22:00-02:00*"）。複数区間はカンマ区切り。 */
export function formatTimeRanges(ranges: readonly TimeRange[]): string {
  return ranges.map((r) => `${r.start}-${r.end}${r.crossesMidnight ? '*' : ''}`).join(', ');
}

/** 空文字/空白のみは空配列。トークンに '-' が無い/空トークンは無視する（フォームの打鍵途中を許容）。 */
export function parseTimeRangesText(text: string): TimeRange[] {
  return text
    .split(',')
    .map((t) => t.trim())
    .filter((t) => t !== '')
    .map((tok): TimeRange | null => {
      const crossesMidnight = tok.endsWith('*');
      const core = (crossesMidnight ? tok.slice(0, -1) : tok).trim();
      const sep = core.indexOf('-');
      if (sep < 0) return null;
      const start = core.slice(0, sep).trim();
      const end = core.slice(sep + 1).trim();
      if (start === '' || end === '') return null;
      return { start, end, ...(crossesMidnight ? { crossesMidnight: true } : {}) };
    })
    .filter((r): r is TimeRange => r !== null);
}

/** "YYYY-MM-DD:closed" または "YYYY-MM-DD:09:00-12:00, 13:00-15:00"（コロン省略/空欄は closed 扱い）。 */
export function formatExceptionLine(e: OperatingException): string {
  if (e.closed) return `${e.date}:closed`;
  return `${e.date}:${formatTimeRanges(e.ranges ?? [])}`;
}

export function formatExceptionsText(list: readonly OperatingException[]): string {
  return list.map(formatExceptionLine).join('\n');
}

function parseExceptionLine(line: string): OperatingException | null {
  const idx = line.indexOf(':');
  const date = (idx < 0 ? line : line.slice(0, idx)).trim();
  if (date === '') return null;
  const rest = (idx < 0 ? '' : line.slice(idx + 1)).trim();
  if (rest === '' || rest.toLowerCase() === 'closed') return { date, closed: true };
  return { date, closed: false, ranges: parseTimeRangesText(rest) };
}

/** 1行1件（空行は無視）。 */
export function parseExceptionsText(text: string): OperatingException[] {
  return text
    .split('\n')
    .map((l) => l.trim())
    .filter((l) => l !== '')
    .map(parseExceptionLine)
    .filter((e): e is OperatingException => e !== null);
}
