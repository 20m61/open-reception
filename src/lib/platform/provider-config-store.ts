/**
 * テナント別プロバイダ**非秘密設定**のストア (issue #405 Inc1 → #762 Inc2)。
 *
 * secret の値は保存しない（AC2）。本ストアは `TenantProviderConfig`（非秘密設定のみ）を tenantId で
 * 引く。secret は `tenant-secret-store` に別管理し（Secrets Manager）、presence のみを別途参照する。
 *
 * ## なぜ永続化したか (#762)
 *
 * Inc1 の実体は**プロセス内 `Map`** だった。OpenNext の Lambda は複数インスタンスで動くので、
 * 管理 API を処理したインスタンスだけが設定を持ち、**受付端末のリクエストを処理する別
 * インスタンスからは見えない**。実 Vonage 資格情報を入れても本番では効かない（効くかどうかが
 * リクエストごとに変わる）状態で、実 PSTN 受付の前提が揃っていなかった。
 *
 * §9 標準（docs/persistence-design.md）に合わせ、`getBackend()` の collection へ委譲する。
 * 呼び出し側 route の変更は不要（本ファイルの互換 API はそのまま）。
 */
import type { TenantProviderConfig } from '@/domain/provider-config/types';
import {
  DataBackedTenantProviderConfigRepository,
  type TenantProviderConfigRecord,
  type TenantProviderConfigRepository,
} from './repository';

let repository: TenantProviderConfigRepository | undefined;

/** プロセス共有のリポジトリ（§9.2 のファクトリ）。 */
function repo(): TenantProviderConfigRepository {
  if (!repository) repository = new DataBackedTenantProviderConfigRepository();
  return repository;
}

/**
 * 保存する形へ射影する。
 *
 * 🔴 **既知の非秘密フィールドだけを書く。** 呼び出し元が渡したオブジェクトをそのまま
 * 保存すると、route の検証をすり抜けた（あるいは検証を持たない新しい呼び出し元が渡した）
 * secret 風のキーが設定ストアへ落ちる。型は呼び出し元が増えたときの砦にならないので、
 * **値の側でも落とす**（`rules/pii-secret-minimization.md`）。
 *
 * 任意フィールドは持っているときだけ書く（`undefined` を撒かない ──
 * DynamoDB では属性の有無として観測でき、旧レコードとの差にもなる）。
 */
function toRecord(config: TenantProviderConfig): TenantProviderConfigRecord {
  const record: TenantProviderConfigRecord = {
    id: config.tenantId,
    tenantId: config.tenantId,
    provider: config.provider,
    enabled: config.enabled,
    updatedAt: config.updatedAt,
    updatedBy: config.updatedBy,
  };
  if (config.applicationId !== undefined) record.applicationId = config.applicationId;
  if (config.fromNumber !== undefined) record.fromNumber = config.fromNumber;
  if (config.timeoutMs !== undefined) record.timeoutMs = config.timeoutMs;
  return record;
}

/** テナントの設定を取得する（未設定は null）。 */
export async function getTenantProviderConfig(
  tenantId: string,
): Promise<TenantProviderConfig | null> {
  return (await repo().get(tenantId)) ?? null;
}

/** テナントの設定を upsert する（呼び出し側で認可・監査済み）。 */
export async function putTenantProviderConfig(config: TenantProviderConfig): Promise<void> {
  await repo().put(toRecord(config));
}

/** テナントの設定を削除する。 */
export async function deleteTenantProviderConfig(tenantId: string): Promise<void> {
  await repo().remove(tenantId);
}

/** テスト用に初期化する（memory backend のみ実効）。 */
export async function __resetProviderConfigStore(): Promise<void> {
  await repo().reset();
}
