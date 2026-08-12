/**
 * IAM ポリシー JSON の構造検証 (spec §11)。
 *
 * 「policy を見る限り安全」で終わらせないための最初の網。**実 API 評価は
 * `scripts/aws-negative-tests.ts` の SimulatePrincipalPolicy が担う**ので、ここでは
 * 「書き忘れ」と「明らかな穴」だけを機械で押さえる。
 */
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';
import { auditPolicyDocument, type PolicyDocument } from './aws-policy-shape';

const load = (name: string): PolicyDocument =>
  JSON.parse(readFileSync(resolve(process.cwd(), 'scripts/aws-policies', name), 'utf8')) as PolicyDocument;

describe('auditPolicyDocument', () => {
  it('Allow の Action:* + Resource:* を管理者権限として検出する', () => {
    const audit = auditPolicyDocument({
      Version: '2012-10-17',
      Statement: [{ Effect: 'Allow', Action: '*', Resource: '*' }],
    });
    expect(audit.grantsAdmin).toBe(true);
  });

  it('Allow の Action:* でも Resource が限定されていれば管理者ではない', () => {
    const audit = auditPolicyDocument({
      Version: '2012-10-17',
      Statement: [{ Effect: 'Allow', Action: '*', Resource: 'arn:aws:s3:::example/*' }],
    });
    expect(audit.grantsAdmin).toBe(false);
  });

  it('Deny されている ARN パターンを列挙する', () => {
    const audit = auditPolicyDocument({
      Version: '2012-10-17',
      Statement: [
        { Effect: 'Deny', Action: 'cloudformation:*', Resource: 'arn:aws:cloudformation:*:*:stack/nodi-*/*' },
      ],
    });
    expect(audit.deniedResourcePatterns).toContain('arn:aws:cloudformation:*:*:stack/nodi-*/*');
  });

  it('boundary 条件の無い iam:CreateRole の Allow を検出する', () => {
    const audit = auditPolicyDocument({
      Version: '2012-10-17',
      Statement: [{ Effect: 'Allow', Action: 'iam:CreateRole', Resource: '*' }],
    });
    expect(audit.unboundedRoleCreation).toBe(true);
  });

  it('PermissionsBoundary 条件付きの iam:CreateRole は検出しない', () => {
    const audit = auditPolicyDocument({
      Version: '2012-10-17',
      Statement: [
        {
          Effect: 'Allow',
          Action: 'iam:CreateRole',
          Resource: '*',
          Condition: {
            StringEquals: {
              'iam:PermissionsBoundary':
                'arn:aws:iam::822063948773:policy/OpenReceptionClaudeBoundary',
            },
          },
        },
      ],
    });
    expect(audit.unboundedRoleCreation).toBe(false);
  });

  it('StringEqualsIfExists は boundary 条件と認めない（キー欠如時に true になる）', () => {
    const audit = auditPolicyDocument({
      Version: '2012-10-17',
      Statement: [
        {
          Effect: 'Allow',
          Action: 'iam:CreateRole',
          Resource: '*',
          Condition: {
            StringEqualsIfExists: {
              'iam:PermissionsBoundary':
                'arn:aws:iam::822063948773:policy/OpenReceptionClaudeBoundary',
            },
          },
        },
      ],
    });
    expect(audit.unboundedRoleCreation).toBe(true);
  });

  it('Null 演算子は boundary 条件と認めない（キーの不在を主張しうる）', () => {
    const audit = auditPolicyDocument({
      Version: '2012-10-17',
      Statement: [
        {
          Effect: 'Allow',
          Action: 'iam:CreateRole',
          Resource: '*',
          Condition: { Null: { 'iam:PermissionsBoundary': 'true' } },
        },
      ],
    });
    expect(audit.unboundedRoleCreation).toBe(true);
  });

  it('Action / Resource が配列でも文字列でも同じに扱う', () => {
    const audit = auditPolicyDocument({
      Version: '2012-10-17',
      Statement: [{ Effect: 'Deny', Action: ['s3:*'], Resource: ['arn:aws:s3:::nodi-*'] }],
    });
    expect(audit.deniedResourcePatterns).toContain('arn:aws:s3:::nodi-*');
  });

  it('Deny の NotResource を Resource とは別に集計する', () => {
    const audit = auditPolicyDocument({
      Version: '2012-10-17',
      Statement: [
        {
          Effect: 'Deny',
          Action: 'cloudformation:*',
          NotResource: ['arn:aws:cloudformation:*:*:stack/OpenReception-Web-dev/*'],
        },
      ],
    });
    expect(audit.deniedNotResourcePatterns).toContain(
      'arn:aws:cloudformation:*:*:stack/OpenReception-Web-dev/*',
    );
    expect(audit.deniedResourcePatterns).toEqual([]);
  });
});

/** 他プロジェクトの列挙。spec の Global Constraints と 1:1。 */
const FOREIGN_PATTERNS = ['nodi-', 'salon-loop-', 'Kiaff', 'cdk-hnb659fds-', 'cdk-staging-'];

