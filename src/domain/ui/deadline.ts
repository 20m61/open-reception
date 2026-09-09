/**
 * 「応答が返らない往復」に上限を掛ける (#1029)。
 *
 * ## なぜ `AbortSignal.timeout` を使わないか
 *
 * 🔴 **`AbortSignal.timeout` は Safari 16（2022-09）からで、iPadOS 15 以前には無い。**
 * しかも呼ぶと `TypeError` を投げるので、`fetch` の引数として評価すると
 * **要求が 1 本も飛ばない**。独立レビュー 3 周目が本番ビルドで実測した:
 *
 * ```
 * delete AbortSignal.timeout した /kiosk/checkout
 *   gets=0 resolves=0 posts=0   ← リクエストが 1 本も送信されていない
 *   画面: 「通信エラーが発生しました。もう一度お試しください。」
 * ```
 *
 * 回線は正常なのに退館の 3 手段が全滅し、staff は存在しないネットワーク障害を追うことになる。
 * **「悪い回線でだけ固まる」を直そうとして「特定の端末クラスで常に失敗する」へ変換していた。**
 * `docs/ipad-uat.md` の端末方針は「iPadOS は**可能な限り**最新のメジャー版」＝努力目標なので、
 * 16 以上を前提にできない。
 *
 * `AbortController` + `setTimeout` は Safari 12.1 / iOS 12.2 から使える。このリポジトリの
 * クライアント側は元々こちらを使っていた（`src/components/admin/use-site-list.ts`,
 * `src/lib/kiosk/operating-status-poll.ts`）。
 *
 * ## なぜ `expired()` を返すか
 *
 * 🔴 **例外の `name` で締切を見分けない**（独立レビュー 1 周目 MINOR-2）。締切は相によって
 * 別の名前で投げる —— Chromium の実測ではヘッダが来なければ `TimeoutError`、
 * ヘッダは来て **body が止まる**と `res.json()` が `AbortError`。WebKit が同じ名前を使う
 * 保証は無く、**この環境には webkit バイナリが無いので実測できない**。名前で分けると、
 * 別の名前を使うエンジンでは締切が黙って「通信エラー」へ落ちる —— 画面に痕跡が残らない。
 *
 * `signal.aborted` は**自分が張った締切そのもの**なので、エンジンに依らない。
 */
export type Deadline = {
  /** `fetch` の `signal` へ渡す。 */
  readonly signal: AbortSignal;
  /** 締切が切れたか（例外名に依存しない判定）。 */
  readonly expired: () => boolean;
  /** 往復が終わったらタイマーを解放する（`finally` で呼ぶ）。 */
  readonly done: () => void;
};

export function startDeadline(ms: number): Deadline {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), ms);
  return {
    signal: controller.signal,
    expired: () => controller.signal.aborted,
    done: () => clearTimeout(timer),
  };
}
