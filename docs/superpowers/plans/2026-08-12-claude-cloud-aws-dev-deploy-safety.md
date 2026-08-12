# Claude Cloud → AWS dev 安全デプロイ Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Claude Code on the cloud から AWS dev のみへ `preflight → verify → diff → deploy → smoke` を無人実行できる安全境界・wrapper・negative test・runbook を、**デプロイを 1 度も実行せずに**完成させる。

**Architecture:** 判定ロジックはすべて `src/domain/governance/` の純関数に置き、`scripts/aws-*.{ts,sh}` は I/O だけの薄い CLI にする（既存の `change-risk` / `merge-method` / `script-wiring` と同じ形）。IAM ポリシーは JSON としてリポジトリに置き、**構造を unit テストで固定**する。AWS への実適用は人間が runbook で行う。

**Tech Stack:** TypeScript / vitest / bash / AWS CLI v2 / AWS CDK (v2, `infra/`)

## Global Constraints

- 設計の正本は `docs/superpowers/specs/2026-08-12-claude-cloud-aws-dev-deploy-safety-design.md`。**矛盾したら spec が正**。
- **本計画では `cdk deploy` を一度も実行しない。** IAM の実作成・bootstrap も行わない（人間が runbook で実行する）。
- AWS アカウント: `822063948773` / リージョン `ap-northeast-1` + `us-east-1`。
- CDK qualifier: **`orcloud01`**（9 文字固定）。Toolkit スタック名 `CDKToolkit-orcloud01`。
- IAM 名称: boundary = `OpenReceptionClaudeBoundary` / entry role = `OpenReceptionClaudeDeploy-dev` / exec policy = `OpenReceptionClaudeCfnExec-dev`。
- 許可スタック名パターン: `OpenReception-<Stack>-dev`（正規表現 `^OpenReception-[A-Za-z0-9]+-dev$`）。
- 他プロジェクト denylist: `nodi-*` / `salon-loop-*` / `Kiaff*` / `CDKToolkit` / `CDKToolkit-staging` / `cdk-hnb659fds-*` / `cdk-staging-*`。
- **スクリプトは `scripts/` 直下にフラットに置く**（`scripts/aws/` はサブディレクトリのため `check-script-wiring.ts` の走査対象外になる）。
- コミットは Conventional Commits（日本語可）、本文末尾に `#<issue>` 参照。
- **テストは必ず変異させて赤を確認してから green にする。** 通って当然のテストを書かない。
- 内側ループは `npx vitest run <path>`（全体 `npm test` は約 95 秒）。
- `sed` / `find` / `grep` はエイリアスされているため、スクリプト内では `/usr/bin/sed` 等か `command sed` を使う。
- 秘密の値を **log / docs / git / artifact のいずれにも書かない**。

---

### Task 0: Issue を先に立てる

**Files:** なし（GitHub 上の操作）

以降の全コミットが `#<issue>` を参照するため、**最初に採番する**（後から履歴を書き換えない）。

- [ ] **Step 1: 既存 Issue との重複を確認する**

クラウドセッションでは `gh issue list` が GraphQL 403 になりうるため REST を使う:

```bash
gh api 'repos/20m61/open-reception/issues?state=open&per_page=100' \
  --jq '.[] | select(.pull_request == null) | "\(.number)\t\(.title)"'
```

関連する既存 Issue: **#675**（Cloud Execution Adapter）/ **#388**（隔離環境の自律開発
パイプライン）/ **#392**（AWS 自律実行基盤の責務境界）/ **#195**（Notification/Monitoring
デプロイ）。**新規に立てて、これらから参照する**（統合はしない。粒度が違う）。

- [ ] **Step 2: Issue を作る**

タイトル: `[Infra/Security] Claude Code on the cloud から AWS dev へ安全にデプロイする境界を作る`

本文に含めるもの:
- spec `docs/superpowers/specs/2026-08-12-claude-cloud-aws-dev-deploy-safety-design.md` へのリンク
- plan `docs/superpowers/plans/2026-08-12-claude-cloud-aws-dev-deploy-safety.md` へのリンク
- 受け入れ条件（spec §15 の Definition of Done）
- 関連 Issue `#675` / `#388` / `#392` / `#195`
- **本 Issue では `cdk deploy` を実行しない**旨

- [ ] **Step 3: 採番した番号を控える**

以降のコミットメッセージの `#<issue>` をこの番号に置き換える。

---

### Task 1: change set の危険判定（純関数）

**Files:**
- Create: `src/domain/governance/deploy-diff-gate.ts`
- Create: `src/domain/governance/deploy-diff-gate.test.ts`

**Interfaces:**
- Consumes: なし（この計画の最初のタスク）
- Produces: `evaluateDeployChangeSet(summary: ChangeSetSummary): DeployGateVerdict`、型 `ChangeSetSummary` / `ChangeSetResourceChange` / `DeployGateVerdict` / `DeployBlockReason` / `DeployFlagReason`、定数 `ALLOWED_STACK_PATTERN`

- [ ] **Step 1: 失敗するテストを書く**

`src/domain/governance/deploy-diff-gate.test.ts`:

```ts
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
```

- [ ] **Step 2: テストが失敗することを確認**

Run: `npx vitest run src/domain/governance/deploy-diff-gate.test.ts`
Expected: FAIL — `Failed to resolve import "./deploy-diff-gate"`

- [ ] **Step 3: 最小実装を書く**

`src/domain/governance/deploy-diff-gate.ts`:

```ts
/**
 * CloudFormation change set の危険判定 (spec §6)。
 *
 * 設計原則:
 *  - 副作用なし。`describe-change-set` の JSON から抜いた最小の形を**受け取る**だけで、
 *    自分で AWS を叩かない（呼び出し側が渡す。純関数のままテストできる）。
 *  - `cdk diff` のテキストを parse しない。取りこぼす。
 *
 * **止める側と記録だけの側を分けてある。** 一律停止にすると gate が恒常的に赤くなり、
 * 赤を無視する習慣がつく方が危険（`change-risk.ts` が report-only である理由と同じ）。
 * IAM Role / Policy の Add・Modify を止めないのは、exec role が作る Role に
 * Permissions Boundary が強制されるため（spec §4.2 層 4）。**差分レビューより強い保証**。
 */

/** 自動デプロイを止める理由。 */
export const DEPLOY_BLOCK_REASONS = [
  'unexpectedStack',
  'resourceRemoval',
  'unknownAction',
  'resourceReplacement',
  'kmsChange',
  'secretsChange',
  'dnsOrCertificateChange',
  'networkBoundaryChange',
  'iamPrincipalChange',
] as const;
export type DeployBlockReason = (typeof DEPLOY_BLOCK_REASONS)[number];

/** 止めないが記録する理由。 */
export const DEPLOY_FLAG_REASONS = ['iamPolicyChange'] as const;
export type DeployFlagReason = (typeof DEPLOY_FLAG_REASONS)[number];

/** `describe-change-set` の `Changes[].ResourceChange` から必要な項目だけ。 */
export type ChangeSetResourceChange = {
  /**
   * CloudFormation の変更操作。'Add' と 'Modify' だけが既知で安全。
   * 'Remove', 'Import', 'Dynamic' や将来の値は gate で止める（保守的に扱う）。
   * 既知の無害は Add と Modify のみ。他は詳細が判明するまで deploy を許可しない。
   */
  readonly action: string;
  readonly resourceType: string;
  readonly logicalResourceId: string;
  /** 'True' | 'False' | 'Conditional'。Modify のときのみ現れる。 */
  readonly replacement?: string;
};

export type ChangeSetSummary = {
  readonly stackName: string;
  readonly changes: ReadonlyArray<ChangeSetResourceChange>;
};

export type DeployBlock = { readonly reason: DeployBlockReason; readonly evidence: string };
export type DeployFlag = { readonly reason: DeployFlagReason; readonly evidence: string };

export type DeployGateVerdict = {
  readonly blocked: boolean;
  readonly blocks: ReadonlyArray<DeployBlock>;
  readonly flags: ReadonlyArray<DeployFlag>;
};

/**
 * 許可するスタック名。`bin/open-reception.ts` が `OpenReception-<Stack>-<env>` を
 * 決定論的に付ける。**末尾を固定する**（`-dev-extra` を通さない）。
 */
export const ALLOWED_STACK_PATTERN = /^OpenReception-[A-Za-z0-9]+-dev$/;

/** dev スタックが作る正当な理由が無い IAM プリンシパル。 */
const IAM_PRINCIPAL_TYPES = new Set([
  'AWS::IAM::User',
  'AWS::IAM::AccessKey',
  'AWS::IAM::Group',
  'AWS::IAM::UserToGroupAddition',
]);

/** 種別だけで止めるもの（Add でも止める。dev に存在しないため出現自体が想定外）。 */
const BLOCKED_TYPE_PREFIXES: ReadonlyArray<[string, DeployBlockReason]> = [
  ['AWS::KMS::', 'kmsChange'],
  ['AWS::SecretsManager::', 'secretsChange'],
  ['AWS::Route53::', 'dnsOrCertificateChange'],
  ['AWS::CertificateManager::', 'dnsOrCertificateChange'],
  ['AWS::EC2::SecurityGroup', 'networkBoundaryChange'],
];

/**
 * deploy で許可する action。これら以外（Remove, Import, Dynamic, 未知の値）は
 * 詳細が判明するまで保守的に stop する。
 *  - 'Add': リソース新規作成。仕様が明確。
 *  - 'Modify': リソース更新。replacement フィールドで置き換え判定。
 */
const SAFE_ACTIONS = new Set(['Add', 'Modify']);

const describeChange = (c: ChangeSetResourceChange): string =>
  `${c.logicalResourceId} (${c.resourceType}) action=${c.action} replacement=${c.replacement ?? '-'}`;

/**
 * 停止条件は 1 行で移せるようにしておく（spec §6 の注記）。
 * 「IAM Role/Policy の Add・Modify も止める」に変えたい場合はここを触る。
 */
export function evaluateDeployChangeSet(summary: ChangeSetSummary): DeployGateVerdict {
  const blocks: DeployBlock[] = [];
  const flags: DeployFlag[] = [];

  if (!ALLOWED_STACK_PATTERN.test(summary.stackName)) {
    blocks.push({
      reason: 'unexpectedStack',
      evidence: `stack=${summary.stackName} は ${ALLOWED_STACK_PATTERN.source} に一致しません`,
    });
  }

  for (const c of summary.changes) {
    const evidence = describeChange(c);

    if (c.action === 'Remove') {
      blocks.push({ reason: 'resourceRemoval', evidence });
    }
    // Remove 以外で安全でない action（Import, Dynamic, 未知の値）は止める。
    // Add と Modify だけが既知で安全。
    if (!SAFE_ACTIONS.has(c.action) && c.action !== 'Remove') {
      blocks.push({ reason: 'unknownAction', evidence });
    }
    // 'Conditional' は実行時条件で決まる＝安全だと証明できないので止める側に倒す。
    if (c.replacement === 'True' || c.replacement === 'Conditional') {
      blocks.push({ reason: 'resourceReplacement', evidence });
    }
    for (const [prefix, reason] of BLOCKED_TYPE_PREFIXES) {
      if (c.resourceType.startsWith(prefix)) blocks.push({ reason, evidence });
    }
    if (IAM_PRINCIPAL_TYPES.has(c.resourceType)) {
      blocks.push({ reason: 'iamPrincipalChange', evidence });
    }
    if (c.resourceType.startsWith('AWS::IAM::') && !IAM_PRINCIPAL_TYPES.has(c.resourceType)) {
      flags.push({ reason: 'iamPolicyChange', evidence });
    }
  }

  return { blocked: blocks.length > 0, blocks, flags };
}
```

