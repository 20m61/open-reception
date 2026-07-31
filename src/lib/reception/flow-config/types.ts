/**
 * 来訪目的別カスタム受付フロー設定の永続化型 (issue #100, increment 1)。
 *
 * 純ドメイン（src/domain/reception/custom-flow.ts）の ReceptionFlow に、テナント/サイト
 * 境界・採番済み ID・タイムスタンプを合成した「保存される」表現を定義する。
 * フロー定義の中身（ステップ・フィールド）はドメイン型をそのまま再利用する。
 */
import type { SiteId, TenantId } from '@/domain/tenant/types';
import type {
  FlowField,
  FlowStepKind,
  ReceptionFlowId,
} from '@/domain/reception/custom-flow';

/** 永続化される受付フロー設定。Collection<{id}> の制約を満たすため id は string。 */
export type StoredReceptionFlow = {
  id: ReceptionFlowId;
  tenantId: TenantId;
  /** 対象拠点。サイト境界認可（canAccessSite）の基準。 */
  siteId: SiteId;
  purposeKey: string;
  displayName: string;
  description?: string;
  order: number;
  enabled: boolean;
  steps: FlowStepKind[];
  fields: FlowField[];
  completionMessage?: string;
  createdAt: string;
  updatedAt: string;
};

/** 作成入力。id/タイムスタンプはサービスが採番する。 */
export type CreateReceptionFlowInput = {
  tenantId: TenantId;
  siteId: SiteId;
  /** 検証前の生ドラフト（ドメインの validateReceptionFlow に渡す）。 */
  purposeKey?: unknown;
  displayName?: unknown;
  description?: unknown;
  order?: unknown;
  steps?: unknown;
  fields?: unknown;
  completionMessage?: unknown;
};

/** 更新パッチ。指定フィールドのみ反映する。enabled は有効/無効トグルに使う。 */
export type UpdateReceptionFlowPatch = {
  displayName?: unknown;
  description?: unknown;
  order?: unknown;
  steps?: unknown;
  fields?: unknown;
  completionMessage?: unknown;
  enabled?: boolean;
};
