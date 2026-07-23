import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * RealtimeRuntimeStack Reconciler Lambda ハンドラの単体テスト (issue #366 W2 残)。
 *
 * `infra/lambda/realtime-reconciler/handler.ts` は `@aws-sdk/client-*` を実 AWS 呼び出しへ
 * `new XxxClient({}).send(...)` する薄いオーケストレーションのため、SDK client の `send` を
 * `vi.mock('@aws-sdk/client-*')` で差し替えてユニットテストする（`aws-cdk-lib` 同様
 * `aws-sdk-client-mock` は依存追加になるため使わない）。
 *
 * ハンドラは環境変数（`ASG_NAME` 等）をモジュール top-level で読むため、`vi.resetModules()` +
 * `process.env` 設定 + `await import('../lambda/realtime-reconciler/handler')` の順で
 * テストごとに新規モジュールインスタンスを作る（`src/lib/voice-transport/token.test.ts` と
 * 同じ流儀）。
 */

const asgSend = vi.fn();
const ec2Send = vi.fn();
const route53Send = vi.fn();
const ssmSend = vi.fn();

/** テスト用の Command スタブ。`new XxxCommand(input)` を模し、`__cmd`/`input` で判別する。 */
function fakeCommandClass(cmd: string) {
  return class {
    __cmd = cmd;
    input: unknown;
    constructor(input: unknown) {
      this.input = input;
    }
  };
}

vi.mock('@aws-sdk/client-auto-scaling', () => ({
  AutoScalingClient: class {
    send = asgSend;
  },
  DescribeAutoScalingGroupsCommand: fakeCommandClass('DescribeAutoScalingGroups'),
  SetDesiredCapacityCommand: fakeCommandClass('SetDesiredCapacity'),
}));
vi.mock('@aws-sdk/client-ec2', () => ({
  EC2Client: class {
    send = ec2Send;
  },
  DescribeInstancesCommand: fakeCommandClass('DescribeInstances'),
}));
vi.mock('@aws-sdk/client-route-53', () => ({
  Route53Client: class {
    send = route53Send;
  },
  ChangeResourceRecordSetsCommand: fakeCommandClass('ChangeResourceRecordSets'),
}));
vi.mock('@aws-sdk/client-ssm', () => ({
  SSMClient: class {
    send = ssmSend;
  },
  GetParameterCommand: fakeCommandClass('GetParameter'),
}));

const ENV_KEYS = ['ASG_NAME', 'START_HOUR', 'STOP_HOUR', 'FORCE_STOP_PARAM', 'HOSTED_ZONE_ID', 'RECORD_NAME'];

function clearEnv() {
  for (const k of ENV_KEYS) delete process.env[k];
}

/** 開始/終了時刻の内側になる基準時刻（09:00 JST = 00:00 UTC、既定 START_HOUR=8/STOP_HOUR=23）。 */
const WITHIN_HOURS_UTC = new Date('2026-07-23T00:00:00.000Z');

async function loadHandler() {
  vi.resetModules();
  return import('../lambda/realtime-reconciler/handler');
}

beforeEach(() => {
  vi.useFakeTimers();
  vi.setSystemTime(WITHIN_HOURS_UTC);
  asgSend.mockReset();
  ec2Send.mockReset();
  route53Send.mockReset();
  ssmSend.mockReset();
  clearEnv();
  process.env.ASG_NAME = 'test-asg';
});

afterEach(() => {
  vi.useRealTimers();
  clearEnv();
});

describe('handler (#366 W2 残: Reconciler Lambda 分岐カバレッジ)', () => {
  it('force-stop=true のときは営業時間内でも DesiredCapacity=0 を SetDesiredCapacity する', async () => {
    process.env.FORCE_STOP_PARAM = '/open-reception-dev/realtime/force-stop';
    ssmSend.mockResolvedValue({ Parameter: { Value: 'true' } });
    asgSend.mockImplementation((cmd: { __cmd: string }) => {
      if (cmd.__cmd === 'DescribeAutoScalingGroups') {
        return Promise.resolve({ AutoScalingGroups: [{ DesiredCapacity: 1, Instances: [] }] });
      }
      return Promise.resolve({});
    });

    const { handler } = await loadHandler();
    await handler();

    expect(ssmSend).toHaveBeenCalledTimes(1);
    const setCall = asgSend.mock.calls.find(([cmd]) => cmd.__cmd === 'SetDesiredCapacity');
    expect(setCall).toBeDefined();
    expect(setCall![0].input).toEqual(
      expect.objectContaining({ AutoScalingGroupName: 'test-asg', DesiredCapacity: 0 }),
    );
  });

  it('force-stop パラメータが ParameterNotFound（未作成）ならスケジュール通りの desired を使う', async () => {
    // FORCE_STOP_PARAM を設定しつつ ParameterNotFound を返す（kill-switch 未設定 = スケジュール通り）。
    process.env.FORCE_STOP_PARAM = '/open-reception-dev/realtime/force-stop';
    const notFound = Object.assign(new Error('not found'), { name: 'ParameterNotFound' });
    ssmSend.mockRejectedValue(notFound);
    asgSend.mockImplementation((cmd: { __cmd: string }) => {
      if (cmd.__cmd === 'DescribeAutoScalingGroups') {
        return Promise.resolve({ AutoScalingGroups: [{ DesiredCapacity: 0, Instances: [] }] });
      }
      return Promise.resolve({});
    });

    const { handler } = await loadHandler();
    await handler();

    // WITHIN_HOURS_UTC は営業時間内（既定 START_HOUR=8/STOP_HOUR=23, JST 09:00）なので desired=1。
    const setCall = asgSend.mock.calls.find(([cmd]) => cmd.__cmd === 'SetDesiredCapacity');
    expect(setCall).toBeDefined();
    expect(setCall![0].input).toEqual(
      expect.objectContaining({ AutoScalingGroupName: 'test-asg', DesiredCapacity: 1 }),
    );
  });

  it('force-stop パラメータ読み取りが ParameterNotFound 以外のエラーなら throw する（fail-open にしない）', async () => {
    process.env.FORCE_STOP_PARAM = '/open-reception-dev/realtime/force-stop';
    ssmSend.mockRejectedValue(new Error('AccessDenied'));

    const { handler } = await loadHandler();
    await expect(handler()).rejects.toThrow('AccessDenied');
    expect(asgSend).not.toHaveBeenCalled();
  });

  it('現在の DesiredCapacity が目標と一致するときは SetDesiredCapacity を呼ばない', async () => {
    // FORCE_STOP_PARAM 未設定 → isForceStopped は false 固定。営業時間内で desired=1、
    // 現在値も 1 なら SetDesiredCapacity は呼ばれない。
    asgSend.mockImplementation((cmd: { __cmd: string }) => {
      if (cmd.__cmd === 'DescribeAutoScalingGroups') {
        return Promise.resolve({ AutoScalingGroups: [{ DesiredCapacity: 1, Instances: [] }] });
      }
      return Promise.resolve({});
    });

    const { handler } = await loadHandler();
    await handler();

    expect(ssmSend).not.toHaveBeenCalled();
    const setCall = asgSend.mock.calls.find(([cmd]) => cmd.__cmd === 'SetDesiredCapacity');
    expect(setCall).toBeUndefined();
  });

  it('DesiredCapacity が不一致のときのみ SetDesiredCapacity を呼ぶ（0→1 へ変更）', async () => {
    asgSend.mockImplementation((cmd: { __cmd: string }) => {
      if (cmd.__cmd === 'DescribeAutoScalingGroups') {
        return Promise.resolve({ AutoScalingGroups: [{ DesiredCapacity: 0, Instances: [] }] });
      }
      return Promise.resolve({});
    });

    const { handler } = await loadHandler();
    await handler();

    const setCall = asgSend.mock.calls.find(([cmd]) => cmd.__cmd === 'SetDesiredCapacity');
    expect(setCall).toBeDefined();
    expect(setCall![0].input).toEqual(
      expect.objectContaining({ AutoScalingGroupName: 'test-asg', DesiredCapacity: 1 }),
    );
  });

  it('InService instance の Public IP を Route53 UPSERT する（dns 設定あり・desired=1）', async () => {
    process.env.HOSTED_ZONE_ID = 'Z1234567890ABC';
    process.env.RECORD_NAME = 'realtime.dev.example.com';
    asgSend.mockImplementation((cmd: { __cmd: string }) => {
      if (cmd.__cmd === 'DescribeAutoScalingGroups') {
        return Promise.resolve({
          AutoScalingGroups: [
            {
              DesiredCapacity: 1,
              Instances: [
                { InstanceId: 'i-pending', LifecycleState: 'Pending' },
                { InstanceId: 'i-inservice', LifecycleState: 'InService' },
              ],
            },
          ],
        });
      }
      return Promise.resolve({});
    });
    ec2Send.mockResolvedValue({
      Reservations: [{ Instances: [{ PublicIpAddress: '203.0.113.10' }] }],
    });
    route53Send.mockResolvedValue({});

    const { handler } = await loadHandler();
    await handler();

    expect(ec2Send).toHaveBeenCalledTimes(1);
    expect(ec2Send.mock.calls[0]![0].input).toEqual(
      expect.objectContaining({ InstanceIds: ['i-inservice'] }),
    );
    expect(route53Send).toHaveBeenCalledTimes(1);
    const changeInput = route53Send.mock.calls[0]![0].input as {
      HostedZoneId: string;
      ChangeBatch: { Changes: unknown[] };
    };
    expect(changeInput.HostedZoneId).toBe('Z1234567890ABC');
    expect(changeInput.ChangeBatch.Changes[0]).toEqual(
      expect.objectContaining({
        Action: 'UPSERT',
        ResourceRecordSet: expect.objectContaining({
          Name: 'realtime.dev.example.com',
          Type: 'A',
          ResourceRecords: [{ Value: '203.0.113.10' }],
        }),
      }),
    );
  });

  it('dns 設定が無ければ InService instance があっても Route53 を呼ばない', async () => {
    asgSend.mockImplementation((cmd: { __cmd: string }) => {
      if (cmd.__cmd === 'DescribeAutoScalingGroups') {
        return Promise.resolve({
          AutoScalingGroups: [
            { DesiredCapacity: 1, Instances: [{ InstanceId: 'i-inservice', LifecycleState: 'InService' }] },
          ],
        });
      }
      return Promise.resolve({});
    });

    const { handler } = await loadHandler();
    await handler();

    expect(ec2Send).not.toHaveBeenCalled();
    expect(route53Send).not.toHaveBeenCalled();
  });

  it('ASG_NAME 未設定なら早期に throw する', async () => {
    delete process.env.ASG_NAME;
    const { handler } = await loadHandler();
    await expect(handler()).rejects.toThrow('ASG_NAME environment variable is required');
    expect(asgSend).not.toHaveBeenCalled();
  });
});