- [ ] **Step 4: テストが通ることを確認**

Run: `npx vitest run src/domain/governance/deploy-diff-gate.test.ts`
Expected: PASS（全ケース）

- [ ] **Step 5: 変異させてテストが実際に効いていることを確認**

`evaluateDeployChangeSet` の `if (c.replacement === 'True' || c.replacement === 'Conditional')` から `|| c.replacement === 'Conditional'` を一時的に削除して実行する。

Run: `npx vitest run src/domain/governance/deploy-diff-gate.test.ts`
Expected: FAIL —「Replacement Conditional も止める」が落ちる。確認したら元に戻す。

- [ ] **Step 6: typecheck を通す**

Run: `npm run typecheck`
Expected: エラーなし（**vitest は型検査をしない**。ここで単体で通す）

- [ ] **Step 7: コミット**

```bash
git add src/domain/governance/deploy-diff-gate.ts src/domain/governance/deploy-diff-gate.test.ts
git commit -m "feat(governance): change set の危険判定を純関数として追加 (#<issue>)"
```

---

### Task 2: preflight 判定（純関数）

**Files:**
- Create: `src/domain/governance/deploy-preflight.ts`
- Create: `src/domain/governance/deploy-preflight.test.ts`

**Interfaces:**
- Consumes: Task 1 の `ALLOWED_STACK_PATTERN` は使わない（preflight は環境の検査、Task 1 は差分の検査で関心が別）
- Produces: `evaluatePreflight(observed: PreflightObservation, requirement: PreflightRequirement): PreflightVerdict`、型 `PreflightObservation` / `PreflightRequirement` / `PreflightVerdict` / `PreflightFailure`

- [ ] **Step 1: 失敗するテストを書く**

`src/domain/governance/deploy-preflight.test.ts`:

```ts
/**
 * preflight の判定 (spec §5)。
 *
 * **1 つでも不一致なら止める。** 環境判定ミス（脅威 T13）はここでしか捕まらない。
 * 観測は呼び出し側（`scripts/aws-cloud-deploy.sh`）が集め、判定はここが行う。
 */
import { describe, expect, it } from 'vitest';
import {
  DEFAULT_PREFLIGHT_REQUIREMENT,
  evaluatePreflight,
  type PreflightObservation,
} from './deploy-preflight';

const ok = (over: Partial<PreflightObservation> = {}): PreflightObservation => ({
  callerArn: 'arn:aws:sts::822063948773:assumed-role/OpenReceptionClaudeDeploy-dev/cloud-session',
  accountId: '822063948773',
  region: 'ap-northeast-1',
  qualifier: 'orcloud01',
  environment: 'dev',
  credentialSecondsRemaining: 3600,
  workingTreeClean: true,
  gateStampSatisfied: true,
  negativeTestsPassed: true,
  ...over,
});

describe('全部そろえば通る', () => {
  it('deploy まで許可される', () => {
    const verdict = evaluatePreflight(ok(), DEFAULT_PREFLIGHT_REQUIREMENT);
    expect(verdict.ok).toBe(true);
    expect(verdict.failures).toEqual([]);
  });
});

describe('1 つでも不一致なら止める', () => {
  it.each<[string, Partial<PreflightObservation>, string]>([
    ['別アカウント', { accountId: '111122223333' }, 'accountId'],
    ['別リージョン', { region: 'us-west-2' }, 'region'],
    ['既定 qualifier', { qualifier: 'hnb659fds' }, 'qualifier'],
    ['staging 環境', { environment: 'staging' }, 'environment'],
    ['prod 環境', { environment: 'prod' }, 'environment'],
    [
      '別ロール（人間の CDK user）',
      { callerArn: 'arn:aws:iam::822063948773:user/CDK' },
      'callerArn',
    ],
    [
      '似た名前のロール（部分一致で通さない）',
      {
        callerArn:
          'arn:aws:sts::822063948773:assumed-role/OpenReceptionClaudeDeploy-dev-evil/x',
      },
      'callerArn',
    ],
    ['作業ツリーが dirty', { workingTreeClean: false }, 'workingTreeClean'],
    ['ゲート未実行', { gateStampSatisfied: false }, 'gateStampSatisfied'],
    ['negative test 未通過', { negativeTestsPassed: false }, 'negativeTestsPassed'],
    ['credential 残り 5 分', { credentialSecondsRemaining: 300 }, 'credentialSecondsRemaining'],
  ])('%s', (_name, over, field) => {
    const verdict = evaluatePreflight(ok(over), DEFAULT_PREFLIGHT_REQUIREMENT);
    expect(verdict.ok).toBe(false);
    expect(verdict.failures.map((f) => f.field)).toContain(field);
  });

  it('複数の不一致をすべて報告する（最初の 1 件で打ち切らない）', () => {
    const verdict = evaluatePreflight(
      ok({ accountId: '111122223333', region: 'us-west-2' }),
      DEFAULT_PREFLIGHT_REQUIREMENT,
    );
    expect(verdict.failures.map((f) => f.field).sort()).toEqual(['accountId', 'region']);
  });

  it('不一致の根拠に観測値と期待値が載る', () => {
    const verdict = evaluatePreflight(ok({ accountId: '111122223333' }), DEFAULT_PREFLIGHT_REQUIREMENT);
    const detail = verdict.failures[0]!.detail;
    expect(detail).toContain('111122223333');
    expect(detail).toContain('822063948773');
  });
});

describe('credential 残時間の閾値は用途で変わる', () => {
  it('残り 25 分は diff には足りるが deploy には足りない', () => {
    expect(
      evaluatePreflight(ok({ credentialSecondsRemaining: 1500 }), {
        ...DEFAULT_PREFLIGHT_REQUIREMENT,
        minCredentialSeconds: 1200,
      }).ok,
    ).toBe(true);
    expect(
      evaluatePreflight(ok({ credentialSecondsRemaining: 1500 }), {
        ...DEFAULT_PREFLIGHT_REQUIREMENT,
        minCredentialSeconds: 2400,
      }).ok,
    ).toBe(false);
  });
});

describe('観測できていない値を PASS にしない', () => {
  it('credential 残時間が null なら止める（判定不能を通さない）', () => {
    const verdict = evaluatePreflight(
      ok({ credentialSecondsRemaining: null }),
      DEFAULT_PREFLIGHT_REQUIREMENT,
    );
    expect(verdict.ok).toBe(false);
    expect(verdict.failures.map((f) => f.field)).toContain('credentialSecondsRemaining');
  });
});
```

- [ ] **Step 2: テストが失敗することを確認**

Run: `npx vitest run src/domain/governance/deploy-preflight.test.ts`
Expected: FAIL — `Failed to resolve import "./deploy-preflight"`

- [ ] **Step 3: 最小実装を書く**

`src/domain/governance/deploy-preflight.ts`:

```ts
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
  if (observed.credentialSecondsRemaining === null) {
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
```

- [ ] **Step 4: テストが通ることを確認**

Run: `npx vitest run src/domain/governance/deploy-preflight.test.ts`
Expected: PASS

- [ ] **Step 5: 変異させて確認**

`assumedRoleName` の比較を `role !== required.roleName` から `!observed.callerArn.includes(required.roleName)` へ一時変更する。

Run: `npx vitest run src/domain/governance/deploy-preflight.test.ts`
Expected: FAIL —「似た名前のロール（部分一致で通さない）」が落ちる。確認したら元に戻す。

- [ ] **Step 6: typecheck**

Run: `npm run typecheck`
Expected: エラーなし

- [ ] **Step 7: コミット**

```bash
git add src/domain/governance/deploy-preflight.ts src/domain/governance/deploy-preflight.test.ts
git commit -m "feat(governance): デプロイ preflight の判定を純関数として追加 (#<issue>)"
```

---

### Task 3: IAM ポリシー JSON と構造検証

**Files:**
- Create: `scripts/aws-policies/claude-boundary.json`（層 4）
- Create: `scripts/aws-policies/claude-deploy-entry.json`（entry role の権限）
- Create: `scripts/aws-policies/claude-deploy-entry-trust.json`（entry role の信頼ポリシー）
- Create: `scripts/aws-policies/claude-cfn-exec.json`（層 2・3）
- Create: `scripts/aws-policies/claude-deploy-role-restriction.json`（**層 1・主境界**）
- Create: `src/domain/governance/aws-policy-shape.ts`
- Create: `src/domain/governance/aws-policy-shape.test.ts`

**Interfaces:**
- Consumes: なし
- Produces: `auditPolicyDocument(doc: PolicyDocument): PolicyAudit`、型 `PolicyDocument` / `PolicyStatement` / `PolicyAudit`

**なぜテストするのか:** ポリシー JSON は「読んで安全そう」で終わらせない（spec §9）。ここでは
**AWS へ接続せずに固定できる性質**（他プロジェクトへの Deny が入っているか、boundary 条件の
無い `iam:CreateRole` が Allow されていないか、`Resource: "*"` の Allow に `Action: "*"` が
付いていないか）を機械で押さえる。実際の評価は Task 5 の `SimulatePrincipalPolicy` が担う。

- [ ] **Step 1: 失敗するテストを書く**

`src/domain/governance/aws-policy-shape.test.ts`:

```ts
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

  it('Action / Resource が配列でも文字列でも同じに扱う', () => {
    const audit = auditPolicyDocument({
      Version: '2012-10-17',
      Statement: [{ Effect: 'Deny', Action: ['s3:*'], Resource: ['arn:aws:s3:::nodi-*'] }],
    });
    expect(audit.deniedResourcePatterns).toContain('arn:aws:s3:::nodi-*');
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
```

- [ ] **Step 2: テストが失敗することを確認**

Run: `npx vitest run src/domain/governance/aws-policy-shape.test.ts`
Expected: FAIL — `Failed to resolve import "./aws-policy-shape"`

- [ ] **Step 3: `aws-policy-shape.ts` を実装する**

