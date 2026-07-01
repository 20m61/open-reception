/**
 * 通知ルート設定の入力バリデーション (issue #88, increment 1 / #275 で domain へ集約)。
 *
 * すべて純関数。route ハンドラ・サービス層から再利用し、テーブルテストで網羅する。
 * 機微値（target.value）は形式の最小検証のみ行い、内容はログ・エラーに含めない。
 */
import {
  isNotificationChannelKind,
  type CallTarget,
  type CallTargetGroup,
} from './call-route';

export type ValidationError = { code: 'invalid_input'; message: string };
export type Validated<T> = { ok: true; value: T } | { ok: false; error: ValidationError };

function fail(message: string): Validated<never> {
  return { ok: false, error: { code: 'invalid_input', message } };
}

/** ルート名の検証（空不可・長さ上限）。 */
export function validateRouteName(raw: unknown): Validated<string> {
  if (typeof raw !== 'string') return fail('name is required');
  const name = raw.trim();
  if (name === '') return fail('name must not be empty');
  if (name.length > 120) return fail('name is too long');
  return { ok: true, value: name };
}

/** 単一の呼び出し先を正規化・検証する。 */
export function validateTarget(raw: unknown): Validated<CallTarget> {
  if (typeof raw !== 'object' || raw === null) return fail('target must be an object');
  const o = raw as Record<string, unknown>;

  const label = typeof o.label === 'string' ? o.label.trim() : '';
  if (label === '') return fail('target label is required');

  if (!isNotificationChannelKind(o.channel)) return fail('target channel is invalid');

  const value = typeof o.value === 'string' ? o.value.trim() : '';
  if (value === '') return fail('target value is required');

  // priority は非負整数。未指定は 0。
  const priority =
    o.priority === undefined ? 0 : typeof o.priority === 'number' ? o.priority : NaN;
  if (!Number.isInteger(priority) || priority < 0) return fail('target priority must be a non-negative integer');

  return { ok: true, value: { label, channel: o.channel, value, priority } };
}

/** グループを正規化・検証する。 */
export function validateGroup(raw: unknown): Validated<CallTargetGroup> {
  if (typeof raw !== 'object' || raw === null) return fail('group must be an object');
  const o = raw as Record<string, unknown>;

  const label = typeof o.label === 'string' ? o.label.trim() : '';
  if (label === '') return fail('group label is required');

  if (!Array.isArray(o.targets)) return fail('group targets must be an array');
  const targets: CallTarget[] = [];
  for (const t of o.targets) {
    const v = validateTarget(t);
    if (!v.ok) return v;
    targets.push(v.value);
  }
  return { ok: true, value: { label, targets } };
}

/** グループ配列を検証する（未指定は空配列を許容＝段階的に呼び出し先を足せる）。 */
export function validateGroups(raw: unknown): Validated<CallTargetGroup[]> {
  if (raw === undefined) return { ok: true, value: [] };
  if (!Array.isArray(raw)) return fail('groups must be an array');
  const groups: CallTargetGroup[] = [];
  for (const g of raw) {
    const v = validateGroup(g);
    if (!v.ok) return v;
    groups.push(v.value);
  }
  return { ok: true, value: groups };
}
