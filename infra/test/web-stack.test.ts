import * as path from 'node:path';
import { beforeAll, describe, it, expect } from 'vitest';
import * as cdk from 'aws-cdk-lib';
import { Template, Match } from 'aws-cdk-lib/assertions';
import { WebStack } from '../lib/stacks/web-stack';
import { openNextArtifactState, describeArtifactState } from '../lib/build-artifacts';
import { resolveEnv, ENVIRONMENTS } from '../lib/config/environments';
import { SERVICE_HOLD_PAGE_PATH } from '../../src/domain/reception/service-hold-page';

describe('environments config', () => {
  it('resolves known environments and defaults to dev', () => {
    expect(resolveEnv(undefined).environment).toBe('dev');
    expect(resolveEnv('prod').environment).toBe('prod');
  });

  it('throws on unknown environment', () => {
    expect(() => resolveEnv('qa')).toThrow(/Unknown environment/);
  });

  it('prod has stricter log retention than dev', () => {
    expect(ENVIRONMENTS.prod.web.logRetentionDays).toBeGreaterThan(
      ENVIRONMENTS.dev.web.logRetentionDays,
    );
  });
});

// `.open-next/` が **在るだけ**では足りない（古いと synth が凍結ガードで throw する）。
// `fresh` のときだけ synth し、absent / stale は理由付きで skip する (#628)。
// dev 以外の WebStack は origin-verify の供給元が必須で、未指定は synth で止まる（N3。
// 未指定構成は CloudFront 経由の POST が全滅するため）。origin-verify の方式そのものが
// 検証対象でない prod の suite には、テンプレートに平文を残さない Secrets Manager 名を渡す。
const ORIGIN_VERIFY_NAME_FOR_PROD_SUITES = 'open-reception/test/app';
/**
 * prod / staging を synth する suite が N3b（発行 URL の基底オリジン必須）のガードを
 * 通過するためだけの値。**これらの suite の検証対象ではない**（PriceClass / IAM /
 * Cognito / secrets の形を見ている）ので、内容に意味は持たせない。
 */
const PUBLIC_ORIGIN_FOR_PROD_SUITES = 'https://example.cloudfront.net';


/**
 * テンプレートから CloudFront の custom error response を取り出す。
 * `hasResourceProperties` は「在ること」しか見られないので、
 * **無いこと**（403/503 を割り当てていない）を見るには実体が要る。
 */
type CustomErrorResponse = {
  readonly ErrorCode: number;
  readonly ResponseCode?: number;
  readonly ResponsePagePath?: string;
  readonly ErrorCachingMinTTL?: number;
};

function distributionConfig(template: Template): Record<string, unknown> {
  const [dist] = Object.values(template.findResources('AWS::CloudFront::Distribution'));
  return (dist as { Properties: { DistributionConfig: Record<string, unknown> } }).Properties
    .DistributionConfig;
}

function errorResponses(template: Template): readonly CustomErrorResponse[] {
  return (distributionConfig(template).CustomErrorResponses ?? []) as CustomErrorResponse[];
}

function errorResponseCodes(template: Template): readonly number[] {
  return errorResponses(template).map((r) => r.ErrorCode);
}

/** CloudFront の PathPattern（`*` のみのグロブ）が当たるか。正規表現は使わない（誤エスケープで
 * 静かに「当たらない」側へ倒れると、このテストが縛りたい性質ごと消える）。 */
function globMatches(pattern: string, target: string): boolean {
  const parts = pattern.split('*');
  if (parts.length === 1) return pattern === target;
  const head = parts[0]!;
  const tail = parts[parts.length - 1]!;
  if (!target.startsWith(head) || !target.endsWith(tail)) return false;
  let cursor = head.length;
  for (const part of parts.slice(1, -1)) {
    const at = target.indexOf(part, cursor);
    if (at < 0) return false;
    cursor = at + part.length;
  }
  return target.length - cursor >= tail.length;
}

/** そのパスを実際に受ける cache behavior（無ければ default = server Lambda へ落ちる）。 */
function matchingBehavior(
  template: Template,
  target: string,
): { readonly PathPattern: string; readonly TargetOriginId: string } | undefined {
  const behaviors = (distributionConfig(template).CacheBehaviors ?? []) as {
    PathPattern: string;
    TargetOriginId: string;
  }[];
  return behaviors.find((b) => globMatches(b.PathPattern, target));
}

const ARTIFACTS = openNextArtifactState(path.join(__dirname, '..', '..'));
const OPEN_NEXT_READY = ARTIFACTS.state === 'fresh';
if (!OPEN_NEXT_READY) {
  // 黙って 0 件にしない。vitest の "skipped" だけでは**なぜ**が残らず、
  // 「ゲートで走っているつもりで実は 1 度も走っていない」#628 の再演になる。
  console.warn(`[infra] WebStack synth suites skipped: ${describeArtifactState(ARTIFACTS)}`);
}

