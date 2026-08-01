/**
 * 変更リスクの報告 CLI (issue #424 増分 3)。
 *
 * `src/domain/governance/change-risk.ts`（純関数）へ、git から集めた変更パスと追加依存名を
 * 渡して結果を印字する。判定ロジックはここに持たない（I/O だけ）。
 *
 * `scripts/quality-gate.sh` が毎回呼ぶ。**別系統のチェッカを増やすと誰も回さない**ので、
 * 単独の手動コマンドにはしない（`docs/ai-development-loop.md` §9「既に在るので作らないもの」）。
 *
 * **報告専用で、ゲートを FAIL させない。** これは検出器であって判定者ではなく、偽陽性に
 * 倒してある（`change-risk.ts` の冒頭参照）。ここで止めると、非破壊な API 追加のたびに
 * ゲートが赤くなり、赤を無視する習慣がつく方が危険。承認の実行は人間が行う。
 */
import { execFileSync } from 'node:child_process';
import {
  addedDependencyNames,
  classifyChangeRisk,
  type DependencyManifest,
} from '../src/domain/governance/change-risk';
import { resolveBase } from '../src/domain/governance/git-base';

/** 停止境界の日本語ラベル（`docs/ai-development-loop.md` §6 の文言に合わせる）。 */
const BOUNDARY_LABEL = {
  productionDeploy: '本番デプロイ / 本番データ操作',
  authBoundary: '認証・認可・PIN/IP 制御の境界変更',
  persistenceOrPublicApi: '永続スキーマ・公開 API の非互換変更',
  externalTransmission: '新しい外部送信',
  secretOrPii: 'secret / PII / 監査ログ方針の変更',
  dependency: '新規依存・ライセンス判断 (#105)',
  recurringCost: '継続的な費用増',
  journeyOrStateModel: '主要 Journey・state・fallback の意味を変える仕様判断',
} as const;

function git(args: ReadonlyArray<string>): string {
  return execFileSync('git', [...args], { encoding: 'utf8' });
}

/** 失敗しても報告を止めない（git の状態は環境で揺れる。報告のために壊さない）。 */
function tryGit(args: ReadonlyArray<string>): string | null {
  try {
    return git(args);
  } catch {
    return null;
  }
}

/**
 * 比較起点。**`change-budget.ts` と同じ実装を共有する** (#557)。
 *
 * 同じ問いに 2 つの実装があると、同一実行の中で違う数字を出しても気づけない
 * （#557 では 1 番目が 47 ファイル、末尾のここが 7 件だった）。
 */
const resolveBaseRef = (): string | null => resolveBase(tryGit);

/**
 * 変更パスを集める。**ゲートが実際に検査するのは作業ツリー**なので、
 * ブランチのコミット分と未コミット分の両方を見る。
 */
function changedPaths(base: string | null): ReadonlyArray<string> {
  const paths = new Set<string>();
  if (base !== null) {
    for (const line of (tryGit(['diff', '--name-only', base, 'HEAD']) ?? '').split('\n')) {
      if (line.trim() !== '') paths.add(line.trim());
    }
  }
  // 未コミット（staged / unstaged / untracked）。porcelain の先頭 2 桁は状態コード。
  // **`-uall` が必須**: 既定の porcelain は未追跡ディレクトリを `src/foo/` の 1 行へ畳むので、
  // 新しいディレクトリに置いたファイルがまるごと判定から消える（実際に踏んだ）。
  for (const line of (tryGit(['status', '--porcelain', '-uall']) ?? '').split('\n')) {
    if (line.trim() === '') continue;
    const path = line.slice(3).trim();
    // リネームは "old -> new" 形式。新しい側を見る。
    paths.add(path.includes(' -> ') ? path.split(' -> ')[1]! : path);
  }
  return [...paths];
}

function manifestAt(ref: string | null, path: string): DependencyManifest {
  const raw = ref === null ? null : tryGit(['show', `${ref}:${path}`]);
  if (raw === null) return {};
  try {
    return JSON.parse(raw) as DependencyManifest;
  } catch {
    return {};
  }
}

function currentManifest(path: string): DependencyManifest {
  // HEAD ではなく作業ツリーの内容を見る（未コミットの依存追加を見落とさない）。
  const raw = tryGit(['show', `:${path}`]) ?? tryGit(['show', `HEAD:${path}`]);
  if (raw === null) return {};
  try {
    return JSON.parse(raw) as DependencyManifest;
  } catch {
    return {};
  }
}

function main(): void {
  const base = resolveBaseRef();
  const paths = changedPaths(base);
  const added = [
    ...addedDependencyNames(manifestAt(base, 'package.json'), currentManifest('package.json')),
    ...addedDependencyNames(
      manifestAt(base, 'infra/package.json'),
      currentManifest('infra/package.json'),
    ),
  ];
  const assessment = classifyChangeRisk({ paths, addedDependencies: added });

  console.log(`  変更ファイル: ${paths.length} 件（起点: ${base?.slice(0, 8) ?? 'なし'}）`);
  if (!assessment.requiresHumanApproval) {
    console.log('  停止境界に触れていません（人間承認は不要）');
    return;
  }

  console.log('  ⚠ 人間承認が必要な変更に触れています:');
  for (const { boundary, evidence } of assessment.hits) {
    console.log(`    - ${BOUNDARY_LABEL[boundary]}`);
    for (const item of evidence.slice(0, 5)) console.log(`        ${item}`);
    if (evidence.length > 5) console.log(`        … 他 ${evidence.length - 5} 件`);
  }
  console.log('  → PR の「人間承認が必要な変更」節にチェックを入れ、マージ前に確認する');
  console.log('  （検出器なので偽陽性はある。非破壊と判断できるなら理由を PR に書く）');
}

main();
