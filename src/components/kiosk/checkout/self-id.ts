/**
 * 退館の自己特定 純ロジック (issue #328)。
 *
 * 副作用・I/O を持たない。退館クレデンシャル（QR token / 短い数字コード）の
 * 正規化・照合・TTL 判定・token 抽出を集約し node 環境で網羅検証する。
 *
 * PII は扱わない（`rules/pii-secret-minimization.md`）:
 *   - token は高エントロピー乱数（256 bit、生成はサーバの checkout-credential.ts）。
 *   - code は 4 桁数字（低エントロピー。サイト境界 + ラベル照合 + TTL + 試行上限で防御）。
 *   - targetLabel は呼び出し先の表示名（部署名等）で氏名等 PII ではない。
 *
 * 照合方針は #98 の checkin payload.ts と揃える（QR = URL or 生 token を両方解釈）。
 */

/** 退館コードの桁数（4 桁数字）。 */
export const CHECKOUT_CODE_LENGTH = 4;

/** 退館 QR/URL の token クエリ名（`<baseUrl>/kiosk/checkout?ct=<token>`）。 */
export const CHECKOUT_TOKEN_QUERY = 'ct';

/** 退館クレデンシャルの既定 TTL（ミリ秒）。同日退館を許容しつつ長期滞留を防ぐ 12 時間。 */
export const DEFAULT_CHECKOUT_TTL_MS = 12 * 60 * 60 * 1000;

/** token の形式: base64url（英数 + - + _）。空・記号混入は弾く。 */
const TOKEN_PATTERN = /^[A-Za-z0-9_-]+$/;

/** 確認ステップに出す非 PII サマリ（氏名は含めない）。 */
export type CheckoutSelfIdSummary = {
  /** 入館時刻（ISO 8601）。 */
  checkedInAt: string;
  /** 呼び出し先ラベル（部署名等・非 PII）。 */
  targetLabel: string;
  /** 用件（目的種別のラベル・非 PII）。 */
  purpose: string;
};

/**
 * 入力コードを正規化する。空白除去 + 全角→半角（NFKC）で 4 桁数字なら返す。桁違い・非数字は null。
 */
export function normalizeCheckoutCode(raw: unknown): string | null {
  if (typeof raw !== 'string') return null;
  const compact = raw.normalize('NFKC').replace(/\s+/g, '');
  return new RegExp(`^[0-9]{${CHECKOUT_CODE_LENGTH}}$`).test(compact) ? compact : null;
}

/**
 * 呼び出し先ラベルの照合用正規化。NFKC + trim + 内部空白畳み込み + 小文字化。
 * 照合専用（表示にはオリジナルを使う）。
 */
export function normalizeTargetLabel(raw: unknown): string {
  if (typeof raw !== 'string') return '';
  return raw.normalize('NFKC').trim().replace(/\s+/g, ' ').toLowerCase();
}

/** 2 つのラベルが（正規化して）一致するか。空同士は一致とみなさない（素通り防止）。 */
export function targetLabelMatches(a: unknown, b: unknown): boolean {
  const na = normalizeTargetLabel(a);
  const nb = normalizeTargetLabel(b);
  return na.length > 0 && na === nb;
}

/** expiresAt（ISO）に now が到達していれば失効。不正な日付は安全側で失効扱い。 */
export function isCredentialExpired(expiresAt: string, now: Date): boolean {
  const exp = Date.parse(expiresAt);
  if (!Number.isFinite(exp)) return true;
  return now.getTime() >= exp;
}

/**
 * 読み取ったテキスト（退館 QR の URL or 生 token）から token を取り出す。不正なら null。
 * URL は `?ct=<token>` のみ受理し、他クエリ（例 checkin の `rt`）は拒否する。
 */
export function extractCheckoutToken(raw: unknown): string | null {
  if (typeof raw !== 'string') return null;
  const text = raw.trim();
  if (text === '') return null;

  // URL 形式（退館 checkout URL）。
  if (text.includes('://') || text.includes('/') || text.includes('?')) {
    try {
      const value = new URL(text).searchParams.get(CHECKOUT_TOKEN_QUERY);
      return value && TOKEN_PATTERN.test(value) ? value : null;
    } catch {
      return null;
    }
  }

  // 生 token（base64url のみ）。
  return TOKEN_PATTERN.test(text) ? text : null;
}