// WebStack の synth は `.open-next/` 成果物を要求するため、未ビルド環境では skip する。
//
// 🔴 **describe ボディ直下で `new WebStack(...)` しないこと。** vitest は `runIf(false)` でも
// describe のコールバックを **collect 時に実行する**ので、そこで throw すると
// **ファイル全体の収集が死に、`runIf` を付けていない他の describe まで巻き添えで走らなくなる**。
// 実際にそれで引数ガードの suite が 1 度も実行されていなかった（#612 の再レビューで判明）。
// 構築は `beforeAll` へ置く。
describe.runIf(OPEN_NEXT_READY)('WebStack synthesis', () => {
  let template: Template;
  beforeAll(() => {
    const app = new cdk.App();
    template = Template.fromStack(
      new WebStack(app, 'TestWeb', {
        env: { account: '123456789012', region: 'ap-northeast-1' },
        config: resolveEnv('dev'),
        appEnv: { ADMIN_AUTH_PROVIDER: 'none' },
      }),
    );
  }, 60000);

  it('provisions a private asset bucket', () => {
    template.hasResourceProperties('AWS::S3::Bucket', {
      PublicAccessBlockConfiguration: {
        BlockPublicAcls: true,
        RestrictPublicBuckets: true,
      },
    });
  });

  it('creates server and image Lambda functions on arm64 / node22', () => {
    template.resourceCountIs('AWS::Lambda::Url', 2);
    template.hasResourceProperties('AWS::Lambda::Function', {
      Runtime: 'nodejs22.x',
      Architectures: ['arm64'],
    });
  });

  it('Function URLs require IAM auth (no public invocation)', () => {
    template.hasResourceProperties('AWS::Lambda::Url', { AuthType: 'AWS_IAM' });
  });

  it('grants CloudFront-scoped invoke via OAC', () => {
    template.resourceCountIs('AWS::CloudFront::OriginAccessControl', 3);
    template.hasResourceProperties('AWS::Lambda::Permission', {
      Action: 'lambda:InvokeFunctionUrl',
      Principal: 'cloudfront.amazonaws.com',
      SourceArn: Match.anyValue(),
    });
  });

  it('grants lambda:InvokeFunction to CloudFront for OAC (AWS 2025-10 requirement, #192)', () => {
    // OAC 経由の Function URL 呼び出しは InvokeFunctionUrl に加え InvokeFunction も必須。
    // server / image の 2 関数分。これが無いと CloudFront → Function URL が 403 になる。
    template.resourcePropertiesCountIs(
      'AWS::Lambda::Permission',
      {
        Action: 'lambda:InvokeFunction',
        Principal: 'cloudfront.amazonaws.com',
        SourceArn: Match.anyValue(),
      },
      2,
    );
  });

  it('attaches security headers to static/image assets via ResponseHeadersPolicy (#193)', () => {
    // S3/画像オリジンの静的アセットにも CORP/Permissions-Policy/HSTS 等を付与する。
    template.hasResourceProperties('AWS::CloudFront::ResponseHeadersPolicy', {
      ResponseHeadersPolicyConfig: {
        CustomHeadersConfig: {
          Items: Match.arrayWith([
            Match.objectLike({ Header: 'Cross-Origin-Resource-Policy', Value: 'same-origin' }),
            Match.objectLike({ Header: 'Cross-Origin-Embedder-Policy', Value: 'require-corp' }),
          ]),
        },
        SecurityHeadersConfig: Match.objectLike({
          StrictTransportSecurity: Match.anyValue(),
          ContentTypeOptions: Match.anyValue(),
        }),
      },
    });
  });

  it('serves through a single CloudFront distribution', () => {
    template.resourceCountIs('AWS::CloudFront::Distribution', 1);
  });

  /**
   * 全断（オリジン到達不能）のときに来訪者へ出す応答 (#629 / Gate A)。
   *
   * `service-hold-page.ts` は middleware から返る。**サーバ Lambda が落ちていると
   * middleware は走らない**ので、その経路には入らない。CloudFront 既定の応答は
   * 英語の技術文（"The request could not be satisfied" / "ERROR: ... CloudFront"）で、
   * それが**来訪者が最初に見る画面**になる。
   */
  it('502 / 504 を来訪者向けの停止画面へ差し替える (#629)', () => {
    template.hasResourceProperties('AWS::CloudFront::Distribution', {
      DistributionConfig: Match.objectLike({
        CustomErrorResponses: Match.arrayWith([
          Match.objectLike({ ErrorCode: 502, ResponsePagePath: SERVICE_HOLD_PAGE_PATH }),
          Match.objectLike({ ErrorCode: 504, ResponsePagePath: SERVICE_HOLD_PAGE_PATH }),
        ]),
      }),
    });
  });

  /**
   * 🔴 **403 / 503 / 500 を割り当てない。** custom error response は
   * **ディストリビューション単位**で cache behavior に絞れないため、割り当てると
   * API の 403/503/500 まで HTML に潰れる（`PROVIDER_WEBHOOKS_DISABLED` の 503 +
   * `Retry-After` は Vonage の再送に効いている運用スイッチ）。
   * `service-hold-page.ts` が middleware 方式を選んだ理由そのもの。
   */
  it('🔴 403 / 503 / 500 は割り当てない（API の応答を HTML に潰さない）', () => {
    const codes = errorResponseCodes(template);
    for (const forbidden of [403, 500, 503]) {
      expect(codes, `${forbidden} を割り当てている`).not.toContain(forbidden);
    }
  });

  /**
   * 🔴 **ステータスコードを変えない。** 200 に潰すと、機械（Vonage の再送等）から見て
   * 「成功した」ことになり再送が止まる。
   */
  it('🔴 ステータスコードを変えない（再送を止めない）', () => {
    for (const r of errorResponses(template)) {
      expect(r.ResponseCode, `${r.ErrorCode} を ${r.ResponseCode} へ差し替えている`).toBe(
        r.ErrorCode,
      );
    }
  });

  /**
   * 🔴 **停止画面は S3 から配る。** ページ自身をサーバ Lambda から取ると、Lambda が
   * 落ちているまさにそのときに取れない。AWS の仕様上、custom error page は
   * **パスに一致する cache behavior の origin** から取得されるので、
   * `/assets/*`（S3 origin）の behavior に一致していることが条件。
   */
  it('🔴 停止画面は server Lambda 以外の origin から配る（落ちていても取れる）', () => {
    const config = distributionConfig(template);
    const matched = matchingBehavior(template, SERVICE_HOLD_PAGE_PATH);
    expect(
      matched,
      `${SERVICE_HOLD_PAGE_PATH} に一致する cache behavior が無い（default = server Lambda へ落ちる）`,
    ).toBeDefined();
    const defaultOrigin = (config.DefaultCacheBehavior as { TargetOriginId: string }).TargetOriginId;
    expect(matched?.TargetOriginId, '停止画面を server Lambda から取ろうとしている').not.toBe(
      defaultOrigin,
    );
  });

  /**
   * 🔴 **エラーを長くキャッシュしない。** 既定は 5 分で、復旧してもその間ずっと
   * 停止画面が出続ける。
   */
  it('🔴 エラーのキャッシュを短く持つ（復旧を遅らせない）', () => {
    for (const r of errorResponses(template)) {
      expect(r.ErrorCachingMinTTL, `${r.ErrorCode} のキャッシュが長い`).toBeLessThanOrEqual(60);
    }
  });

  it('passes app env vars to the server function', () => {
    template.hasResourceProperties('AWS::Lambda::Function', {
      Environment: {
        Variables: Match.objectLike({ ADMIN_AUTH_PROVIDER: 'none', NODE_ENV: 'production' }),
      },
    });
  });

  it('provisions a single on-demand DynamoDB table with PK/SK and TTL', () => {
    template.resourceCountIs('AWS::DynamoDB::Table', 1);
    template.hasResourceProperties('AWS::DynamoDB::Table', {
      BillingMode: 'PAY_PER_REQUEST',
      KeySchema: [
        { AttributeName: 'PK', KeyType: 'HASH' },
        { AttributeName: 'SK', KeyType: 'RANGE' },
      ],
      TimeToLiveSpecification: { AttributeName: 'ttl', Enabled: true },
    });
  });

  it('defines GSI1 for reception-log lookups', () => {
    template.hasResourceProperties('AWS::DynamoDB::Table', {
      GlobalSecondaryIndexes: Match.arrayWith([
        Match.objectLike({
          IndexName: 'GSI1',
          KeySchema: [
            { AttributeName: 'GSI1PK', KeyType: 'HASH' },
            { AttributeName: 'GSI1SK', KeyType: 'RANGE' },
          ],
        }),
      ]),
    });
  });

  it('wires the server function to DynamoDB (env + IAM)', () => {
    template.hasResourceProperties('AWS::Lambda::Function', {
      Environment: {
        Variables: Match.objectLike({
          DATA_BACKEND: 'dynamodb',
          TABLE_NAME: Match.anyValue(),
        }),
      },
    });
    template.hasResourceProperties('AWS::IAM::Policy', {
      PolicyDocument: Match.objectLike({
        Statement: Match.arrayWith([
          Match.objectLike({
            // grantReadWriteData の証左として書き込み権限の付与を確認する。
            Action: Match.arrayWith(['dynamodb:PutItem']),
            Effect: 'Allow',
          }),
        ]),
      }),
    });
  });

  it('does not set CloudFront aliases when no custom domain is configured', () => {
    template.hasResourceProperties('AWS::CloudFront::Distribution', {
      DistributionConfig: Match.objectLike({ Aliases: Match.absent() }),
    });
  });
});

