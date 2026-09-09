/**
 * 「応答が返らない往復」に上限を掛ける (#1029)。
 *
 * ## なぜ `AbortSignal.timeout` を使わないか
 *
 * 🔴 **理由は「`expired()` をエンジンに依存させないため」である。**
 * `AbortSignal.timeout` を `fetch` の引数として直接評価すると、**その API が無い環境では
 * 呼んだ瞬間に投げ、要求が 1 本も飛ばない**（独立レビュー 3 周目が `delete
 * AbortSignal.timeout` した本番ビルドで実測: `gets=0 resolves=0 posts=0`、画面は
 * 「通信エラーが発生しました」）。自分で `AbortController` を持てば、締切の有無を
 * `signal.aborted` で見られるので**例外の名前に依存しない**判定ができる。
 *
 * ⚠️ **「iPadOS 15 では動かない」とは書かない**（独立レビュー 4 周目 MINOR-4 の訂正）。
 * 3 周目はそう書いたが、**このリポジトリのビルド対象はそれより新しい** ――
 * `browserslist` の上書きが無いので Next 16 の既定（`safari 16.4` 以上）が効き、
 * `AbortSignal.timeout`（Safari 16.0〜）は**対象のどのブラウザにも在る**。
 * 上の実測は API を人為的に消した環境のものであって、実機の再現ではない。
 * それでも `AbortController` を選ぶのは、**例外名に依存しない判定**という独立した理由が
 * あるからである（下記）。実機 WebKit での検証は未実施（この環境に webkit バイナリが無い）。
 *
 * このリポジトリのクライアント側は元々 `AbortController` + `setTimeout` を使っている
 * （`src/components/admin/use-site-list.ts`, `src/lib/kiosk/operating-status-poll.ts`）。
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