```ts
/**
 * IAM ポリシー JSON の構造検証 (spec §11)。
 *
 * 副作用なし。**これは網であって証明ではない** — 「書き忘れ」と「明らかな穴」を
 * 機械で押さえるだけで、実際に DENY されるかは `SimulatePrincipalPolicy` が確かめる
 * （`scripts/aws-negative-tests.ts`）。両方揃って初めて spec §9 を満たす。
 */

export type PolicyStatement = {
  readonly Effect: 'Allow' | 'Deny';
  readonly Action?: string | ReadonlyArray<string>;
  readonly NotAction?: string | ReadonlyArray<string>;
  readonly Resource?: string | ReadonlyArray<string>;
  readonly Principal?: unknown;
  readonly Condition?: Record<string, Record<string, string | ReadonlyArray<string>>>;
};

export type PolicyDocument = {
  readonly Version: string;
  readonly Statement: ReadonlyArray<PolicyStatement>;
};

export type PolicyAudit = {
  /** Allow かつ Action:* かつ Resource:* を含むか。 */
  readonly grantsAdmin: boolean;
  /** PermissionsBoundary 条件の無い `iam:CreateRole` の Allow を含むか。 */
  readonly unboundedRoleCreation: boolean;
  readonly deniedActions: ReadonlyArray<string>;
  readonly deniedResourcePatterns: ReadonlyArray<string>;
  readonly allowedResourcePatterns: ReadonlyArray<string>;
};

const list = (v: string | ReadonlyArray<string> | undefined): ReadonlyArray<string> =>
  v === undefined ? [] : typeof v === 'string' ? [v] : v;

/** `iam:PermissionsBoundary` 条件が付いているか。キー名は大小差を吸収する。 */
function hasBoundaryCondition(s: PolicyStatement): boolean {
  if (s.Condition === undefined) return false;
  for (const values of Object.values(s.Condition)) {
    for (const key of Object.keys(values)) {
      if (key.toLowerCase() === 'iam:permissionsboundary') return true;
    }
  }
  return false;
}

const matchesAction = (actions: ReadonlyArray<string>, wanted: string): boolean =>
  actions.some((a) => a === wanted || a === '*' || (a.endsWith(':*') && wanted.startsWith(a.slice(0, -1))));

export function auditPolicyDocument(doc: PolicyDocument): PolicyAudit {
  let grantsAdmin = false;
  let unboundedRoleCreation = false;
  const deniedActions: string[] = [];
  const deniedResourcePatterns: string[] = [];
  const allowedResourcePatterns: string[] = [];

  for (const s of doc.Statement) {
    const actions = list(s.Action);
    const resources = list(s.Resource);

    if (s.Effect === 'Deny') {
      deniedActions.push(...actions);
      deniedResourcePatterns.push(...resources);
      continue;
    }

    allowedResourcePatterns.push(...resources);
    if (actions.includes('*') && resources.includes('*')) grantsAdmin = true;
    if (matchesAction(actions, 'iam:CreateRole') && !hasBoundaryCondition(s)) {
      unboundedRoleCreation = true;
    }
  }

  return { grantsAdmin, unboundedRoleCreation, deniedActions, deniedResourcePatterns, allowedResourcePatterns };
}
```

- [ ] **Step 4: 4 つのポリシー JSON を書く**

`scripts/aws-policies/claude-deploy-entry-trust.json`（entry role の信頼ポリシー）:

```json
{
  "Version": "2012-10-17",
  "Statement": [
    {
      "Sid": "OnlyHumanCdkUserWithExternalId",
      "Effect": "Allow",
      "Principal": { "AWS": "arn:aws:iam::822063948773:user/CDK" },
      "Action": "sts:AssumeRole",
      "Condition": {
        "StringEquals": { "sts:ExternalId": "open-reception-claude-cloud-dev" }
      }
    }
  ]
}
```

`scripts/aws-policies/claude-deploy-entry.json`（entry role の権限）:

> 🔴 **Task 7 補記（実装で判明。IMPORTANT A）**: `cloudformation:DescribeChangeSet` /
> `ExecuteChangeSet` / `DeleteChangeSet` は stack ARN ではなく **changeSet リソースタイプ**
> （`arn:...:changeSet/<name>/<id>`、stack 名を含まない）で認可される。当初案は
> `ReadOwnDevStacksForDiffGate` に `cloudformation:DescribeStacks` しか含めておらず、
> `run_diff_gate` が実際に呼ぶ `describe-change-set` が構造的に Deny され続けていた。
> `ReadOwnChangeSetsForDiffGate` を追加し、changeSet 名（`claude-gate-*`）でスコープする。
> `DenyEverythingElseOutsideTheChain` の `NotAction` にも `cloudformation:DescribeStacks` /
> `cloudformation:DescribeChangeSet` を加えてある。詳細は spec §4.2 層 1 と §13。

```json
{
  "Version": "2012-10-17",
  "Statement": [
    {
      "Sid": "AssumeDedicatedBootstrapRolesOnly",
      "Effect": "Allow",
      "Action": "sts:AssumeRole",
      "Resource": [
        "arn:aws:iam::822063948773:role/cdk-orcloud01-deploy-role-822063948773-ap-northeast-1",
        "arn:aws:iam::822063948773:role/cdk-orcloud01-deploy-role-822063948773-us-east-1",
        "arn:aws:iam::822063948773:role/cdk-orcloud01-file-publishing-role-822063948773-ap-northeast-1",
        "arn:aws:iam::822063948773:role/cdk-orcloud01-file-publishing-role-822063948773-us-east-1",
        "arn:aws:iam::822063948773:role/cdk-orcloud01-image-publishing-role-822063948773-ap-northeast-1",
        "arn:aws:iam::822063948773:role/cdk-orcloud01-image-publishing-role-822063948773-us-east-1",
        "arn:aws:iam::822063948773:role/cdk-orcloud01-lookup-role-822063948773-ap-northeast-1",
        "arn:aws:iam::822063948773:role/cdk-orcloud01-lookup-role-822063948773-us-east-1"
      ]
    },
    {
      "Sid": "DenySharedBootstrapRoles",
      "Effect": "Deny",
      "Action": "sts:AssumeRole",
      "Resource": [
        "arn:aws:iam::822063948773:role/cdk-hnb659fds-*",
        "arn:aws:iam::822063948773:role/cdk-staging-*"
      ]
    },
    {
      "Sid": "ReadOwnDevStacksForDiffGate",
      "Effect": "Allow",
      "Action": "cloudformation:DescribeStacks",
      "Resource": [
        "arn:aws:cloudformation:ap-northeast-1:822063948773:stack/OpenReception-Web-dev/*",
        "arn:aws:cloudformation:ap-northeast-1:822063948773:stack/OpenReception-WebMonitoring-dev/*",
        "arn:aws:cloudformation:us-east-1:822063948773:stack/OpenReception-CfMonitoring-dev/*"
      ]
    },
    {
      "Sid": "ReadOwnChangeSetsForDiffGate",
      "Effect": "Allow",
      "Action": "cloudformation:DescribeChangeSet",
      "Resource": [
        "arn:aws:cloudformation:ap-northeast-1:822063948773:changeSet/claude-gate-*/*",
        "arn:aws:cloudformation:us-east-1:822063948773:changeSet/claude-gate-*/*"
      ]
    },
    {
      "Sid": "DenyEverythingElseOutsideTheChain",
      "Effect": "Deny",
      "NotAction": [
        "sts:AssumeRole",
        "sts:GetCallerIdentity",
        "cloudformation:DescribeStacks",
        "cloudformation:DescribeChangeSet"
      ],
      "Resource": "*"
    }
  ]
}
```

`scripts/aws-policies/claude-boundary.json`（Permissions Boundary）:

> 🔴 **Task 7 補記（実装で判明）**: `iam:CreateRole` / `PutRolePolicy` / `AttachRolePolicy`
> は、`lambda:*` 等を含む大きな `AllowServicesNeededByDevStacks` から分離した専用の
> `AllowRoleMutationOnlyWithBoundary` ステートメントで持ち、素の `StringEquals` で
> `iam:PermissionsBoundary` を要求する（`DenyRoleCreationWithoutThisBoundary` の
> `StringNotEquals` と対になる）。同じ Allow に束ねると boundary 条件を掛けた瞬間に
> 無関係な 30 アクションを巻き添えにするため。詳細は spec §4.2 層 4 を参照。

```json
{
  "Version": "2012-10-17",
  "Statement": [
    {
      "Sid": "AllowServicesNeededByDevStacks",
      "Effect": "Allow",
      "Action": [
        "cloudformation:*",
        "lambda:*",
        "s3:*",
        "dynamodb:*",
        "cloudfront:*",
        "cognito-idp:*",
        "logs:*",
        "cloudwatch:*",
        "sns:*",
        "ssm:*",
        "apigateway:*",
        "iam:GetRole",
        "iam:GetRolePolicy",
        "iam:ListRolePolicies",
        "iam:ListAttachedRolePolicies",
        "iam:PassRole",
        "iam:DeleteRole",
        "iam:TagRole",
        "iam:UntagRole",
        "iam:DeleteRolePolicy",
        "iam:DetachRolePolicy",
        "iam:CreatePolicy",
        "iam:DeletePolicy",
        "iam:CreatePolicyVersion",
        "iam:DeletePolicyVersion",
        "iam:GetPolicy",
        "iam:GetPolicyVersion",
        "iam:ListPolicyVersions",
        "sts:AssumeRole",
        "sts:GetCallerIdentity"
      ],
      "Resource": "*"
    },
    {
      "Sid": "AllowRoleMutationOnlyWithBoundary",
      "Effect": "Allow",
      "Action": ["iam:CreateRole", "iam:PutRolePolicy", "iam:AttachRolePolicy"],
      "Resource": "*",
      "Condition": {
        "StringEquals": {
          "iam:PermissionsBoundary": "arn:aws:iam::822063948773:policy/OpenReceptionClaudeBoundary"
        }
      }
    },
    {
      "Sid": "DenyForeignProjectStacks",
      "Effect": "Deny",
      "Action": "cloudformation:*",
      "Resource": [
        "arn:aws:cloudformation:*:822063948773:stack/nodi-*/*",
        "arn:aws:cloudformation:*:822063948773:stack/salon-loop-*/*",
        "arn:aws:cloudformation:*:822063948773:stack/Kiaff*/*",
        "arn:aws:cloudformation:*:822063948773:stack/CDKToolkit/*",
        "arn:aws:cloudformation:*:822063948773:stack/CDKToolkit-staging/*",
        "arn:aws:cloudformation:*:822063948773:stack/OpenReception-*-staging/*",
        "arn:aws:cloudformation:*:822063948773:stack/OpenReception-*-prod/*"
      ]
    },
    {
      "Sid": "DenyForeignProjectData",
      "Effect": "Deny",
      "Action": ["dynamodb:*", "s3:*"],
      "Resource": [
        "arn:aws:dynamodb:*:822063948773:table/nodi-*",
        "arn:aws:dynamodb:*:822063948773:table/salon-loop-*",
        "arn:aws:s3:::nodi-*",
        "arn:aws:s3:::nodi-*/*",
        "arn:aws:s3:::salon-loop-*",
        "arn:aws:s3:::salon-loop-*/*",
        "arn:aws:s3:::cdk-hnb659fds-*",
        "arn:aws:s3:::cdk-hnb659fds-*/*",
        "arn:aws:s3:::cdk-staging-*",
        "arn:aws:s3:::cdk-staging-*/*"
      ]
    },
    {
      "Sid": "DenySharedBootstrapRoles",
      "Effect": "Deny",
      "Action": ["sts:AssumeRole", "iam:PassRole"],
      "Resource": [
        "arn:aws:iam::822063948773:role/cdk-hnb659fds-*",
        "arn:aws:iam::822063948773:role/cdk-staging-*"
      ]
    },
    {
      "Sid": "DenyRoleCreationWithoutThisBoundary",
      "Effect": "Deny",
      "Action": ["iam:CreateRole", "iam:PutRolePolicy", "iam:AttachRolePolicy"],
      "Resource": "*",
      "Condition": {
        "StringNotEquals": {
          "iam:PermissionsBoundary": "arn:aws:iam::822063948773:policy/OpenReceptionClaudeBoundary"
        }
      }
    },
    {
      "Sid": "DenyBoundaryEscape",
      "Effect": "Deny",
      "Action": ["iam:DeleteRolePermissionsBoundary", "iam:PutRolePermissionsBoundary"],
      "Resource": "*"
    },
    {
      "Sid": "DenyTamperingWithTheBoundaryPolicyItself",
      "Effect": "Deny",
      "Action": [
        "iam:CreatePolicyVersion",
        "iam:DeletePolicyVersion",
        "iam:SetDefaultPolicyVersion",
        "iam:DeletePolicy"
      ],
      "Resource": "arn:aws:iam::822063948773:policy/OpenReceptionClaudeBoundary"
    },
    {
      "Sid": "DenyPrincipalCreationAndOrgChanges",
      "Effect": "Deny",
      "Action": [
        "iam:CreateUser",
        "iam:CreateAccessKey",
        "iam:CreateLoginProfile",
        "iam:UpdateAssumeRolePolicy",
        "organizations:*",
        "account:*"
      ],
      "Resource": "*"
    },
    {
      "Sid": "DenySharedDnsAndCertificates",
      "Effect": "Deny",
      "Action": ["route53:*", "acm:*", "route53domains:*"],
      "Resource": "*"
    },
    {
      "Sid": "DenySecretsAndKeyDestruction",
      "Effect": "Deny",
      "Action": ["secretsmanager:*", "kms:ScheduleKeyDeletion", "kms:DisableKey", "kms:PutKeyPolicy"],
      "Resource": "*"
    }
  ]
}
```

