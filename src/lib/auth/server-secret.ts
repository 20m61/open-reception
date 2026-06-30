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
 * - `failClosed: true`（新規の未認証トラストルート向け）: デプロイ環境で未設定なら throw。
 * - 既定（既存 admin/kiosk セッション鍵）: デプロイ環境で未設定なら警告ログのみ（後方互換）。
 *   実シークレット注入（Secrets Manager #194）後は failClosed へ引き上げてよい。
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
  if (value && value.length > 0) return value;

  if (inDeployedRuntime()) {
    const msg = `${envName} is not set in a deployed environment; refusing the insecure dev fallback secret`;
    if (opts.failClosed) throw new Error(msg);
    // 既存鍵は後方互換のため停止させず、運用が気づけるよう loud に警告する。
    console.warn(`[security] ${envName} unset in deploy — using INSECURE dev fallback. Set it (Secrets Manager #194).`);
  }
  return devFallback;
}
