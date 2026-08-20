/**
 * QR 受付の「確認 → 実際に呼び出す」 (#736 Gate A)。
 *
 * ## なぜ関数として切り出すのか
 *
 * この順序は `CheckinFlow` の `useEffect` の中に書けるが、**そこに置くと誰も縛れない**。
 * このリポジトリには jsdom も testing-library も無く（vitest は node 環境）、
 * QR の注入口（`?debugScanPayload=`）は本番ビルドで無効なので E2E からも踏めない
 * ── token を URL クエリに載せない、という別の正しい判断の帰結。
 *
 * 実際、`/call` を呼ばない状態が長く残っていた。**確認だけで「受付が完了しました」と
 * 表示していた**（誰も呼ばれていないのに全員が受付完了する）。同型の嘘を
 * `unrouted`（#738）・`out_of_hours`（#747）で塞いだ直後に、QR 経路が丸ごと残っていた。
 *
 * よって `fetch` を注入できる関数として出し、順序と「呼ばなかったときに完了にしないこと」を
 * node のテストで固定する。`CheckinFlow` 側は結果を dispatch へ写すだけになる。
 */
import { checkinCallOutcomeFrom } from '@/domain/checkin/call-outcome';
import type { CheckinCallFailureReason } from '@/domain/checkin/failure';
import { checkinCallFailureReasonFrom } from '@/domain/checkin/failure';

export type CheckinConfirmResult =
  /** 担当者へ繋がった。ここだけが「受付完了」。 */
  | { readonly kind: 'connected' }
  /** 実 PSTN を 1 手撃った。結果は webhook 経由で `/status` に現れる。 */
  | { readonly kind: 'pending'; readonly receptionId: string }
  | { readonly kind: 'failed'; readonly reason: CheckinCallFailureReason };

export type ConfirmAndCallDeps = { readonly fetchFn?: typeof globalThis.fetch };

/**
 * 予約を使用済みにして受付を作り、**続けて実際に呼び出す**。
 *
 * 🔴 **例外を投げない。** 呼び出し元は React の効果で、投げると画面が
 * 「呼び出しています…」のまま固まる。失敗は結果として返す。
 */
export async function confirmAndCall(
  payload: string,
  deps: ConfirmAndCallDeps = {},
): Promise<CheckinConfirmResult> {
  // 🔴 `globalThis` へ束縛する。裸の `globalThis.fetch` を渡すと `this` を検査する実装で
  // Illegal invocation になる（`voice-dial.ts` と同じ理由）。
  const fetchFn = deps.fetchFn ?? globalThis.fetch.bind(globalThis);

  let receptionId: string;
  try {
    const res = await fetchFn('/api/kiosk/checkin/confirm', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ payload }),
    });
    if (!res.ok) {
      // 403 / 400 / 503 / その他を「通信に失敗しました」へ潰さない（#98 差分 D）。
      return { kind: 'failed', reason: checkinCallFailureReasonFrom(res.status) };
    }
    const created = (await res.json().catch(() => undefined)) as
      | { reception?: { id?: string } }
      | undefined;
    // 受付 ID が無ければ呼びようがない。**完了として扱わない。**
    if (typeof created?.reception?.id !== 'string') return { kind: 'failed', reason: 'server' };
    receptionId = created.reception.id;
  } catch {
    return { kind: 'failed', reason: checkinCallFailureReasonFrom(undefined) };
  }

  // 呼び出しは通常受付とまったく同じルートへ委ねる（営業時間ガード・停止スイッチ・取次・
  // 失敗理由をそのまま再利用し、二重実装を作らない）。
  let outcome: ReturnType<typeof checkinCallOutcomeFrom>;
  try {
    const res = await fetchFn(`/api/kiosk/receptions/${receptionId}/call`, { method: 'POST' });
    const body = (await res.json().catch(() => undefined)) as
      | { state?: string; error?: string }
      | undefined;
    outcome = checkinCallOutcomeFrom(res.status, body);
  } catch {
    outcome = checkinCallOutcomeFrom(undefined, undefined);
  }

  if (outcome.kind === 'pending') return { kind: 'pending', receptionId };
  return outcome;
}
