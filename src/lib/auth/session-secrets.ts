/**
 * 管理 / 受付端末**セッション**の署名鍵の起動時自己検査 (#1124)。
 *
 * 鍵の getter（`getAdminSecret` / `getKioskSecret`）は deploy 環境で未設定・公開既定値なら
 * throw する。ただしそれだけだと、壊れたデプロイは**最初に鍵を使うリクエストまで**
 * 「動いているように見える」。`instrumentation.ts` の `register()` からここを呼び、
 * **サーバ自体を起動させない**（運用者が最初の 1 リクエストで気づける）。
 *
 * 🔴 判定は getter をそのまま呼ぶ。条件を別に書くと、getter と検査が**別の述語**になって
 * ずれる（片方だけ直す変更で、検査は通るのに getter は既定値を使う、が起こる）。
 *
 * 🔴 この検査は `register()` を通る経路（SSR / Route Handler）にしか効かない。
 * middleware は `register()` より先に走るので、そちらは getter の throw を
 * 「セッション無し」として扱う（`src/proxy.ts`）。
 */
import { getAdminSecret } from './admin';
import { getKioskSecret } from './kiosk';

/** deploy 環境で鍵が未設定・公開既定値なら throw する。ローカル / e2e では何もしない。 */
export function assertSessionSecretsConfigured(): void {
  getAdminSecret();
  getKioskSecret();
}
