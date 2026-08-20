/**
 * 全断時に来訪者へ出す応答 (#629 / N2a)。
 *
 * origin-verify が拒否したとき、iPad の全画面に出るのは英語 1 語の `forbidden` だけだった。
 * matcher は `/kiosk` を含むので、**来訪者が最初に見る画面**がこれになる。
 *
 * ## middleware で返す理由（CloudFront ではなく）
 *
 * CloudFront の custom error response は**ディストリビューション単位**でしか設定できず
 * cache behavior に絞れないので、403/503 を割り当てると **API の 403/503 応答まで
 * HTML に差し替わる**（`PROVIDER_WEBHOOKS_DISABLED` の 503 + `Retry-After` は Vonage の
 * 再送に効いている運用スイッチ）。origin-verify の拒否は middleware 自身が返しているので、
 * ここで `Accept` を見れば **CloudFront に触れずに** 来訪者向けの応答を出せる。
 *
 * ## 制約
 *
 * この応答は Next のレンダリングを通らない（`_next/static` は matcher の外）。
 * **外部リソースもスクリプトも使えない** —— 全断中にそれ自体が取りに行けず白画面になる。
 */

/**
 * ブラウザの画面遷移か（HTML を返してよいか）。
 *
 * 🔴 **ワイルドカードや欠落を HTML 扱いにしない。** curl・webhook・多くの API クライアントは
 * ワイルドカードの Accept を送る。ここを取り違えると Vonage の再送が HTML を受け取る ——
 * #629 が CloudFront 方式を避けた理由そのものを、middleware 側で再現してしまう。
 */
export function prefersHtml(accept: string | null): boolean {
  return accept !== null && accept.includes('text/html');
}

/** 4 言語の案内。文言は `docs/experience/README.md` の「有人支援へ倒す」に合わせる。 */
const MESSAGES: readonly { readonly lang: string; readonly title: string; readonly body: string }[] = [
  { lang: 'ja', title: '受付を一時停止しています', body: '恐れ入りますが、近くのスタッフにお声がけください。' },
  { lang: 'en', title: 'Reception is temporarily paused', body: 'Please ask a nearby staff member for assistance.' },
  { lang: 'ko', title: '접수를 일시 중지하고 있습니다', body: '가까운 직원에게 말씀해 주세요.' },
  { lang: 'zh', title: '接待暂停中', body: '请向附近的工作人员咨询。' },
];

/**
 * 来訪者向けの停止画面。**403 と 503 で同じ文面**を返す。
 *
 * 🔴 **理由を書かない。** `missing-secret`（503）と不一致（403）を本文で区別すると、
 * 外部に**迂回可能な時間帯を教える**ことになる（`src/proxy.ts` の `denyOriginVerify` が
 * 元から持っている制約）。来訪者にとっても区別に意味は無い。
 */
export function renderServiceHoldPage(): string {
  const sections = MESSAGES.map(
    (m) => `<section lang="${m.lang}"><h1>${m.title}</h1><p>${m.body}</p></section>`,
  ).join('');
  return `<!doctype html><html lang="ja"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>${MESSAGES[0]!.title}</title><style>:root{color-scheme:light dark}body{margin:0;min-height:100vh;display:flex;flex-direction:column;justify-content:center;gap:1.5rem;padding:2rem 3rem;font-family:system-ui,sans-serif;background:#f6f7f9;color:#1b1d20}section{max-width:48rem}h1{font-size:1.75rem;margin:0 0 .5rem}p{font-size:1.25rem;margin:0;color:#41464d}section+section{padding-top:1.25rem;border-top:1px solid #d8dbe0}@media(prefers-color-scheme:dark){body{background:#16181b;color:#eceef1}p{color:#b9bec6}section+section{border-top-color:#31353b}}</style></head><body>${sections}</body></html>`;
}
