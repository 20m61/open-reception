/**
 * 危険操作（失効・削除・停止・ローテーション等）の監査連携ヘルパ (issue #91, increment 1)。
 *
 * 方針:
 *   - 監査記録そのものは `appendAuditLog`（@/lib/mock-backend/reception-log-store）へ委譲する。
 *     actor を明示できるため #264 の操作者帰属に使う（未指定は 'admin'）。本モジュールは
 *     「危険操作で監査に何を残すか」を一箇所に集約する薄い層。
 *   - **既存の AuditAction（src/domain/reception/log.ts）だけを使う**。log.ts は読み取り参照
 *     のみで編集しない。新しい action が必要なケースは docs / report に列挙してオーケストレータ
 *     が後で log.ts へ追加する。
 *   - **機微値・PII は監査に残さない**。metadata は sanitizeAuditMetadata で素通しできる
 *     プリミティブのみへ縮約し、secret/PII を疑わせるキーは値をマスクする。
 */
import type { AuditAction } from '@/domain/reception/log';
import { appendAuditLog } from '@/lib/mock-backend/reception-log-store';

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

/**
 * リクエストから高詳細監査のコンテキスト（IP・user-agent）を取り出す (issue #83 AC13)。
 *
 * IP は `x-forwarded-for` の **末尾（最も手前の信頼 proxy が付与した値）** を採る。CloudFront は
 * client 提供の X-Forwarded-For の**右側**に実 client IP を追記するため、先頭値は client 詐称可能で
 * 運用者 IP を偽装できてしまう（監査の accountability を崩す）。認可には使わない best-effort。
 * user-agent は監査肥大化を避けるため 256 文字で切り詰める。取得できないものは undefined。
 */
export function auditContextFromRequest(request: Request): { ip?: string; userAgent?: string } {
  const hops = (request.headers.get('x-forwarded-for') ?? '')
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean);
  const ip = hops.at(-1) || undefined;
  const ua = request.headers.get('user-agent')?.slice(0, 256) || undefined;
  return { ip, userAgent: ua };
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
  /** 設定変更の変更前/後の値 (issue #83 AC13)。sanitize して機微値を落とす。 */
  before?: Record<string, unknown>;
  after?: Record<string, unknown>;
  /** 操作元の IP・user-agent を記録するためのリクエスト (issue #83 AC13)。 */
  request?: Request;
  /** 操作者識別子 (issue #264)。未指定は 'admin'。platform 破壊的操作は昇格した developer の identity を渡す。 */
  actor?: string;
};

/**
 * 危険操作を監査ログに記録する。reason と sanitize 済み metadata に加え、高詳細監査 (#83 AC13) の
 * before/after（sanitize 済み）・IP・user-agent を残す。機微値・PII は落とす。
 * 戻り値は appendAuditLog の結果（呼び出し側はレスポンス整形に使わない方がよい）。
 */
export async function recordDangerAction(input: DangerAuditInput) {
  const merged: Record<string, unknown> = { ...input.metadata };
  if (input.reason !== undefined) merged.reason = input.reason;
  const ctx = input.request ? auditContextFromRequest(input.request) : {};
  // actor 未指定は従来どおり 'admin'。platform 破壊的操作は操作者 identity を残す（#264 説明責任）。
  return appendAuditLog({
    action: input.action,
    actor: input.actor ?? 'admin',
    targetType: input.target.type,
    targetId: input.target.id,
    metadata: sanitizeAuditMetadata(merged),
    before: sanitizeAuditMetadata(input.before),
    after: sanitizeAuditMetadata(input.after),
    ip: ctx.ip,
    userAgent: ctx.userAgent,
  });
}
