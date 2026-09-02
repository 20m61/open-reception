import { readFileSync, readdirSync } from 'node:fs';
import { join, relative, resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

/**
 * **書き込みの結果を捨てない** (#870 増分 02)。
 *
 * ## 何が起きていたか
 *
 * 管理画面の書き込みが `await fetch(...)` の**戻りを見ずに** `await load()` していた。
 * 403 / 409 / 5xx でも一覧を取り直すだけなので、行は静かに元へ戻る。運用者には
 * **「何も起きなかった」のか「失敗した」のかが区別できない**。viewer ロールが担当者を
 * 無効化したつもりで無効化できていない、削除したつもりの受付フローが来訪者に出続ける、
 * といったことが黙って起こる。
 *
 * ## 検出器は「文として捨てられた fetch」を見る
 *
 * 判定は単純な形にした —— **`await fetch(...)` が文として現れる**なら、その戻りはどこにも
 * 束縛されておらず、結果を見る術が無い。`const res = await fetch(...)` に変えれば必ず
 * `res` を検査する枝を書くことになる。
 *
 * これは**下界の検出器**であることを明記しておく。`Promise.all(xs.map(() => fetch(...)))` の
 * ように束縛されないまま捨てられる形は捕まえられない（`ReceptionFlowsManager` の並び替えが
 * まさにそれで、本 PR では手で直した）。**「この検査が緑＝全部の書き込みが検査されている」
 * ではない。**「明らかに捨てている形が増えていない」だけである。
 *
 * ## 残っているものは登録簿に載せる
 *
 * 未対応を allowlist に置くのは黙らせるためではなく、**増えたら落とすため**。
 * ここに無いファイルが捨て書き込みを持てば落ちる。
 *
 * 🔴 **この allowlist は「縮むこと」を機械で強制していない。** 強制すると、並行して走る
 * ほかの PR（本 PR と同時期の #879 / #881 が同じファイル群に触る）がマージされた瞬間に
 * 別の PR の検査が壊れる。**縮む方向の圧力は Issue で持ち、機械は「増えないこと」だけを
 * 見る**という分担にした。
 */
const ADMIN_DIR = resolve(process.cwd(), 'src/components/admin');

/** 文として書かれた fetch（戻りがどこにも束縛されていない）。 */
const DISCARDED_FETCH = /^\s*(?:await|void)\s+fetch\(/gm;

function findTsx(dir: string): string[] {
  const found: string[] = [];
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const path = join(dir, entry.name);
    if (entry.isDirectory()) found.push(...findTsx(path));
    else if (entry.name.endsWith('.tsx') && !entry.name.endsWith('.test.tsx')) found.push(path);
  }
  return found;
}

/**
 * #870 増分 02 で直した画面。**ここは 0 件でなければならない。**
 *
 * Issue が挙げていた `CallRoutesManager` は #873（PR #879）で画面ごと削除されるため対象外。
 */
const FIXED = [
  'SitesManager.tsx',
  'StaffManager.tsx',
  'StaffEditor.tsx',
  'DepartmentsManager.tsx',
  'ReceptionFlowsManager.tsx',
  'KiosksManager.tsx',
  'MotionsManager.tsx',
] as const;

/**
 * まだ捨て書き込みが残っている画面。**本 PR の対象外**で、理由つきで登録する。
 *
 * 触らなかったのは意図的で、いずれも**同時期の別 PR が同じファイルを触っており**、
 * ここで直すとマージ衝突を作るため（マージは直列・`CLAUDE.md`）。
 */
const KNOWN_REMAINING: Readonly<Record<string, string>> = {
  /** #873（PR #879）で画面ごと削除される。 */
  'CallRoutesManager.tsx': '削除予定',
  /** #870 増分 03/04（PR #881）が読み取り側を触っている。 */
  'SecurityManager.tsx': '別 PR が同ファイルを変更中',
  /** 同上。 */
  'integrations/IntegrationsManager.tsx': '別 PR が同ファイルを変更中',
  /** Issue のリストに無く、本増分の対象外。 */
  'AssetsManager.tsx': '未対応（Issue のリスト外）',
  'RoutingPolicyManager.tsx': '未対応（Issue のリスト外）',
  'demo-studio/DemoStudio.tsx': '未対応（Issue のリスト外・開発者向け画面）',
};

const SCREENS = findTsx(ADMIN_DIR).map((path) => ({
  key: relative(ADMIN_DIR, path),
  discarded: (readFileSync(path, 'utf8').match(DISCARDED_FETCH) ?? []).length,
}));

describe('書き込みの結果を捨てない (#870 増分 02)', () => {
  it('走査が admin の画面を 20 件以上見ている（空振りしていない＝下界）', () => {
    expect(SCREENS.length).toBeGreaterThanOrEqual(20);
  });

  it('検出器が実際に何かを検出できる（allowlist が空でない＝下界）', () => {
    // 全部 0 件になったら検出器が壊れている可能性がある。allowlist を空にする日は、
    // この検査ごと畳んでよい。
    const remaining = SCREENS.filter((s) => s.discarded > 0);
    expect(remaining.length).toBeGreaterThan(0);
  });

  it.each(FIXED)('%s は書き込みの結果を捨てていない', (key) => {
    const screen = SCREENS.find((s) => s.key === key);
    expect(screen, `${key} が見つからない`).toBeDefined();
    expect(
      screen?.discarded,
      `${key} に戻りを束縛しない fetch がある。const res = await fetch(...) にして ` +
        '!res?.ok の枝で失敗を伝えること（SaveFeedback を使う）',
    ).toBe(0);
  });

  it('登録簿に無い画面が捨て書き込みを持たない（増えたら落とす）', () => {
    const unregistered = SCREENS.filter(
      (s) => s.discarded > 0 && !(s.key in KNOWN_REMAINING),
    ).map((s) => s.key);
    expect(unregistered).toEqual([]);
  });
});
