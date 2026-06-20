/**
 * 危険操作（失効・削除・停止・ローテーション等）の監査連携ヘルパ (issue #91, increment 1)。
 *
 * 方針:
 *   - 監査記録そのものは既存 `appendAdminAudit`（@/lib/mock-backend/reception-log-store）へ
 *     委譲する。本モジュールは「危険操作で監査に何を残すか」を一箇所に集約する薄い層。
 *   - **既存の AuditAction（src/domain/reception/log.ts）だけを使う**。log.ts は読み取り参照
 *     のみで編集しない。新しい action が必要なケースは docs / report に列挙してオーケストレータ
 *     が後で log.ts へ追加する。
 *   - **機微値・PII は監査に残さない**。metadata は sanitizeAuditMetadata で素通しできる
 *     プリミティブのみへ縮約し、secret/PII を疑わせるキーは値をマスクする。
 */
import type { AuditAction } from '@/domain/reception/log';
import { appendAdminAudit } from '@/lib/mock-backend/reception-log-store';

/**
 * 値をマスクすべきキーの判定（小文字・部分一致）。機微情報の取り違えを防ぐ防御的フィルタで、
 * 本来は呼び出し側が機微値を渡さない前提。万一渡されてもログに平文を残さない。
 */
const SENSITIVE_KEY_PATTERNS = [
  'secret',
  'password',
  'passwd',
  'pin',
  'token',
  'apikey',
  'api_key',
  'privatekey',
  'private_key',
  'credential',
  'authorization',
  'cookie',
  'email',
  'phone',
  'name', // 来訪者氏名・担当者名などの PII 取り違え防止（呼び出し側は label 化済みを渡すこと）
] as const;

function isSensitiveKey(key: string): boolean {
  const k = key.toLowerCase();
  return SENSITIVE_KEY_PATTERNS.some((p) => k.includes(p));
}

/**
 * 監査 metadata を安全な `Record<string, string>` に縮約する。
 *   - undefined / null のエントリは捨てる。
 *   - 機微キーは値を `[redacted]` に置換（キーの存在自体は監査の手掛かりとして残す）。
 *   - boolean / number は文字列化、それ以外（object 等）は捨てる（誤って構造体を残さない）。
 */
export function sanitizeAuditMetadata(
  metadata: Record<string, unknown> | undefined,
): Record<string, string> | undefined {
  if (!metadata) return undefined;
  const out: Record<string, string> = {};
  for (const [key, value] of Object.entries(metadata)) {
    if (value === undefined || value === null) continue;
    if (isSensitiveKey(key)) {
      out[key] = '[redacted]';
      continue;
    }
    if (typeof value === 'string') {
      out[key] = value;
    } else if (typeof value === 'boolean' || typeof value === 'number') {
      out[key] = String(value);
    }
    // object/array/function などは意図的に捨てる（構造体・PII の混入防止）。
  }
  return Object.keys(out).length > 0 ? out : undefined;
}

/** 危険操作の監査入力。reason は理由入力 UX（confirm-flow）の値を想定。 */
export type DangerAuditInput = {
  /** 既存 AuditAction のみ。新規が必要なら log.ts を編集せず report に列挙する。 */
  action: AuditAction;
  /** 対象リソース種別 / ID（PII を含めない）。 */
  target: { type: string; id?: string };
  /** 操作理由（危険操作 UX で入力）。機微値・PII を含めない短い説明。 */
  reason?: string;
  /** 追加の補助情報。sanitizeAuditMetadata を通して機微値を落とす。 */
  metadata?: Record<string, unknown>;
};

/**
 * 危険操作を監査ログに記録する。reason と sanitize 済み metadata を残し、機微値は落とす。
 * 戻り値は appendAdminAudit の結果（呼び出し側はレスポンス整形に使わない方がよい）。
 */
export async function recordDangerAction(input: DangerAuditInput) {
  const merged: Record<string, unknown> = { ...input.metadata };
  if (input.reason !== undefined) merged.reason = input.reason;
  return appendAdminAudit(input.action, input.target, sanitizeAuditMetadata(merged));
}
