import { describe, it, expect } from 'vitest';
import * as cdk from 'aws-cdk-lib';
import { Match, Template } from 'aws-cdk-lib/assertions';
import { RealtimeRuntimeStack } from '../lib/stacks/realtime-runtime-stack';
import { resolveEnv } from '../lib/config/environments';

const ENV = { account: '123456789012', region: 'ap-northeast-1' };

function buildTemplate(
  envName: 'dev' | 'staging' | 'prod' = 'dev',
  withDns = false,
  bedrockModelArnPattern?: string,
) {
  const app = new cdk.App();
  const config = resolveEnv(envName);
  const stack = new RealtimeRuntimeStack(app, 'TestRealtimeRuntime', {
    env: ENV,
    config,
    dns: withDns
      ? { hostedZoneId: 'Z1234567890ABC', zoneName: 'example.com', recordName: 'realtime.dev.example.com' }
      : undefined,
    bedrockModelArnPattern,
  });
  return { stack, template: Template.fromStack(stack) };
}

describe('RealtimeRuntimeStack (issue #366 Phase 0)', () => {
  it('NAT Gateway を作らない（コスト方針）', () => {
    const { template } = buildTemplate();
    template.resourceCountIs('AWS::EC2::NatGateway', 0);
  });

  it('単一 AZ・public subnet のみ（MVP 単一障害点許容）', () => {
    const { template } = buildTemplate();
    // maxAzs: 1 + subnetConfiguration に public のみ指定 → PublicSubnet が 1 個だけ作られる。
    template.resourceCountIs('AWS::EC2::Subnet', 1);
  });

  it('Security Group は SSH(22) を開放せず、WSS(443) のみ許可する', () => {
    const { template } = buildTemplate();
    template.hasResourceProperties('AWS::EC2::SecurityGroup', {
      SecurityGroupIngress: Match.arrayWith([
        Match.objectLike({ FromPort: 443, ToPort: 443, CidrIp: '0.0.0.0/0' }),
      ]),
    });
    const sgs = template.findResources('AWS::EC2::SecurityGroup');
    for (const sg of Object.values(sgs)) {
      const ingress = (sg as { Properties?: { SecurityGroupIngress?: Array<{ FromPort?: number }> } })
        .Properties?.SecurityGroupIngress;
      for (const rule of ingress ?? []) {
        expect(rule.FromPort).not.toBe(22);
      }
    }
  });

  it('LaunchTemplate は IMDSv2 必須・EBS gp3 暗号化・config の instanceType を使う', () => {
    const { template } = buildTemplate('dev');
    template.hasResourceProperties('AWS::EC2::LaunchTemplate', {
      LaunchTemplateData: Match.objectLike({
        InstanceType: 't4g.small',
        MetadataOptions: Match.objectLike({ HttpTokens: 'required' }),
        BlockDeviceMappings: Match.arrayWith([
          Match.objectLike({
            Ebs: Match.objectLike({ VolumeType: 'gp3', Encrypted: true }),
          }),
        ]),
      }),
    });
  });

  it('ASG は min=0 / max=1 (ADR-002)', () => {
    const { template } = buildTemplate();
    template.hasResourceProperties('AWS::AutoScaling::AutoScalingGroup', {
      MinSize: '0',
      MaxSize: '1',
    });
  });

  it('ASG の update policy は DesiredCapacity 系の変更を無視する（Reconciler の実行時調整と両立）', () => {
    const { template } = buildTemplate();
    const groups = template.findResources('AWS::AutoScaling::AutoScalingGroup');
    const [group] = Object.values(groups) as Array<{
      UpdatePolicy?: { AutoScalingScheduledAction?: { IgnoreUnmodifiedGroupSizeProperties?: boolean } };
    }>;
    expect(group).toBeDefined();
    expect(group?.UpdatePolicy?.AutoScalingScheduledAction?.IgnoreUnmodifiedGroupSizeProperties).toBe(true);
  });

  it('Reconciler Lambda は 1 分毎の EventBridge Rule から起動される', () => {
    const { template } = buildTemplate();
    template.hasResourceProperties('AWS::Events::Rule', {
      ScheduleExpression: 'rate(1 minute)',
    });
  });

  it('Reconciler Lambda の環境変数に営業時間ポリシーが渡る', () => {
    const { template } = buildTemplate('dev');
    template.hasResourceProperties('AWS::Lambda::Function', {
      Environment: Match.objectLike({
        Variables: Match.objectLike({ START_HOUR: '8', STOP_HOUR: '23' }),
      }),
    });
  });

  it('force-stop kill-switch の SSM Parameter を作る（deploy 不要の緊急停止手段）', () => {
    const { template } = buildTemplate('dev');
    template.hasResourceProperties('AWS::SSM::Parameter', {
      Name: '/open-reception-dev/realtime/force-stop',
      Value: 'false',
    });
  });

  it('Component=realtime-runtime タグを Stack 配下へ付与する', () => {
    const { template } = buildTemplate();
    template.hasResourceProperties('AWS::EC2::SecurityGroup', {
      Tags: Match.arrayWith([{ Key: 'Component', Value: 'realtime-runtime' }]),
    });
  });

  it('月額 Budget を config.realtime.monthlyBudgetUsd で作る', () => {
    const { template } = buildTemplate('dev');
    template.hasResourceProperties('AWS::Budgets::Budget', {
      Budget: Match.objectLike({
        BudgetLimit: { Amount: 20, Unit: 'USD' },
        BudgetType: 'COST',
        TimeUnit: 'MONTHLY',
      }),
    });
  });

  it('dns 未指定なら Route 53 リソースを作らない（実 hosted zone なしで synth できる）', () => {
    const { template } = buildTemplate('dev', false);
    template.resourceCountIs('AWS::Route53::RecordSet', 0);
  });

  it('dns 指定時のみ Route 53 A レコードを作る', () => {
    const { template } = buildTemplate('dev', true);
    template.hasResourceProperties('AWS::Route53::RecordSet', {
      Name: 'realtime.dev.example.com.',
      Type: 'A',
    });
  });

  describe('bedrock:InvokeModel はモデル ARN パターンへ限定する (#366 W3)', () => {
    it('既定（未指定）でも Resource は "*" ではなく anthropic foundation-model パターンへ絞る', () => {
      const { template } = buildTemplate('dev');
      const policies = template.findResources('AWS::IAM::Policy');
      const bedrockStatements = Object.values(policies).flatMap((p) => {
        const statements = (
          p as { Properties?: { PolicyDocument?: { Statement?: Array<{ Action?: unknown; Resource?: unknown }> } } }
        ).Properties?.PolicyDocument?.Statement;
        return (statements ?? []).filter((s) => {
          const action = s.Action;
          return action === 'bedrock:InvokeModel' || (Array.isArray(action) && action.includes('bedrock:InvokeModel'));
        });
      });
      expect(bedrockStatements.length).toBeGreaterThan(0);
      for (const statement of bedrockStatements) {
        expect(statement.Resource).not.toBe('*');
        const resources = Array.isArray(statement.Resource) ? statement.Resource : [statement.Resource];
        for (const resource of resources) {
          // CDK が Fn::Join 等でトークン化することがあるため、素の文字列のときだけ内容も検証する。
          if (typeof resource === 'string') {
            expect(resource).not.toBe('*');
            expect(resource).toMatch(/foundation-model/);
          }
        }
      }
    });

    it('context 経由で渡した ARN パターンを使う', () => {
      const custom = 'arn:aws:bedrock:ap-northeast-1::foundation-model/anthropic.claude-3-haiku-*';
      const { template } = buildTemplate('dev', false, custom);
      template.hasResourceProperties('AWS::IAM::Policy', {
        PolicyDocument: Match.objectLike({
          Statement: Match.arrayWith([
            Match.objectLike({ Action: 'bedrock:InvokeModel', Resource: custom }),
          ]),
        }),
      });
    });
  });
});
