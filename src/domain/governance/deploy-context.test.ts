/**
 * デプロイに必須の CDK context を fail-closed で解決する（#680 / 2026-08-15 のインシデント）。
 *
 * ## なぜ要るか
 *
 * `infra/bin/open-reception.ts` の `appSecretsName` / `originVerifySecret` /
 * `publicOriginOverride` は **未指定でも synth が通る**。通るが、出来上がるのは別構成の
 * スタックで、Secrets Manager 連携も QR の基底オリジンも落ちる。
 *
 * 2026-08-15 に `scripts/aws-cloud-deploy.sh` がこれらを渡していなかったため、
 * 実際に dev の ServerFn から `secretsmanager:GetSecretValue` の付与が消え、
 * 起動時に secret を読めず fail-closed で中断して **dev が 500** になった。
 *
 * 「省いても成功してしまう」ことが事故の起点なので、**未指定なら止める**。
 */
import { describe, expect, it } from 'vitest';
import { REQUIRED_DEPLOY_CONTEXT_VARS, resolveDeployContext } from './deploy-context';

const COMPLETE = {
  OR_APP_SECRETS_NAME: 'open-reception/dev/app-v2',
  OR_ORIGIN_VERIFY_SECRET: 'TEST-high-entropy-value',
  OR_PUBLIC_ORIGIN_OVERRIDE: 'https://example.cloudfront.net',
} as const;

describe('resolveDeployContext', () => {
  it('揃っていれば cdk へ渡す -c 引数を返す', () => {
    const result = resolveDeployContext(COMPLETE);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.args).toEqual([
      '-c',
      'appSecretsName=open-reception/dev/app-v2',
      '-c',
      'originVerifySecret=TEST-high-entropy-value',
      '-c',
      'publicOriginOverride=https://example.cloudfront.net',
    ]);
  });

  it.each(Object.keys(COMPLETE))('🔴 %s が無ければ止める', (missing) => {
    const env: Record<string, string | undefined> = { ...COMPLETE };
    delete env[missing];
    const result = resolveDeployContext(env);
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.missing).toContain(missing);
  });

  it.each(['', '   '])('🔴 空文字（%j）は「未指定」として止める', (blank) => {
    const result = resolveDeployContext({ ...COMPLETE, OR_APP_SECRETS_NAME: blank });
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.missing).toContain('OR_APP_SECRETS_NAME');
  });

  it('🔴 足りないものを全部並べる（1 つ直して再実行、を繰り返させない）', () => {
    const result = resolveDeployContext({});
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect([...result.missing].sort()).toEqual([...REQUIRED_DEPLOY_CONTEXT_VARS].sort());
  });

  /**
   * 🔴 `originVerifySecret` は**秘密の値そのもの**。診断メッセージへ載せない。
   * 載せるとログ・PR 本文・スクリーンショットへ漏れる。
   */
  it('🔴 診断メッセージに secret の値を含めない', () => {
    const result = resolveDeployContext({ ...COMPLETE, OR_APP_SECRETS_NAME: undefined });
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.message).not.toContain(COMPLETE.OR_ORIGIN_VERIFY_SECRET);
    // 変数名は出してよい（何を設定すればよいか分からないと直せない）。
    expect(result.message).toContain('OR_APP_SECRETS_NAME');
  });

  it('前後の空白は落として渡す（コピペ事故で -c の値が壊れないように）', () => {
    const result = resolveDeployContext({ ...COMPLETE, OR_APP_SECRETS_NAME: '  a/b  ' });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.args).toContain('appSecretsName=a/b');
  });
});
