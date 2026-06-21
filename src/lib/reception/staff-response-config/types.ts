/**
 * 担当者応答アクション設定の永続化型 (issue #99 increment 2)。
 *
 * 純ドメイン（src/domain/reception/staff-response.ts）の応答種別ごとの上書き
 * （有効/無効・来訪者文言）に、テナント/サイト境界とタイムスタンプを合成した
 * 「保存される」表現を定義する。設定が無い種別は定義の既定にフォールバックする
 * （永続化では「上書きのある種別だけ」を保持し、未設定種別は既定のまま動く）。
 *
 * PII を一切持たない（応答種別と管理者定義の文言のみ）。
 */
import type { SiteId, TenantId } from '@/domain/tenant/types';
import type {
  StaffResponseAction,
  StaffResponseConfigOverrides,
} from '@/domain/reception/staff-response';

/**
 * 永続化される担当者応答設定。tenantId/siteId の組で 1 レコード。
 * Collection<{id}> の制約を満たすため id は `${tenantId}#${siteId}` を採番する。
 */
export type StoredStaffResponseConfig = {
  id: string;
  tenantId: TenantId;
  /** 対象拠点。サイト境界認可（canAccessSite）の基準。 */
  siteId: SiteId;
  /** 応答種別ごとの上書き（部分指定。未設定種別は既定にフォールバック）。 */
  overrides: StaffResponseConfigOverrides;
  createdAt: string;
  updatedAt: string;
};

/** 1 応答種別の更新パッチ。サービスが検証して overrides に反映する。 */
export type StaffResponseOverridePatch = {
  action: StaffResponseAction;
  /** 有効/無効。省略時は据え置き。 */
  enabled?: boolean;
  /**
   * 来訪者文言の上書き。空文字/空白を渡すと上書きを解除して既定へ戻す。
   * 省略時は据え置き。
   */
  messageOverride?: string | null;
};
