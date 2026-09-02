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
import { approvalToken, isApproved } from '../src/domain/governance/deploy-approval-token';
import {
  ALLOWED_STACK_PATTERN,
  evaluateDeployChangeSet,
  type ChangeSetResourceChange,
  type ChangeSetSummary,
  type StackTemplateResources,
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
 * CloudFormation が「変更なし」を伝えるときの `StatusReason` の接頭辞。
 *
 * CDK には全く同じ判定を行う名前付き述語がある
 * （`infra/node_modules/aws-cdk/lib/index.js` を `didn't contain changes` で検索）。
 * `--no-execute` 付きで change set を作ると、この「変更なし」の場合も CloudFormation は
 * 空の change set を `Status: 'FAILED'` のまま残す。`diff`/`deploy` は 3 スタックを
 * ループし、そのうち少なくとも 1 つは変更が無いのが通常運用なので、これを
 * 「判定不能」と一律に止めると**ほぼ毎回**実行が止まってしまう
 * （2026-08-12 レビューで指摘。以前の実装は自己申告の留保事項だった）。
 */
const NO_OP_STATUS_REASON_PREFIXES = [
  "The submitted information didn't contain changes.",
  'No updates are to be performed.',
] as const;

/**
 * `Status: 'FAILED'` が「本当に危険で判定不能」ではなく「単に変更が無かった」ことを
 * `StatusReason` の接頭辞から判定する。**この 2 パターン以外の `FAILED`（あるいは
 * `Status` 自体の欠落）は、引き続き無条件で止める。**「変更なしに見えるが実は違う」を
 * 拾わないよう、接頭辞一致に限定し、部分一致や大小無視はしない
 * （CloudFormation が返す文言はサービス側の固定文字列であり、揺れを許容する理由が無い）。
 *
 * 🔴 **LOW fail-open（2026-08-12 レビュー第 3 ラウンド）: `StatusReason` の一致だけでは
 * 不十分だった。** `evaluateDeployChangeSet` を呼ばずに早期 return すると、
 * Task 1 が確立した `unexpectedStack`（許可されていないスタック名）チェックも一緒に
 * スキップしてしまう。「foreign スタックを名乗りつつ no-op 理由文字列を持つ `FAILED`」や
 * 「no-op 理由文字列を持ちながら実は `Changes` が空でない `FAILED`」（本来ありえない
 * 組み合わせだが、入力を信頼しない）を通してしまわないよう、ここで
 * `Changes` が実際に空であることも条件に含める。**スタック名の検証は呼び出し側
 * （`main()`）で `ALLOWED_STACK_PATTERN` に対して行う**（`evaluateDeployChangeSet` と
 * 同じ検証を、通常経路を経由せずに行う必要があるため）。
 */
function isNoOpChangeSet(raw: RawChangeSet): boolean {
  if (raw.Status !== 'FAILED') return false;
  if ((raw.Changes ?? []).length > 0) return false;
  const reason = raw.StatusReason ?? '';
  return NO_OP_STATUS_REASON_PREFIXES.some((prefix) => reason.startsWith(prefix));
}

/**
 * 欠落を「問題なし」に落とさない。`Action` が読めなければ `'Unknown'` として扱い、
 * evaluateDeployChangeSet の `unknownAction` ブロックに掛かるようにする
 * （Add/Modify 以外は保守的に stop する。§6 の SAFE_ACTIONS 参照）。
 */
function toSummary(
  raw: RawChangeSet,
  stackNameArg: string,
  templateResources: StackTemplateResources,
): ChangeSetSummary {
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
  return { stackName: raw.StackName ?? stackNameArg, changes, templateResources };
}

/**
 * synth 済みテンプレート（`infra/cdk.out/<stack>.template.json`）の `Resources` から
 * 「論理 ID → Properties」を作る。
 *
 * 🔴 **読めなければ空 `{}` を返さない。** `describe-change-set` はプロパティの値を
 * 返さないので、テンプレートが読めないと #680 R10 の検査（carve-out の名前空間・
 * Function URL・公開 invoke）が**まるごと空振りしたまま green になる**。
 * 「読めなかった」を「問題なかった」に落とすのは、このリポジトリが何度も
 * 踏んでいる形（`lesson-empty-string-means-unknown`）なので、throw する。
 */
function readTemplateResources(path: string): StackTemplateResources {
  let parsed: unknown;
  try {
    parsed = JSON.parse(readFileSync(path, 'utf8'));
  } catch (e) {
    throw new Error(`synth テンプレートを読めません: ${path} (${(e as Error).message})`);
  }
  const resources =
    typeof parsed === 'object' && parsed !== null
      ? (parsed as { Resources?: unknown }).Resources
      : undefined;
  if (typeof resources !== 'object' || resources === null) {
    throw new Error(`synth テンプレートに Resources がありません: ${path}`);
  }
  const out: Record<string, { type: string; properties: Readonly<Record<string, unknown>> }> = {};
  for (const [logicalId, resource] of Object.entries(resources as Record<string, unknown>)) {
    const entry =
      typeof resource === 'object' && resource !== null
        ? (resource as { Type?: unknown; Properties?: unknown })
        : {};
    // 🔴 `Type` が読めないときに `''` で埋めない。gate 側は「Ref 先が
    // AWS::IAM::Role である」ことを Type で確かめるので、未知は未知として渡し、
    // 判定不能（＝停止）に落ちるようにする。
    out[logicalId] = {
      type: typeof entry.Type === 'string' ? entry.Type : 'Unknown',
      properties:
        typeof entry.Properties === 'object' && entry.Properties !== null
          ? (entry.Properties as Readonly<Record<string, unknown>>)
          : {},
    };
  }
  return out;
}

/**
 * 承認（`OR_APPROVED_DIFF`）が効くモード。
 *
 * 🔴 **既定は `diff`（＝承認を無視する）。** モードを渡し忘れた呼び出しが「承認が効く」側に
 * 倒れると、gate の停止が黙って無効化されうる。未知の値も `diff` として扱う。
 */
function parseMode(raw: string | undefined): 'diff' | 'deploy' {
  return raw === 'deploy' ? 'deploy' : 'diff';
}

function main(): void {
  const [jsonPath, stackName, templatePath, modeArg] = process.argv.slice(2);
  const mode = parseMode(modeArg);
  if (jsonPath === undefined || stackName === undefined || templatePath === undefined) {
    console.error(
      'Usage: tsx scripts/aws-diff-gate.ts <change-set-json> <stack-name> <synth-template-json> [diff|deploy]',
    );
    console.error(
      '  <synth-template-json> は infra/cdk.out/<stack-name>.template.json。' +
        'describe-change-set はプロパティの値を返さないため、これが無いと IAM ロールや' +
        ' Function URL の中身を検査できません（#680 R10）。',
    );
    process.exit(2);
  }

  const raw = JSON.parse(readFileSync(jsonPath, 'utf8')) as RawChangeSet;

  // Status を見ずに Changes だけを見ると、change set 作成そのものが FAILED でも
  // 「変更 0 件 → 安全」に見えてしまう（上記コメント参照）。CREATE_COMPLETE 以外は
  // 内容を安全に判定できないものとして止める ―― ただし「変更が無かっただけ」の
  // FAILED（isNoOpChangeSet）は例外で、安全側に倒しつつ実行を継続する。
  if (raw.Status !== 'CREATE_COMPLETE') {
    if (isNoOpChangeSet(raw)) {
      const noOpStackName = raw.StackName ?? stackName;
      // 🔴 no-op 早期 return は `evaluateDeployChangeSet` を経由しないため、
      // Task 1 由来の `unexpectedStack` 検証をここで代わりに行う。省略すると、
      // 許可されていないスタック名を名乗る「変更なし」ペイロードを素通りさせてしまう。
      if (!ALLOWED_STACK_PATTERN.test(noOpStackName)) {
        console.error(
          `  ⛔ change set は「変更なし」ですが、stack=${noOpStackName} は許可パターン` +
            ` (${ALLOWED_STACK_PATTERN.source}) に一致しません。`,
        );
        console.error('  → 人間が確認してください。');
        process.exit(1);
      }
      console.log(`  stack: ${noOpStackName} / 変更なし（${raw.StatusReason}）`);
      console.log('  ✅ 危険な変更はありません（自動デプロイ可）');
      return;
    }
    console.error(
      `  ⛔ change set の Status が CREATE_COMPLETE ではありません（Status=${raw.Status ?? 'Unknown'}` +
        `${raw.StatusReason ? `: ${raw.StatusReason}` : ''}）。`,
    );
    console.error('  → 変更内容を安全に判定できないため自動デプロイを停止します。人間が確認してください。');
    process.exit(1);
  }

  // 🔴 no-op 早期 return より**後**で読む。「変更なし」の change set には
  // 検査対象が 1 件も無いので、テンプレートの有無で運用を止める理由が無い。
  let templateResources: StackTemplateResources;
  try {
    templateResources = readTemplateResources(templatePath);
  } catch (e) {
    console.error(`  ⛔ ${(e as Error).message}`);
    console.error('  → 中身を検査できないため自動デプロイを停止します（#680 R10）。');
    process.exit(1);
  }

  const summary = toSummary(raw, stackName, templateResources);
  const verdict = evaluateDeployChangeSet(summary);

  console.log(`  stack: ${summary.stackName} / 変更 ${summary.changes.length} 件`);
  for (const flag of verdict.flags) {
    console.log(`  ⚠ 記録: [${flag.reason}] ${flag.evidence}`);
  }
  if (!verdict.blocked) {
    console.log('  ✅ 危険な変更はありません（自動デプロイ可）');
    return;
  }
  const token = approvalToken(summary.stackName, verdict.blocks);

  // 🔴 **承認が効くのは `deploy` のときだけ。** `diff` は素の判定を見せる場所であり、
  // ここで承認を効かせると「承認済みだから差分が無いように見える」状態を作ってしまう。
  if (mode === 'deploy' && isApproved(summary.stackName, verdict.blocks, process.env.OR_APPROVED_DIFF)) {
    console.error(
      `  ⚠️ 人間の承認により ${verdict.blocks.length} 件のブロックを通過します（トークン一致）: ${token}`,
    );
    // 何を承認したのかを必ず残す。「承認した」だけのログは後から検証できない。
    for (const block of verdict.blocks) {
      console.error(`    - [${block.reason}] ${block.evidence}`);
    }
    return;
  }

  console.error('  ⛔ 危険な変更を検出したため自動デプロイを停止します:');
  for (const block of verdict.blocks) {
    console.error(`    - [${block.reason}] ${block.evidence}`);
  }
  console.error(`  承認トークン: ${token}`);
  console.error(
    '  → 内容を確認のうえ承認する場合は、このトークンを OR_APPROVED_DIFF に渡して deploy してください' +
      '（トークンはこの差分に固定されており、差分が変われば無効になります）',
  );
  process.exit(1);
}

main();