`scripts/aws-policies/claude-cfn-exec.json`（CloudFormation 実行ロールのポリシー）:

> 🔴 **Task 7 補記（実装で判明）**: `claude-boundary.json` と同じ理由で、
> `iam:CreateRole` / `PutRolePolicy` / `AttachRolePolicy` を専用の
> `AllowRoleMutationOnlyWithBoundary` ステートメントへ分離してある。

```json
{
  "Version": "2012-10-17",
  "Statement": [
    {
      "Sid": "AllowDevStackResourceManagement",
      "Effect": "Allow",
      "Action": [
        "cloudformation:*",
        "lambda:*",
        "s3:*",
        "dynamodb:*",
        "cloudfront:*",
        "cognito-idp:*",
        "logs:*",
        "cloudwatch:*",
        "sns:*",
        "ssm:*",
        "apigateway:*",
        "iam:GetRole",
        "iam:GetRolePolicy",
        "iam:ListRolePolicies",
        "iam:ListAttachedRolePolicies",
        "iam:PassRole",
        "iam:DeleteRole",
        "iam:TagRole",
        "iam:UntagRole",
        "iam:DeleteRolePolicy",
        "iam:DetachRolePolicy",
        "iam:CreatePolicy",
        "iam:DeletePolicy",
        "iam:CreatePolicyVersion",
        "iam:DeletePolicyVersion",
        "iam:GetPolicy",
        "iam:GetPolicyVersion",
        "iam:ListPolicyVersions"
      ],
      "Resource": "*"
    },
    {
      "Sid": "AllowRoleMutationOnlyWithBoundary",
      "Effect": "Allow",
      "Action": ["iam:CreateRole", "iam:PutRolePolicy", "iam:AttachRolePolicy"],
      "Resource": "*",
      "Condition": {
        "StringEquals": {
          "iam:PermissionsBoundary": "arn:aws:iam::822063948773:policy/OpenReceptionClaudeBoundary"
        }
      }
    },
    {
      "Sid": "DenyForeignProjectStacks",
      "Effect": "Deny",
      "Action": "cloudformation:*",
      "Resource": [
        "arn:aws:cloudformation:*:822063948773:stack/nodi-*/*",
        "arn:aws:cloudformation:*:822063948773:stack/salon-loop-*/*",
        "arn:aws:cloudformation:*:822063948773:stack/Kiaff*/*",
        "arn:aws:cloudformation:*:822063948773:stack/CDKToolkit/*",
        "arn:aws:cloudformation:*:822063948773:stack/CDKToolkit-staging/*",
        "arn:aws:cloudformation:*:822063948773:stack/OpenReception-*-staging/*",
        "arn:aws:cloudformation:*:822063948773:stack/OpenReception-*-prod/*"
      ]
    },
    {
      "Sid": "DenyForeignProjectData",
      "Effect": "Deny",
      "Action": ["dynamodb:*", "s3:*"],
      "Resource": [
        "arn:aws:dynamodb:*:822063948773:table/nodi-*",
        "arn:aws:dynamodb:*:822063948773:table/salon-loop-*",
        "arn:aws:s3:::nodi-*",
        "arn:aws:s3:::nodi-*/*",
        "arn:aws:s3:::salon-loop-*",
        "arn:aws:s3:::salon-loop-*/*",
        "arn:aws:s3:::cdk-hnb659fds-*",
        "arn:aws:s3:::cdk-hnb659fds-*/*",
        "arn:aws:s3:::cdk-staging-*",
        "arn:aws:s3:::cdk-staging-*/*"
      ]
    },
    {
      "Sid": "DenySharedBootstrapRoles",
      "Effect": "Deny",
      "Action": ["sts:AssumeRole", "iam:PassRole"],
      "Resource": [
        "arn:aws:iam::822063948773:role/cdk-hnb659fds-*",
        "arn:aws:iam::822063948773:role/cdk-staging-*"
      ]
    },
    {
      "Sid": "DenyRoleCreationWithoutBoundary",
      "Effect": "Deny",
      "Action": ["iam:CreateRole", "iam:PutRolePolicy", "iam:AttachRolePolicy"],
      "Resource": "*",
      "Condition": {
        "StringNotEquals": {
          "iam:PermissionsBoundary": "arn:aws:iam::822063948773:policy/OpenReceptionClaudeBoundary"
        }
      }
    },
    {
      "Sid": "DenySecretsDnsAndPrincipals",
      "Effect": "Deny",
      "Action": [
        "secretsmanager:*",
        "route53:*",
        "acm:*",
        "iam:CreateUser",
        "iam:CreateAccessKey",
        "organizations:*",
        "account:*"
      ],
      "Resource": "*"
    }
  ]
}
```

`scripts/aws-policies/claude-deploy-role-restriction.json`（**層 1・主境界**。bootstrap が作った
`cdk-orcloud01-deploy-role-*` へ**インラインポリシーとして上乗せする Deny のみ**。
Deny は Allow に優先するので、bootstrap 既定の `cloudformation:*` をここで削り取る）:

> 🔴 **Task 7 補記（実装で判明。IMPORTANT A）**: `claude-deploy-entry.json` と同じ理由で、
> `NotResource` に `changeSet/claude-gate-*/*` の 2 エントリ（ap-northeast-1 / us-east-1）を
> 追加してある。これが無いと `DenyCloudFormationOutsideDevStacks` が changeset 系アクション
> （`DescribeChangeSet`/`ExecuteChangeSet`/`DeleteChangeSet`）まで巻き添えにし、
> `cdk deploy` 自体が動かなくなる。この名前スコープが生む残存ギャップは spec §13 を参照。

```json
{
  "Version": "2012-10-17",
  "Statement": [
    {
      "Sid": "DenyCloudFormationOutsideDevStacks",
      "Effect": "Deny",
      "Action": "cloudformation:*",
      "NotResource": [
        "arn:aws:cloudformation:ap-northeast-1:822063948773:stack/OpenReception-Web-dev/*",
        "arn:aws:cloudformation:ap-northeast-1:822063948773:stack/OpenReception-WebMonitoring-dev/*",
        "arn:aws:cloudformation:us-east-1:822063948773:stack/OpenReception-CfMonitoring-dev/*",
        "arn:aws:cloudformation:ap-northeast-1:822063948773:stack/CDKToolkit-orcloud01/*",
        "arn:aws:cloudformation:us-east-1:822063948773:stack/CDKToolkit-orcloud01/*",
        "arn:aws:cloudformation:ap-northeast-1:822063948773:changeSet/claude-gate-*/*",
        "arn:aws:cloudformation:us-east-1:822063948773:changeSet/claude-gate-*/*"
      ]
    },
    {
      "Sid": "DenyForeignAndNonDevStacksExplicitly",
      "Effect": "Deny",
      "Action": "cloudformation:*",
      "Resource": [
        "arn:aws:cloudformation:*:822063948773:stack/nodi-*/*",
        "arn:aws:cloudformation:*:822063948773:stack/salon-loop-*/*",
        "arn:aws:cloudformation:*:822063948773:stack/Kiaff*/*",
        "arn:aws:cloudformation:*:822063948773:stack/CDKToolkit/*",
        "arn:aws:cloudformation:*:822063948773:stack/CDKToolkit-staging/*",
        "arn:aws:cloudformation:*:822063948773:stack/OpenReception-*-staging/*",
        "arn:aws:cloudformation:*:822063948773:stack/OpenReception-*-prod/*"
      ]
    },
    {
      "Sid": "DenyPassingSharedExecRoles",
      "Effect": "Deny",
      "Action": ["iam:PassRole", "sts:AssumeRole"],
      "Resource": [
        "arn:aws:iam::822063948773:role/cdk-hnb659fds-*",
        "arn:aws:iam::822063948773:role/cdk-staging-*"
      ]
    }
  ]
}
```

> **`NotResource` と明示 Deny の両方を書いているのは重複ではない。** `NotResource` は
> 許可スタックの列挙漏れがあったときに**閉じる方向**へ効き、明示 Deny は
> `NotResource` の書き間違い（例: `*` を混入させる）があったときに**他プロジェクトだけは
> 必ず守る**。片方が壊れてももう片方が残る。

- [ ] **Step 5: テストが通ることを確認**

Run: `npx vitest run src/domain/governance/aws-policy-shape.test.ts`
Expected: PASS

- [ ] **Step 6: 変異させて確認**

`claude-boundary.json` から `DenySharedDnsAndCertificates` ステートメントを一時的に削除する。

Run: `npx vitest run src/domain/governance/aws-policy-shape.test.ts`
Expected: FAIL —「`route53:*` を Deny している」「`acm:*` を Deny している」が落ちる。
`git diff` が空でないことを確かめてから元に戻す（変異が当たっていないのに「テストが弱い」と読まない）。

- [ ] **Step 7: typecheck とコミット**

```bash
npm run typecheck
git add scripts/aws-policies src/domain/governance/aws-policy-shape.ts src/domain/governance/aws-policy-shape.test.ts
git commit -m "feat(infra): Claude Cloud 専用 IAM ポリシーと構造検証を追加 (#<issue>)"
```

---

### Task 4: CLI 2 本と配線登録