// カスタムドメイン (issue #189): 既存 us-east-1 証明書 ARN を取り込み、Distribution に
// alias と ViewerCertificate を設定する。createDnsRecord=false なら Route53 を作らない。
// 各テストはフルスタック構築（OpenNext アセットのハッシュ）を伴うため timeout を緩める。
describe.runIf(OPEN_NEXT_READY)('WebStack custom domain (#189)', () => {
  const CERT_ARN = 'arn:aws:acm:us-east-1:123456789012:certificate/abcd-1234';
  const ACCOUNT = '123456789012';
  const REGION = 'ap-northeast-1';

  // HostedZone.fromLookup は実 AWS の context provider を起動するため、unit テストでは
  // 既知の lookup キーを context に seed して同期的にダミーゾーンを返させる。
  const hostedZoneContext = {
    [`hosted-zone:account=${ACCOUNT}:domainName=parent.example.com:region=${REGION}`]: {
      Id: '/hostedzone/DUMMY1234',
      Name: 'parent.example.com.',
    },
  };

  const synth = (createDnsRecord: boolean) => {
    const app = new cdk.App({ context: createDnsRecord ? hostedZoneContext : undefined });
    const stack = new WebStack(app, 'TestWebCustomDomain', {
      env: { account: ACCOUNT, region: REGION },
      config: resolveEnv('prod'),
      originVerifySecretName: ORIGIN_VERIFY_NAME_FOR_PROD_SUITES,
      publicOriginOverride: PUBLIC_ORIGIN_FOR_PROD_SUITES,
      appEnv: { ADMIN_AUTH_PROVIDER: 'none' },
      customDomain: {
        domainName: 'open-reception.parent.example.com',
        certificateArn: CERT_ARN,
        hostedZoneDomainName: createDnsRecord ? 'parent.example.com' : undefined,
        createDnsRecord,
      },
    });
    return Template.fromStack(stack);
  };

  it('binds the FQDN as a CloudFront alias with the imported certificate', () => {
    synth(false).hasResourceProperties('AWS::CloudFront::Distribution', {
      DistributionConfig: Match.objectLike({
        Aliases: ['open-reception.parent.example.com'],
        ViewerCertificate: Match.objectLike({
          AcmCertificateArn: CERT_ARN,
          SslSupportMethod: 'sni-only',
        }),
      }),
    });
  }, 30000);

  it('does not create Route53 records when createDnsRecord is false', () => {
    synth(false).resourceCountIs('AWS::Route53::RecordSet', 0);
  }, 30000);

  it('creates A and AAAA alias records when createDnsRecord is true', () => {
    const template = synth(true);
    template.resourceCountIs('AWS::Route53::RecordSet', 2);
    template.hasResourceProperties('AWS::Route53::RecordSet', {
      Type: 'A',
      Name: 'open-reception.parent.example.com.',
    });
    template.hasResourceProperties('AWS::Route53::RecordSet', {
      Type: 'AAAA',
      Name: 'open-reception.parent.example.com.',
    });
  }, 30000);

  it('rejects createDnsRecord without a hosted zone', () => {
    const app = new cdk.App();
    expect(
      () =>
        new WebStack(app, 'TestWebBadDomain', {
          env: { account: ACCOUNT, region: REGION },
          config: resolveEnv('prod'),
          originVerifySecretName: ORIGIN_VERIFY_NAME_FOR_PROD_SUITES,
        publicOriginOverride: PUBLIC_ORIGIN_FOR_PROD_SUITES,
          customDomain: {
            domainName: 'open-reception.parent.example.com',
            certificateArn: CERT_ARN,
            createDnsRecord: true,
          },
        }),
    ).toThrow(/hostedZoneDomainName/);
  }, 30000);
});

