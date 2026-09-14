/**
 * 管理者 Cognito ユーザーを用意するときの述語（#1051）。
 *
 * ## なぜ純関数として置くか
 *
 * `scripts/admin-user-provision.sh` は対話で email とパスワードを受け取る。判定を bash に
 * 書くとテストできないので、観測だけ集めてここへ渡す（`scripts/aws-cloud-deploy.sh` と
 * 同じ形）。
 *
 * ## 何を守るか
 *
 * 🔴 **username をメール形式にできない。** Admin プールは
 * `signInAliases: { username: true, email: true }` ＝ **email はエイリアス**なので、
 * username 自体がメール形式だと AWS が `InvalidParameterException`
 * （"Username cannot be of email format, since user pool is configured for email alias"）で
 * 弾く。メールアドレスでログインさせたいなら「username は非メール形式 ＋ email 属性を
 * `email_verified=true` で付ける」が正しい形で、これは 2026-09-09 に dev で実際に踏んだ。
 * 散文の注意書きでは同じ穴をまた踏むので、`deriveUsernameFromEmail` の出力が
 * **必ず** `validateAdminCredentials` を通ることをテストで縛ってある。
 */

/**
 * Admin ユーザープールのパスワードポリシー。
 *
 * 🔴 **ここが唯一の定義。** `infra/lib/stacks/web-stack.ts` の `AdminUserPool` がこの定数を
 * import する（`ORIGIN_VERIFY_LOG_MARKERS` と同じ共有の形）。CDK 側に数値を直書きすると、
 * 片方だけ変えたときに**スクリプトが通したパスワードを Cognito が拒否する**という、
 * 実行するまで見えないドリフトになる。一致は
 * `infra/test/web-stack.test.ts` が合成テンプレートに対して縛る。
 */
export const ADMIN_PASSWORD_POLICY = {
  minLength: 12,
  requireLowercase: true,
  requireUppercase: true,
  requireDigits: true,
  requireSymbols: true,
} as const;

/**
 * Cognito が「記号」と認める文字の集合（末尾の空白も含む。AWS の仕様どおり）。
 *
 * 🔴 **自前で「英数字以外は記号」と定義しない。** それだと全角文字などを記号として数えて
 * しまい、`requireSymbols` を満たしたつもりの入力を Cognito が拒否する。
 */
export const ADMIN_PASSWORD_SYMBOLS = '^$*.[]{}()?"!@#%&/\\,><\':;|_~`+= ';

export type AdminCredentialViolation =
  | 'password-too-short'
  | 'password-missing-lowercase'
  | 'password-missing-uppercase'
  | 'password-missing-digit'
  | 'password-missing-symbol'
  | 'username-empty'
  | 'username-is-email'
  | 'username-too-long'
  | 'email-invalid';

export interface AdminCredentialCandidate {
  readonly username: string;
  readonly email: string;
  readonly password: string;
}

/** Cognito の username 上限（128）。導出側はこれより手前で切る。 */
const USERNAME_MAX_LENGTH = 128;

/**
 * 「メール形式」の判定。Cognito 側の拒否条件に合わせて **`@` を含むこと**を軸に見る。
 * ここを厳密な RFC 判定にすると、AWS が弾くのにこちらが通す隙間ができる（弱いほうへ倒す）。
 */
function looksLikeEmail(value: string): boolean {
  return value.includes('@');
}

function isValidEmail(value: string): boolean {
  const at = value.indexOf('@');
  if (at <= 0) return false;
  if (value.indexOf('@', at + 1) !== -1) return false; // @ が 2 つ以上
  const domain = value.slice(at + 1);
  if (!domain.includes('.')) return false;
  if (domain.startsWith('.') || domain.endsWith('.')) return false;
  if (/\s/.test(value)) return false;
  return true;
}

/** パスワード単体の検査。policy を満たさない項目だけを返す。 */
function passwordViolations(password: string): AdminCredentialViolation[] {
  const out: AdminCredentialViolation[] = [];
  if (password.length < ADMIN_PASSWORD_POLICY.minLength) out.push('password-too-short');
  if (ADMIN_PASSWORD_POLICY.requireLowercase && !/[a-z]/.test(password)) {
    out.push('password-missing-lowercase');
  }
  if (ADMIN_PASSWORD_POLICY.requireUppercase && !/[A-Z]/.test(password)) {
    out.push('password-missing-uppercase');
  }
  if (ADMIN_PASSWORD_POLICY.requireDigits && !/[0-9]/.test(password)) {
    out.push('password-missing-digit');
  }
  if (
    ADMIN_PASSWORD_POLICY.requireSymbols &&
    ![...password].some((c) => ADMIN_PASSWORD_SYMBOLS.includes(c))
  ) {
    out.push('password-missing-symbol');
  }
  return out;
}

/**
 * 資格情報の候補を検査する。**空配列＝そのまま Cognito へ渡してよい**。
 */
export function validateAdminCredentials(
  candidate: AdminCredentialCandidate,
): readonly AdminCredentialViolation[] {
  const out: AdminCredentialViolation[] = [];

  const username = candidate.username;
  if (username.trim().length === 0) out.push('username-empty');
  else if (looksLikeEmail(username)) out.push('username-is-email');
  else if (username.length > USERNAME_MAX_LENGTH) out.push('username-too-long');

  if (!isValidEmail(candidate.email)) out.push('email-invalid');

  out.push(...passwordViolations(candidate.password));
  return out;
}

/** 導出した username を Cognito が受け付ける形へ寄せるときの上限（余裕を持って切る）。 */
const DERIVED_USERNAME_MAX_LENGTH = 60;

/** ローカル部が空になったときの既定。空 username は Cognito が拒否するため必ず埋める。 */
const DERIVED_USERNAME_FALLBACK = 'admin';

/**
 * メールアドレスから username を導出する。
 *
 * 出力は**必ず** `validateAdminCredentials` を通る（`@` を含まず、空でなく、上限内）。
 * この保証はテストで総当たりに縛ってあり、散文ではない。
 */
export function deriveUsernameFromEmail(email: string): string {
  const localPart = email.split('@')[0] ?? '';
  const sanitized = localPart
    .toLowerCase()
    // Cognito の username に安全な文字だけ残す。'@' は定義上ここで必ず落ちる。
    .replace(/[^a-z0-9._-]+/g, '-')
    // 先頭・末尾の区切りは見た目にも Cognito 的にも不要
    .replace(/^[.\-_]+|[.\-_]+$/g, '')
    .slice(0, DERIVED_USERNAME_MAX_LENGTH)
    // slice で末尾が区切りになることがあるので、もう一度落とす
    .replace(/[.\-_]+$/g, '');

  return sanitized.length > 0 ? sanitized : DERIVED_USERNAME_FALLBACK;
}
