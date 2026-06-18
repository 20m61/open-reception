/**
 * 通知リクエストの入力検証 (DESIGN #34 §5-1)。
 * 純関数として切り出し、handler から再利用・単体テストする。
 * 不正入力は handler 側で 400 を返す。
 */
import type { NotificationRequest, NotificationKind, NotificationTarget } from './types';

export interface ValidationResult {
  ok: boolean;
  errors: string[];
  /** 検証を通過した正規化済みリクエスト（ok=true のときのみ）。 */
  value?: NotificationRequest;
}

const KINDS: ReadonlySet<NotificationKind> = new Set(['call', 'announcement']);
const TARGET_TYPES: ReadonlySet<NotificationTarget['type']> = new Set(['phone', 'sip', 'app']);

/** 通知本文の最大長（Polly 文字数課金・濫用抑止のため上限を設ける）。 */
export const MAX_MESSAGE_LENGTH = 600;
/** 識別子の最大長。 */
const MAX_ID_LENGTH = 128;

function isNonEmptyString(v: unknown, max: number): v is string {
  return typeof v === 'string' && v.trim().length > 0 && v.length <= max;
}

/** 通知先の検証（任意フィールド）。 */
function validateTarget(target: unknown, errors: string[]): NotificationTarget | undefined {
  if (target === undefined || target === null) return undefined;
  if (typeof target !== 'object') {
    errors.push('target はオブジェクトである必要があります。');
    return undefined;
  }
  const t = target as Record<string, unknown>;
  if (!TARGET_TYPES.has(t.type as NotificationTarget['type'])) {
    errors.push('target.type は phone/sip/app のいずれかである必要があります。');
  }
  if (!isNonEmptyString(t.value, 256)) {
    errors.push('target.value が不正です。');
  }
  if (errors.length > 0) return undefined;
  return { type: t.type as NotificationTarget['type'], value: (t.value as string).trim() };
}

/** 未知の入力（API ボディ）を検証し、正規化された NotificationRequest を返す。 */
export function validateNotificationRequest(input: unknown): ValidationResult {
  const errors: string[] = [];

  if (typeof input !== 'object' || input === null) {
    return { ok: false, errors: ['リクエストボディが不正です。'] };
  }
  const body = input as Record<string, unknown>;

  if (!isNonEmptyString(body.siteId, MAX_ID_LENGTH)) {
    errors.push('siteId は必須です。');
  }
  if (!isNonEmptyString(body.requestId, MAX_ID_LENGTH)) {
    errors.push('requestId（冪等キー）は必須です。');
  }
  if (!KINDS.has(body.kind as NotificationKind)) {
    errors.push('kind は call/announcement のいずれかである必要があります。');
  }
  if (!isNonEmptyString(body.message, MAX_MESSAGE_LENGTH)) {
    errors.push(`message は必須で ${MAX_MESSAGE_LENGTH} 文字以内である必要があります。`);
  }

  const target = validateTarget(body.target, errors);

  if (errors.length > 0) {
    return { ok: false, errors };
  }

  return {
    ok: true,
    errors: [],
    value: {
      siteId: (body.siteId as string).trim(),
      requestId: (body.requestId as string).trim(),
      kind: body.kind as NotificationKind,
      message: (body.message as string).trim(),
      target,
    },
  };
}
