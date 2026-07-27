/**
 * 受付体験の版管理と端末反映のドメイン型 (issue #420 / epic #418 Wave 2)。
 *
 * #419 の `EffectiveKioskConfiguration` が「いま端末に適用される構成」なら、本モジュールは
 * 「どの構成を、いつ、誰の承認で、どの端末へ配るか」を扱う。両者の接点は `configHash`
 * （`src/domain/product-context/config-hash.ts`）で、**版は構成の指紋を保持するだけで
 * 構成そのものを二重に持たない**。プレビューと公開後で同じ指紋が観測できることが AC。
 *
 * 方針（`src/domain/demo-studio/publication.ts` の先行事例に合わせる）:
 *   - すべて純関数・I/O なし・入力を破壊しない。時刻は呼び出し側が ISO で渡す。
 *   - `versions` は **append-only**。publish も rollback も新しい版を積むだけで、過去の
 *     `configHash` / `createdAt` / `revision` を書き換えない（監査可能性・切り戻しの担保）。
 *   - `revision` は**単調増加**。端末側の stale 検出が「番号の大小」だけで成立する。
 *     rollback も新しい revision を採番する（過去へ戻ると端末が古い版を新しいと誤認する）。
 *
 * 統合メモ: #363 のデモ公開モデル（`domain/demo-studio/publication.ts`）とは概念が重複する。
 * `docs/product-integration-plan.md` §5 の方針どおり、最終的に**版モデルは本モジュールへ一本化**し
 * デモ側を寄せる（両方を恒久的に残さない）。本 increment では移行しない。
 */
import type { SiteId, TenantId } from '@/domain/tenant/types';

/** 版の状態。live なのは `published` の 1 件のみ。 */
export const EXPERIENCE_VERSION_STATUSES = [
  'draft',
  'published',
  'archived',
  'rolled_back',
] as const;
export type ExperienceVersionStatus = (typeof EXPERIENCE_VERSION_STATUSES)[number];

/** 公開前の自動検証項目（#420「品質ゲート」）。実チェッカの配線は後続 increment。 */
export const VALIDATION_CHECKS = [
  'config_schema',
  'asset',
  'motion_mapping',
  'language_fallback',
  'call_route',
  'permission',
  'accessibility',
] as const;
export type ValidationCheck = (typeof VALIDATION_CHECKS)[number];

/** `error` は公開を止める。`warning` は記録するが止めない。 */
export type ValidationSeverity = 'error' | 'warning';

export type ValidationFinding = {
  check: ValidationCheck;
  severity: ValidationSeverity;
  /** 運用者向けの短い説明。PII・secret を含めない。 */
  message: string;
};

export type ValidationSummary = {
  checkedAt: string;
  findings: ValidationFinding[];
};

/** 受付体験の 1 版。内容そのものではなく、内容の指紋と来歴を持つ。 */
export type ReceptionExperienceVersion = {
  revision: number;
  status: ExperienceVersionStatus;
  /** #419 resolver が算出した構成の指紋。 */
  configHash: string;
  validationSummary?: ValidationSummary;
  createdBy: string;
  createdAt: string;
  approvedBy?: string;
  approvedAt?: string;
  publishedBy?: string;
  publishedAt?: string;
  /** rollback で作られた版の復元元 revision。 */
  rolledBackFrom?: number;
};

/** 受付体験（拠点ごとの編集単位）と、その版履歴。 */
export type ReceptionExperience = {
  id: string;
  tenantId: TenantId;
  siteId: SiteId;
  name: string;
  /** append-only。revision 昇順。 */
  versions: ReceptionExperienceVersion[];
  updatedAt: string;
};

/** 端末への反映状態。 */
export const DEPLOYMENT_STATUSES = ['applied', 'pending', 'stale', 'failed'] as const;
export type DeploymentStatus = (typeof DEPLOYMENT_STATUSES)[number];

/** 1 端末分の反映状況（desired = 公開中の版、loaded = 端末が実際に読み込んだ版）。 */
export type KioskConfigDeployment = {
  kioskId: string;
  siteId: SiteId;
  desiredRevision: number;
  desiredConfigHash: string;
  loadedRevision?: number;
  loadedConfigHash?: string;
  lastAttemptAt?: string;
  /** 読込失敗の分類（端末 heartbeat が報告する）。 */
  errorCode?: string;
  /** 失敗が「どの版の読込で」起きたか。desired と一致するときだけ failed とみなす。 */
  errorRevision?: number;
};
