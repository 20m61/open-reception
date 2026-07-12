/**
 * 退館クレデンシャルサービス (issue #328)。
 *
 * チェックイン時に滞在へ紐づく**退館の自己特定手段**を発行し、退館時に解決・確定する。
 * #98 の QR チェックイン機構と同じ設計方針（高エントロピー token・PII 非包含・resolve/confirm 分離）
 * に揃える。詳細と脅威モデルは docs/checkout-stay-design.md §8。
 *
 * 2 手段:
 *   - **token**（主・強い経路）: `randomBytes(32)` の base64url（256 bit）。QR に URL で載せる。
 *     総当り不可 → スロットルなし（TTL / consumed のみ検査）。テナント/サイト境界は二重防御で照合。
 *   - **code**（副・カメラ非対応時のフォールバック）: 4 桁数字。低エントロピーゆえ列挙攻撃を受け得る。
 *     **一次防御はスロットル**（scope 単位のスライディングウィンドウ）。ラベルは公開情報（在館一覧に
 *     出す判別材料）なので秘密扱いしない。**列挙オラクルを塞ぐ**ため「コード不一致」と「ラベル不一致」は
 *     同一の失敗（`not_recognized`・同一 HTTP）で返し、当該コードのクレデンシャル存在を露呈しない。
 *
 * 永続化は inc1 では in-memory（プロセス共有）。**スロットルもプロセス内**のため、複数 Lambda
 * インスタンスに跨ると実効試行上限が緩む（インスタンス数倍）。信頼された物理 kiosk 前提での
 * 多層防御であり、絶対的バリアではない（docs §8.3）。getBackend 化・共有スロットルは後続増分。
 * PII は保存も返却もしない（サマリは checkedInAt / targetLabel / purpose の非 PII のみ）。
 */
import { randomBytes, randomInt } from 'node:crypto';
import type { SiteId, TenantId } from '@/domain/tenant/types';
import type { StayId } from '@/domain/visit/types';
import {
  CHECKOUT_CODE_LENGTH,
  DEFAULT_CHECKOUT_TTL_MS,
  extractCheckoutToken,
  isCredentialExpired,
  normalizeCheckoutCode,
  targetLabelMatches,
  type CheckoutSelfIdSummary,
} from '@/components/kiosk/checkout/self-id';

/** 自己特定の手段種別（監査 metadata に載せる非 PII 値）。 */
export type CheckoutSelfIdMethod = 'qr' | 'code';

export type CheckoutCredentialStatus = 'active' | 'consumed';

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

/**
 * 解決/確定の失敗理由（受付端末が文言を出し分ける）。
 * - invalid:            入力が不正（コード形式不正・payload 不正）。
 * - not_found:          token が見つからない（token 経路のみ。token は秘密なので区別しても漏れない）。
 * - not_recognized:     コードまたは呼び出し先が確認できない（code 経路の**統一失敗**＝列挙オラクル封じ）。
 * - expired:            クレデンシャルの有効期限切れ。
 * - throttled:          コード試行がウィンドウ内上限に達した（列挙防止の一次防御）。
 * - already_checked_out: token が使用済み（token 経路。code 経路は not_recognized に併合）。
 */
export type CheckoutResolveReason =
  | 'invalid'
  | 'not_found'
  | 'not_recognized'
  | 'expired'
  | 'throttled'
  | 'already_checked_out';

export type CheckoutScope = { tenantId: TenantId; siteId: SiteId };

export type CheckoutResolveResult =
  | { ok: true; method: CheckoutSelfIdMethod; summary: CheckoutSelfIdSummary }
  | { ok: false; reason: CheckoutResolveReason };

/** 確定用の解決結果。**状態は変更しない**（consumed 化は checkout 成功後に markConsumed で行う）。 */
export type CheckoutForCheckoutResult =
  | { ok: true; method: CheckoutSelfIdMethod; stayId: StayId; credentialToken: string }
  | { ok: false; reason: CheckoutResolveReason };

