/**
 * プラットフォーム運用コンソールのダッシュボード雛形 (issue #85, increment 1; 本実装は #90)。
 *
 * #90 の Platform Dashboard 要件（全テナント数・稼働中・異常・直近エラー・利用量・
 * コスト概算・メンテナンス状況 等）はここに段階実装する。
 * 本増分はプレースホルダのみで、安全 UX 方針（読み取り中心・対象テナント明示）を明記する。
 */
export default function PlatformDashboardPage() {
  return (
    <section>
      <h1 style={{ marginTop: 0 }}>運用ダッシュボード</h1>
      <p style={{ opacity: 0.85, maxWidth: 720 }}>
        総合開発者・プラットフォーム運用者向けのテナント横断コンソールです。
        全テナントの稼働状況・直近エラー・利用量・コスト概算・メンテナンス状況を確認します。
        画面の本実装は issue #90 で行います。
      </p>
      <p style={{ opacity: 0.7, maxWidth: 720, fontSize: '0.875rem' }}>
        方針: 通常時は読み取り中心。対象テナントは常に画面上部に明示し、有効/停止・
        メンテナンス等の破壊的操作は DangerZone に隔離して理由入力・確認を必須にします。
        認可は API 側で role/tenantId を検証し、本エリアは developer ロールのみが入れます。
      </p>
    </section>
  );
}