**Files:**
- Create: `scripts/aws-diff-gate.ts`
- Create: `scripts/aws-negative-tests.ts`
- Modify: `scripts/check-script-wiring.ts`（`WIRING_SOURCES` と `MANUAL_ONLY_ALLOWLIST`）
- Modify: `package.json`（`scripts` に 2 エントリ）

**Interfaces:**
- Consumes: Task 1 の `evaluateDeployChangeSet` / `ChangeSetSummary`
- Produces: `npm run aws:diff-gate -- <change-set-json-path> <stack-name>`（危険なら exit 1）、`npm run aws:negative-tests`（1 件でも期待外れなら exit 1）

**配線の考え方:** `scripts/check-script-wiring.ts` は `scripts/quality-gate.sh` /
`record-gate-run.sh` / `scripts/hooks/**` / `src` / `infra/**` からの参照だけを配線と数える。
`aws-cloud-deploy.sh`（Task 5）は**実際の入口**なので `WIRING_SOURCES` に加える。
入口そのものである `aws-cloud-deploy.sh` と `aws-issue-credentials.sh` は
`MANUAL_ONLY_ALLOWLIST` に理由付きで登録する。

- [ ] **Step 1: 配線検査のテストを先に赤くする**

`src/domain/governance/` にはこの検査のテストが無く、`scripts/check-script-wiring.ts` 自体が
検査器である。まず**新しいスクリプトを置いただけの状態**を作って検査が赤くなることを確認する。

```bash
touch scripts/aws-diff-gate.ts scripts/aws-negative-tests.ts
npx tsx scripts/check-script-wiring.ts
```

Expected: FAIL — `aws-diff-gate.ts` と `aws-negative-tests.ts` が「誰も呼んでいない」として報告される。
**これが期待どおりの赤**（検査が効いている証拠）。

- [ ] **Step 2: `scripts/aws-diff-gate.ts` を実装する**

```ts
/**
 * change set の危険判定 CLI (spec §6)。
 *
 * `src/domain/governance/deploy-diff-gate.ts`（純関数）へ、
 * `aws cloudformation describe-change-set` の JSON を渡して印字する。判定はここに持たない。
 *
 * `scripts/aws-cloud-deploy.sh` の `diff` / `deploy` が呼ぶ。
 * **危険と判定したら非ゼロで終わる**（`change-risk.ts` と違いこちらは判定者。
 * 実際にデプロイを止める必要がある）。
 */
import { readFileSync } from 'node:fs';
import {
  evaluateDeployChangeSet,
  type ChangeSetResourceChange,
  type ChangeSetSummary,
} from '../src/domain/governance/deploy-diff-gate';

type RawChangeSet = {
  readonly StackName?: string;
  readonly Changes?: ReadonlyArray<{
    readonly ResourceChange?: {
      readonly Action?: string;
      readonly ResourceType?: string;
      readonly LogicalResourceId?: string;
      readonly Replacement?: string;
    };
  }>;
};

/**
 * 欠落を「問題なし」に落とさない。`Action` が読めなければ `'Unknown'` として扱い、
 * 少なくとも Remove/Replacement の判定から静かに外れないようにする。
 */
function toSummary(raw: RawChangeSet, stackNameArg: string): ChangeSetSummary {
  const changes: ChangeSetResourceChange[] = [];
  for (const entry of raw.Changes ?? []) {
    const rc = entry.ResourceChange;
    if (rc === undefined) continue;
    changes.push({
      action: rc.Action ?? 'Unknown',
      resourceType: rc.ResourceType ?? 'Unknown',
      logicalResourceId: rc.LogicalResourceId ?? 'Unknown',
      replacement: rc.Replacement,
    });
  }
  return { stackName: raw.StackName ?? stackNameArg, changes };
}

function main(): void {
  const [jsonPath, stackName] = process.argv.slice(2);
  if (jsonPath === undefined || stackName === undefined) {
    console.error('Usage: tsx scripts/aws-diff-gate.ts <change-set-json> <stack-name>');
    process.exit(2);
  }

  const raw = JSON.parse(readFileSync(jsonPath, 'utf8')) as RawChangeSet;
  const summary = toSummary(raw, stackName);
  const verdict = evaluateDeployChangeSet(summary);

  console.log(`  stack: ${summary.stackName} / 変更 ${summary.changes.length} 件`);
  for (const flag of verdict.flags) {
    console.log(`  ⚠ 記録: [${flag.reason}] ${flag.evidence}`);
  }
  if (!verdict.blocked) {
    console.log('  ✅ 危険な変更はありません（自動デプロイ可）');
    return;
  }
  console.error('  ⛔ 危険な変更を検出したため自動デプロイを停止します:');
  for (const block of verdict.blocks) {
    console.error(`    - [${block.reason}] ${block.evidence}`);
  }
  console.error('  → 人間が差分を確認し、必要なら手動でデプロイしてください');
  process.exit(1);
}

main();
```

- [ ] **Step 3: `scripts/aws-negative-tests.ts` を実装する**

> 🔴 **判定部分は純関数に切り出してテストする。** このスクリプト全体は AWS 認証情報が
> 無いと動かず、本サイクルでは一度も実走しない。**実走しないコードをテスト無しで置かない。**
> `src/domain/governance/negative-test-outcome.ts` に
> `classifyAwsError(stderr: string): 'denied' | 'unknown'` と
> `summarizeNegativeTests(results: ReadonlyArray<{id: string; expected: 'allowed'|'denied'; actual: 'allowed'|'denied'|'unknown'}>): {failed: number}`
> を置き、同居テストで固定する。とくに:
>
> - `AccessDenied` / `not authorized` / `explicit deny` を `denied` と判定する（大小無視）
> - **`unknown` は期待が `denied` でも PASS にしない**（判定不能を PASS にしない）
> - stderr が空文字のときも `unknown`（[[空文字は「問題なし」ではない]] の型）
>
> 下記の `aws()` / `simulate()` はこの純関数を呼ぶだけにする。

```ts
/**
 * Negative security tests (spec §7)。
 *
 * 🔴 **破壊系を実試行しない。** 「AccessDenied を期待して DeleteTable を実行する」テストは、
 * Deny が効いていなかった場合に**本当に消す**。副作用の無い操作だけ実試行し、
 * 破壊系は `iam:SimulatePrincipalPolicy` で判定する。
 *
 * `scripts/aws-cloud-deploy.sh preflight` が呼ぶ。**1 件でも期待外れなら非ゼロで終わる**
 * （判定不能も期待外れとして扱う。`--strict` の思想: 測れていないものを PASS にしない）。
 */
import { execFileSync } from 'node:child_process';

const ACCOUNT = '822063948773';

type Outcome = 'allowed' | 'denied' | 'unknown';
type Check = { readonly id: string; readonly description: string; readonly expected: Exclude<Outcome, 'unknown'> };

/** 実試行する（副作用なし）。 */
const LIVE_CHECKS: ReadonlyArray<Check & { readonly run: () => Outcome }> = [
  {
    id: 'N2',
    description: '共有 bootstrap (hnb659fds) の deploy role を assume',
    expected: 'denied',
    run: () => assumeRole(`arn:aws:iam::${ACCOUNT}:role/cdk-hnb659fds-deploy-role-${ACCOUNT}-ap-northeast-1`),
  },
  {
    id: 'N3',
    description: '共有 bootstrap (staging) の deploy role を assume',
    expected: 'denied',
    run: () => assumeRole(`arn:aws:iam::${ACCOUNT}:role/cdk-staging-deploy-role-${ACCOUNT}-ap-northeast-1`),
  },
  {
    id: 'N4',
    description: 'OpenReception-Web-dev を describe',
    expected: 'allowed',
    run: () => describeStack('OpenReception-Web-dev'),
  },
  { id: 'N5', description: 'nodi-dev-app を describe', expected: 'denied', run: () => describeStack('nodi-dev-app') },
  {
    id: 'N6',
    description: 'salon-loop-staging-data を describe',
    expected: 'denied',
    run: () => describeStack('salon-loop-staging-data'),
  },
  {
    id: 'N7',
    description: 'Secrets Manager の列挙',
    expected: 'denied',
    run: () => aws(['secretsmanager', 'list-secrets', '--max-results', '1']),
  },
];

/** 実試行しない。`SimulatePrincipalPolicy` で判定する（人間の Admin 環境から実行）。 */
const SIMULATED_CHECKS: ReadonlyArray<{
  readonly id: string;
  readonly action: string;
  readonly resource: string;
}> = [
  { id: 'S1', action: 'dynamodb:DeleteTable', resource: `arn:aws:dynamodb:ap-northeast-1:${ACCOUNT}:table/nodi-dev-anything` },
  { id: 'S2', action: 'cloudformation:DeleteStack', resource: `arn:aws:cloudformation:ap-northeast-1:${ACCOUNT}:stack/nodi-dev-app/*` },
  { id: 'S3', action: 'secretsmanager:GetSecretValue', resource: `arn:aws:secretsmanager:ap-northeast-1:${ACCOUNT}:secret:salon-loop/*` },
  { id: 'S5', action: 'iam:AttachRolePolicy', resource: `arn:aws:iam::${ACCOUNT}:role/any-role` },
  { id: 'S6', action: 'iam:PassRole', resource: `arn:aws:iam::${ACCOUNT}:role/cdk-hnb659fds-cfn-exec-role-${ACCOUNT}-ap-northeast-1` },
  { id: 'S7', action: 'iam:DeleteRolePermissionsBoundary', resource: `arn:aws:iam::${ACCOUNT}:role/any-role` },
  { id: 'S8', action: 'route53:ChangeResourceRecordSets', resource: 'arn:aws:route53:::hostedzone/ANY' },
  { id: 'S9', action: 'cloudformation:UpdateStack', resource: `arn:aws:cloudformation:ap-northeast-1:${ACCOUNT}:stack/OpenReception-Web-prod/*` },
  { id: 'S10', action: 'kms:ScheduleKeyDeletion', resource: `arn:aws:kms:ap-northeast-1:${ACCOUNT}:key/any` },
];

/**
 * 🔴 **stderr を診断に載せる。** `execFileSync` の例外は `message` がコマンド行までで、
 * 理由は `stderr` にある。載せないと 3 周にわたって当て推量で直すことになる（2026-08-08 の実例）。
 */
function aws(args: ReadonlyArray<string>): Outcome {
  try {
    execFileSync('aws', [...args], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] });
    return 'allowed';
  } catch (e) {
    const stderr = (e as { stderr?: Buffer }).stderr?.toString() ?? '';
    if (/AccessDenied|not authorized|ExplicitDeny/i.test(stderr)) return 'denied';
    console.error(`      (判定不能) ${stderr.trim().split('\n')[0] ?? '(stderr 空)'}`);
    return 'unknown';
  }
}

const assumeRole = (arn: string): Outcome =>
  aws(['sts', 'assume-role', '--role-arn', arn, '--role-session-name', 'negative-test']);

const describeStack = (name: string): Outcome =>
  aws(['cloudformation', 'describe-stacks', '--stack-name', name]);