export type CheckoutCredentialServiceDeps = {
  now?: () => Date;
  /** クレデンシャル TTL（ミリ秒）。既定 12h。 */
  ttlMs?: number;
  /** コード試行スロットルのウィンドウ（ミリ秒）。既定 10 分。 */
  codeThrottleWindowMs?: number;
  /** ウィンドウ内で許容するコード失敗回数。超過で throttled。既定 10。 */
  codeThrottleMax?: number;
  /** テスト用の token/コード生成差し替え。 */
  randomToken?: () => string;
  randomCode?: () => string;
};

/** 発行時の code 一意化リトライ上限。 */
const CODE_UNIQUE_RETRY = 50;
/** コード試行スロットルの既定ウィンドウ（10 分）。 */
export const DEFAULT_CODE_THROTTLE_WINDOW_MS = 10 * 60 * 1000;
/** コード試行スロットルの既定上限（ウィンドウ内 10 回失敗で throttled）。 */
export const DEFAULT_CODE_THROTTLE_MAX = 10;

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

/** 解決成功時の内部中間結果（状態は未変更）。 */
type Resolved = { ok: true; cred: CheckoutCredential; method: CheckoutSelfIdMethod };

export class CheckoutCredentialService {
  /** token をキーにした in-memory ストア。 */
  private readonly byToken = new Map<string, CheckoutCredential>();
  /** scope 単位のコード失敗タイムスタンプ（スライディングウィンドウ・スロットル）。 */
  private readonly codeFailures = new Map<string, number[]>();
  private readonly now: () => Date;
  private readonly ttlMs: number;
  private readonly throttleWindowMs: number;
  private readonly throttleMax: number;
  private readonly randomToken: () => string;
  private readonly randomCode: () => string;

