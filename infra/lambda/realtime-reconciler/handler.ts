/**
 * RealtimeRuntimeStack Reconciler Lambda (issue #366 Phase 0, `docs/adr/0003-*.md`)。
 *
 * EventBridge により 1 分毎に起動され、以下を行う:
 *   1. 営業時間ポリシー（現状は環境変数の固定時刻。DynamoDB 連携は #367 統合待ちの後続 increment）
 *      と force-stop kill-switch（SSM Parameter）から目標 DesiredCapacity(0|1) を決定する。
 *   2. ASG の現在の DesiredCapacity と異なれば SetDesiredCapacity を呼ぶ。
 *   3. スケールアウトが InService になっていれば、その EC2 の Public IPv4 を Route 53 A レコードへ
 *      UPSERT する（動的 Public IPv4 + Route 53, ADR-004）。dns 設定が無い場合はスキップする。
 *
 * **本 increment のスコープ外（follow-up）**:
 *   - drain（進行中セッションを待ってから停止）はアプリ層 `/health/live` `/health/ready` `/drain`
 *     API が無いと実装できない（アプリ本体は別 issue/track）。現状は即時 SetDesiredCapacity(0) のみ。
 *   - 営業時間の DynamoDB 化（#367 ServiceOperatingPolicy 連携）。
 *
 * NodejsFunction(esbuild) でバンドルする。`@aws-sdk/*` は Lambda Node.js ランタイム同梱のため
 * externalModules 指定でバンドル対象から除外する（`infra/lib/constructs/realtime-reconciler-function.ts`
 * 参照）。型検査は infra/tsconfig.json の include(`lambda/**`)で行い、`@aws-sdk/client-*` は
 * infra devDependencies（#105 チェック済み・THIRD_PARTY_NOTICES.md 記載）を型定義に使う。
 */
import {
  AutoScalingClient,
  DescribeAutoScalingGroupsCommand,
  SetDesiredCapacityCommand,
} from '@aws-sdk/client-auto-scaling';
import { EC2Client, DescribeInstancesCommand } from '@aws-sdk/client-ec2';
import { ChangeResourceRecordSetsCommand, Route53Client } from '@aws-sdk/client-route-53';
import { GetParameterCommand, SSMClient } from '@aws-sdk/client-ssm';
import { desiredCapacityFor } from '../../lib/config/realtime-schedule';

const autoscaling = new AutoScalingClient({});
const ec2 = new EC2Client({});
const route53 = new Route53Client({});
const ssm = new SSMClient({});

const ASG_NAME = process.env.ASG_NAME ?? '';
const START_HOUR = Number(process.env.START_HOUR ?? '8');
const STOP_HOUR = Number(process.env.STOP_HOUR ?? '23');
// SSM String Parameter 名（未設定なら kill-switch を使わない）。
const FORCE_STOP_PARAM = process.env.FORCE_STOP_PARAM;
// Route 53 DNS 更新（両方揃っている場合のみ実施）。
const HOSTED_ZONE_ID = process.env.HOSTED_ZONE_ID;
const RECORD_NAME = process.env.RECORD_NAME;

export async function handler(): Promise<void> {
  if (!ASG_NAME) {
    throw new Error('ASG_NAME environment variable is required');
  }

  const forceStop = await isForceStopped();
  const desired = forceStop
    ? 0
    : desiredCapacityFor(new Date(), { timezone: 'Asia/Tokyo', startHour: START_HOUR, stopHour: STOP_HOUR });

  const groups = await autoscaling.send(
    new DescribeAutoScalingGroupsCommand({ AutoScalingGroupNames: [ASG_NAME] }),
  );
  const group = groups.AutoScalingGroups?.[0];
  const currentDesired = group?.DesiredCapacity ?? 0;

  if (currentDesired !== desired) {
    await autoscaling.send(
      new SetDesiredCapacityCommand({
        AutoScalingGroupName: ASG_NAME,
        DesiredCapacity: desired,
        HonorCooldown: false,
      }),
    );
  }

  if (desired === 1 && HOSTED_ZONE_ID && RECORD_NAME) {
    await reconcileDns(group?.Instances ?? []);
  }
}

async function isForceStopped(): Promise<boolean> {
  if (!FORCE_STOP_PARAM) return false;
  try {
    const res = await ssm.send(new GetParameterCommand({ Name: FORCE_STOP_PARAM }));
    // 書込側は AllowedPattern ^(true|false)$ で拘束するが、手動更新の揺れ（空白/大文字）にも
    // 頑健にしておく（"TRUE " 等を silent no-op にしない）。
    return res.Parameter?.Value?.trim().toLowerCase() === 'true';
  } catch (err) {
    // 「パラメータ未作成」だけを kill-switch 未設定 = スケジュール通りとして扱う。
    // それ以外（権限・スロットリング等）の失敗を fail-open にすると、緊急停止フラグが
    // 読めない間ずっと稼働し続けてしまうため、throw して invocation を失敗させ
    // ReconcilerErrors アラームで可観測にする。
    if (err instanceof Error && err.name === 'ParameterNotFound') return false;
    throw err;
  }
}

interface AsgInstanceRef {
  InstanceId?: string;
  LifecycleState?: string;
}

async function reconcileDns(instances: AsgInstanceRef[]): Promise<void> {
  const instanceId = instances.find((i) => i.LifecycleState === 'InService')?.InstanceId;
  if (!instanceId) return;

  const described = await ec2.send(new DescribeInstancesCommand({ InstanceIds: [instanceId] }));
  const publicIp = described.Reservations?.[0]?.Instances?.[0]?.PublicIpAddress;
  if (!publicIp) return;

  await route53.send(
    new ChangeResourceRecordSetsCommand({
      HostedZoneId: HOSTED_ZONE_ID,
      ChangeBatch: {
        Changes: [
          {
            Action: 'UPSERT',
            ResourceRecordSet: {
              Name: RECORD_NAME,
              Type: 'A',
              TTL: 60,
              ResourceRecords: [{ Value: publicIp }],
            },
          },
        ],
      },
    }),
  );
}
