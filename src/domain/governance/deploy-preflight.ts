/**
 * preflight の判定 (spec §5)。
 *
 * 副作用なし。観測は呼び出し側が集め、ここは突き合わせるだけ。
 *
 * **判定不能を PASS にしない。** `credentialSecondsRemaining` が `null`（取得失敗）なら
 * 止める。空文字や null を「問題なし」と読む実装は、塞ぐはずの穴を自分で開ける。
 */

export type PreflightObservation = {
  /** `sts:GetCallerIdentity` の Arn。 */
  readonly callerArn: string;
  readonly accountId: string;
  readonly region: string;
  /** 使用する CDK bootstrap qualifier。 */
  readonly qualifier: string;
  /** `-c env=` の値。 */
  readonly environment: string;
  /** credential の残り秒数。取得できなければ null。 */
  readonly credentialSecondsRemaining: number | null;
  readonly workingTreeClean: boolean;
  /** 現ツリーに対する品質ゲート green 記録があるか（`scripts/lib/gate-stamp.sh`）。 */
  readonly gateStampSatisfied: boolean;
  readonly negativeTestsPassed: boolean;
};

export type PreflightRequirement = {
  readonly accountId: string;
  readonly allowedRegions: ReadonlyArray<string>;
  readonly qualifier: string;
  readonly environment: string;
  /** assumed-role のロール名。**部分一致では判定しない**（`-evil` 付きを通さない）。 */
  readonly roleName: string;
  readonly minCredentialSeconds: number;
};

export const DEFAULT_PREFLIGHT_REQUIREMENT: PreflightRequirement = {
  accountId: '822063948773',
  // us-east-1 のスタックは CDK CLI が内部で扱う。CLI 自身の region は ap-northeast-1 に固定する。
  allowedRegions: ['ap-northeast-1'],
  qualifier: 'orcloud01',
  environment: 'dev',
  roleName: 'OpenReceptionClaudeDeploy-dev',
  minCredentialSeconds: 1200,
};

export type PreflightFailure = { readonly field: string; readonly detail: string };
export type PreflightVerdict = { readonly ok: boolean; readonly failures: ReadonlyArray<PreflightFailure> };

/**
 * assumed-role の ARN からロール名を取り出す。
 * 形式: `arn:aws:sts::<account>:assumed-role/<RoleName>/<SessionName>`
 */
function assumedRoleName(arn: string): string | null {
  const m = /^arn:aws:sts::\d{12}:assumed-role\/([^/]+)\/.+$/.exec(arn);
  return m?.[1] ?? null;
}

export function evaluatePreflight(
  observed: PreflightObservation,
  required: PreflightRequirement,
): PreflightVerdict {
  const failures: PreflightFailure[] = [];
  const fail = (field: string, detail: string) => failures.push({ field, detail });

  const role = assumedRoleName(observed.callerArn);
  if (role !== required.roleName) {
    fail('callerArn', `caller=${observed.callerArn} 期待するロール=${required.roleName}`);
  }
  if (observed.accountId !== required.accountId) {
    fail('accountId', `account=${observed.accountId} 期待=${required.accountId}`);
  }
  if (!required.allowedRegions.includes(observed.region)) {
    fail('region', `region=${observed.region} 期待=${required.allowedRegions.join(',')}`);
  }
  if (observed.qualifier !== required.qualifier) {
    fail('qualifier', `qualifier=${observed.qualifier} 期待=${required.qualifier}`);
  }
  if (observed.environment !== required.environment) {
    fail('environment', `env=${observed.environment} 期待=${required.environment}`);
  }
  // 🔴 **`=== null` ではなく `== null` で null と undefined の両方を拾う。**
  // 型定義上 `credentialSecondsRemaining` は `number | null` で `undefined` は無いはずだが、
  // 呼び出し側（`scripts/aws-preflight.ts`）は `JSON.parse` の結果を `as PreflightObservation`
  // で キャストしているだけで実行時の形は保証されない。フィールドが丸ごと欠落した JSON では
  // 実行時の値は `undefined` になる。厳密等価 `=== null` だとこれを素通りさせてしまい、
  // 次の分岐で `undefined < required.minCredentialSeconds` が（NaN 比較と同様に）常に
  // `false` になるため、**判定不能なのに failure が 1 件も記録されない**（Important 4）。
  // ここは意図的に緩い等価（`== null`）を使う。
  if (observed.credentialSecondsRemaining == null) {
    fail('credentialSecondsRemaining', 'credential の残時間を取得できませんでした（判定不能）');
  } else if (observed.credentialSecondsRemaining < required.minCredentialSeconds) {
    fail(
      'credentialSecondsRemaining',
      `残り ${observed.credentialSecondsRemaining}s < 必要 ${required.minCredentialSeconds}s`,
    );
  }
  if (!observed.workingTreeClean) fail('workingTreeClean', '作業ツリーに未コミットの変更があります');
  if (!observed.gateStampSatisfied) {
    fail('gateStampSatisfied', '現ツリーに対する品質ゲート green の記録がありません');
  }
  if (!observed.negativeTestsPassed) fail('negativeTestsPassed', 'negative security test が未通過です');

  return { ok: failures.length === 0, failures };
}
