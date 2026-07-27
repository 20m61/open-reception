/**
 * 受付体験の版管理と端末反映のドメイン型 (issue #420 / epic #418 Wave 2)。
 *
 * #419 の `EffectiveKioskConfiguration` が「いま端末に適用される構成」なら、本モジュールは
 * 「どの構成を、いつ、誰の承認で、どの端末へ配るか」を扱う。
 *
 * increment 1 では版は指紋（`configHash`）だけを持つ設計だったが、**それでは公開が成立しない**
 * （指紋が指す中身＝可変ストアが動いてしまう）。increment 2 で
 * `ExperienceConfigurationSnapshot` を導入し、版は中身ごと固定する。
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

/**
 * 版が固定した構成の中身 (issue #420 increment 2)。
 *
 * **これが無いと「下書き変更が本番へ即時反映されない」は成立しない。** 現行の設定は可変ストア
 * （branding / voice / signage …）に live で載っており、管理画面の保存がそのまま端末へ届く。
 * 版に指紋（`configHash`）だけを持たせても、指紋が指す中身が動いてしまうため公開の意味が無い。
 * そこで下書き保存時に**解決済みセクション値のスナップショット**を取り、公開版はそれを配る。
 */
export type ExperienceConfigurationSnapshot = {
  /** `CONFIGURATION_SECTIONS` の各セクション値（`EffectiveKioskConfiguration` と同じ形）。 */
  sections: Record<string, unknown>;
  /** セクションごとの由来。公開後も「どこで設定された値か」を辿れるように一緒に固定する。 */
  provenance?: Record<string, string>;
  /**
   * スナップショット時点の**内容の**指紋（`computeSectionsHash`）。
   * API 応答の `configHash`（context/version を含む）とは別物なので取り違えないこと。
   */
  configHash: string;
};

/** 受付体験の 1 版。内容の指紋・来歴と、固定した構成のスナップショットを持つ。 */
export type ReceptionExperienceVersion = {
  revision: number;
  status: ExperienceVersionStatus;
  /** #419 resolver が算出した構成の指紋。 */
  configHash: string;
  /**
   * 固定した構成の中身。未設定の版は「その時点の live なストア」を指す旧来の挙動に倒れる
   * （スナップショット導入前に作られた版・seed 版との互換）。
   */
  snapshot?: ExperienceConfigurationSnapshot;
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
