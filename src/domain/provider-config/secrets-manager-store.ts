/**
 * テナント別 secret の AWS Secrets Manager 実装 (issue #405 Inc2)。
 *
 * **server-only（client から import 不可）**: secret 値・AWS SDK を扱うため 'use client' から
 * import しない（`./server-only-import.test.ts` が静的に固定）。
 *
 * 設計:
 *   - `TenantSecretStore` の参照名 `tenants/<tenantId>/<provider>` を、環境 prefix を冠した
 *     Secrets Manager シークレット名 `<prefix>/tenants/<tenantId>/<provider>`（例
 *     `open-reception/prod/tenants/acme/vonage`）へ写像する。prefix は `PROVIDER_SECRET_PREFIX`
 *     env（CDK が注入）由来。テナント越境を防ぐため ref の path 脱出（`..`/絶対パス/空）は拒否する。
 *   - AWS I/O は `TenantSecretBackend` interface に隔離し、store 本体（写像・冪等・presence 意味論）を
 *     実 AWS 無しで単体テストできるようにする。実 backend `AwsSecretsManagerBackend` は SDK を遅延
 *     import する薄い層（`SecretsVonageAdapter` と同流儀）で、実疎通の検証は #65 にスタックする。
 *   - secret 生値は `SecretValue` のまま授受し、平文 string の露出面を最小化する。エラーは値を含まない
 *     静的メッセージへ正規化し、原因は `err.name` のみログする（値・secretId をログ/例外に出さない）。
 *
 * IAM（blocking）: 実行ロールには `<prefix>/tenants/*` の resource prefix 限定で
 * Get/Describe/Create/Put/Delete のみを付与する（CDK 側 WebStack で配線。ワイルドカード全体は禁止）。
 */
import { SecretValue, type TenantSecretStore } from './secret';

/**
 * AWS Secrets Manager 操作の最小注入境界。実 AWS を要さず store をテストするための port。
 * 実装は AWS 例外を以下のセマンティクスへ正規化する（store に AWS 例外名を漏らさない）。
 */
export interface TenantSecretBackend {
  /** GetSecretValue。未存在・削除予定・SecretString 無しはすべて `null`。 */
  get(secretId: string): Promise<string | null>;
  /** CreateSecret。既に同名が存在すれば `'exists'`（呼び出し側が put へ切替える）。 */
  create(secretId: string, value: string): Promise<'created' | 'exists'>;
  /** PutSecretValue（既存シークレットへ新バージョン）。 */
  put(secretId: string, value: string): Promise<void>;
  /** DescribeSecret。存在し削除予定（DeletedDate）でなければ `true`。未存在は `false`。 */
  describe(secretId: string): Promise<boolean>;
  /** DeleteSecret（復旧猶予つき）。未存在・削除予定済みは no-op。 */
  delete(secretId: string): Promise<void>;
}

/** ref が Secrets Manager 名前空間を脱出しないか検証（越境防止）。 */
function assertSafeRef(ref: string): void {
  if (!ref || ref.startsWith('/') || ref.includes('..') || ref.includes('//')) {
    // ref 自体は secret 値ではないが、値・内部詳細を含めない静的メッセージにする。
    throw new Error('invalid secret ref');
  }
}

/** prefix を正規化（前後スラッシュ除去）。空/空白のみは fail-closed で拒否。 */
function normalizePrefix(prefix: string): string {
  const trimmed = prefix.trim().replace(/^\/+|\/+$/g, '');
  if (!trimmed) {
    throw new Error('PROVIDER_SECRET_PREFIX is required for the Secrets Manager backend');
  }
  return trimmed;
}

/** backend エラーを値非漏洩の静的メッセージへ正規化し、原因は err.name のみログする。 */
function rethrowRedacted(op: string, err: unknown): never {
  const name = err instanceof Error ? err.name : 'UnknownError';
  // secret 値・secretId は出さない。運用に要る最小情報（op と err.name）のみ。
  console.error(`[tenant-secret-store] secrets manager ${op} failed`, { name });
  throw new Error(`tenant secret ${op} failed`);
}

/**
 * `TenantSecretStore` の Secrets Manager 実装。参照名を prefix 付きシークレット名へ写像し、
 * set=Create/Put・clear=Delete・presence=Describe・get=GetSecretValue を委譲する。
 */
export class SecretsManagerTenantSecretStore implements TenantSecretStore {
  private readonly prefix: string;

  constructor(
    private readonly backend: TenantSecretBackend,
    prefix: string,
  ) {
    this.prefix = normalizePrefix(prefix);
  }

  /** `tenants/<tenantId>/<provider>` → `<prefix>/tenants/<tenantId>/<provider>`。 */
  private secretId(ref: string): string {
    assertSafeRef(ref);
    return `${this.prefix}/${ref}`;
  }

