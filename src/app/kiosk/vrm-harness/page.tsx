/**
 * VRM 実描画検査のための**ハーネス**（#930 / #932 / #933）。
 *
 * ## なぜ要るのか
 *
 * `scripts/vrm-visual-check.mjs` は唯一 VRM の実描画を見る層だが、`/kiosk` を相手にすると
 * **見たい状況を作れない**ことが実測で分かった:
 *
 * - `vrmUrl` はサーバの env から渡るので、**セッション内で差し替えられない**。
 *   `page.goto` で変えるとコンポーネントが作り直され、状態の持ち越し（#932）が再現しない
 * - 状態遷移でモーションを切り替えようとすると、`selectingPurpose` では
 *   **`vrm-canvas` が 0 個**（アバターは idle 専用）で、canvas ごと mixer が破棄される。
 *   よって「退場したアクションが mixer に残る」（#930）も再現しない
 *
 * どちらも**検査の都合ではなく到達性の問題**なので、`VrmAvatarViewer` を
 * **マウントしたまま入力だけ差し替えられる**面をここに用意する。
 *
 * ## 本番には出さない
 *
 * `KIOSK_VRM_HARNESS=1` のときだけ描画し、それ以外は 404 にする。既定は無効なので、
 * env を立てていない環境（＝本番）からは到達できない。この既定は
 * `tests/config/vrm-harness-gate.test.ts` が縛る。
 */
import { notFound } from 'next/navigation';
import { VrmHarnessClient } from './harness-client';

export const dynamic = 'force-dynamic';

/** ハーネスを有効にする env。**既定は無効**。 */
export const VRM_HARNESS_ENV = 'KIOSK_VRM_HARNESS';

export default function VrmHarnessPage() {
  if (process.env[VRM_HARNESS_ENV] !== '1') notFound();
  return <VrmHarnessClient />;
}
