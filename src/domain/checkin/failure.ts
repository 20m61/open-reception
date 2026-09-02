/**
 * QR 受付の呼び出し失敗の理由と、来訪者へ出す文言の対応 (issue #98 / 差分 D)。
 *
 * **通常受付には第 36 wave（#453）で入った修正が、QR 受付には入っていなかった。**
 * `/api/kiosk/checkin/confirm` は 403（端末セッション切れ）・400（予約が受け付けられない）・
 * 503（上流到達不能）・その他のサーバ失敗を返しうるのに、`CheckinFlow` はすべて
 * `CALL_FAILED` → `networkError` へ潰し、来訪者には一律で「通信に失敗しました」と出していた。
 *
 * 通信が生きているのに「通信に失敗しました」と言うのは、体験設計の原則
 * 「システム状態を沈黙させない」（`docs/experience/README.md`）を実質的に満たさない。
 * 来訪者は端末を疑って無意味に再試行する。
 *
 * **状態は増やさない。** `networkError` のままで `why` だけを添えて文言を選ぶ（第 36 wave と
 * 同じ方針）。区別のために状態を増やすと、逃げ道・再試行・通常受付への切替の組み合わせが
 * 状態ごとに倍になる。
 *
 * > **命名の負債**: 状態名 `networkError` は、通信以外の失敗も受けるようになった時点で実態より
 * > 狭い。改名は `CHECKIN_STATES` / `CHECKIN_ERROR_STATES` / i18n キー対応表 / テストへ波及する
 * > ので別増分にする（ADR 0008 に follow-up として記録）。
 */
import type { MessageKey } from '@/lib/i18n';

export const CHECKIN_CALL_FAILURE_REASONS = [
  'network',
  'session',
  'invalid',
  'server',
  'unanswered',
  'unrouted',
  'out_of_hours',
] as const;

/**
 * - `network` … 端末からサーバへ到達できなかった（fetch 例外）、または上流へ到達できなかった（503）。
 * - `session` … 端末セッションが切れている（403）。**来訪者の操作では直らない**。
 * - `invalid` … 予約を受け付けられなかった（400）。QR 側の問題。
 * - `server`  … 到達したが完了できなかった（その他）。原因を来訪者に転嫁しない。
 * - `unanswered` … 呼び出しは**行われた**が担当者が出なかった (#736)。失敗と混同しない。
 * - `unrouted` … 実発信が停止中で、呼び出しが**一度も行われていない** (#736)。
 * - `out_of_hours` … 受付時間外で、呼び出しが**一度も行われていない** (#736)。
 */
export type CheckinCallFailureReason = (typeof CHECKIN_CALL_FAILURE_REASONS)[number];

/**
 * HTTP ステータスから失敗理由を導く。`status` 未指定 = fetch が例外（応答を得られていない）。
 *
 * 503 を `network` に寄せるのは、来訪者から見た復旧手段が「待って再試行」で同じだから
 * （サーバが上流へ到達できない状態は、端末が到達できない状態と体験上区別する意味が薄い）。
 */
export function checkinCallFailureReasonFrom(status: number | undefined): CheckinCallFailureReason {
  if (status === undefined || status === 503) return 'network';
  if (status === 403) return 'session';
  if (status === 400) return 'invalid';
  return 'server';
}

/** 失敗理由に対応する本文の i18n キー。 */
export function checkinCallFailureMessageKeyFor(reason: CheckinCallFailureReason): MessageKey {
  switch (reason) {
    case 'network':
      // 既存文言を維持する（通信断のときの案内は元から正しかった）。
      return 'checkin.error.network';
    case 'session':
      return 'checkin.error.session';
    case 'invalid':
      return 'checkin.error.reservation';
    case 'server':
      return 'checkin.error.server';
    case 'unanswered':
      return 'checkin.error.unanswered';
    case 'unrouted':
      return 'checkin.error.unrouted';
    case 'out_of_hours':
      return 'checkin.error.outOfHours';
  }
}
