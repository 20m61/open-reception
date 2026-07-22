import { KioskFlow } from '@/components/kiosk/KioskFlow';
import { resolveDefaultScope } from '@/lib/tenant/default-scope';
import { resolveKioskStatusFor } from '@/lib/operating-policy/store';

// 営業状態は時刻依存（`resolveKioskStatusFor` は Date.now() を評価する）のため、
// ビルド時の静的プリレンダーへ古い判定を焼き込まない（issue #367）。
export const dynamic = 'force-dynamic';

/**
 * 受付端末のエントリ。状態遷移モデル (issue #10) に沿って
 * 待機 → 目的 → 担当者 → 入力 → 確認 → 呼び出し → 結果 を表示する (issue #11–#15)。
 *
 * 営業時間外UX (issue #367): サーバ側で保存済み `ServiceOperatingPolicy` を評価し、
 * `KioskFlow` の `operatingStatus` prop（既存の受け口、#367 の kiosk 側表示レール
 * `@/domain/kiosk/operating-status.ts`）へ渡す。closed かつ待機中なら KioskFlow が
 * `OutOfHoursView` を表示する（`src/domain/kiosk/mode.ts`）。
 *
 * スコープ解決: このページはまだ per-request の kiosk 識別子（cookie ベースの認証済み
 * kiosk セッション）を持たない（`KioskFlow.tsx` 内の `KIOSK_ID` 定数は heartbeat/PIN 用の
 * 暫定値）ため、`/call` の営業時間ガード（`evaluateCallGuard`）と同じ既定スコープ
 * （`resolveDefaultScope`、単一テナント運用の MVP 前提）で評価する。未設定テナントは
 * `resolveKioskStatusFor` が undefined を返し、KioskFlow 側の fail-open（`operatingStateOf`
 * が判定不能を「通常受付」として扱う）で従来どおり動作する。
 *
 * 営業中→時間外の切替: このページはリクエストのたびにサーバで再評価する（force-dynamic）。
 * 待機画面が長時間開いたまま自動では切り替わらない点は、既存の待機サイネージ/端末ハートビート
 * と同じ制約（クライアント側の定期再取得は本 increment のスコープ外）。
 */
export default async function KioskHomePage() {
  const scope = resolveDefaultScope();
  const operatingStatus = await resolveKioskStatusFor(String(scope.tenantId), String(scope.siteId));
  return <KioskFlow operatingStatus={operatingStatus} />;
}
