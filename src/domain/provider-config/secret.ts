/**
 * テナント別プロバイダ secret の型安全ラッパとストア interface (issue #405 Inc1)。
 *
 * **server-only（client から import 不可）**: この module は secret 値を扱うため client component
 * （'use client'）から import してはならない（AC3）。本リポジトリの規約（`server-only` npm パッケージは
 * 未導入で、`src/lib/security/client-secret-guard.test.ts` の静的解析で client への secret 混入を防ぐ）に
 * 従い、`./server-only-import.test.ts` が「'use client' ファイルが本 module を import しない」ことを
 * 静的に固定する（回帰防止）。
 *
 * 方針:
 *   - secret の値は `SecretValue` でラップし、toString/toJSON/util.inspect を redact して
 *     serialize 事故（ログ/レスポンス/監査への平文混入）を型で防ぐ（AC3）。生値は reveal() でのみ取得。
 *   - secret 本体は `TenantSecretStore` interface 経由でのみ read/write する。Inc1 は in-memory mock
 *     実装のみ（Secrets Manager 実装・CDK は Inc2）。
 *   - 参照名は `tenants/<tenantId>/<provider>` 名前空間（AC4: 越境参照名を組ませない）。
 */
import type { ProviderId } from './types';

const REDACTED = '[redacted]';

/**
 * secret 値の型安全ラッパ。あらゆる serialize 経路（String()/テンプレート/JSON.stringify/
 * console.log=util.inspect）で `[redacted]` を返し、生値の漏洩を型で防ぐ。生値は reveal() のみ。
 */
export class SecretValue {
  // 真の private field。列挙されず、JSON.stringify の対象にもならない。
  readonly #value: string;

  constructor(value: string) {
    this.#value = value;
  }

  /** ストア/アダプタ内部専用。生値を取り出す唯一の経路。 */
  reveal(): string {
    return this.#value;
  }

  toString(): string {
    return REDACTED;
  }

  toJSON(): string {
    return REDACTED;
  }

  get [Symbol.toStringTag](): string {
    return 'SecretValue';
  }

  // console.log / util.inspect 経路でも生値を出さない。
  [Symbol.for('nodejs.util.inspect.custom')](): string {
    return REDACTED;
  }
}

/** ref 構成要素として安全か（空・区切り文字混入で名前空間を脱出させない）。 */
function assertRefComponent(part: string, label: string): void {
  if (!part || part.includes('/') || part.includes('..')) {
    throw new Error(`invalid ${label} for secret ref`);
  }
}

/** secret 参照名 `tenants/<tenantId>/<provider>`。tenantId は認可済みコンテキスト由来のみ渡すこと。 */
export function secretRef(tenantId: string, provider: ProviderId): string {
  assertRefComponent(tenantId, 'tenantId');
  assertRefComponent(provider, 'provider');
  return `tenants/${tenantId}/${provider}`;
}

/**
 * テナント別 secret の read/write 境界。値は `SecretValue` でのみ授受し、平文 string を直接
 * 出し入れしない（呼び出し側での取り違え・ログ混入を防ぐ）。Inc2 で Secrets Manager 実装を追加。
 */
export interface TenantSecretStore {
  setSecret(ref: string, value: SecretValue): Promise<void>;
  clearSecret(ref: string): Promise<void>;
  hasSecret(ref: string): Promise<boolean>;
  getSecret(ref: string): Promise<SecretValue | null>;
}

/** in-memory mock 実装（dev/test/Inc1）。プロセス内 Map に生値を保持する（永続化しない）。 */
export class InMemoryTenantSecretStore implements TenantSecretStore {
  private readonly store = new Map<string, string>();

  async setSecret(ref: string, value: SecretValue): Promise<void> {
    this.store.set(ref, value.reveal());
  }

  async clearSecret(ref: string): Promise<void> {
    this.store.delete(ref);
  }

  async hasSecret(ref: string): Promise<boolean> {
    return this.store.has(ref);
  }

  async getSecret(ref: string): Promise<SecretValue | null> {
    const raw = this.store.get(ref);
    return raw === undefined ? null : new SecretValue(raw);
  }
}
