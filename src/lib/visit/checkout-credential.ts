/**
 * 退館クレデンシャルサービス (issue #328)。
 *
 * チェックイン時に滞在へ紐づく**退館の自己特定手段**を発行し、退館時に解決・確定する。
 * #98 の QR チェックイン機構と同じ設計方針（高エントロピー token・PII 非包含・resolve/confirm 分離）
 * に揃える。詳細と脅威モデルは docs/checkout-stay-design.md §8。
 *
 * 2 手段:
 *   - **token**（主）: `randomBytes(32)` の base64url（256 bit）。QR に URL で載せる。総当り不可 →
 *     試行制限なし（TTL / consumed のみ検査）。テナント/サイト境界は二重防御で照合する。
 *   - **code**（副）: 4 桁数字。低エントロピーゆえ**サイト境界 + ラベル照合 + TTL + 試行上限**で防御。
 *
 * 永続化は inc1 では in-memory（プロセス共有）。getBackend 化は後続増分（design §8.6）。
 * PII は保存も返却もしない（サマリは checkedInAt / targetLabel / purpose の非 PII のみ）。
 */
import { randomBytes, randomInt } from 'node:crypto';
import type { SiteId, TenantId } from '@/domain/tenant/types';
import type { StayId } from '@/domain/visit/types';
import {
  CHECKOUT_CODE_LENGTH,
  CHECKOUT_MAX_ATTEMPTS,
  DEFAULT_CHECKOUT_TTL_MS,
  extractCheckoutToken,
  isCredentialExpired,
  normalizeCheckoutCode,
  targetLabelMatches,
  type CheckoutSelfIdSummary,
} from '@/components/kiosk/checkout/self-id';

/** 自己特定の手段種別（監査 metadata に載せる非 PII 値）。 */
export type CheckoutSelfIdMethod = 'qr' | 'code';

export type CheckoutCredentialStatus = 'active' | 'consumed' | 'locked';

/** 退館クレデンシャル（サーバ内部保持。token/code は外へ出さない）。 */
export type CheckoutCredential = {
  token: string;
  code: string;
  tenantId: TenantId;
  siteId: SiteId;
  stayId: StayId;
  checkedInAt: string;
  targetLabel: string;
  purpose: string;
  issuedAt: string;
  expiresAt: string;
  /** コード経路の失敗試行回数。上限で locked。 */
  attempts: number;
  status: CheckoutCredentialStatus;
};

/** 発行結果（発行側＝受付完了画面/予約 QR がこれを来訪者へ提示する）。 */
export type IssuedCheckoutCredential = {
  token: string;
  code: string;
  expiresAt: string;
};

export type CheckoutIssueInput = {
  tenantId: TenantId;
  siteId: SiteId;
  stayId: StayId;
  checkedInAt: string;
  targetLabel: string;
  purpose: string;
};

/** 解決/確定の入力（QR token 経路 or code+ラベル経路）。 */
export type CheckoutResolveInput =
  | { kind: 'token'; payload: string }
  | { kind: 'code'; code: string; targetLabel: string };

/** 解決/確定の失敗理由（受付端末が文言を出し分ける）。 */
export type CheckoutResolveReason =
  | 'invalid'
  | 'not_found'
  | 'expired'
  | 'locked'
  | 'label_mismatch'
  | 'already_checked_out';

export type CheckoutScope = { tenantId: TenantId; siteId: SiteId };

export type CheckoutResolveResult =
  | { ok: true; method: CheckoutSelfIdMethod; summary: CheckoutSelfIdSummary }
  | { ok: false; reason: CheckoutResolveReason };

export type CheckoutConsumeResult =
  | { ok: true; method: CheckoutSelfIdMethod; stayId: StayId }
  | { ok: false; reason: CheckoutResolveReason };

export type CheckoutCredentialServiceDeps = {
  now?: () => Date;
  /** クレデンシャル TTL（ミリ秒）。既定 12h。 */
  ttlMs?: number;
  /** テスト用の token/コード生成差し替え。 */
  randomToken?: () => string;
  randomCode?: () => string;
};

/** 発行時の code 一意化リトライ上限。 */
const CODE_UNIQUE_RETRY = 50;