// Secrets Manager 化 (issue #194): appSecretsName 指定時、server Lambda に
// APP_SECRETS_ARN env と secretsmanager:GetSecretValue 権限を付与する。
describe.runIf(OPEN_NEXT_READY)('WebStack app secrets (#194)', () => {
  const synth = (appSecretsName?: string) => {
    const app = new cdk.App();
    const stack = new WebStack(app, 'TestWebSecrets', {
      env: { account: '123456789012', region: 'ap-northeast-1' },
      config: resolveEnv('prod'),
      originVerifySecretName: ORIGIN_VERIFY_NAME_FOR_PROD_SUITES,
      publicOriginOverride: PUBLIC_ORIGIN_FOR_PROD_SUITES,
      appEnv: { ADMIN_AUTH_PROVIDER: 'none' },
      appSecretsName,
    });
    return Template.fromStack(stack);
  };

  it('does not wire Secrets Manager when appSecretsName is absent', () => {
    const template = synth(undefined);
    template.hasResourceProperties('AWS::Lambda::Function', {
      Environment: { Variables: Match.objectLike({ APP_SECRETS_ARN: Match.absent() }) },
    });
  }, 30000);

  it('sets APP_SECRETS_ARN and grants GetSecretValue to the server function', () => {
    const template = synth('open-reception/prod/app');
    template.hasResourceProperties('AWS::Lambda::Function', {
      Environment: { Variables: Match.objectLike({ APP_SECRETS_ARN: Match.anyValue() }) },
    });
    template.hasResourceProperties('AWS::IAM::Policy', {
      PolicyDocument: Match.objectLike({
        Statement: Match.arrayWith([
          Match.objectLike({
            Action: Match.arrayWith(['secretsmanager:GetSecretValue']),
            Effect: 'Allow',
          }),
        ]),
      }),
    });
  }, 30000);
});

// テナント別プロバイダ secret を Secrets Manager で扱う (issue #405 Inc2)。
// providerSecretBackend=secrets-manager 指定時、server Lambda に env と、テナント prefix 限定の
// 最小 IAM（Get/Describe/Create/Put/Delete を <prefix>/tenants/* のみ）を付与する。
// シークレット自体は実行時作成のため CDK では作らない。
describe.runIf(OPEN_NEXT_READY)('WebStack tenant provider secrets (#405 Inc2)', () => {
  const PREFIX = 'open-reception/prod';
  const synth = (opts?: {
    providerSecretBackend?: 'memory' | 'secrets-manager';
    providerSecretPrefix?: string;
  }) => {
    const app = new cdk.App();
    const stack = new WebStack(app, 'TestWebProviderSecrets', {
      env: { account: '123456789012', region: 'ap-northeast-1' },
      config: resolveEnv('prod'),
      originVerifySecretName: ORIGIN_VERIFY_NAME_FOR_PROD_SUITES,
      publicOriginOverride: PUBLIC_ORIGIN_FOR_PROD_SUITES,
      appEnv: { ADMIN_AUTH_PROVIDER: 'none' },
      ...opts,
    });
    return Template.fromStack(stack);
  };

  it('does not wire provider secrets by default (memory backend / 現行不変)', () => {
    const template = synth();
    template.hasResourceProperties('AWS::Lambda::Function', {
      Environment: {
        Variables: Match.objectLike({
          PROVIDER_SECRET_BACKEND: Match.absent(),
          PROVIDER_SECRET_PREFIX: Match.absent(),
        }),
      },
    });
  }, 30000);

  it('injects PROVIDER_SECRET_BACKEND / PROVIDER_SECRET_PREFIX env into the server function', () => {
    const template = synth({
      providerSecretBackend: 'secrets-manager',
      providerSecretPrefix: PREFIX,
    });
    template.hasResourceProperties('AWS::Lambda::Function', {
      Environment: {
        Variables: Match.objectLike({
          PROVIDER_SECRET_BACKEND: 'secrets-manager',
          PROVIDER_SECRET_PREFIX: PREFIX,
        }),
      },
    });
  }, 30000);

  it('grants least-privilege secretsmanager actions scoped to <prefix>/tenants/* only', () => {
    const template = synth({
      providerSecretBackend: 'secrets-manager',
      providerSecretPrefix: PREFIX,
    });
    template.hasResourceProperties('AWS::IAM::Policy', {
      PolicyDocument: Match.objectLike({
        Statement: Match.arrayWith([
          Match.objectLike({
            Action: Match.arrayWith([
              'secretsmanager:GetSecretValue',
              'secretsmanager:DescribeSecret',
              'secretsmanager:CreateSecret',
              'secretsmanager:PutSecretValue',
              'secretsmanager:DeleteSecret',
            ]),
            Effect: 'Allow',
            // resource prefix 限定（ワイルドカード全体は禁止）。ARN 末尾が :secret:<prefix>/tenants/* 。
            Resource: Match.stringLikeRegexp(':secret:open-reception/prod/tenants/\\*$'),
          }),
        ]),
      }),
    });
  }, 30000);

  it('does NOT grant secretsmanager actions on Resource "*" (no account-wide wildcard)', () => {
    const template = synth({
      providerSecretBackend: 'secrets-manager',
      providerSecretPrefix: PREFIX,
    });
    const policies = template.findResources('AWS::IAM::Policy');
    for (const policy of Object.values(policies)) {
      const statements = policy.Properties.PolicyDocument.Statement as Array<{
        Action?: string | string[];
        Resource?: unknown;
      }>;
      for (const st of statements) {
        const actions = Array.isArray(st.Action) ? st.Action : st.Action ? [st.Action] : [];
        const touchesProviderSecrets = actions.some(
          (a) => a === 'secretsmanager:CreateSecret' || a === 'secretsmanager:DeleteSecret',
        );
        if (touchesProviderSecrets) {
          expect(st.Resource).not.toBe('*');
        }
      }
    }
  }, 30000);

  it('throws when secrets-manager backend is selected without a prefix (fail-closed)', () => {
    expect(() => synth({ providerSecretBackend: 'secrets-manager' })).toThrow(
      /providerSecretPrefix/,
    );
  }, 30000);

  it('does not create the tenant secrets themselves (runtime-created)', () => {
    const template = synth({
      providerSecretBackend: 'secrets-manager',
      providerSecretPrefix: PREFIX,
    });
    // #405 Inc2 はシークレット実体を CDK で作らない。既存 #194 の appSecrets を渡していないので 0。
    template.resourceCountIs('AWS::SecretsManager::Secret', 0);
  }, 30000);
});