describe('claude-boundary.json', () => {
  const doc = load('claude-boundary.json');

  it('管理者権限を与えない', () => {
    expect(auditPolicyDocument(doc).grantsAdmin).toBe(false);
  });

  it('boundary 条件の無い Role 作成を許さない', () => {
    expect(auditPolicyDocument(doc).unboundedRoleCreation).toBe(false);
  });

  it.each(FOREIGN_PATTERNS)('%s を Deny している', (pattern) => {
    const denied = auditPolicyDocument(doc).deniedResourcePatterns.join('\n');
    expect(denied).toContain(pattern);
  });

  it.each([
    'iam:DeleteRolePermissionsBoundary',
    'iam:PutRolePermissionsBoundary',
    'route53:*',
    'acm:*',
    'iam:CreateUser',
    'iam:CreateAccessKey',
  ])('%s を Deny している', (action) => {
    expect(auditPolicyDocument(doc).deniedActions).toContain(action);
  });

  it('boundary 自身の書き換えを Deny している', () => {
    const denied = auditPolicyDocument(doc).deniedResourcePatterns.join('\n');
    expect(denied).toContain('policy/OpenReceptionClaudeBoundary');
  });
});

describe('claude-cfn-exec.json', () => {
  const doc = load('claude-cfn-exec.json');

  it('管理者権限を与えない（既定 bootstrap の AdministratorAccess を使わない理由）', () => {
    expect(auditPolicyDocument(doc).grantsAdmin).toBe(false);
  });

  it('secretsmanager を Deny している（dev には 1 つも存在しない）', () => {
    expect(auditPolicyDocument(doc).deniedActions).toContain('secretsmanager:*');
  });

  it('boundary 条件の無い Role 作成を許さない', () => {
    expect(auditPolicyDocument(doc).unboundedRoleCreation).toBe(false);
  });

  it.each(FOREIGN_PATTERNS)('%s を Deny している', (pattern) => {
    expect(auditPolicyDocument(doc).deniedResourcePatterns.join('\n')).toContain(pattern);
  });
});

describe('claude-deploy-entry.json', () => {
  const doc = load('claude-deploy-entry.json');
  const audit = auditPolicyDocument(doc);

  it('管理者権限を与えない', () => {
    expect(audit.grantsAdmin).toBe(false);
  });

  it('既定 qualifier のロールへの AssumeRole を Deny している', () => {
    const denied = audit.deniedResourcePatterns.join('\n');
    expect(denied).toContain('cdk-hnb659fds-');
    expect(denied).toContain('cdk-staging-');
  });

  it('専用 qualifier のロールへの AssumeRole だけを Allow している', () => {
    const allowed = audit.allowedResourcePatterns.join('\n');
    expect(allowed).toContain('cdk-orcloud01-');
    expect(allowed).not.toContain('cdk-hnb659fds-');
  });
});

describe('claude-deploy-role-restriction.json（層 1・主境界）', () => {
  const audit = auditPolicyDocument(load('claude-deploy-role-restriction.json'));

  it('許可スタック以外への cloudformation を Deny している', () => {
    const denied = audit.deniedResourcePatterns.join('\n');
    expect(denied).toContain('stack/nodi-');
    expect(denied).toContain('stack/salon-loop-');
    expect(denied).toContain('stack/OpenReception-*-prod/');
    expect(denied).toContain('stack/OpenReception-*-staging/');
  });

  it('Allow を一切含まない（既存 deploy role への上乗せ Deny だけ）', () => {
    expect(audit.allowedResourcePatterns).toEqual([]);
    expect(audit.grantsAdmin).toBe(false);
  });

  it('共有 bootstrap の cfn-exec-role への PassRole を Deny している', () => {
    expect(audit.deniedActions).toContain('iam:PassRole');
    expect(audit.deniedResourcePatterns.join('\n')).toContain('cdk-hnb659fds-');
  });

  it('NotResource 許可リストが dev の 3 スタックと専用 Toolkit を挙げている', () => {
    const patterns = audit.deniedNotResourcePatterns.join('\n');
    expect(patterns).toContain('stack/OpenReception-Web-dev/');
    expect(patterns).toContain('stack/OpenReception-WebMonitoring-dev/');
    expect(patterns).toContain('stack/OpenReception-CfMonitoring-dev/');
    expect(patterns).toContain('stack/CDKToolkit-orcloud01/');
  });

  it('NotResource 許可リストにワイルドカード単体を含まない（主境界を無効化する）', () => {
    expect(audit.deniedNotResourcePatterns).not.toContain('*');
    for (const p of audit.deniedNotResourcePatterns) {
      expect(p).toMatch(/^arn:aws:cloudformation:/);
    }
  });
});

describe('claude-deploy-entry-trust.json', () => {
  const doc = load('claude-deploy-entry-trust.json');

  it('user/CDK だけを信頼し ExternalId を要求する', () => {
    const raw = JSON.stringify(doc);
    expect(raw).toContain('arn:aws:iam::822063948773:user/CDK');
    expect(raw).toContain('sts:ExternalId');
  });

  it('Principal が * でない', () => {
    const raw = JSON.stringify(doc);
    expect(raw).not.toContain('"Principal":"*"');
    expect(raw).not.toContain('"AWS":"*"');
  });
});