  constructor(deps: CheckoutCredentialServiceDeps = {}) {
    this.now = deps.now ?? (() => new Date());
    this.ttlMs = deps.ttlMs ?? DEFAULT_CHECKOUT_TTL_MS;
    this.throttleWindowMs = deps.codeThrottleWindowMs ?? DEFAULT_CODE_THROTTLE_WINDOW_MS;
    this.throttleMax = deps.codeThrottleMax ?? DEFAULT_CODE_THROTTLE_MAX;
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
      status: 'active',
    };
    this.byToken.set(token, cred);
    return { token, code, expiresAt };
  }

  /**
   * 確認画面用に解決する（非 PII サマリ）。**状態は変更しない**。
   * code 経路は失敗時にスロットルへ計上し、上限超過は throttled を返す（列挙防止）。
   */
  resolve(scope: CheckoutScope, input: CheckoutResolveInput, at?: Date): CheckoutResolveResult {
    const r = this.tryResolve(scope, input, at ?? this.now());
    if (!r.ok) return r;
    return {
      ok: true,
      method: r.method,
      summary: {
        checkedInAt: r.cred.checkedInAt,
        targetLabel: r.cred.targetLabel,
        purpose: r.cred.purpose,
      },
    };
  }

  /**
   * 退館確定のために解決する。**状態は変更しない**（consumed 化は checkout 成功後に markConsumed）。
   * これにより「先に consumed → checkout 失敗でクレデンシャルだけ焼失し来訪者が締め出される」不具合を防ぐ。
   */
  resolveForCheckout(
    scope: CheckoutScope,
    input: CheckoutResolveInput,
    at?: Date,
  ): CheckoutForCheckoutResult {
    const r = this.tryResolve(scope, input, at ?? this.now());
    if (!r.ok) return r;
    return { ok: true, method: r.method, stayId: r.cred.stayId, credentialToken: r.cred.token };
  }

  /** token を consumed にする（checkout 成功後にのみ呼ぶ。冪等）。 */
  markConsumed(token: string): void {
    const cred = this.byToken.get(token);
    if (cred) cred.status = 'consumed';
  }

  /** テスト用: 全クレデンシャル・スロットル状態を破棄する。 */
  reset(): void {
    this.byToken.clear();
    this.codeFailures.clear();
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

  /**
   * token/コードを解決する共通ロジック（状態は変更しない）。
   * - token 経路: 256 bit ゆえスロットルなし。not_found/expired/already_checked_out を区別可（漏れない）。
   * - code 経路: スロットル → コード照合。失敗（未一致/ラベル不一致/期限切れ）は計上し、
   *   未一致とラベル不一致は **not_recognized に統一**して列挙オラクルを塞ぐ。
   */
  private tryResolve(
    scope: CheckoutScope,
    input: CheckoutResolveInput,
    now: Date,
  ): Resolved | { ok: false; reason: CheckoutResolveReason } {
    if (input.kind === 'token') {
      const token = extractCheckoutToken(input.payload);
      if (!token) return { ok: false, reason: 'invalid' };
      const cred = this.byToken.get(token);
      if (!cred || !inScope(cred, scope)) return { ok: false, reason: 'not_found' };
      if (cred.status === 'consumed') return { ok: false, reason: 'already_checked_out' };
      if (isCredentialExpired(cred.expiresAt, now)) return { ok: false, reason: 'expired' };
      return { ok: true, cred, method: 'qr' };
    }

    // ---- code 経路 ----
    const code = normalizeCheckoutCode(input.code);
    // 形式不正は列挙ではない（4 桁の推測ではない）ためスロットルへ計上しない。
    if (!code) return { ok: false, reason: 'invalid' };

    const key = scopeKey(scope);
    // スロットルを**照合の前**に評価し、超過中は一切の照合・タイミング差を与えない（一次防御）。
    if (this.isCodeThrottled(key, now)) return { ok: false, reason: 'throttled' };

    const outcome = this.matchCode(scope, code, input.targetLabel, now);
    if (!outcome.ok) {
      this.recordCodeFailure(key, now);
      return outcome;
    }
    return { ok: true, cred: outcome.cred, method: 'code' };
  }

  /**
   * code をアクティブなクレデンシャルへ照合する。
   * 未一致・ラベル不一致は同一の not_recognized（存在を露呈しない）。期限切れのみ区別する。
   */
  private matchCode(
    scope: CheckoutScope,
    code: string,
    targetLabel: string,
    now: Date,
  ): { ok: true; cred: CheckoutCredential } | { ok: false; reason: 'not_recognized' | 'expired' } {
    // consumed は「存在しない」ものとして扱う（存在露呈を避ける）。
    const cred = [...this.byToken.values()].find(
      (c) => inScope(c, scope) && c.code === code && c.status === 'active',
    );
    if (!cred) return { ok: false, reason: 'not_recognized' };
    if (isCredentialExpired(cred.expiresAt, now)) return { ok: false, reason: 'expired' };
    // ラベルは秘密ではない（在館一覧で公開）。不一致は「コード未一致」と同じ結果に統一する。
    if (!targetLabelMatches(cred.targetLabel, targetLabel)) return { ok: false, reason: 'not_recognized' };
    return { ok: true, cred };
  }

  /** ウィンドウ外の失敗を刈り取り、残数が上限以上なら throttled。 */
  private isCodeThrottled(key: string, now: Date): boolean {
    return this.prunedFailures(key, now).length >= this.throttleMax;
  }

  private recordCodeFailure(key: string, now: Date): void {
    const list = this.prunedFailures(key, now);
    list.push(now.getTime());
    this.codeFailures.set(key, list);
  }

  private prunedFailures(key: string, now: Date): number[] {
    const cutoff = now.getTime() - this.throttleWindowMs;
    const pruned = (this.codeFailures.get(key) ?? []).filter((t) => t > cutoff);
    this.codeFailures.set(key, pruned);
    return pruned;
  }
}

function inScope(cred: CheckoutCredential, scope: CheckoutScope): boolean {
  return cred.tenantId === scope.tenantId && cred.siteId === scope.siteId;
}

/** スロットルの scope キー（tenant + site）。区切りに NUL を使い衝突を避ける。 */
function scopeKey(scope: CheckoutScope): string {
  return `${scope.tenantId} ${scope.siteId}`;
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
