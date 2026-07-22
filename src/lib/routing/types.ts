/**
 * ルーティング永続化の保存型と API ビュー型 (issue #374, 残 increment)。
 *
 * ドメイン型（`@/domain/routing/*`）に永続化・境界のためのフィールドだけを加算する。
 * ドメイン型そのものは変更しない（第3wave の契約に乗る）。
 *
 * PII 方針（`.claude/rules/pii-secret-minimization.md`）:
 *   - `ContactEndpoint` の接続アドレス（`e164` / `uri`）は機微値。**保存はするが API レスポンス
 *     （`EndpointView`）へは決して出さない**。UI へは末尾数桁だけの `maskedAddress` を返す。
 *   - 監査ログにもアドレスを残さない（service 層が担保）。
 */
import type { ContactEndpoint, ContactChannel, EndpointOwnerType } from '@/domain/routing/endpoint';
import type { RoutingPolicy } from '@/domain/routing/policy';

/** 保存する接続先。テナント/サイト境界と作成/更新時刻を加算する。 */
export type StoredContactEndpoint = ContactEndpoint & {
  tenantId: string;
  /** 対象サイト。未設定はテナント横断（境界認可は service 層）。 */
  siteId?: string;
  createdAt: string;
  updatedAt: string;
};

/** 保存するルーティングポリシー。RoutingPolicy に作成/更新時刻を加算する。 */
export type StoredRoutingPolicy = RoutingPolicy & {
  createdAt: string;
  updatedAt: string;
};

/**
 * API が返す接続先ビュー。**アドレス（e164/uri）を構造的に持たない**。
 * 管理 UI はこの型だけを受け取り、アドレスの平文をブラウザへ持ち込まない。
 */
export type EndpointView = {
  id: string;
  tenantId: string;
  siteId?: string;
  ownerType: EndpointOwnerType;
  ownerId: string;
  channel: ContactChannel;
  providerKey: string;
  enabled: boolean;
  label?: string;
  /** アドレスの末尾数桁のみのマスク表示（例: `****1234`）。編集時は再入力する。 */
  maskedAddress: string;
  createdAt: string;
  updatedAt: string;
};

/**
 * API が返すポリシービュー。保存ポリシーに、非エンジニア向けの**文章形式説明**（`description`）を
 * 添える。文章は接続先の `label`（PII 非含）だけを使い、アドレスは決して出さない（`describe.ts`）。
 */
export type PolicyView = StoredRoutingPolicy & {
  /** `describeRoutingPolicy` による手順の文章（1 手 = 1 行、先頭は概要行）。 */
  description: string[];
};
