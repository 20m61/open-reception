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
  /**
   * `describe-change-set` のトップレベル `Status`。
   *
   * 🔴 **`Changes` が空だから安全とは限らない。** change set の作成自体が
   * `FAILED` になった場合（例: 作成中のエラー、あるいは「差分なし」以外の理由での
   * 失敗）でも `Changes` は空配列になり得る。`Status` を見ずに `Changes` だけで
   * 判定すると、`evaluateDeployChangeSet` は変更 0 件として `blocked: false` を返し、
   * 「危険な変更はありません」と誤って印字してしまう（fail-open。Important smaller
   * items, 2026-08-12 レビュー）。`CREATE_COMPLETE` 以外は内容を判定できないものとして
   * 保守的に止める。
   */
  readonly Status?: string;
  readonly StatusReason?: string;
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
 * evaluateDeployChangeSet の `unknownAction` ブロックに掛かるようにする
 * （Add/Modify 以外は保守的に stop する。§6 の SAFE_ACTIONS 参照）。
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

  // Status を見ずに Changes だけを見ると、change set 作成そのものが FAILED でも
  // 「変更 0 件 → 安全」に見えてしまう（上記コメント参照）。CREATE_COMPLETE 以外は
  // 内容を安全に判定できないものとして止める。
  if (raw.Status !== 'CREATE_COMPLETE') {
    console.error(
      `  ⛔ change set の Status が CREATE_COMPLETE ではありません（Status=${raw.Status ?? 'Unknown'}` +
        `${raw.StatusReason ? `: ${raw.StatusReason}` : ''}）。`,
    );
    console.error('  → 変更内容を安全に判定できないため自動デプロイを停止します。人間が確認してください。');
    process.exit(1);
  }

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
