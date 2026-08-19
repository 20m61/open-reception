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
  type ChangeScope,
  classifyChangeScope,
  effectiveScope,
  isStepSkippable,
  SKIPPABLE_STEPS,
} from '../src/domain/governance/change-scope';
import { collectChangedPaths, resolveBase } from '../src/domain/governance/git-base';

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
 * 変更範囲を決める。**測れていないなら省略しない** (#712)。
 *
 * ## 全滅は安全側だが、部分失敗は安全側ではない
 *
 * `classifyChangeScope([])` が `code` を返すので、収集が**全部**失敗すれば安全側に倒れる。
 * 塞げていなかったのは**部分失敗**:
 *
 *   `git diff` だけ失敗（コミット済みのコード変更が消える）
 *     + 未コミットが docs のみ → paths は非空・docs のみ → `docs` → 検証が飛ぶ
 *
 * `change-risk` と違ってここは**二値の判定を必ず出さねばならない**ので、保留ではなく
 * **厳しい方（`code`）へ倒す**（この向きは `change-scope.ts` の設計原則どおりで、
 * `change-risk.ts` とは逆）。
 *
 * ## なぜ黙って倒さないのか
 *
 * `quality-gate.sh` は `scope` が `code` のとき何も表示しない。黙って倒すと、
 * ガードが効いているかどうかを確かめる術が無くなる（「保留メッセージを見たことがない」＝
 * 「効いている」ではない）。理由を `note=` として stdout に出し、シェルに見せる。
 */
function main(): void {
  // `--strict`（定期実行）では省略しない。判断は domain 側の `effectiveScope` が持つ。
  const strict = process.argv.includes('--strict');
  const base = resolveBaseRef();
  const notes: string[] = [];
  let detected: ChangeScope = 'code';

  if (base === null) {
    // 起点が解決できないなら比較のしようがない → 省略しない。
    notes.push('起点を解決できないため変更範囲を測れていません。省略しません');
  } else {
    const collected = collectChangedPaths(tryGit, base);
    if (collected.failures.length > 0) {
      notes.push(
        `変更パスを集めきれないため省略しません（失敗: ${collected.failures.join(' / ')}）`,
      );
    } else {
      detected = classifyChangeScope(collected.paths);
    }
  }

  const scope = effectiveScope(detected, { strict });
  console.log(`scope=${scope}`);
  for (const step of SKIPPABLE_STEPS) {
    if (isStepSkippable(step, scope)) console.log(`skip=${step}`);
  }
  // **`note=` は `scope=` / `skip=` の後**（シェルは行ごとに読むので順序は自由だが、
  // 人が読むときに判定結果が先に来る方が読みやすい）。
  for (const note of notes) console.log(`note=${note}`);
}

main();
