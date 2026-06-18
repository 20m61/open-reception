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
/**
 * 識別子（siteId / requestId）の許可文字。
 * SSM パラメータ名へ補間する siteId に '/' や '..' を入れさせないため allowlist する
 * （path/パラメータ名インジェクション防止）。
 */
const ID_PATTERN = /^[A-Za-z0-9_-]+$/;

/** trim 後の長さで上限を検査する（実際に保存・合成されるのは trim 済みの値）。 */
function isNonEmptyString(v: unknown, max: number): v is string {
  if (typeof v !== 'string') return false;
  const trimmed = v.trim();
  return trimmed.length > 0 && trimmed.length <= max;
}

/** 識別子: 非空・長さ上限・文字種 allowlist を満たすか（trim 後で判定）。 */
function isValidId(v: unknown): v is string {
  return isNonEmptyString(v, MAX_ID_LENGTH) && ID_PATTERN.test((v as string).trim());
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

  if (!isValidId(body.siteId)) {
    errors.push('siteId は必須で、英数字・ハイフン・アンダースコアのみ使用できます。');
  }
  if (!isValidId(body.requestId)) {
    errors.push('requestId（冪等キー）は必須で、英数字・ハイフン・アンダースコアのみ使用できます。');
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
