/**
 * 変更範囲の判定 CLI（ゲートのステップ省略に使う）。
 *
 * `src/domain/governance/change-scope.ts`（純関数）へ、git から集めた変更パスを渡して
 * `scope=` と `skip=` を印字する。**省略してよいステップ名も TS 側から出す**（shell に
 * 同じ一覧を書くと二重管理になり、片方だけ直ってズレる）。
 *
 * 出力（1 行 1 項目・shell が読みやすい形）:
 *   scope=docs
 *   skip=build
 *   skip=e2e
 *
 * 判定できないときは**必ず `scope=code`**（＝何も省略しない）へ倒す。ここで楽観に倒すと
 * 検証していないツリーが green になる。
 */
import { execFileSync } from 'node:child_process';
import {
  classifyChangeScope,
  effectiveScope,
  isStepSkippable,
  SKIPPABLE_STEPS,
} from '../src/domain/governance/change-scope';
import { resolveBase } from '../src/domain/governance/git-base';

function tryGit(args: ReadonlyArray<string>): string | null {
  try {
    return execFileSync('git', [...args], { encoding: 'utf8' });
  } catch {
    return null;
  }
}

/**
 * 比較起点。**`change-budget.ts` / `change-risk.ts` と同じ実装を共有する** (#557 follow-up)。
 *
 * ここは唯一**ステップを省略できる**消費者なので、起点がずれると docs 判定になって
 * build / e2e / sast / lighthouse が飛ぶ。3 つ目の写しを残さない。
 */
const resolveBaseRef = (): string | null => resolveBase(tryGit, process.env.GATE_BASE_SHA);

/**
 * 変更パス。ゲートが検査するのは作業ツリーなので、ブランチのコミット分と未コミット分の両方。
 * `-uall` が必須（既定の porcelain は未追跡ディレクトリを 1 行へ畳む）。
 */
function changedPaths(base: string | null): ReadonlyArray<string> {
  const paths = new Set<string>();
  if (base !== null) {
    for (const line of (tryGit(['diff', '--name-only', base, 'HEAD']) ?? '').split('\n')) {
      if (line.trim() !== '') paths.add(line.trim());
    }
  }
  for (const line of (tryGit(['status', '--porcelain', '-uall']) ?? '').split('\n')) {
    if (line.trim() === '') continue;
    const path = line.slice(3).trim();
    paths.add(path.includes(' -> ') ? path.split(' -> ')[1]! : path);
  }
  return [...paths];
}

function main(): void {
  // `--strict`（定期実行）では省略しない。判断は domain 側の `effectiveScope` が持つ。
  const strict = process.argv.includes('--strict');
  const base = resolveBaseRef();
  // 起点が解決できないなら比較のしようがない → 省略しない。
  const detected = base === null ? 'code' : classifyChangeScope(changedPaths(base));
  const scope = effectiveScope(detected, { strict });
  console.log(`scope=${scope}`);
  for (const step of SKIPPABLE_STEPS) {
    if (isStepSkippable(step, scope)) console.log(`skip=${step}`);
  }
}

main();
