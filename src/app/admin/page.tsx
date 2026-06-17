/**
 * 管理ダッシュボードのプレースホルダ (issue #22 で本実装)。
 */
export default function AdminHomePage() {
  return (
    <section>
      <h1 style={{ marginTop: 0 }}>ダッシュボード</h1>
      <p style={{ opacity: 0.85, maxWidth: 640 }}>
        受付端末、部署、担当者、アセット、音声、セキュリティ設定をここから管理します。
        各設定画面は後続の issue で実装します。
      </p>
    </section>
  );
}
