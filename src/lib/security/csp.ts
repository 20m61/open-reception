/**
 * nonce ベース CSP（issue #200）。
 *
 * script-src から 'unsafe-inline' を排除し、リクエストごとに生成する nonce で
 * Next.js の inline/bootstrap script を許可する。nonce は per-request のため
 * 静的ヘッダ（next.config.ts）では扱えず、`src/proxy.ts` で生成して
 * リクエスト/レスポンス双方の Content-Security-Policy ヘッダに載せる。
 * Next.js はリクエストヘッダの CSP から nonce を抽出し、SSR 時に自身の
 * framework/inline script へ自動付与する（＝全ルート動的レンダリング必須。
 * root layout の `connection()` で強制する）。
 *
 * 段階導入（#200 撤回知見）: 'strict-dynamic' は付けない。同一オリジンの
 * chunk（外部 script）は 'self' で許可し、inline script のみ nonce で許可する。
 *
 * style-src（issue #289）: 本番ビルドの SSR HTML に `<style>` 要素は含まれず
 * （CSS は同一オリジンの外部 stylesheet）、inline style は React の style 属性
 * （style-src-attr の管轄）のみ。そのため style-src（= style-src-elem の
 * フォールバック）から 'unsafe-inline' を排除し、注入 `<style>`/外部 CSS を
 * ブロックする。style 属性は React SSR が多用しており CSP nonce では許可
 * できない（属性は nonce 対象外）ため、style-src-attr で明示的に許可する。
 * ZAP 10055 は style-src-attr の 'unsafe-inline' を警告しない（ローカル ZAP
 * baseline で確認済み）。
 */

/** Server Component から nonce を参照するためのリクエストヘッダ名。 */
export const NONCE_HEADER = 'x-nonce';

/** CSP script-src 用の per-request nonce（128bit エントロピー、base64）。 */
export function createCspNonce(): string {
  const bytes = new Uint8Array(16);
  crypto.getRandomValues(bytes);
  // Buffer は edge runtime に無いことがあるため btoa 互換の変換を使う。
  let binary = '';
  for (const b of bytes) binary += String.fromCharCode(b);
  return btoa(binary);
}

/**
 * 同一オリジン iframe への埋め込みを許可するルート (#363)。
 * 受付体験スタジオ本体（/admin/demo）がプレビューを iframe で抱えるため、
 * プレビュールートのみ frame-ancestors 'self'（X-Frame-Options は next.config.ts 側で
 * SAMEORIGIN に上書き）。それ以外は従来どおり 'none' / DENY を維持する。
 */
const SELF_FRAMEABLE_PATHS = new Set<string>(['/admin/demo/preview']);

/**
 * 配る CSP のオプションを **pathname だけ**から決める（#1132 レビュー 10・11 周目）。
 *
 * 🔴 **導出を `proxy.ts` から持ってきた。** 元は proxy 側で組み立てていたため、
 * **リクエストの形（cookie / query / ヘッダ）や環境変数を条件に CSP を緩める**変更が
 * どのテストにも映らなかった（レビュー 9・10 周目の実測。テストレーンでは env が
 * 未設定なので期待値と実測が揃って緩まず、**本番だけが緩む**）。
 *
 * ここへ寄せると:
 *
 * - このモジュールは「**環境変数を読まない**」を `csp.test.ts` が 1 行で縛っている ——
 *   導出ごとその射程に入る
 * - 引数が `pathname` しか無いので、**リクエストの形は引数経由では渡せない**
 *   （8・9 周目のように「形を数え上げる」必要が無くなる）
 * - `proxy.ts` に残るのは `NODE_ENV` の 1 箇所だけになる
 *
 * 🔴 **`isDev` も引数から外した（10 周目の実測）。** 引数で受けていたとき、
 * `proxy.ts` が `process.env.CSP_DEV_RELAX === '1'` やリクエストヘッダから渡す変異が
 * **生存した**（テストレーンでは未設定／未送信なので、期待値と実測が揃って緩まない）。
 * 引数が `pathname` だけなら、**呼び出し側に渡せるものが無い**。
 *
 * 🔴 **この関数は純関数ではない**（`NODE_ENV` を読む）。ここへ置けるのは、`csp.test.ts` が
 * **実行時に読まれた env キーを記録**して `NODE_ENV` 以外がゼロであることを縛っているから
 * である（綴りに依存しない。10 周目の「ソースを正規表現で走査する」版は
 * `process.env['X']` を素通りさせた）。
 *
 * 🔴 **残る射程**（レビュー 14 周目に実測へ合わせて訂正）:
 *
 * - **env を条件にした**緩和 … `src/proxy.test.ts` の毒値の負の対照と、`csp.test.ts` の
 *   実行時記録器（`NODE_ENV` 以外はゼロ）、および `NODE_ENV` への依存を
 *   **モジュールを評価し直して**総当たりする 2 本が見る
 * - **位置**（渡す前に書き換える / 配った後で上書きする / helper へ委譲する）…
 *   **毒値の対照は見ていない**（実測）。見るのは `proxy` / `passThrough` の**本体の固定**である
 * - **cookie / ヘッダ / query を条件にした**緩和 … 族ごと塞いでいるのは
 *   「この関数が pathname しか受け取らない」ことと本体の固定で、変種テストは第 2 の証人にすぎない
 */
export function cspOptionsFor(pathname: string): { dev: boolean; frameAncestors: 'none' | 'self' } {
  return {
    dev: process.env.NODE_ENV === 'development',
    frameAncestors: SELF_FRAMEABLE_PATHS.has(pathname) ? 'self' : 'none',
  };
}

/**
 * CSP ディレクティブ文字列を組み立てる。
 * nonce 以外は従来の静的 CSP（#6/#31: blob/data の限定許可、ZAP 10055 の
 * スキームワイルドカード回避）を踏襲する。
 */
export function buildCsp(
  nonce: string,
  opts?: {
    dev?: boolean;
    /**
     * frame-ancestors の許可先。既定 'none'（全ルートで iframe 埋め込み拒否）。
     * 受付体験スタジオのプレビュー（/admin/demo/preview を同一オリジンの
     * /admin/demo が iframe で抱える, #363）のみ 'self' を渡す。
     */
    frameAncestors?: 'none' | 'self';
  },
): string {
  // 開発時のみ 'unsafe-eval' を許可（React がサーバエラーのスタック再構築等に
  // eval を使うため。production では React/Next.js とも eval を使わない）。
  const devEval = opts?.dev ? " 'unsafe-eval'" : '';
  // 開発時のみ style-src（elem）に 'unsafe-inline' を許可（Turbopack dev/HMR や
  // dev オーバーレイが `<style>` を注入するため。production ビルドは外部 CSS のみ）。
  const devStyleInline = opts?.dev ? " 'unsafe-inline'" : '';
  return [
    "default-src 'self'",
    `script-src 'self' 'nonce-${nonce}'${devEval}`,
    `style-src 'self'${devStyleInline}`,
    // React SSR の style 属性（766 箇所超）を許可する。属性は nonce/hash 対象外
    //（hash は 'unsafe-hashes' が別途要る）ため 'unsafe-inline' で明示許可する。
    "style-src-attr 'unsafe-inline'",
    "img-src 'self' data: blob:",
    "font-src 'self' data:",
    "connect-src 'self' blob:",
    "media-src 'self' data:",
    "object-src 'none'",
    "base-uri 'self'",
    "form-action 'self'",
    `frame-ancestors '${opts?.frameAncestors ?? 'none'}'`,
  ].join('; ');
}