function simulate(principalArn: string, action: string, resource: string): Outcome {
  try {
    const out = execFileSync(
      'aws',
      [
        'iam', 'simulate-principal-policy',
        '--policy-source-arn', principalArn,
        '--action-names', action,
        '--resource-arns', resource,
        '--query', 'EvaluationResults[0].EvalDecision',
        '--output', 'text',
      ],
      { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] },
    ).trim();
    if (out === 'allowed') return 'allowed';
    if (out.endsWith('Deny')) return 'denied';
    return 'unknown';
  } catch (e) {
    const stderr = (e as { stderr?: Buffer }).stderr?.toString() ?? '';
    console.error(`      (判定不能) ${stderr.trim().split('\n')[0] ?? '(stderr 空)'}`);
    return 'unknown';
  }
}

function main(): void {
  const simulateOnly = process.argv.includes('--simulate-only');
  const principalArn = process.env.SIMULATE_PRINCIPAL_ARN ?? `arn:aws:iam::${ACCOUNT}:role/OpenReceptionClaudeDeploy-dev`;
  let failed = 0;

  if (!simulateOnly) {
    console.log('  実試行（副作用なし）:');
    for (const check of LIVE_CHECKS) {
      const actual = check.run();
      const pass = actual === check.expected;
      if (!pass) failed += 1;
      console.log(`    ${pass ? '✅' : '❌'} ${check.id} ${check.description} → ${actual}（期待 ${check.expected}）`);
    }
  }

  console.log('  シミュレーション（破壊系は実試行しない）:');
  for (const check of SIMULATED_CHECKS) {
    const actual = simulate(principalArn, check.action, check.resource);
    const pass = actual === 'denied';
    if (!pass) failed += 1;
    console.log(`    ${pass ? '✅' : '❌'} ${check.id} ${check.action} → ${actual}（期待 denied）`);
  }

  if (failed > 0) {
    console.error(`  ⛔ negative security test: ${failed} 件が期待どおりでない`);
    process.exit(1);
  }
  console.log('  ✅ negative security test 全件 PASS');
}

main();
```

- [ ] **Step 4: `package.json` に npm script を追加する**

```json
"aws:diff-gate": "tsx scripts/aws-diff-gate.ts",
"aws:negative-tests": "tsx scripts/aws-negative-tests.ts"
```

> 🔴 **配線登録（`check-script-wiring.ts` の編集）は Task 5 で行う。** 配線元となる
> `scripts/aws-cloud-deploy.sh` がまだ存在せず、`WIRING_SOURCES` に存在しないパスを
> 足すと `readFileSync` が投げて検査自体が壊れる。**Task 4 と Task 5 は 1 コミットにまとめる**
> （CLI だけでは誰も呼ばず、wrapper だけでは動かないので、レビュー単位としても不可分）。

- [ ] **Step 5: diff gate を実データ形状で手動確認する**

```bash
cat > /tmp/cs.json <<'JSON'
{"StackName":"OpenReception-Web-dev","Changes":[
  {"ResourceChange":{"Action":"Modify","ResourceType":"AWS::DynamoDB::Table","LogicalResourceId":"DataTable","Replacement":"True"}}]}
JSON
npx tsx scripts/aws-diff-gate.ts /tmp/cs.json OpenReception-Web-dev; echo "exit=$?"
```

Expected: `⛔ 危険な変更を検出` と `resourceReplacement`、`exit=1`

- [ ] **Step 6: typecheck**

Run: `npm run typecheck`
Expected: エラーなし（**コミットは Task 5 の末尾でまとめて行う**）

---

### Task 5: deploy wrapper と配線登録

**Files:**
- Create: `scripts/aws-preflight.ts`
- Create: `scripts/aws-cloud-deploy.sh`
- Create: `tests/hooks/aws-cloud-deploy.test.ts`
- Modify: `scripts/check-script-wiring.ts`（`WIRING_SOURCES` と `MANUAL_ONLY_ALLOWLIST`）

**Interfaces:**
- Consumes: Task 2 の `evaluatePreflight` / `DEFAULT_PREFLIGHT_REQUIREMENT` / `PreflightObservation`、Task 4 の `scripts/aws-diff-gate.ts` と `scripts/aws-negative-tests.ts`
- Produces: `bash scripts/aws-cloud-deploy.sh <preflight|verify|diff|deploy|smoke>`、`tsx scripts/aws-preflight.ts <observation-json> [minCredentialSeconds]`

**設計メモ:** **preflight の判定ロジックを bash に書かない**（テストできない）。wrapper は
観測を JSON に組み立てるだけにして、判定は `scripts/aws-preflight.ts` → Task 2 の純関数へ
渡す。`aws-diff-gate.ts` と同じ形。

- [ ] **Step 1: wrapper の失敗ケースを固定するテストを書く**

`tests/hooks/aws-cloud-deploy.test.ts`:

```ts
/**
 * `scripts/aws-cloud-deploy.sh` の振る舞い検証 (spec §5)。
 *
 * `tests/hooks/guard-destructive.test.ts` と同じ方針: 実際に起動して確かめる。
 * **AWS へは接続しない** — 未知のサブコマンドと引数検証、および
 * 「AWS 認証情報が無いときに黙って成功しない」ことを固定する。
 */
import { execFileSync } from 'node:child_process';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

const WRAPPER = resolve(process.cwd(), 'scripts/aws-cloud-deploy.sh');

function run(args: ReadonlyArray<string>, env: Record<string, string> = {}) {
  try {
    const stdout = execFileSync('bash', [WRAPPER, ...args], {
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'pipe'],
      env: { ...process.env, ...env },
    });
    return { status: 0, stdout, stderr: '' };
  } catch (e) {
    const err = e as { status?: number; stdout?: Buffer; stderr?: Buffer };
    return {
      status: err.status ?? -1,
      stdout: err.stdout?.toString() ?? '',
      stderr: err.stderr?.toString() ?? '',
    };
  }
}

describe('引数の検証', () => {
  it('サブコマンド無しは usage を出して非ゼロ', () => {
    const { status, stderr } = run([]);
    expect(status).not.toBe(0);
    expect(stderr).toContain('Usage');
  });

  it('未知のサブコマンドは非ゼロ', () => {
    const { status, stderr } = run(['destroy']);
    expect(status).not.toBe(0);
    expect(stderr).toContain('destroy');
  });

  it.each(['preflight', 'verify', 'diff', 'deploy', 'smoke'])('%s は既知のサブコマンド', (sub) => {
    const { stderr } = run([sub, '--help']);
    expect(stderr).not.toContain('未知のサブコマンド');
  });
});

describe('環境の固定', () => {
  it('env=dev 以外を拒否する', () => {
    const { status, stderr } = run(['diff'], { OR_DEPLOY_ENV: 'prod' });
    expect(status).not.toBe(0);
    expect(stderr).toContain('dev');
  });

  it('AWS 認証情報が無い状態で成功と報告しない', () => {
    const { status } = run(['preflight'], {
      AWS_ACCESS_KEY_ID: '',
      AWS_SECRET_ACCESS_KEY: '',
      AWS_SESSION_TOKEN: '',
      AWS_PROFILE: 'definitely-not-a-real-profile',
    });
    expect(status).not.toBe(0);
  });
});

describe('危険な既定を持たない', () => {
  it('スクリプト本文に --force / --require-approval never を含まない', () => {
    const source = execFileSync('cat', [WRAPPER], { encoding: 'utf8' });
    expect(source).not.toContain('--require-approval never');
    expect(source).not.toContain('--no-verify');
  });

  it('既定 qualifier hnb659fds を使わない', () => {
    const source = execFileSync('cat', [WRAPPER], { encoding: 'utf8' });
    expect(source).toContain('orcloud01');
    expect(source).not.toContain('hnb659fds');
  });
});
```

- [ ] **Step 2: テストが失敗することを確認**

Run: `npx vitest run tests/hooks/aws-cloud-deploy.test.ts`
Expected: FAIL — wrapper が存在しない

- [ ] **Step 3: `scripts/aws-preflight.ts`（薄い CLI）を書く**

```ts
/**
 * preflight 判定 CLI (spec §5)。
 *
 * `scripts/aws-cloud-deploy.sh` が集めた観測を JSON で受け取り、
 * `src/domain/governance/deploy-preflight.ts` に判定させて印字する。
 * **不一致があれば非ゼロで終わる。**
 */
import { readFileSync } from 'node:fs';
import {
  DEFAULT_PREFLIGHT_REQUIREMENT,
  evaluatePreflight,
  type PreflightObservation,
} from '../src/domain/governance/deploy-preflight';

function main(): void {
  const [jsonPath, minSecondsArg] = process.argv.slice(2);
  if (jsonPath === undefined) {
    console.error('Usage: tsx scripts/aws-preflight.ts <observation-json> [minCredentialSeconds]');
    process.exit(2);
  }
  const observed = JSON.parse(readFileSync(jsonPath, 'utf8')) as PreflightObservation;
  const required = {
    ...DEFAULT_PREFLIGHT_REQUIREMENT,
    minCredentialSeconds:
      minSecondsArg === undefined
        ? DEFAULT_PREFLIGHT_REQUIREMENT.minCredentialSeconds
        : Number(minSecondsArg),
  };
  const verdict = evaluatePreflight(observed, required);
  if (verdict.ok) {
    console.log('  ✅ preflight 全項目 PASS');
    return;
  }
  console.error('  ⛔ preflight 不一致:');
  for (const f of verdict.failures) console.error(`    - ${f.field}: ${f.detail}`);
  process.exit(1);
}

main();
```

- [ ] **Step 4: `scripts/aws-cloud-deploy.sh` を書く**

```bash
#!/usr/bin/env bash
# =============================================================================
# Claude Code on the cloud から AWS dev へデプロイするための wrapper (spec §5)。
#
#   scripts/aws-cloud-deploy.sh <preflight|verify|diff|deploy|smoke>
#
# クラウドから素の `cdk deploy` を打たないための唯一の入口。迂回しても既定 qualifier の
# ロールを assume できず失敗する（fail-closed）が、迂回を前提にしない。
#
# 判定ロジックはこのファイルに書かない（bash はテストしづらい）。観測を集めて
# scripts/aws-preflight.ts と scripts/aws-diff-gate.ts へ渡す。
# =============================================================================
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
QUALIFIER="orcloud01"
DEPLOY_ENV="${OR_DEPLOY_ENV:-dev}"
REGION="${AWS_REGION:-ap-northeast-1}"
STACKS=(
  "OpenReception-Web-${DEPLOY_ENV}"
  "OpenReception-WebMonitoring-${DEPLOY_ENV}"
  "OpenReception-CfMonitoring-${DEPLOY_ENV}"
)

usage() {
  echo "Usage: $0 <preflight|verify|diff|deploy|smoke>" >&2
}

if [ $# -lt 1 ]; then
  usage
  exit 2
fi
SUB="$1"
shift || true

case "${SUB}" in
  preflight|verify|diff|deploy|smoke) ;;
  *)
    echo "未知のサブコマンド: ${SUB}" >&2
    usage
    exit 2
    ;;
esac

# 環境の固定。dev 以外はここで止める（脅威 T13）。
if [ "${DEPLOY_ENV}" != "dev" ]; then
  echo "OR_DEPLOY_ENV=${DEPLOY_ENV} は許可されていません（dev のみ）" >&2
  exit 2
