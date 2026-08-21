/**
 * 「この設定で実際に取り次げるか」を設定だけから判断する (#763)。
 *
 * ## なぜ要るのか
 *
 * 「有効か」を判定する述語が 3 か所にあり、揃っていなかった:
 *
 * | 場所 | 述語 | secret を見るか |
 * | --- | --- | --- |
 * | 管理画面の presence | `vonage && secret あり && enabled` | 見る |
 * | 保存 API | 検証なし（何でも保存できる） | — |
 * | 受付の実挙動（`intendsRealDialing`） | `vonage && enabled && fromNumber` | 見ない |
 *
 * その結果、**secret を入れる前に「vonage・有効・発信元番号」を保存できてしまい**、
 * その状態だと管理画面は「未接続」と出るのに受付端末は全件 503 になる。
 * **管理画面のトグル 1 回で、警告も確認もなくテナントの受付が落ちる**導線があった。
 *
 * ## どう解いたか（2026-08-21 のユーザー判断: 「警告して保存は通す」）
 *
 * 保存は拒否しない ──「設定を先に保存 → secret を後で入れる」という二段階の運用導線を
 * 壊さないため。代わりに**同じ 1 つの述語**から警告を導き、保存応答と読み取り応答の
 * 両方へ載せる。判定が 1 か所なら、上の表のようなずれは構造的に起きない。
 */
import type { SecretPresence, TenantProviderConfig } from './types';

/**
 * この設定は**実 PSTN 発信を意図している**か。
 *
 * 🔴 **secret を見ない。** 見ると「意図」ではなく「今できるか」を答えることになり、
 * 「mock でよい（dev / デモ）」と「vonage のつもりだが繋がらない」の区別が消える
 * （`src/lib/platform/provider-resolution.ts` の doc 参照）。
 *
 * 🔴 **`fromNumber` を条件に含める。** vonage + enabled だけだと、**Video 受付だけで
 * 運用しているテナント**（発信元番号は要らない）まで巻き込んで全断させる。
 */
export function intendsRealDialingFrom(
  config: Pick<TenantProviderConfig, 'provider' | 'enabled' | 'fromNumber'> | null | undefined,
): boolean {
  if (config?.provider !== 'vonage' || config.enabled !== true) return false;
  // 空文字は未設定と同じ扱い（`buildVoiceCredentials` の `!fromNumber` と揃える）。
  return typeof config.fromNumber === 'string' && config.fromNumber.length > 0;
}

/**
 * 警告の語彙。**列挙で固定する** ── 任意の文字列を許すと、設定値や secret の断片が
 * メッセージに混ざりうる（`rules/pii-secret-minimization.md`）。
 */
export const PROVIDER_CONFIG_WARNINGS = [
  /** 実発信を意図しているのに secret が無い ＝ 受付は全件 503 になる。 */
  'real_dialing_without_secret',
  /** 実発信を意図しているのに applicationId が無い ＝ 同上。 */
  'real_dialing_without_application_id',
] as const;

export type ProviderConfigWarning = (typeof PROVIDER_CONFIG_WARNINGS)[number];

/**
 * 保存された設定に対する警告。**空配列＝「この設定なら取り次げる」ではない**
 * （ルート定義の有無まではここでは分からない）。ここが見ているのは
 * 「実発信を意図しているのに、その意図を満たせない設定になっている」ことだけ。
 */
export function providerConfigWarnings(
  config: TenantProviderConfig | null | undefined,
  secretPresence: SecretPresence,
): readonly ProviderConfigWarning[] {
  if (!intendsRealDialingFrom(config)) return [];

  const warnings: ProviderConfigWarning[] = [];
  if (secretPresence !== 'set') warnings.push('real_dialing_without_secret');
  if (!config?.applicationId) warnings.push('real_dialing_without_application_id');
  return warnings;
}
