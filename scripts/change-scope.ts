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
  isStepSkippable,
  SKIPPABLE_STEPS,
} from '../src/domain/governance/change-scope';

function tryGit(args: ReadonlyArray<string>): string | null {
  try {
    return execFileSync('git', [...args], { encoding: 'utf8' });
  } catch {
    return null;
  }
}

/** 比較起点。`origin/main` → `main` の順。無ければ null。 */
function resolveBase(): string | null {
  for (const ref of ['origin/main', 'main']) {
    if (tryGit(['rev-parse', '--verify', '--quiet', ref]) !== null) {
      const mergeBase = tryGit(['merge-base', ref, 'HEAD']);
      if (mergeBase !== null) return mergeBase.trim();
    }
  }
  return null;
}

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
  const base = resolveBase();
  // 起点が解決できないなら比較のしようがない → 省略しない。
  const scope = base === null ? 'code' : classifyChangeScope(changedPaths(base));
  console.log(`scope=${scope}`);
  for (const step of SKIPPABLE_STEPS) {
    if (isStepSkippable(step, scope)) console.log(`skip=${step}`);
  }
}

main();
