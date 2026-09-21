/**
 * デプロイに必須の CDK context を fail-closed で解決する（#680 / 2026-08-15 のインシデント）。
 *
 * ## なぜ要るか
 *
 * `infra/bin/open-reception.ts` の `appSecretsName` / `originVerifySecretName` /
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
import {
  REQUIRED_DEPLOY_CONTEXT_VARS,
  parseDeployContextFile,
  resolveDeployContext,
  resolveDeployContextEnvBlock,
} from './deploy-context';

const COMPLETE = {
  OR_APP_SECRETS_NAME: 'open-reception/dev/app-v2',
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
      'originVerifySecretName=open-reception/dev/app-v2',
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

  it('🔴 生の OR_ORIGIN_VERIFY_SECRET を deploy context に要求しない (#1148)', () => {
    expect(REQUIRED_DEPLOY_CONTEXT_VARS).not.toContain('OR_ORIGIN_VERIFY_SECRET');
    const result = resolveDeployContext(COMPLETE);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.args.some((arg) => arg.startsWith('originVerifySecret='))).toBe(false);
    expect(result.args).toContain('originVerifySecretName=open-reception/dev/app-v2');
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

    it('🔴 不正値の診断は値ではなく修正方法を返す', () => {
      const result = resolveDeployContext({ ...COMPLETE, OR_PROVIDER_SECRET_BACKEND: 'aws' });
      expect(result.ok).toBe(false);
      if (result.ok) return;
      expect(result.message).toContain('memory | secrets-manager');
    });
  });

  /**
   * 説明文やプレースホルダを context として貼る事故は、secret 値を扱わなくなっても残る。
   * 3 つの必須 context はすべて ASCII の名前・URL・語彙なので fail-closed に保つ。
   */
  describe('プレースホルダ・説明文の混入', () => {
    const PLACEHOLDER_FULLWIDTH = '＜実際の値＞';
    const PLACEHOLDER_ASCII_ONLY = '<VALUE_HERE>';
    const NON_ASCII_ONLY = 'ここに値を入れてください';

    it.each(Object.keys(COMPLETE))('🔴 %s に山括弧つきプレースホルダが入っていたら止める', (key) => {
      const result = resolveDeployContext({ ...COMPLETE, [key]: PLACEHOLDER_FULLWIDTH });
      expect(result.ok).toBe(false);
      if (result.ok) return;
      expect(result.invalid).toContain(key);
    });

    it.each(Object.keys(COMPLETE))('🔴 %s の ASCII 山括弧のみの形も止める', (key) => {
      const result = resolveDeployContext({ ...COMPLETE, [key]: PLACEHOLDER_ASCII_ONLY });
      expect(result.ok).toBe(false);
      if (result.ok) return;
      expect(result.invalid).toContain(key);
    });

    it('🔴 山括弧が無くても非 ASCII の説明文は止める', () => {
      const result = resolveDeployContext({ ...COMPLETE, OR_APP_SECRETS_NAME: NON_ASCII_ONLY });
      expect(result.ok).toBe(false);
      if (result.ok) return;
      expect(result.invalid).toContain('OR_APP_SECRETS_NAME');
      expect(result.message).toContain('印字可能 ASCII 以外');
    });

    it('🔴 実運用の3変数の形は弾かない', () => {
      const result = resolveDeployContext({
        OR_APP_SECRETS_NAME: 'open-reception/dev/app-v2',
        OR_PUBLIC_ORIGIN_OVERRIDE: 'https://dvxkh8nfwl334.cloudfront.net',
        OR_PROVIDER_SECRET_BACKEND: 'secrets-manager',
      });
      expect(result.ok).toBe(true);
    });
  });
});

describe('parseDeployContextFile', () => {
  it('KEY=VALUE を読む', () => {
    const parsed = parseDeployContextFile(
      ['OR_APP_SECRETS_NAME=open-reception/dev/app-v2', 'OR_PROVIDER_SECRET_BACKEND=memory'].join('\n'),
    );
    expect(parsed.OR_APP_SECRETS_NAME).toBe('open-reception/dev/app-v2');
    expect(parsed.OR_PROVIDER_SECRET_BACKEND).toBe('memory');
  });

  it('空行・コメント・前後の空白を落とす', () => {
    const parsed = parseDeployContextFile(
      ['', '# 窓を開けるとき用', '  OR_APP_SECRETS_NAME =  spaced  ', '   ', '#OR_X=y'].join('\n'),
    );
    expect(parsed.OR_APP_SECRETS_NAME).toBe('spaced');
    // 🔴 **`parsed.OR_X` が undefined であることを主張しても空虚**（実測で生存した変異）。
    // コメント判定を消しても、`#OR_X=y` のキーは `#OR_X` になるので `OR_X` は結局 undefined。
    // 「コメント行を落とした」を本当に言うには、**キー集合そのもの**を縛るしかない。
    expect(Object.keys(parsed)).toEqual(['OR_APP_SECRETS_NAME']);
  });

  it('値の中の = は保つ（secret に = が入りうる）', () => {
    expect(parseDeployContextFile('OR_PUBLIC_ORIGIN_OVERRIDE=https://example.com/?a=b==').OR_PUBLIC_ORIGIN_OVERRIDE).toBe('https://example.com/?a=b==');
  });

  it('前後の引用符を外す（貼り付けたまま囲ってしまう事故を吸収する）', () => {
    expect(parseDeployContextFile("OR_APP_SECRETS_NAME='quoted'").OR_APP_SECRETS_NAME).toBe('quoted');
    expect(parseDeployContextFile('OR_APP_SECRETS_NAME="quoted"').OR_APP_SECRETS_NAME).toBe('quoted');
    // 🔴 片側だけの引用符は外さない（値の一部かもしれない）。
    expect(parseDeployContextFile('OR_APP_SECRETS_NAME="half').OR_APP_SECRETS_NAME).toBe('"half');
  });

  it('= を含まない行と、キーが空の行は無視する', () => {
    const parsed = parseDeployContextFile(['garbage line', '=value', 'OR_APP_SECRETS_NAME=ok'].join('\n'));
    expect(Object.keys(parsed)).toEqual(['OR_APP_SECRETS_NAME']);
  });
});

