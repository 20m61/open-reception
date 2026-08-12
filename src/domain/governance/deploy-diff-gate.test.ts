/**
 * change set の危険判定 (spec §6)。
 *
 * `cdk diff` のテキストではなく `aws cloudformation describe-change-set` の JSON を
 * 入力にする。テキスト parse は取りこぼすため。
 */
import { describe, expect, it } from 'vitest';
import {
  ALLOWED_STACK_PATTERN,
  evaluateDeployChangeSet,
  type ChangeSetResourceChange,
  type ChangeSetSummary,
} from './deploy-diff-gate';

const change = (over: Partial<ChangeSetResourceChange> = {}): ChangeSetResourceChange => ({
  action: 'Modify',
  resourceType: 'AWS::Lambda::Function',
  logicalResourceId: 'ServerFn',
  replacement: 'False',
  ...over,
});

const summary = (over: Partial<ChangeSetSummary> = {}): ChangeSetSummary => ({
  stackName: 'OpenReception-Web-dev',
  changes: [change()],
  ...over,
});

describe('通すべきものを通す', () => {
  it('Lambda の非置換 Modify は通る', () => {
    const verdict = evaluateDeployChangeSet(summary());
    expect(verdict.blocked).toBe(false);
    expect(verdict.blocks).toEqual([]);
  });

  it('変更ゼロ（no-op deploy）は通る', () => {
    expect(evaluateDeployChangeSet(summary({ changes: [] })).blocked).toBe(false);
  });

  it('Add は通る', () => {
    expect(evaluateDeployChangeSet(summary({ changes: [change({ action: 'Add' })] })).blocked).toBe(
      false,
    );
  });

  it('Modify で replacement=False は通る（安全な Update を許可する）', () => {
    expect(
      evaluateDeployChangeSet(summary({ changes: [change({ action: 'Modify', replacement: 'False' })] }))
        .blocked,
    ).toBe(false);
  });
});

describe('停止する', () => {
  it.each<[string, Partial<ChangeSetSummary>, string]>([
    [
      'スタック名が dev でない',
      { stackName: 'OpenReception-Web-prod' },
      'unexpectedStack',
    ],
    [
      'スタック名が他プロジェクト',
      { stackName: 'nodi-dev-app' },
      'unexpectedStack',
    ],
    [
      'リソース削除',
      { changes: [change({ action: 'Remove' })] },
      'resourceRemoval',
    ],
    [
      'Replacement True',
      { changes: [change({ replacement: 'True' })] },
      'resourceReplacement',
    ],
    [
      'Replacement Conditional も止める',
      { changes: [change({ replacement: 'Conditional' })] },
      'resourceReplacement',
    ],
    [
      'KMS は Add でも止める',
      { changes: [change({ action: 'Add', resourceType: 'AWS::KMS::Key' })] },
      'kmsChange',
    ],
    [
      'SecretsManager は Add でも止める',
      { changes: [change({ action: 'Add', resourceType: 'AWS::SecretsManager::Secret' })] },
      'secretsChange',
    ],
    [
      'Route53',
      { changes: [change({ resourceType: 'AWS::Route53::RecordSet' })] },
      'dnsOrCertificateChange',
    ],
    [
      'ACM',
      { changes: [change({ resourceType: 'AWS::CertificateManager::Certificate' })] },
      'dnsOrCertificateChange',
    ],
    [
      'SecurityGroup',
      { changes: [change({ resourceType: 'AWS::EC2::SecurityGroupIngress' })] },
      'networkBoundaryChange',
    ],
    [
      'IAM User の作成',
      { changes: [change({ action: 'Add', resourceType: 'AWS::IAM::User' })] },
      'iamPrincipalChange',
    ],
    [
      'IAM AccessKey の作成',
      { changes: [change({ action: 'Add', resourceType: 'AWS::IAM::AccessKey' })] },
      'iamPrincipalChange',
    ],
    [
      'IAM Group の作成',
      { changes: [change({ action: 'Add', resourceType: 'AWS::IAM::Group' })] },
      'iamPrincipalChange',
    ],
    [
      'IAM UserToGroupAddition の作成',
      { changes: [change({ action: 'Add', resourceType: 'AWS::IAM::UserToGroupAddition' })] },
      'iamPrincipalChange',
    ],
    [
      'Dynamic action は未知なので止める',
      { changes: [change({ action: 'Dynamic' })] },
      'unknownAction',
    ],
    [
      'Import action は未知なので止める',
      { changes: [change({ action: 'Import' })] },
      'unknownAction',
    ],
  ])('%s', (_name, over, reason) => {
    const verdict = evaluateDeployChangeSet(summary(over));
    expect(verdict.blocked).toBe(true);
    expect(verdict.blocks.map((b) => b.reason)).toContain(reason);
  });

  it('根拠に論理 ID とリソース種別が載る（人が確認できないと信用できない）', () => {
    const verdict = evaluateDeployChangeSet(
      summary({ changes: [change({ action: 'Remove', logicalResourceId: 'DataTable' })] }),
    );
    const evidence = verdict.blocks.map((b) => b.evidence).join('\n');
    expect(evidence).toContain('DataTable');
    expect(evidence).toContain('AWS::Lambda::Function');
  });
});

describe('記録のみ（止めない）', () => {
  it('IAM Role の Modify は flag だけで通す', () => {
    const verdict = evaluateDeployChangeSet(
      summary({ changes: [change({ resourceType: 'AWS::IAM::Role' })] }),
    );
    expect(verdict.blocked).toBe(false);
    expect(verdict.flags.map((f) => f.reason)).toContain('iamPolicyChange');
  });

  it('IAM Role の Remove は止める（flag では済ませない）', () => {
    const verdict = evaluateDeployChangeSet(
      summary({ changes: [change({ action: 'Remove', resourceType: 'AWS::IAM::Role' })] }),
    );
    expect(verdict.blocked).toBe(true);
  });
});

describe('ALLOWED_STACK_PATTERN', () => {
  it.each(['OpenReception-Web-dev', 'OpenReception-WebMonitoring-dev', 'OpenReception-CfMonitoring-dev'])(
    '%s は許可',
    (name) => expect(ALLOWED_STACK_PATTERN.test(name)).toBe(true),
  );
  it.each([
    'OpenReception-Web-staging',
    'OpenReception-Web-prod',
    'OpenReception-Web-dev-extra',
    'XOpenReception-Web-dev',
    'nodi-dev-app',
    'salon-loop-staging-data',
  ])('%s は不許可', (name) => expect(ALLOWED_STACK_PATTERN.test(name)).toBe(false));
});
