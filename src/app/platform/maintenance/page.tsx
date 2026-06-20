import { DangerActionPlaceholder, ReadOnlySection } from '@/components/admin/platform/primitives';

/**
 * プラットフォーム: メンテナンス管理（read 中心スケルトン） (issue #90, increment 1)。
 *
 * 全体 / テナント単位のメンテナンス状態・お知らせ・障害情報・受付端末へのメンテナンス表示を
 * read 専用で確認する。メンテナンス発動などの破壊的操作は確認・影響範囲表示・昇格・監査を
 * 伴う導線に隔離する（本増分では無効化）。
 */
export default function PlatformMaintenancePage() {
  return (
    <ReadOnlySection
      title="メンテナンス"
      description="全体 / テナント単位のメンテナンス状態・お知らせ・障害情報・受付端末へのメンテナンス表示を確認します（読み取り中心）。状態の変更は影響範囲が広いため、確認・昇格・監査を伴う導線に隔離します。"
    >
      <div style={{ marginTop: 'var(--space-md)', maxWidth: 760 }}>
        <DangerActionPlaceholder label="メンテナンスモード発動 / お知らせ・障害情報の登録" />
      </div>
    </ReadOnlySection>
  );
}