// originVerifySecret 方式（CloudFront OAC の POST 署名問題回避）:
// Function URL を NONE にし、CloudFront origin custom header x-origin-verify で保護する。
// **生値は dev 専用** (issue #612)。prod は Secrets Manager 方式（下の describe）。
describe.runIf(OPEN_NEXT_READY)('WebStack origin-verify secret (#OAC-POST)', () => {
  const SECRET = 'test-origin-verify-secret-高エントロピー';
  let template: Template;
  beforeAll(() => {
    const app = new cdk.App();
    template = Template.fromStack(
      new WebStack(app, 'TestWebOriginVerify', {
        env: { account: '123456789012', region: 'ap-northeast-1' },
        config: resolveEnv('dev'),
        appEnv: { ADMIN_AUTH_PROVIDER: 'none' },
        originVerifySecret: SECRET,
      }),
    );
  }, 60000);

  it('uses Function URL authType NONE (public, protected by header)', () => {
    template.resourceCountIs('AWS::Lambda::Url', 2);
    // **件数で固定する。** hasResourceProperties は 1 つでも一致すれば通るので、
    // 「片方だけ NONE」を見逃す。**NONE は server だけ**（image は常に OAC + AWS_IAM。#631）。
    template.resourcePropertiesCountIs('AWS::Lambda::Url', { AuthType: 'NONE' }, 1);
    template.resourcePropertiesCountIs('AWS::Lambda::Url', { AuthType: 'AWS_IAM' }, 1);
  }, 30000);

  it('drops OAC for the server origin only (S3 と image の OAC は残る) (#631)', () => {
    template.resourceCountIs('AWS::CloudFront::OriginAccessControl', 2);
  }, 30000);

  it('grants lambda:InvokeFunction only to the image function (server は公開のため不要) (#631)', () => {
    template.resourcePropertiesCountIs(
      'AWS::Lambda::Permission',
      {
        Action: 'lambda:InvokeFunction',
        Principal: 'cloudfront.amazonaws.com',
        SourceArn: Match.anyValue(),
      },
      1,
    );
  }, 30000);

  it('injects x-origin-verify custom header into the CloudFront origins', () => {
    template.hasResourceProperties('AWS::CloudFront::Distribution', {
      DistributionConfig: Match.objectLike({
        Origins: Match.arrayWith([
          Match.objectLike({
            OriginCustomHeaders: Match.arrayWith([
              Match.objectLike({ HeaderName: 'x-origin-verify', HeaderValue: SECRET }),
            ]),
          }),
        ]),
      }),
    });
  }, 30000);

  it('passes ORIGIN_VERIFY_SECRET to the server function', () => {
    template.hasResourceProperties('AWS::Lambda::Function', {
      Environment: { Variables: Match.objectLike({ ORIGIN_VERIFY_SECRET: SECRET }) },
    });
  }, 30000);

  it('marks the deployment as origin-verify (proxy が fail-closed に倒せる) (#612)', () => {
    template.hasResourceProperties('AWS::Lambda::Function', {
      Environment: { Variables: Match.objectLike({ ORIGIN_VERIFY_REQUIRED: '1' }) },
    });
  }, 30000);
});