  async setSecret(ref: string, value: SecretValue): Promise<void> {
    const id = this.secretId(ref);
    try {
      // 未存在は Create、存在時は Put（新バージョン）。冪等な再 set を許す。
      const result = await this.backend.create(id, value.reveal());
      if (result === 'exists') {
        await this.backend.put(id, value.reveal());
      }
    } catch (err) {
      rethrowRedacted('set', err);
    }
  }

  async clearSecret(ref: string): Promise<void> {
    const id = this.secretId(ref);
    try {
      // 復旧猶予（既定 30 日）つき削除。ForceDelete は誤操作の取り返しがつかないため既定にしない。
      // 未存在は backend 側で no-op に正規化される（冪等）。
      await this.backend.delete(id);
    } catch (err) {
      rethrowRedacted('clear', err);
    }
  }

  async hasSecret(ref: string): Promise<boolean> {
    const id = this.secretId(ref);
    try {
      return await this.backend.describe(id);
    } catch (err) {
      rethrowRedacted('presence', err);
    }
  }

  async getSecret(ref: string): Promise<SecretValue | null> {
    const id = this.secretId(ref);
    try {
      const raw = await this.backend.get(id);
      return raw === null ? null : new SecretValue(raw);
    } catch (err) {
      rethrowRedacted('get', err);
    }
  }
}

/**
 * 実 AWS Secrets Manager backend。SDK（既存依存 `@aws-sdk/client-secrets-manager`）を遅延 import し、
 * warm container 内で client を再利用する（`SecretsVonageAdapter` と同流儀）。実疎通検証は #65。
 *
 * 復旧猶予（RecoveryWindowInDays）は AWS 既定の 30 日を明示指定する（誤削除からの復元余地を残す）。
 */
export class AwsSecretsManagerBackend implements TenantSecretBackend {
  private clientPromise: Promise<import('@aws-sdk/client-secrets-manager').SecretsManagerClient> | undefined;

  constructor(private readonly region: string) {}

  private client(): Promise<import('@aws-sdk/client-secrets-manager').SecretsManagerClient> {
    if (!this.clientPromise) {
      this.clientPromise = (async () => {
        const { SecretsManagerClient } = await import('@aws-sdk/client-secrets-manager');
        return new SecretsManagerClient({ region: this.region });
      })();
    }
    return this.clientPromise;
  }

  async get(secretId: string): Promise<string | null> {
    const { GetSecretValueCommand } = await import('@aws-sdk/client-secrets-manager');
    const client = await this.client();
    try {
      const res = await client.send(new GetSecretValueCommand({ SecretId: secretId }));
      return res.SecretString ?? null;
    } catch (err) {
      if (isNotFound(err)) return null;
      throw err;
    }
  }

  async create(secretId: string, value: string): Promise<'created' | 'exists'> {
    const { CreateSecretCommand } = await import('@aws-sdk/client-secrets-manager');
    const client = await this.client();
    try {
      await client.send(new CreateSecretCommand({ Name: secretId, SecretString: value }));
      return 'created';
    } catch (err) {
      if (err instanceof Error && err.name === 'ResourceExistsException') return 'exists';
      throw err;
    }
  }

  async put(secretId: string, value: string): Promise<void> {
    const { PutSecretValueCommand } = await import('@aws-sdk/client-secrets-manager');
    const client = await this.client();
    await client.send(new PutSecretValueCommand({ SecretId: secretId, SecretString: value }));
  }

  async describe(secretId: string): Promise<boolean> {
    const { DescribeSecretCommand } = await import('@aws-sdk/client-secrets-manager');
    const client = await this.client();
    try {
      const res = await client.send(new DescribeSecretCommand({ SecretId: secretId }));
      // 削除予定（DeletedDate 設定済み）は「存在しない」扱いにする。
      return res.DeletedDate === undefined;
    } catch (err) {
      if (isNotFound(err)) return false;
      throw err;
    }
  }

  async delete(secretId: string): Promise<void> {
    const { DeleteSecretCommand } = await import('@aws-sdk/client-secrets-manager');
    const client = await this.client();
    try {
      // 復旧猶予 30 日（AWS 既定）。ForceDeleteWithoutRecovery は使わない（誤削除復元の余地を残す）。
      await client.send(
        new DeleteSecretCommand({ SecretId: secretId, RecoveryWindowInDays: 30 }),
      );
    } catch (err) {
      // 未存在・削除予定済みは冪等に no-op。
      if (isNotFound(err)) return;
      if (err instanceof Error && err.name === 'InvalidRequestException') return;
      throw err;
    }
  }
}

function isNotFound(err: unknown): boolean {
  return err instanceof Error && err.name === 'ResourceNotFoundException';
}
