/**
 * 試行予算の一次鍵に使う**発信元の識別**（#1021 AC4 / レビュー B1）。
 *
 * ## 末尾を採る理由
 *
 * CloudFront は client 提供の `x-forwarded-for` の**右側**に実 client IP を追記するので、
 * **先頭値は client が詐称できる**。末尾（最も手前の信頼 proxy が付与した値）は詐称できない。
 * `src/lib/admin/audit.ts` の `auditContextFromRequest` が同じ理由で同じ抽出をしている
 * —— **規約を 2 通りにしない**ため、抽出の根拠もここに 1 度だけ書く。
 *
 * 本番で末尾が信頼できる根拠は `src/proxy.ts` の origin-verify で、CloudFront 迂回
 * （Function URL 直叩き）を**全ルートで**拒否する。
 *
 * 🔴 **当初この増分は「非詐称可能な識別子は無い」と判断して鍵を global 1 本にしていた。**
 * それは authorize route が読んでいる `split(',')[0]`（先頭）から一般化した誤りで、
 * 独立レビューが上記 2 箇所を挙げて反証した。global 1 本だと攻撃者が少量のリクエストで
 * **運用者を無期限に閉め出せ**、kiosk の復旧経路（エンロール発行）が admin セッションを
 * 要求するため**受付が復旧不能になる**。
 *
 * 🔴 **これは認可には使わない。** 予算の鍵（誰の失敗として数えるか）にだけ使う。
 * IP を認可根拠にしないのは authorize route が既に書いているとおり。
 */

/** 発信元を識別できないときの鍵。**全員がこれを共有する**（fail-safe 側）。 */
export const GLOBAL_IDENTITY = 'global';

/**
 * リクエストの発信元を予算の鍵へ写す。
 *
 * 🔴 **接頭辞 `ip:` を付ける。** 付けないと、`GLOBAL_IDENTITY` と同じ文字列を XFF へ
 * 詰めるだけで**global の予算を狙って消費させられる**（鍵の衝突）。
 *
 * 🔴 **鍵に IP 以外を混ぜない。** user-agent 等を混ぜると鍵が PII 寄りになり、
 * かつ攻撃者が自由に変えられる成分で鍵が割れて予算が素通りする
 * （`rules/pii-secret-minimization.md`）。
 */
export function clientIdentity(request: Request): string {
  const hops = (request.headers.get('x-forwarded-for') ?? '')
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean);
  const viewer = hops.at(-1);
  return viewer === undefined ? GLOBAL_IDENTITY : `ip:${viewer}`;
}