fi

# --help はサブコマンド判定だけして抜ける（テストが AWS に触れずに済むように）。
if [ "${1:-}" = "--help" ]; then
  usage
  exit 0
fi

collect_observation() {
  local out="$1" min_seconds="$2"
  local identity account arn expiry remaining clean stamp neg

  if ! identity="$(aws sts get-caller-identity --output json 2>&1)"; then
    echo "AWS 認証情報を解決できません: ${identity}" >&2
    return 1
  fi
  account="$(printf '%s' "${identity}" | node -e 'let s="";process.stdin.on("data",d=>s+=d).on("end",()=>console.log(JSON.parse(s).Account))')"
  arn="$(printf '%s' "${identity}" | node -e 'let s="";process.stdin.on("data",d=>s+=d).on("end",()=>console.log(JSON.parse(s).Arn))')"

  # credential の残時間。取得できなければ null（判定不能を PASS にしない）。
  expiry="${AWS_CREDENTIAL_EXPIRATION:-}"
  if [ -n "${expiry}" ]; then
    remaining="$(node -e "console.log(Math.floor((Date.parse(process.argv[1]) - Date.now())/1000))" "${expiry}")"
  else
    remaining="null"
  fi

  if [ -z "$(git -C "${ROOT}" status --porcelain -uall)" ]; then clean=true; else clean=false; fi

  # 品質ゲートのスタンプ（既存の scripts/lib/gate-stamp.sh を使う）。
  # shellcheck source=lib/gate-stamp.sh
  . "${ROOT}/scripts/lib/gate-stamp.sh"
  if gate_stamp_satisfies "pr"; then stamp=true; else stamp=false; fi

  # 🔴 Task 7 補記: 実装は `--live-only` を渡す。S 系（SimulatePrincipalPolicy）は
  # `OpenReceptionClaudeDeploy-dev` がその権限を持たない前提のためここでは実行せず、
  # 人間が Admin 環境の runbook（`--simulate-only`）で別途実施する（Important 5b）。
  # フラグ無しの `npm run aws:negative-tests` は両方を走らせるため Admin 専用であり、
  # クラウドの preflight から呼ぶと S 系が全部 unknown（＝ FAIL 扱い）になる。
  if npx tsx "${ROOT}/scripts/aws-negative-tests.ts" --live-only; then neg=true; else neg=false; fi

  cat > "${out}" <<EOF
{
  "callerArn": "${arn}",
  "accountId": "${account}",
  "region": "${REGION}",
  "qualifier": "${QUALIFIER}",
  "environment": "${DEPLOY_ENV}",
  "credentialSecondsRemaining": ${remaining},
  "workingTreeClean": ${clean},
  "gateStampSatisfied": ${stamp},
  "negativeTestsPassed": ${neg}
}
EOF
  npx tsx "${ROOT}/scripts/aws-preflight.ts" "${out}" "${min_seconds}"
}

run_diff_gate() {
  local stack="$1" cs_name cs_json
  cs_name="claude-gate-$(git -C "${ROOT}" rev-parse --short HEAD)"
  cs_json="$(mktemp)"

  # cdk が change set を作る。--no-execute で実行しない。
  ( cd "${ROOT}/infra" && npx cdk deploy "${stack}" \
      -c env="${DEPLOY_ENV}" \
      -c "@aws-cdk/core:bootstrapQualifier=${QUALIFIER}" \
      --change-set-name "${cs_name}" --no-execute )

  aws cloudformation describe-change-set \
    --stack-name "${stack}" --change-set-name "${cs_name}" --output json > "${cs_json}"

  npx tsx "${ROOT}/scripts/aws-diff-gate.ts" "${cs_json}" "${stack}"
}

case "${SUB}" in
  preflight)
    collect_observation "$(mktemp)" 1200
    ;;
  verify)
    "${ROOT}/scripts/quality-gate.sh" --pr
    ( cd "${ROOT}" && npm run build:open-next )
    ;;
  diff)
    collect_observation "$(mktemp)" 1200
    for stack in "${STACKS[@]}"; do run_diff_gate "${stack}"; done
    ;;
  deploy)
    collect_observation "$(mktemp)" 2400
    for stack in "${STACKS[@]}"; do run_diff_gate "${stack}"; done
    ( cd "${ROOT}/infra" && npx cdk deploy "${STACKS[@]}" \
        -c env="${DEPLOY_ENV}" \
        -c "@aws-cdk/core:bootstrapQualifier=${QUALIFIER}" \
        --require-approval broadening )
    ;;
  smoke)
    if [ -z "${OR_SMOKE_URL:-}" ]; then
      echo "OR_SMOKE_URL が未設定です（デプロイ済み URL を渡してください）" >&2
      exit 2
    fi
    "${ROOT}/scripts/url-quality-gate.sh" "${OR_SMOKE_URL}"
    ( cd "${ROOT}" && E2E_BASE_URL="${OR_SMOKE_URL}" npm run test:e2e:live )
    ;;
esac
```

- [ ] **Step 5: 実行権限を付けてテストが通ることを確認**

```bash
chmod +x scripts/aws-cloud-deploy.sh
npx vitest run tests/hooks/aws-cloud-deploy.test.ts
```

Expected: PASS

- [ ] **Step 6: 変異させて確認**

wrapper の `if [ "${DEPLOY_ENV}" != "dev" ]` ブロックを一時的にコメントアウトする。

Run: `npx vitest run tests/hooks/aws-cloud-deploy.test.ts`
Expected: FAIL —「env=dev 以外を拒否する」が落ちる。`git diff` が空でないことを確かめてから戻す。

- [ ] **Step 7: `check-script-wiring.ts` に配線を登録する**

`WIRING_SOURCES` に 1 行追加する（`aws-cloud-deploy.sh` は実際の入口なので、
ここからの参照を配線と数えてよい）:

```ts
  'scripts/aws-cloud-deploy.sh',
```

`MANUAL_ONLY_ALLOWLIST` に 2 件追加する（どちらも入口そのもので、リポジトリ内に
呼び出し元が無くて正しい）:

```ts
  'aws-cloud-deploy.sh':
    'クラウドセッション / routine から呼ぶ入口そのもの。リポジトリ内に呼び出し元は無くて正しい。',
  'aws-issue-credentials.sh':
    '人間がローカル Mac の Admin 環境でデプロイ窓を開けるときだけ走る（値をリポジトリに残さない）。',
```

> `aws-issue-credentials.sh` は Task 6 で作る。**先に allowlist へ入れない**
> （存在しないスクリプト名を allowlist に置くと、綴り間違いに気づけない）。
> Task 6 の Step で追加する。ここで入れるのは `aws-cloud-deploy.sh` の 1 件だけ。

- [ ] **Step 8: 配線検査が green になることを確認**

Run: `npx tsx scripts/check-script-wiring.ts`
Expected: PASS（Task 4 Step 1 で赤かった `aws-diff-gate.ts` / `aws-negative-tests.ts` が、
`aws-cloud-deploy.sh` からの参照によって配線済みになる）

- [ ] **Step 9: 変異させて配線検査が効いていることを確認**

`scripts/aws-cloud-deploy.sh` から `scripts/aws-diff-gate.ts` への参照を 1 箇所だけ
一時的に消す。

Run: `npx tsx scripts/check-script-wiring.ts`
Expected: FAIL — `aws-diff-gate.ts` が未配線として報告される。
`git diff` が空でないことを確かめてから戻す。

- [ ] **Step 10: typecheck と（Task 4 とまとめた）コミット**

```bash
npm run typecheck
git add scripts/aws-diff-gate.ts scripts/aws-negative-tests.ts scripts/aws-preflight.ts \
        scripts/aws-cloud-deploy.sh scripts/check-script-wiring.ts package.json \
        tests/hooks/aws-cloud-deploy.test.ts
git commit -m "feat(infra): クラウドからの dev デプロイ wrapper と gate CLI を追加 (#<issue>)"
```

---

### Task 6: credential 発行スクリプト

**Files:**
- Create: `scripts/aws-issue-credentials.sh`
- Create: `tests/hooks/aws-issue-credentials.test.ts`

**Interfaces:**
- Consumes: なし（人間がローカル Mac の Admin 環境で実行する）
- Produces: `scripts/aws-issue-credentials.sh [--hours N] [--print]`

- [ ] **Step 1: 「値を漏らさない」ことを固定するテストを書く**

`tests/hooks/aws-issue-credentials.test.ts`:

```ts
/**
 * `scripts/aws-issue-credentials.sh` の安全性検証 (spec §8)。
 *
 * **秘密の値を出力・保存しないこと**が本スクリプトの唯一かつ最大の要件なので、
 * そこを機械で固定する。AWS へは接続しない（引数検証と本文の性質だけ見る）。
 */
import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

const SCRIPT = resolve(process.cwd(), 'scripts/aws-issue-credentials.sh');
const source = readFileSync(SCRIPT, 'utf8');

function run(args: ReadonlyArray<string>) {
  try {
    const stdout = execFileSync('bash', [SCRIPT, ...args], {
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    return { status: 0, stdout, stderr: '' };
  } catch (e) {
    const err = e as { status?: number; stdout?: Buffer; stderr?: Buffer };
    return { status: err.status ?? -1, stdout: err.stdout?.toString() ?? '', stderr: err.stderr?.toString() ?? '' };
  }
}

describe('値を残さない', () => {
  it('credential をファイルへ書き出さない', () => {
    expect(source).not.toMatch(/>\s*[^&|\s]*credential/i);
    expect(source).not.toContain('~/.aws/credentials');
  });

  it('既定では値を標準出力へ出さない（--print を明示したときだけ）', () => {
    expect(source).toContain('--print');
    // echo で SecretAccessKey を直接出す行が無いこと
    expect(source).not.toMatch(/echo\s+.*SecretAccessKey/);
  });

  it('set -x（トレース）を有効にしない', () => {
    expect(source).not.toMatch(/^\s*set\s+-[a-z]*x/m);
  });
});

describe('引数の検証', () => {
  it('--hours に 12 を超える値を拒否する', () => {
    const { status, stderr } = run(['--hours', '13']);
    expect(status).not.toBe(0);
    expect(stderr).toContain('12');
  });

  it('--hours に数値でない値を拒否する', () => {
    expect(run(['--hours', 'abc']).status).not.toBe(0);
  });
});

describe('チェーンを固定する', () => {
  it('専用 entry role を assume する', () => {
    expect(source).toContain('OpenReceptionClaudeDeploy-dev');
  });

  it('ExternalId を渡す', () => {
    expect(source).toContain('--external-id');
  });
});
```

- [ ] **Step 2: テストが失敗することを確認**

Run: `npx vitest run tests/hooks/aws-issue-credentials.test.ts`
Expected: FAIL — スクリプトが存在しない

- [ ] **Step 3: スクリプトを書く**

```bash
#!/usr/bin/env bash
# =============================================================================
# デプロイ窓を開ける (spec §8)。**ローカル Mac の Admin 環境で人間が実行する。**
#
#   scripts/aws-issue-credentials.sh [--hours N] [--print]
#
# OpenReceptionClaudeDeploy-dev を assume して短命 STS を発行し、
# claude.ai/code の環境ダイアログへ貼るための値をクリップボードへ入れる。
#
# 🔴 値は既定で表示しない。ファイルにも書かない。ログにも残さない。
#    「窓が開いている＝credential が生きている」なので、状態を二重に持たない。
# =============================================================================
set -euo pipefail

ACCOUNT="822063948773"
ROLE_ARN="arn:aws:iam::${ACCOUNT}:role/OpenReceptionClaudeDeploy-dev"
EXTERNAL_ID="open-reception-claude-cloud-dev"
HOURS=4
PRINT=false

while [ $# -gt 0 ]; do
  case "$1" in
    --hours)
      HOURS="${2:-}"
      shift 2
      ;;
    --print)
      PRINT=true
      shift
      ;;
    *)
      echo "未知の引数: $1" >&2
      exit 2
      ;;
  esac