function toBase64Url(bytes: Buffer): string {
  return bytes.toString('base64').replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

/** 高エントロピー token（256 bit）。 */
export function generateCheckoutToken(): string {
  return toBase64Url(randomBytes(32));
}

/** 4 桁の数字コード（0000〜9999、ゼロ埋め）。 */
export function generateCheckoutCode(): string {
  return String(randomInt(0, 10 ** CHECKOUT_CODE_LENGTH)).padStart(CHECKOUT_CODE_LENGTH, '0');
}

/** 内部照合の中間結果。 */
type Lookup =
  | { ok: true; cred: CheckoutCredential; method: CheckoutSelfIdMethod }
  | { ok: false; reason: CheckoutResolveReason };

export class CheckoutCredentialService {
  /** token をキーにした in-memory ストア。 */
  private readonly byToken = new Map<string, CheckoutCredential>();
  private readonly now: () => Date;
  private readonly ttlMs: number;
  private readonly randomToken: () => string;
  private readonly randomCode: () => string;

  constructor(deps: CheckoutCredentialServiceDeps = {}) {
    this.now = deps.now ?? (() => new Date());
    this.ttlMs = deps.ttlMs ?? DEFAULT_CHECKOUT_TTL_MS;
    this.randomToken = deps.randomToken ?? generateCheckoutToken;
    this.randomCode = deps.randomCode ?? generateCheckoutCode;
  }

  /** 滞在へ退館クレデンシャルを発行する（同一サイトのアクティブコードと衝突しない）。 */
  issue(input: CheckoutIssueInput): IssuedCheckoutCredential {
    const now = this.now();
    const issuedAt = now.toISOString();
    const expiresAt = new Date(now.getTime() + this.ttlMs).toISOString();
    const token = this.randomToken();
    const code = this.freshCode(input.siteId, now);

    const cred: CheckoutCredential = {
      token,
      code,
      tenantId: input.tenantId,
      siteId: input.siteId,
      stayId: input.stayId,
      checkedInAt: input.checkedInAt,
      targetLabel: input.targetLabel,
      purpose: input.purpose,
      issuedAt,
      expiresAt,
      attempts: 0,
      status: 'active',
    };
    this.byToken.set(token, cred);
    return { token, code, expiresAt };
  }

  /** 確認画面用に解決する（非 PII サマリ）。コード経路は失敗時に試行を消費する。 */
  resolve(scope: CheckoutScope, input: CheckoutResolveInput, at?: Date): CheckoutResolveResult {
    const lk = this.lookup(scope, input, at ?? this.now());
    if (!lk.ok) return lk;
    return {
      ok: true,
      method: lk.method,
      summary: {
        checkedInAt: lk.cred.checkedInAt,
        targetLabel: lk.cred.targetLabel,
        purpose: lk.cred.purpose,
      },
    };
  }

  /** 退館を確定する（consumed へ遷移）。二重確定は already_checked_out。 */
  consume(scope: CheckoutScope, input: CheckoutResolveInput, at?: Date): CheckoutConsumeResult {
    const lk = this.lookup(scope, input, at ?? this.now());
    if (!lk.ok) return lk;
    lk.cred.status = 'consumed';
    return { ok: true, method: lk.method, stayId: lk.cred.stayId };
  }

  /** テスト用: 全クレデンシャルを破棄する。 */
  reset(): void {
    this.byToken.clear();
  }

  /** サイト内でアクティブ・未失効・未 consumed なコードと衝突しない新規コードを引く。 */
  private freshCode(siteId: SiteId, now: Date): string {
    for (let i = 0; i < CODE_UNIQUE_RETRY; i++) {
      const code = this.randomCode();
      const clash = [...this.byToken.values()].some(
        (c) =>
          c.siteId === siteId &&
          c.code === code &&
          c.status === 'active' &&
          !isCredentialExpired(c.expiresAt, now),
      );
      if (!clash) return code;
    }
    throw new Error('checkout code space exhausted for site');
  }

  /** token/コードを scope・状態・TTL・ラベル照合・試行上限で解決する共通ロジック。 */
  private lookup(scope: CheckoutScope, input: CheckoutResolveInput, now: Date): Lookup {
    if (input.kind === 'token') {
      const token = extractCheckoutToken(input.payload);
      if (!token) return { ok: false, reason: 'invalid' };
      const cred = this.byToken.get(token);
      if (!cred || !inScope(cred, scope)) return { ok: false, reason: 'not_found' };
      const guard = statusGuard(cred, now);
      if (guard) return guard;
      return { ok: true, cred, method: 'qr' };
    }

    // code 経路。
    const code = normalizeCheckoutCode(input.code);
    if (!code) return { ok: false, reason: 'invalid' };
    const cred = [...this.byToken.values()].find(
      (c) => inScope(c, scope) && c.code === code,
    );
    if (!cred) return { ok: false, reason: 'not_found' };
    const guard = statusGuard(cred, now);
    if (guard) return guard;

    if (!targetLabelMatches(cred.targetLabel, input.targetLabel)) {
      cred.attempts += 1;
      if (cred.attempts >= CHECKOUT_MAX_ATTEMPTS) {
        cred.status = 'locked';
        return { ok: false, reason: 'locked' };
      }
      return { ok: false, reason: 'label_mismatch' };
    }
    return { ok: true, cred, method: 'code' };
  }
}

function inScope(cred: CheckoutCredential, scope: CheckoutScope): boolean {
  return cred.tenantId === scope.tenantId && cred.siteId === scope.siteId;
}

/** consumed / locked / expired を理由へ写す。問題なければ undefined。 */
function statusGuard(cred: CheckoutCredential, now: Date): { ok: false; reason: CheckoutResolveReason } | undefined {
  if (cred.status === 'consumed') return { ok: false, reason: 'already_checked_out' };
  if (cred.status === 'locked') return { ok: false, reason: 'locked' };
  if (isCredentialExpired(cred.expiresAt, now)) return { ok: false, reason: 'expired' };
  return undefined;
}

// ---- プロセス共有ファクトリ（route から使う。#98 store.ts と同方針） ----

let singleton: CheckoutCredentialService | undefined;

export function getCheckoutCredentialService(): CheckoutCredentialService {
  if (!singleton) singleton = new CheckoutCredentialService();
  return singleton;
}

/** テスト用: シングルトンを破棄する。 */
export function __resetCheckoutCredentialService(): void {
  singleton = undefined;
}
