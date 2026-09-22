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
 * 発信元ハッシュの salt。**プロセス起動ごとの乱数**で、どこにも保存しない。
 *
 * 🔴 **設定 env（`ATTEMPT_KEY_SALT`）は撤回した（独立レビュー 3 周目 MAJOR-3）。**
 * 実測で、その env は**実装・`.env.example`・設計文書の 3 箇所にしか無く、
 * `infra/` にも `docs/deploy-aws.md` にも 1 度も現れていなかった** ——
 * つまり実デプロイでは既定値
 * （リポジトリに平文で置かれた `dev-insecure-attempt-key-salt`）が使われる。
 * 公開既定値の salt は salt ではないので、**IPv4 の 2^32 は総当たりで逆引きできる**。
 * 「ハッシュだから PII ではない」という主張が**配備の現実で偽**だった。
 *
 * 配線し忘れると静かに嘘になる設定を足すより、**設定を要らなくする**方を採る
 * （「機構を足さない」`.claude/rules/opus5-autonomous-loop.md`）。
 *
 * ## 代償を正確に書く
 *
 * salt がプロセスごとに違うので、**同じ IP でも実行環境（Lambda インスタンス）が
 * 違えば別の鍵**になる。したがって:
 *
 * - **一次（発信元ごと）の予算は実質「プロセスあたり」**になり、同時に生きている
 *   実行環境の数だけ緩む。**「1 IP は 10 回/10 分」と書かない。**
 * - **二次（global cap）は影響を受けない** —— 鍵が `GLOBAL_IDENTITY` の**固定文字列**で、
 *   salt を通らないからである。総量の上界を持っているのはこちらなので、
 *   総当たりに対する実際の backstop は壊れない。
 * - プロセスが入れ替わると、その分の一次窓は**孤児レコード**として残る。TTL（2 時間）で
 *   自然消滅する。増える量の見積りは `docs/persistence-design.md` §4.2。
 *
 * 🔴 **`crypto.getRandomValues` を使う（`Math.random` ではない）。** 予測できる salt は
 * 公開既定値と同じ問題（逆引き可能）に戻る。
 */
const IDENTITY_SALT = crypto.getRandomValues(new Uint8Array(32));

/**
 * IP を**鍵として等価なまま**ハッシュへ写す（#1021 AC4 / レビュー 2 周目 M-4）。
 *
 * 🔴 **生の IP を永続化しない。** 予算の鍵は「同じ発信元か」を判定できれば足りるので、
 * 値そのものを保存する必要が無い。ハッシュにすれば **PII 面が消える**（保存されるのは
 * 不可逆な 32 バイトで、監査のように「誰の IP か」を後から読む用途には使えない）。
 *
 * 🔴 **salt が要る。** IPv4 は空間が小さいので、salt 無しの `sha256(ip)` は
 * **総当たりで逆引きできる**（＝ PII が消えていない）。上の `IDENTITY_SALT`
 * （プロセス起動ごとの乱数・非永続）を混ぜる。
 *
 * 🔴 **これは認可でも監査でもない。** 「誰の IP か」を後から知る必要がある調査は
 * 既存の高詳細監査（`auditContextFromRequest`。**認可済み操作**に紐づく）の領分である。
 */
async function hashedIdentity(viewer: string): Promise<string> {
  const suffix = new TextEncoder().encode(`\u0000${viewer}`);
  const bytes = new Uint8Array(IDENTITY_SALT.length + suffix.length);
  bytes.set(IDENTITY_SALT);
  bytes.set(suffix, IDENTITY_SALT.length);
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