done

if ! printf '%s' "${HOURS}" | grep -Eq '^[0-9]+$'; then
  echo "--hours には整数を指定してください（1〜12）" >&2
  exit 2
fi
if [ "${HOURS}" -lt 1 ] || [ "${HOURS}" -gt 12 ]; then
  echo "--hours は 1〜12 の範囲で指定してください（指定: ${HOURS}）" >&2
  exit 2
fi

CREDS="$(aws sts assume-role \
  --role-arn "${ROLE_ARN}" \
  --role-session-name "claude-cloud-$(date +%Y%m%d-%H%M)" \
  --external-id "${EXTERNAL_ID}" \
  --duration-seconds "$((HOURS * 3600))" \
  --output json)"

EXPIRY="$(printf '%s' "${CREDS}" | node -e 'let s="";process.stdin.on("data",d=>s+=d).on("end",()=>console.log(JSON.parse(s).Credentials.Expiration))')"

BLOCK="$(printf '%s' "${CREDS}" | node -e '
let s="";process.stdin.on("data",d=>s+=d).on("end",()=>{
  const c = JSON.parse(s).Credentials;
  process.stdout.write(
    `AWS_ACCESS_KEY_ID=${c.AccessKeyId}\n` +
    `AWS_SECRET_ACCESS_KEY=${c.SecretAccessKey}\n` +
    `AWS_SESSION_TOKEN=${c.SessionToken}\n` +
    `AWS_REGION=ap-northeast-1\n` +
    `AWS_CREDENTIAL_EXPIRATION=${c.Expiration}\n`);
});')"

if [ "${PRINT}" = true ]; then
  printf '%s\n' "${BLOCK}"
else
  printf '%s' "${BLOCK}" | pbcopy
  echo "クリップボードへコピーしました（値は表示していません）"
fi

echo "窓が閉じる時刻: ${EXPIRY}（${HOURS} 時間）"
echo "claude.ai/code の環境ダイアログへ 5 つの環境変数を登録してください。"
echo "窓を閉じるときは、同じダイアログから削除してください。"
```

- [ ] **Step 4: テストが通ることを確認**

```bash
chmod +x scripts/aws-issue-credentials.sh
npx vitest run tests/hooks/aws-issue-credentials.test.ts
```

Expected: PASS

- [ ] **Step 5: 変異させて確認**

`--hours` の上限チェック（`[ "${HOURS}" -gt 12 ]`）を一時的に `-gt 24` へ変える。

Run: `npx vitest run tests/hooks/aws-issue-credentials.test.ts`
Expected: FAIL —「`--hours` に 12 を超える値を拒否する」が落ちる。確認したら戻す。

- [ ] **Step 6: 配線検査が赤くなることを確認してから allowlist へ入れる**

先に赤を見る（allowlist の綴りが実ファイル名と一致していることの確認になる）:

```bash
npx tsx scripts/check-script-wiring.ts
```

Expected: FAIL — `aws-issue-credentials.sh` が未配線として報告される。

そのうえで `scripts/check-script-wiring.ts` の `MANUAL_ONLY_ALLOWLIST` へ 1 件追加する:

```ts
  'aws-issue-credentials.sh':
    '人間がローカル Mac の Admin 環境でデプロイ窓を開けるときだけ走る（値をリポジトリに残さない）。',
```

- [ ] **Step 7: 配線検査が green になることを確認してコミット**

```bash
npx tsx scripts/check-script-wiring.ts
git add scripts/aws-issue-credentials.sh tests/hooks/aws-issue-credentials.test.ts scripts/check-script-wiring.ts
git commit -m "feat(infra): デプロイ窓を開ける短命 STS 発行スクリプトを追加 (#<issue>)"
```

---

### Task 7: runbook・ADR・既存ドキュメントの訂正

**Files:**
- Create: `docs/runbook-cloud-aws-deploy.md`
- Create: `docs/adr/0009-claude-cloud-aws-dev-deploy-boundary.md`
- Modify: `docs/cloud-dev-environment.md`（§1 環境変数の方針・§4 の「AWS デプロイ 不可」行）
- Modify: `CLAUDE.md`（「ローカル macOS でしかできないこと」の 2 項目目）
- Modify: `docs/adr/README.md`（ADR 一覧に 0009 を追加）

- [ ] **Step 1: runbook を書く**

`docs/runbook-cloud-aws-deploy.md` に spec §12 の 10 ステップを、**コピペで実行できる
コマンド付き**で書く。最低限これを含める:

1. boundary → entry role（trust + 権限）→ cfn exec policy の作成（`aws iam create-policy` /
   `create-role --permissions-boundary` の実コマンド。JSON は `scripts/aws-policies/` を参照）
2. `cdk bootstrap` を 2 リージョンぶん:
   ```bash
   cd infra
   npx cdk bootstrap aws://822063948773/ap-northeast-1 aws://822063948773/us-east-1 \
     --qualifier orcloud01 \
     --toolkit-stack-name CDKToolkit-orcloud01 \
     --cloudformation-execution-policies arn:aws:iam::822063948773:policy/OpenReceptionClaudeCfnExec-dev \
     --custom-permissions-boundary OpenReceptionClaudeBoundary \
     --trust 822063948773
   ```
3. deploy role への層 1（スタック ARN allowlist）適用
4. `SIMULATE_PRINCIPAL_ARN=... npm run aws:negative-tests -- --simulate-only` を Admin から実行
5. `scripts/aws-issue-credentials.sh --hours 4`
6. 環境ダイアログへ**変数名 5 つ**を登録（値は書かない）
7. `bash scripts/aws-cloud-deploy.sh preflight`
8. `bash scripts/aws-cloud-deploy.sh diff`
9. `bash scripts/aws-cloud-deploy.sh deploy` → `OR_SMOKE_URL=... bash scripts/aws-cloud-deploy.sh smoke`
10. 窓を閉じる／再発行

**トラブルシュート節**に、クラウドの `gh` 制約（`gh pr list` / `gh repo view` は GraphQL 403、
REST の `gh api repos/{owner}/{repo}/...` を使う）を書く。

- [ ] **Step 2: ADR を書く**

`docs/adr/0009-claude-cloud-aws-dev-deploy-boundary.md`。既存 ADR（`0003-realtime-runtime-ec2-phase0.md`）
の書式に合わせ、決定事項を 4 つ記録する:

1. アカウント分離ではなく**専用 CDK qualifier + IAM** で隔離する
2. 主境界は名前 prefix ではなく **CloudFormation スタック ARN**（根拠: §2.3 の実測）
3. **短命 STS の有効期限＝デプロイ窓**とし、状態を二重に持たない
4. IAM Role/Policy の Add・Modify は**止めずに記録する**（根拠: Permissions Boundary）

- [ ] **Step 3: 既存ドキュメントの stale な記述を訂正する**

`docs/cloud-dev-environment.md`:
- §1「環境変数」節を **「長期 secret を置かない。有効期限付きの STS credential のみ可。窓を閉じたら削除する」** へ改訂
- §4 の表の「AWS デプロイ / 不可。対話型 SSO がクラウドセッションで使えない」行を
  **「wrapper 経由で dev のみ可（`docs/runbook-cloud-aws-deploy.md`）。SSO ではなく IAM user だったため、
  当初の理由付けは誤りだった」** へ訂正

`CLAUDE.md` の「ローカル macOS でしかできないこと」:
- 「2. **AWS デプロイ** … 対話型 SSO がクラウドで通らない」を
  **「2. **デプロイ窓を開けること** … 短命 STS の発行だけがローカル。デプロイ自体はクラウドから wrapper 経由で行う」** へ差し替え

- [ ] **Step 4: ドキュメントの相互参照が壊れていないことを確認**

```bash
npx tsx scripts/check-script-wiring.ts
./scripts/quality-gate.sh --fast
```

Expected: どちらも PASS

- [ ] **Step 5: コミット**

```bash
git add docs/runbook-cloud-aws-deploy.md docs/adr/0009-claude-cloud-aws-dev-deploy-boundary.md docs/adr/README.md docs/cloud-dev-environment.md CLAUDE.md
git commit -m "docs(infra): クラウドデプロイの runbook・ADR と stale な制約の訂正 (#<issue>)"
```

---

### Task 8: 品質ゲート・PR・マージ

**Files:** なし（GitHub 上の操作）

- [ ] **Step 1: 品質ゲート（クラウドへ委譲）**

ローカルは `--fast` まで。`--pr` 以上はクラウド routine へ委譲する。

```bash
./scripts/quality-gate.sh --fast
git push -u origin HEAD
npm run delegate:prompt   # 委譲プロンプトを生成する
```

- [ ] **Step 2: PR を作る**

PR 本文に必ず含めるもの:

- **`--full --strict` の結果表**（クラウドで取得したもの）
- **negative test の実出力**（S 系 `SimulatePrincipalPolicy` の結果。spec §7「policy を読む限り
  安全で終わらせない」の証拠）
- **「人間承認が必要な変更」節**に、§10 の `user/CDK` 報告と、IAM 実適用が未実施であること
- **`cdk deploy` を一度も実行していないこと**の明記

- [ ] **Step 3: セルフレビュー**

`/code-review` と `pr-review-toolkit:silent-failure-hunter` を回す。
とくに **wrapper が失敗を握り潰していないか**（`|| true` / `set -e` の抜け）を見る。

- [ ] **Step 4: マージ**

ゲート green かつ blocking 指摘なしなら squash + `--delete-branch`。
**クラウド内で完結させる**（ゲートスタンプはローカル `.git` にあるため）。
マージ後、ブランチが残っていないかを確認する（クラウド側が消さない実績が 3 件ある）:

```bash
git push origin --delete <branch> 2>/dev/null || true
git branch -D <branch> 2>/dev/null || true
```

---

## 完了後の報告（spec §DoD）

実装完了時に次を報告して**停止する**:

1. 実装した security architecture
2. AWS identity chain
3. production isolation の根拠（層 1〜4 と、層 2 が「Deny」ではなく「論拠」である点）
4. negative test 結果（S 系シミュレーションの実出力）
5. 作成 / 変更した scripts
6. runbook の場所
7. 残存リスク（spec §13 + `user/CDK`）
8. 人間が次に実行するコマンド（runbook のステップ 1 から）