const VALID_CUSTOM_DOMAIN = JSON.stringify({
  domainName: 'open-reception.example.com',
  certificateArn: 'arn:aws:acm:us-east-1:000000000000:certificate/00000000-0000-0000-0000-000000000000',
});

/**
 * 独自ドメイン（#189）は任意だが、**窓を開けるときに運ばれないと黙って旧ドメインのまま
 * デプロイされる**。#989（必須 4 変数のうち 1 つだけ貼り忘れた）と同じ型なので、
 * 貼り付けブロックへ載せ、不正なら窓を開ける前に落とす。
 */
describe('resolveDeployContextEnvBlock — 独自ドメイン (#189)', () => {
  it('🔴 未設定なら既存の 3 行のまま（任意であることを壊さない）', () => {
    const result = resolveDeployContextEnvBlock(COMPLETE);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.block.split('\n')).toHaveLength(3);
    expect(result.block).not.toContain('OR_CUSTOM_DOMAIN');
  });

  it('設定されていればブロックへ運ぶ', () => {
    const result = resolveDeployContextEnvBlock({
      ...COMPLETE,
      OR_CUSTOM_DOMAIN: VALID_CUSTOM_DOMAIN,
    });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    const lines = result.block.split('\n');
    expect(lines).toHaveLength(4);
    expect(lines[3]).toBe(`OR_CUSTOM_DOMAIN=${VALID_CUSTOM_DOMAIN}`);
  });

  it('🔴 不正なら窓を開ける前に落とす（deploy まで持ち越さない）', () => {
    const result = resolveDeployContextEnvBlock({
      ...COMPLETE,
      OR_CUSTOM_DOMAIN: '{"domainName":"open-reception.example.com","certificateArn":"arn:aws:acm:ap-northeast-1:000000000000:certificate/00000000-0000-0000-0000-000000000000"}',
    });
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.message).toMatch(/us-east-1/);
  });
});

describe('resolveDeployContextEnvBlock', () => {
  it('揃っていれば貼り付け用の KEY=VALUE ブロックを返す', () => {
    const result = resolveDeployContextEnvBlock(COMPLETE);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.block.split('\n')).toEqual([
      'OR_APP_SECRETS_NAME=open-reception/dev/app-v2',
      'OR_PUBLIC_ORIGIN_OVERRIDE=https://example.cloudfront.net',
      'OR_PROVIDER_SECRET_BACKEND=secrets-manager',
    ]);
  });

  it('🔴 順序は REQUIRED と同じで安定している（貼る順が毎回変わらない）', () => {
    const a = resolveDeployContextEnvBlock(COMPLETE);
    const b = resolveDeployContextEnvBlock({ ...COMPLETE });
    expect(a.ok && b.ok && a.block).toEqual(b.ok ? b.block : null);
    if (!a.ok) return;
    expect(a.block.split('\n').map((line) => line.split('=')[0])).toEqual([
      ...REQUIRED_DEPLOY_CONTEXT_VARS,
    ]);
  });

  it('欠けていれば resolveDeployContext と同じ判定で止める', () => {
    const result = resolveDeployContextEnvBlock({ ...COMPLETE, OR_APP_SECRETS_NAME: '' });
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.missing).toEqual(['OR_APP_SECRETS_NAME']);
  });

  it('🔴 語彙の外の値で止める（窓を開けてから気づくのでは遅い）', () => {
    const result = resolveDeployContextEnvBlock({ ...COMPLETE, OR_PROVIDER_SECRET_BACKEND: 'secretsmanager' });
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.invalid).toEqual(['OR_PROVIDER_SECRET_BACKEND']);
  });

  it('🔴 生 secret 変数を貼り付けブロックへ復活させない', () => {
    const result = resolveDeployContextEnvBlock(COMPLETE);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.block).not.toContain('OR_ORIGIN_VERIFY_SECRET=');
  });

  /**
   * 🔴 **窓を開ける前に落とす。** 2026-09-06 の混入は環境ダイアログへ貼った時点で
   * 成立しており、気づいたのは窓を開けて `diff` まで回した後だった。ここで弾けば
   * その往復ぶんの窓を食わずに済む（判定は `resolveDeployContext` と同一のもの）。
   */
  it('🔴 プレースホルダが混ざったブロックは作らせない', () => {
    const result = resolveDeployContextEnvBlock({
      ...COMPLETE,
      OR_APP_SECRETS_NAME: '＜実際の値＞',
    });
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.invalid).toEqual(['OR_APP_SECRETS_NAME']);
  });
});
