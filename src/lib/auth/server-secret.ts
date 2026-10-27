/**
 * サーバ専用シークレットの解決（fail-closed ポリシーの集約）。
 *
 * これまで各所（admin / kiosk / enrollment）で `process.env.X ?? 'dev-insecure-…'` を
 * 個別に書いていた。dev フォールバックはローカル・e2e（`next start` は NODE_ENV=production
 * でも実シークレット未設定で動かす）を壊さないために必要だが、**実デプロイで未設定のまま
 * フォールバックが使われる**と署名鍵が公開ソース上の既知値になり危険（特に未認証の受付
 * エンロールはトークン偽造の踏み台になる）。
 *
 * 「実デプロイか」の判定には `NODE_ENV` ではなく **Lambda 実行マーカー
 * `AWS_LAMBDA_FUNCTION_NAME`** を使う。OpenNext のデプロイ（Lambda）でのみ真になり、
 * ローカル `next start` / e2e では偽のため、テストや手元のプロダクションビルドを壊さない。
 *
 * - `failClosed: true`: デプロイ環境で未設定なら throw。管理 / 受付端末のセッション鍵も
 *   #1124 でここへ移した（起動時の自己検査は `session-secrets.ts`）。
 * - 既定: デプロイ環境で未設定なら警告ログのみ（後方互換）。
 *
 * 🔴 **デプロイ環境では「公開既定値と同じ値」も未設定として扱う (#1124)。** 既定値は
 * リポジトリに平文で載っているので、env に同じ文字列を入れても秘密にならない
 * （`.env.example` や手順書の例をそのまま貼る形で起こる）。完全一致だけを見る。
 * 🔴 メッセージには env 名だけを載せ、値（既定値を含む）は出さない。
 */
function inDeployedRuntime(): boolean {
  return Boolean(process.env.AWS_LAMBDA_FUNCTION_NAME);
}

export function serverSecret(
  envName: string,
  devFallback: string,
  opts: { failClosed?: boolean } = {},
): string {
  const value = process.env[envName];
  const deployed = inDeployedRuntime();
  if (value && value.length > 0 && !(deployed && value === devFallback)) return value;

  if (deployed) {
    const msg = `${envName} is not set (or equals the public dev fallback) in a deployed environment; refusing the insecure dev fallback secret`;
    if (opts.failClosed) throw new Error(msg);
    // 既存鍵は後方互換のため停止させず、運用が気づけるよう loud に警告する。
    console.warn(`[security] ${envName} unset in deploy — using INSECURE dev fallback. Set it (Secrets Manager #194).`);
  }
  return devFallback;
}
