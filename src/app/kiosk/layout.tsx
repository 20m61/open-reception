/**
 * 受付端末レイアウト。
 * 半常設の kiosk 表示を前提とし、管理画面とは認可・UI を分離する (issue #24, #23)。
 * 認可 (PIN / IP / 端末認可) は後続 issue で middleware と接続する。
 */
export default function KioskLayout({
  children,
}: {
  children: React.ReactNode;
}) {
  return (
    <div data-area="kiosk" style={{ minHeight: '100vh' }}>
      {children}
    </div>
  );
}
