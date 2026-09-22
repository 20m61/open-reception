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
import { serverSecret } from '@/lib/auth/server-secret';

/** 発信元を識別できないときの鍵。**全員がこれを共有する**（fail-safe 側）。 */
export const GLOBAL_IDENTITY = 'global';

/**
 * 発信元ハッシュの salt。
 *
 * 🔴 **`failClosed` にしない。** salt が未設定でも**受付は止めない** —— 失われるのは
 * 「保存された鍵から IP を逆引きされにくいこと」だけで、予算そのものは機能する。
 * 止めると、設定漏れのデプロイで**受付が丸ごと開かなくなる**。
 */
const identitySalt = () => serverSecret('ATTEMPT_KEY_SALT', 'dev-insecure-attempt-key-salt');

/**
 * IP を**鍵として等価なまま**ハッシュへ写す（#1021 AC4 / レビュー 2 周目 M-4）。
 *
 * 🔴 **生の IP を永続化しない。** 予算の鍵は「同じ発信元か」を判定できれば足りるので、
 * 値そのものを保存する必要が無い。ハッシュにすれば **PII 面が消える**（保存されるのは
 * 不可逆な 32 バイトで、監査のように「誰の IP か」を後から読む用途には使えない）。
 *
 * 🔴 **salt が要る。** IPv4 は空間が小さいので、salt 無しの `sha256(ip)` は
 * **総当たりで逆引きできる**（＝ PII が消えていない）。サーバ側 salt を混ぜる。
 *
 * 🔴 **これは認可でも監査でもない。** 「誰の IP か」を後から知る必要がある調査は
 * 既存の高詳細監査（`auditContextFromRequest`。**認可済み操作**に紐づく）の領分である。
 */
async function hashedIdentity(viewer: string): Promise<string> {
  const bytes = new TextEncoder().encode(`${identitySalt()}\u0000${viewer}`);
  const digest = await crypto.subtle.digest('SHA-256', bytes);
  const hex = Array.from(new Uint8Array(digest))
    .map((b) => b.toString(16).padStart(2, '0'))
    .join('');
  // 🔴 接頭辞は残す（`GLOBAL_IDENTITY` と衝突させないため）。
  return `ip:${hex}`;
}

/**
 * リクエストの発信元を予算の鍵へ写す。**生の IP は返さない**（上の `hashedIdentity`）。
 *
 * 🔴 **接頭辞 `ip:` を付ける。** 付けないと、`GLOBAL_IDENTITY` と同じ文字列を XFF へ
 * 詰めるだけで**global の予算を狙って消費させられる**（鍵の衝突）。
 *
 * 🔴 **鍵に IP 以外を混ぜない。** user-agent 等を混ぜると鍵が PII 寄りになり、
 * かつ攻撃者が自由に変えられる成分で鍵が割れて予算が素通りする
 * （`rules/pii-secret-minimization.md`）。
 */
export async function clientIdentity(request: Request): Promise<string> {
  const hops = (request.headers.get('x-forwarded-for') ?? '')
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean);
  const viewer = hops.at(-1);
  return viewer === undefined ? GLOBAL_IDENTITY : hashedIdentity(viewer);
}