// origin-verify シークレットを Secrets Manager から供給する (issue #612)。
// 目的は「CFN テンプレートにも Lambda 環境変数にも平文を載せないこと」。
describe.runIf(OPEN_NEXT_READY)('WebStack origin-verify via Secrets Manager (#612)', () => {
  const SECRET_NAME = 'open-reception/test/app';
  const synth = (envName: 'dev' | 'prod') => {
    const app = new cdk.App();
    const stack = new WebStack(app, `TestWebOriginVerifySm${envName}`, {
      env: { account: '123456789012', region: 'ap-northeast-1' },
      config: resolveEnv(envName),
      appEnv: { ADMIN_AUTH_PROVIDER: 'none' },
      originVerifySecretName: SECRET_NAME,
      // N3b（発行 URL の基底オリジン必須）を満たすためだけの値。この suite の対象は
      // secret の供給方式であって origin / QR ではない。
      publicOriginOverride: PUBLIC_ORIGIN_FOR_PROD_SUITES,
    });
    return Template.fromStack(stack);
  };
  let template: Template;
  let rendered: string;
  beforeAll(() => {
    template = synth('prod');
    rendered = JSON.stringify(template.toJSON());
  }, 60000);

  it('keeps the Function URL public + header protected, exactly as the raw-value mode', () => {
    // server のみ NONE。image は OAC のままなので OAC は S3 + image の 2 つ残る（#631）。
    template.resourcePropertiesCountIs('AWS::Lambda::Url', { AuthType: 'NONE' }, 1);
    template.resourcePropertiesCountIs('AWS::Lambda::Url', { AuthType: 'AWS_IAM' }, 1);
    template.resourceCountIs('AWS::CloudFront::OriginAccessControl', 2);
  }, 30000);

  it('puts a CFN dynamic reference (not a literal) in the CloudFront custom header', () => {
    template.hasResourceProperties('AWS::CloudFront::Distribution', {
      DistributionConfig: Match.objectLike({
        Origins: Match.arrayWith([
          Match.objectLike({
            OriginCustomHeaders: Match.arrayWith([
              Match.objectLike({
                HeaderName: 'x-origin-verify',
                // 末尾の `::` は version-stage / version-id 省略（= AWSCURRENT）。
                HeaderValue: `{{resolve:secretsmanager:${SECRET_NAME}:SecretString:ORIGIN_VERIFY_SECRET::}}`,
              }),
            ]),
          }),
        ]),
      }),
    });
  }, 30000);

  it('puts the same dynamic reference in the server function env (no ARN indirection)', () => {
    // **runtime 解決に戻さないこと。** middleware は OpenNext の routing 層から instrumentation の
    // register() より先に呼ばれ、しかも拒否応答を返すと Next サーバへ到達しないので register() は
    // 走らない（回復は matcher 除外パス頼みで順序依存）。値は env に在る必要がある。
    template.hasResourceProperties('AWS::Lambda::Function', {
      Environment: {
        Variables: Match.objectLike({
          ORIGIN_VERIFY_SECRET: `{{resolve:secretsmanager:${SECRET_NAME}:SecretString:ORIGIN_VERIFY_SECRET::}}`,
          ORIGIN_VERIFY_REQUIRED: '1',
        }),
      },
    });
    // ARN を渡す形（= runtime 解決）へ戻っていないこと。
    template.resourcePropertiesCountIs(
      'AWS::Lambda::Function',
      {
        Environment: {
          Variables: Match.objectLike({ ORIGIN_VERIFY_SECRET_ARN: Match.anyValue() }),
        },
      },
      0,
    );
  }, 30000);

  it('does not grant the server function Secrets Manager read for origin-verify', () => {
    // CFN がデプロイ時に解決するので、Lambda 実行ロールに読取権限は要らない（最小権限）。
    // appSecretsName（#194）を渡していないこの stack では GetSecretValue の statement が 0 件。
    template.resourcePropertiesCountIs(
      'AWS::IAM::Policy',
      {
        PolicyDocument: Match.objectLike({
          Statement: Match.arrayWith([
            Match.objectLike({ Action: Match.arrayWith(['secretsmanager:GetSecretValue']) }),
          ]),
        }),
      },
      0,
    );
  }, 30000);

  it('never renders a resolved secret value anywhere in the template', () => {
    // 動的参照のトークン以外に "ORIGIN_VERIFY_SECRET" の値が現れないこと。
    expect(rendered).toContain('{{resolve:secretsmanager:');
    expect(rendered).not.toMatch(/"ORIGIN_VERIFY_SECRET"\s*:\s*"(?!\{\{resolve)/);
  }, 30000);

  it('works in dev too (方式は環境で分岐しない)', () => {
    expect(() => synth('dev')).not.toThrow();
  }, 30000);
});

// 生値・空文字・環境外の経路を塞ぐ (issue #612)。
// **`runIf(OPEN_NEXT_READY)` を付けない。** 引数ガードは `.open-next/` を必要としない位置
// （assertBuildArtifacts より前）で throw するので、未ビルド環境でも検証できる。
// runIf を付けていた頃は、ゲート外(#628)であることと相まって一度も実行されていなかった。
describe('WebStack origin-verify argument guards (#612)', () => {
  const build =
    (
      envName: 'dev' | 'staging' | 'prod',
      props: {
        originVerifySecret?: string;
        originVerifySecretName?: string;
        // N3b（発行 URL の基底オリジン）のガードも同じ帯に居るので、ここから渡せるようにする。
        publicOriginOverride?: string;
        customDomain?: { domainName: string; certificateArn: string };
      },
    ) =>
    () => {
      const app = new cdk.App();
      return new WebStack(app, 'TestWebOriginVerifyGuard', {
        env: { account: '123456789012', region: 'ap-northeast-1' },
        config: resolveEnv(envName),
        appEnv: { ADMIN_AUTH_PROVIDER: 'none' },
        ...props,
      });
    };

  it.each(['prod', 'staging'] as const)('rejects the raw-value mode in %s', (envName) => {
    // 🔴 `=== 'prod'` で書くと staging が素通りする。許可リスト（`!== 'dev'`）で判定すること。
    expect(build(envName, { originVerifySecret: 'TEST-raw' })).toThrow(/dev 以外では使えません/);
  });

  // 🔴 **未指定を「OAC + AWS_IAM へのフォールバック」で黙って通さない (N3)。**
  // その構成では CloudFront -> Lambda Function URL の **POST が全滅**する（OAC が POST ボディを
  // 署名しないため。実測は docs/deploy-aws.md）。つまり context を渡し忘れたデプロイは、
  // login も受付 URL 発行も `/api/kiosk/enroll` も通らない＝**受付が成立しない状態で立ち上がる**。
  // 上の「生値は dev 以外で不可」と対になる: dev 以外では *何らかの* 供給元が要る。
  it.each(['prod', 'staging'] as const)(
    'rejects a deployment with no origin-verify supplier in %s (fail-closed)',
    (envName) => {
      const build_ = build(envName, {});
      // 何を渡せばよいかがメッセージから読めること。
      expect(build_).toThrow(/originVerifySecretName/);
      // なぜ必要かがメッセージから読めること（POST が落ちて受付が成立しない）。
      expect(build_).toThrow(/POST/);
    },
  );

  /**
   * 🔴 **同じクラスの「渡し忘れると受付が成立しない」context がもう 1 本ある (N3b)。**
   *
   * `publicOriginOverride` を渡さず、かつカスタムドメインも無いと、`resolveCheckinBaseUrl` は
   * リクエストの Host から推定する。CloudFront → Lambda Function URL 構成では Host が
   * **Function URL** なので、発行された QR を開いても CloudFront を経由せず
   * `x-origin-verify` が付かない → middleware が forbidden を返す ——
   * **端末エンロール QR も来訪予約 checkin QR も、誰も使えない**（2026-08-04 に実測）。
   *
   * origin-verify（N3）を必須化しても、こちらが無防備なままだと QR 側だけが落ちる。
   */
  it.each(['prod', 'staging'] as const)(
    'rejects a deployment with no public origin in %s (fail-closed / N3b)',
    (envName) => {
      const build_ = build(envName, { originVerifySecretName: 'open-reception/test/app' });
      expect(build_).toThrow(/publicOriginOverride/);
      // なぜ必要かが読めること（QR が誰にも使えない）。
      expect(build_).toThrow(/QR/);
    },
  );

  // カスタムドメインがあれば publicOrigin はそこから決まるので、override は要らない。
  it('accepts a deployment with a custom domain instead of publicOriginOverride (N3b)', () => {
    expect(() => {
      try {
        build('prod', {
          originVerifySecretName: 'open-reception/test/app',
          customDomain: {
            domainName: 'reception.example.com',
            certificateArn: 'arn:aws:acm:us-east-1:123456789012:certificate/test',
          },
        })();
      } catch (e) {
        if (e instanceof Error && /OpenNext build artifacts/.test(e.message)) return;
        throw e;
      }
    }).not.toThrow();
  });

  // 過剰に厳しくしない: dev は未指定のまま通す（開発を止めない）。
  it('still lets dev omit origin-verify entirely (開発を止めない)', () => {
    expect(() => {
      try {
        build('dev', {})();
      } catch (e) {
        // `.open-next/` 未ビルド環境では成果物チェックで落ちる。ガードを通過した証拠として扱う。
        if (e instanceof Error && /OpenNext build artifacts/.test(e.message)) return;
        throw e;
      }
    }).not.toThrow();
  });

  it('rejects passing both (どちらがヘッダに載るか曖昧にしない)', () => {
    expect(
      build('prod', { originVerifySecret: 'TEST-raw', originVerifySecretName: 'open-reception/x' }),
    ).toThrow(/併用できません/);
  });

  // 🔴 `-c originVerifySecret=$UNSET_VAR` は空文字を渡す。falsy 判定に任せると origin-verify が
  // 黙って OFF になり、OAC+IAM に戻って全 POST が 403 になる（回避対象の障害そのもの）。
  it.each([
    ['originVerifySecret', { originVerifySecret: '' }],
    ['originVerifySecret（空白のみ）', { originVerifySecret: '   ' }],
    ['originVerifySecretName', { originVerifySecretName: '' }],
  ])('rejects an empty %s instead of silently disabling verification', (_label, props) => {
    expect(build('prod', props)).toThrow(/空文字\/非文字列/);
  });

  it('rejects a non-string context value (cdk.json の context に実 JSON で書ける)', () => {
    expect(
      build('prod', { originVerifySecretName: true as unknown as string }),
    ).toThrow(/空文字\/非文字列/);
  });

  // 🔴 appEnv 経由の自爆経路。origin-verify 無効構成では addEnvironment による上書きが走らないので、
  // REQUIRED=1 だけが残って全リクエストが恒久 503 になる。
  it('rejects ORIGIN_VERIFY_* passed through appEnv', () => {
    const app = new cdk.App();
    expect(
      () =>
        new WebStack(app, 'TestWebOriginVerifyAppEnv', {
          env: { account: '123456789012', region: 'ap-northeast-1' },
          config: resolveEnv('prod'),
          appEnv: { ADMIN_AUTH_PROVIDER: 'none', ORIGIN_VERIFY_REQUIRED: '1' },
        }),
    ).toThrow(/appEnv に ORIGIN_VERIFY_REQUIRED を渡せません/);
  });

  it('accepts the Secrets Manager mode in every environment', () => {
    // ガードは供給方法だけを見る。方式そのものは環境で分岐しない。
    // `publicOriginOverride` は N3b のガードを満たすためだけに渡す（このテストの対象外）。
    for (const envName of ['dev', 'staging', 'prod'] as const) {
      expect(() => {
        try {
          build(envName, {
            originVerifySecretName: 'open-reception/x',
            publicOriginOverride: 'https://example.cloudfront.net',
          })();
        } catch (e) {
          // `.open-next/` 未ビルド環境では成果物チェックで落ちる。ガードを通過した証拠として扱う。
          if (e instanceof Error && /OpenNext build artifacts/.test(e.message)) return;
          throw e;
        }
      }).not.toThrow();
    }
  });
});


// コスト微最適化 (issue #300): 全環境 PriceClass_200 + アセットバケットの安全なライフサイクル。
describe.runIf(OPEN_NEXT_READY)('WebStack cost optimization (#300)', () => {
  const synth = (envName: 'dev' | 'prod') => {
    const app = new cdk.App();
    const stack = new WebStack(app, `TestWebCost${envName}`, {
      env: { account: '123456789012', region: 'ap-northeast-1' },
      config: resolveEnv(envName),
      originVerifySecretName: ORIGIN_VERIFY_NAME_FOR_PROD_SUITES,
      publicOriginOverride: PUBLIC_ORIGIN_FOR_PROD_SUITES,
      appEnv: { ADMIN_AUTH_PROVIDER: 'none' },
    });
    return Template.fromStack(stack);
  };

  it.each(['dev', 'prod'] as const)(
    'uses PriceClass_200 in %s (国内 iPad 端末向けのため全世界エッジは不要)',
    (envName) => {
      synth(envName).hasResourceProperties('AWS::CloudFront::Distribution', {
        DistributionConfig: Match.objectLike({ PriceClass: 'PriceClass_200' }),
      });
    },
    30000,
  );

  it('asset bucket cleans up incomplete multipart uploads via lifecycle', () => {
    synth('prod').hasResourceProperties('AWS::S3::Bucket', {
      LifecycleConfiguration: {
        Rules: Match.arrayWith([
          Match.objectLike({
            AbortIncompleteMultipartUpload: { DaysAfterInitiation: 7 },
            Status: 'Enabled',
          }),
        ]),
      },
    });
  }, 30000);

  it('asset bucket does NOT expire objects by age (可用性をデプロイ頻度に依存させない)', () => {
    // BucketDeployment(s3 sync) は「アセットが変わったデプロイ時」しか LastModified を
    // 更新しないため、作成日時基準の Expiration は無デプロイ期間が続くと現役アセットを
    // 失効させ得る。年齢ベースの失効ルールを持たないことを設計判断として固定する。
    synth('prod').hasResourceProperties('AWS::S3::Bucket', {
      LifecycleConfiguration: {
        Rules: [Match.objectLike({ ExpirationInDays: Match.absent() })],
      },
    });
  }, 30000);
});

// 管理ログイン Cognito（埋め込み SRP）(issue #238)。
describe.runIf(OPEN_NEXT_READY)('WebStack admin Cognito auth', () => {
  // describe ボディ直下で構築しない理由はファイル冒頭の注意書きを参照。
  let template: Template;
  beforeAll(() => {
    const app = new cdk.App();
    template = Template.fromStack(
      new WebStack(app, 'TestWebCognito', {
        env: { account: '123456789012', region: 'ap-northeast-1' },
        config: resolveEnv('prod'),
        originVerifySecretName: ORIGIN_VERIFY_NAME_FOR_PROD_SUITES,
        publicOriginOverride: PUBLIC_ORIGIN_FOR_PROD_SUITES,
        appEnv: { ADMIN_AUTH_PROVIDER: 'cognito' },
        cognitoAuth: true,
      }),
    );
  }, 60000);

  it('provisions a Cognito User Pool with self sign-up disabled', () => {
    template.resourceCountIs('AWS::Cognito::UserPool', 1);
    template.hasResourceProperties('AWS::Cognito::UserPool', {
      AdminCreateUserConfig: { AllowAdminCreateUserOnly: true },
    });
  });

  it('App Client enables USER_SRP_AUTH only and no client secret / no hosted UI', () => {
    template.hasResourceProperties('AWS::Cognito::UserPoolClient', {
      ExplicitAuthFlows: Match.arrayWith(['ALLOW_USER_SRP_AUTH']),
      GenerateSecret: false,
    });
    // Hosted UI を使わないため UserPoolDomain は作らない。
    template.resourceCountIs('AWS::Cognito::UserPoolDomain', 0);
  });

  it('injects COGNITO_* env into the server function', () => {
    template.hasResourceProperties('AWS::Lambda::Function', {
      Environment: {
        Variables: Match.objectLike({
          ADMIN_AUTH_PROVIDER: 'cognito',
          COGNITO_USER_POOL_ID: Match.anyValue(),
          COGNITO_CLIENT_ID: Match.anyValue(),
          COGNITO_REGION: 'ap-northeast-1',
          COGNITO_ISSUER: Match.anyValue(),
        }),
      },
    });
  }, 30000);

  it('does NOT create Cognito when cognitoAuth is unset', () => {
    const app2 = new cdk.App();
    const noCog = new WebStack(app2, 'TestWebNoCognito', {
      env: { account: '123456789012', region: 'ap-northeast-1' },
      config: resolveEnv('dev'),
      appEnv: { ADMIN_AUTH_PROVIDER: 'none' },
    });
    Template.fromStack(noCog).resourceCountIs('AWS::Cognito::UserPool', 0);
  });
});
