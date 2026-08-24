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
  OR_PROVIDER_SECRET_BACKEND: 'secrets-manager',
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
      '-c',
      'providerSecretBackend=secrets-manager',
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

  /**
   * テナント provider secret の永続先 (#768 の非対称)。
   *
   * #768 で**設定**を永続化した結果、`providerSecretBackend` を渡さないと
   * **設定は残るのに secret は消える**という非対称が生まれた。設定が残るので
   * `intendsRealDialing` は true を返し、secret が消えるので `buildVoiceCredentials` は
   * null を返す ── #765 のガードが発火して**受付が 503** になる。しかもどの Lambda
   * インスタンスが処理したかで結果が変わるので「たまに取り次げない」という形で出る。
   */
  describe('providerSecretBackend (#768 の非対称)', () => {
    it('🔴 未指定なら止める（設定したつもりで揮発するのを防ぐ）', () => {
      const env: Record<string, string | undefined> = { ...COMPLETE };
      delete env.OR_PROVIDER_SECRET_BACKEND;
      const result = resolveDeployContext(env);
      expect(result.ok).toBe(false);
      if (result.ok) return;
      expect(result.missing).toContain('OR_PROVIDER_SECRET_BACKEND');
    });

    /**
     * mock だけで動かす dev デプロイを禁じない。`DATA_BACKEND` と同じ扱いで、
     * **明示的な `memory` は「意図的に揮発でよい」宣言**として通す。
     */
    it("明示的な 'memory' は通す（mock だけの dev を禁じない）", () => {
      const result = resolveDeployContext({
        ...COMPLETE,
        OR_PROVIDER_SECRET_BACKEND: 'memory',
      });
      expect(result.ok).toBe(true);
      if (!result.ok) return;
      expect(result.args).toContain('providerSecretBackend=memory');
    });

    /**
     * 🔴 **綴り違いを黙って通さない。** `bin/open-reception.ts` はキャストするだけで
     * 検証していないので、web-stack の `=== 'secrets-manager'` に一致せず
     * **静かに memory へ倒れる**。設定したつもりで揮発する、いちばん気づけない失敗。
     */
    it.each(['secretsmanager', 'SecretsManager', 'aws', 'true'])(
      '🔴 語彙の外の値（%j）で止める',
      (bad) => {
        const result = resolveDeployContext({ ...COMPLETE, OR_PROVIDER_SECRET_BACKEND: bad });
        expect(result.ok).toBe(false);
        if (result.ok) return;
        expect(result.invalid).toContain('OR_PROVIDER_SECRET_BACKEND');
      },
    );

    it('🔴 不正値を「未指定」と混ぜない（直し方が変わる）', () => {
      const result = resolveDeployContext({ ...COMPLETE, OR_PROVIDER_SECRET_BACKEND: 'aws' });
      expect(result.ok).toBe(false);
      if (result.ok) return;
      expect(result.missing).not.toContain('OR_PROVIDER_SECRET_BACKEND');
      expect(result.message).toContain('memory | secrets-manager');
    });

    it('🔴 不正値の診断にも secret の値を載せない', () => {
      const result = resolveDeployContext({ ...COMPLETE, OR_PROVIDER_SECRET_BACKEND: 'aws' });
      expect(result.ok).toBe(false);
      if (result.ok) return;
      expect(result.message).not.toContain(COMPLETE.OR_ORIGIN_VERIFY_SECRET);
    });
  });
});
