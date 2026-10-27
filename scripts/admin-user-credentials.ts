/**
 * 対話で集めた管理者資格情報を検査し、`admin-set-user-password` の payload を組み立てる（#1051）。
 *
 * 判定ロジックは `src/domain/auth/admin-user-provisioning.ts`（純関数・テスト済み）に置き、
 * ここは stdin/stdout の配線だけを持つ（`scripts/aws-diff-gate.ts` と同じ形）。
 *
 * ## なぜ argv ではなく stdin なのか
 *
 * 🔴 **パスワードを argv に載せない。** `aws ... --password 'xxx'` と書くと、実行中は
 * 同一ホストの他ユーザーから `ps` で丸見えになる。ここでは
 *
 *   1. bash が `read -rs` で受け取り
 *   2. JSON にして **stdin** でこのスクリプトへ渡し
 *   3. このスクリプトが検査して `--cli-input-json` 用の JSON を **stdout** へ出し
 *   4. bash がそれをパイプで `aws --cli-input-json file:///dev/stdin` へ流す
 *
 * という経路にしてある。パスワードは argv にもディスクにも出ない。
 *
 * 使い方:
 *   echo '{"username":..,"email":..,"password":..,"userPoolId":..}' \
 *     | npx tsx scripts/admin-user-credentials.ts
 */
import { readFileSync } from 'node:fs';
import {
  ADMIN_PASSWORD_POLICY,
  type AdminCredentialViolation,
  validateAdminCredentials,
} from '../src/domain/auth/admin-user-provisioning';

/** violation を人が直せる日本語にする。**値そのものは絶対に出さない。** */
const MESSAGES: Record<AdminCredentialViolation, string> = {
  'password-too-short': `パスワードが短すぎます（${ADMIN_PASSWORD_POLICY.minLength} 文字以上）`,
  'password-missing-lowercase': 'パスワードに小文字が要ります',
  'password-missing-uppercase': 'パスワードに大文字が要ります',
  'password-missing-digit': 'パスワードに数字が要ります',
  'password-missing-symbol': 'パスワードに記号が要ります（Cognito が認める記号のみ）',
  'username-empty': 'username が空です',
  'username-is-email':
    'username をメール形式にはできません（プールが email をエイリアスに使うため）。' +
    'メールアドレスは email 属性として付きます',
  'username-too-long': 'username が長すぎます',
  'email-invalid': 'メールアドレスの形式が不正です',
};

interface Input {
  readonly username?: unknown;
  readonly email?: unknown;
  readonly password?: unknown;
  readonly userPoolId?: unknown;
}

function readString(value: unknown, field: string): string {
  if (typeof value !== 'string') {
    // 🔴 欠落を空文字に落とさない。空文字は「空の username」という別の失敗として
    //    検査を通ってしまい、原因が読めなくなる（このリポジトリが繰り返し踏んだ型）。
    throw new Error(`入力 JSON の ${field} が文字列ではありません`);
  }
  return value;
}

function main(): void {
  const raw = readFileSync(0, 'utf8');
  let parsed: Input;
  try {
    parsed = JSON.parse(raw) as Input;
  } catch (e) {
    console.error(`入力 JSON を読めません: ${(e as Error).message}`);
    process.exit(2);
  }

  const username = readString(parsed.username, 'username');
  const email = readString(parsed.email, 'email');
  const password = readString(parsed.password, 'password');
  const userPoolId = readString(parsed.userPoolId, 'userPoolId');

  const violations = validateAdminCredentials({ username, email, password });
  if (violations.length > 0) {
    console.error('入力を受け付けられません:');
    for (const v of violations) console.error(`  - ${MESSAGES[v]}`);
    process.exit(1);
  }

  // `admin-set-user-password` の --cli-input-json payload。
  // JSON.stringify がエスケープを引き受けるので、記号入りのパスワードでも壊れない。
  process.stdout.write(
    JSON.stringify({
      UserPoolId: userPoolId,
      Username: username,
      Password: password,
      Permanent: true,
    }),
  );
}

main();
