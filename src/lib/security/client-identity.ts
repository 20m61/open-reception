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
import { getEnrollmentSecret } from '@/lib/auth/kiosk-enrollment';

/** 発信元を識別できないときの鍵。**全員がこれを共有する**（fail-safe 側）。 */
export const GLOBAL_IDENTITY = 'global';

/**
 * 発信元ハッシュの salt。**既にデプロイへ配線されている fail-closed の鍵から導出する。**
 *
 * ## ここは 2 度方式を替えている。両方の失敗を残す
 *
 * 🔴 **1 度目: `ATTEMPT_KEY_SALT` という専用 env**（独立レビュー 3 周目 MAJOR-3）。
 * その env は実装・`.env.example`・設計文書の 3 箇所にしか無く、**`infra/` にも
 * `docs/deploy-aws.md` にも 1 度も現れていなかった** —— 実デプロイでは公開されている
 * dev 既定値が使われ、「ハッシュだから IP は復元できない」が**配備の現実で偽**だった。
 *
 * 🔴 **2 度目: プロセス起動ごとの乱数**（同 4 周目 MAJOR-1）。設定を要らなくしたので
 * MAJOR-3 は消えたが、**鍵がプロセス間で安定しなくなった**。Lambda は同時実行ごとに
 * 別の実行環境を立てるので、**同じ IP が実行環境の数だけ別の一次鍵**に割れる ——
 * 一次予算（10 回）がどれにも当たらないまま、固定鍵の global cap（60 回）だけが
 * 共有で減る。つまり **1 本の IP を並列に投げるだけでサイト全体の初回認可を閉じられ**、
 * 「1 発信元が二次へ入れられるのは高々 `perOrigin.budget` 回」という
 * `attempt-store.ts` の主張が**本番で偽**になっていた（変更前は最低 6 本の IP が要った）。
 *
 * ## 今の方式が両方を同時に満たす理由
 *
 * `KIOSK_ENROLLMENT_SECRET` は **`failClosed: true`** で、実デプロイ（Lambda）で未設定なら
 * **起動が落ちる**。しかも `docs/deploy-aws.md` が Secrets Manager の必須項目として
 * 名指ししている ―― **既に配線されている**。だから:
 *
 * - **公開既定値に落ちない**（落ちる配備は enroll ごと動かないので気づく）＝ MAJOR-3 が戻らない
 * - **プロセス間で安定**（同じ秘密から決定的に導出する）＝ MAJOR-1 が戻らない
 * - **新しい env も `infra/` 変更も要らない** ＝ 配線し忘れる面を新設しない
 *
 * 🔴 **鍵を使い回さず、HKDF で「分ける」。** 署名鍵をそのまま salt にすると、用途の違う
 * 2 つが同じ値を共有する。専用ラベル付きの HKDF で導出すれば、**保存されたハッシュから
 * 署名鍵は導けない**（一方向）。ラベルは変えないこと —— 変えると全端末の一次窓が
 * 一斉に作り直される（予算がその瞬間だけ倍になる。TTL 2 時間で収まる）。
 */
const SALT_INFO = new TextEncoder().encode('open-reception/attempt-budget/client-identity/v1');

/**
 * 🔴 **成功したときだけ覚える。** 失敗した Promise を覚えると、以後そのプロセスは
 * 永久に同じ失敗を返す（鍵が後から入る経路は無いので実害は小さいが、
 * 「一度の失敗を恒久化する」形そのものを作らない）。
 */
let saltCache: Uint8Array | undefined;

async function identitySalt(): Promise<Uint8Array> {
  if (saltCache !== undefined) return saltCache;
  // 🔴 未設定なら throw する（`failClosed`）。呼び出し側は `secretUnavailableResponse` へ倒す。
  const ikm = new TextEncoder().encode(getEnrollmentSecret());
  const key = await crypto.subtle.importKey('raw', ikm, 'HKDF', false, ['deriveBits']);
  const bits = await crypto.subtle.deriveBits(
    { name: 'HKDF', hash: 'SHA-256', salt: new Uint8Array(0), info: SALT_INFO },
    key,
    256,
  );
  saltCache = new Uint8Array(bits);
  return saltCache;
}

/**
 * 鍵の材料が解決できるかだけを確かめる（`/api/kiosk/enroll` と同じ流儀）。
 *
 * 🔴 **catch の射程を「鍵の解決」だけに保つため**に分けてある。`clientIdentity` ごと
 * try で包むと、ハッシュ計算やヘッダ解析の throw まで 503 に化ける
 * （`src/lib/auth/secret-unavailable.ts` に理由が 1 度だけ書いてある。#1123）。
 */
export function assertIdentitySaltAvailable(): void {
  getEnrollmentSecret();
}

/** テスト用: 導出済み salt を捨てる（鍵を差し替えた面を測るため）。 */
export function __resetIdentitySalt(): void {
  saltCache = undefined;
}

/**
 * IP を**鍵として等価なまま**ハッシュへ写す（#1021 AC4 / レビュー 2 周目 M-4）。
 *
 * 🔴 **生の IP を永続化しない。** 予算の鍵は「同じ発信元か」を判定できれば足りるので、
 * 値そのものを保存する必要が無い。ハッシュにすれば **PII 面が消える**（保存されるのは
 * 不可逆な 32 バイトで、監査のように「誰の IP か」を後から読む用途には使えない）。
 *
 * 🔴 **salt が要る。** IPv4 は空間が小さいので、salt 無しの `sha256(ip)` は
 * **総当たりで逆引きできる**（＝ PII が消えていない）。上の `identitySalt()`
 * （fail-closed の鍵から HKDF で導出。**保存もしないし、公開既定値にも落ちない**）を混ぜる。
 *
 * 🔴 **これは認可でも監査でもない。** 「誰の IP か」を後から知る必要がある調査は
 * 既存の高詳細監査（`auditContextFromRequest`。**認可済み操作**に紐づく）の領分である。
 */
async function hashedIdentity(viewer: string): Promise<string> {
  const salt = await identitySalt();
  const suffix = new TextEncoder().encode(`\u0000${viewer}`);
  const bytes = new Uint8Array(salt.length + suffix.length);
  bytes.set(salt);
  bytes.set(suffix, salt.length);
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
