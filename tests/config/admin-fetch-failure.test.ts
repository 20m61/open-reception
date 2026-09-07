import { describe, expect, it } from 'vitest';
import { readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import {
  fetchSites,
  reportsFailure,
  stripComments,
  tryCatchBlocks,
} from '../../src/domain/governance/fetch-failure-scan';

/**
 * 管理画面の通信失敗が無言にならない (#973)。
 *
 * ## なぜ台帳なのか（免除簿ではない）
 *
 * #968 が platform に対してやったのと同じ検査を `src/components/admin/**` へ広げると、
 * 起票時点で **77 箇所**が「reject を報告しない」側に落ちる。一度に直せる量ではないので、
 * issue の AC6 が明示するとおり**ラチェット**を置く。
 *
 * 🔴 **これは「直さなくてよい」一覧ではない。** 直したら**配列から消す**（消さないと
 * 「まだ残っている」と嘘をつく検査になる）。増やすには配列を触るしかないので、黙って
 * 増えることはない。`check-cjk-literals.ts` の例外リストと同じ型で、**ドリフト**
 * （もう直っているのに残っている）も落とす。
 *
 * ## 走査は platform と同じものを使う
 *
 * `src/domain/governance/fetch-failure-scan.ts`（#968 が積み上げた走査。拡張子軸・
 * ディレクトリ軸・空引数・空白 1 文字まで塞いである）を**共有**する。写しを作ると、
 * 片方に入った修正がもう片方へ入らず、しかも誰も気づかない。
 *
 * ## この検査が見ていないもの（正直に書く）
 *
 * - **呼び出し位置の粒度**なので、`fetch` を helper へ切り出して呼び出し側で `catch` する形は
 *   「無防備」に数える（`use-site-list.ts` が実際にそれ）。直すときは**中身を読んでから**
 *   判断すること —— 台帳から消す条件は「機械が緑になった」ではなく「失敗が画面に出る」である
 * - 形の壊れた 200（AC7〜AC10）は platform 側と同じく別の検査で、ここでは見ていない
 */

const ADMIN_DIR = join(process.cwd(), 'src/components/admin');

/**
 * まだ「失敗を報告する `catch`」を持たない呼び出しの数（ファイルごと）。
 *
 * 🔴 **直したら消す。減らす以外の更新は PR に理由を書くこと。**
 */
const REMAINING: ReadonlyMap<string, number> = new Map([
  ['AiGuidanceManager.tsx', 2],
  ['AssetsManager.tsx', 2],
  ['auth/AuthMethodSettings.tsx', 1],
  ['BrandingManager.tsx', 2],
  ['costs/CostManager.tsx', 1],
  ['CsvImport.tsx', 1],
  ['dashboard/Dashboard.tsx', 1],
  ['demo-studio/DemoStudio.tsx', 13],
  ['DepartmentsManager.tsx', 4],
  ['DevicesManager.tsx', 1],
  ['integrations/IntegrationsManager.tsx', 4],
  ['KiosksManager.tsx', 3],
  ['LanguageSettingsManager.tsx', 2],
  ['MotionsManager.tsx', 2],
  ['OperatingHoursManager.tsx', 2],
  ['ReceptionFlowsManager.tsx', 5],
  ['ReservationsManager.tsx', 5],
  ['RoutingPolicyManager.tsx', 7],
  ['SecurityManager.tsx', 3],
  ['SignageManager.tsx', 1],
  ['SitesManager.tsx', 2],
  ['StaffEditor.tsx', 1],
  ['StaffManager.tsx', 6],
  ['StayManager.tsx', 1],
  ['usage/UsageManager.tsx', 1],
  ['use-site-list.ts', 1],
  ['VoiceManager.tsx', 2],
]);

/** 台帳の合計。**上げるときは PR に理由を書く。** */
const REMAINING_TOTAL = [...REMAINING.values()].reduce((sum, n) => sum + n, 0);

function adminFiles(): { name: string; source: string }[] {
  const out: { name: string; source: string }[] = [];
  const walk = (dir: string, prefix: string): void => {
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      const path = join(dir, entry.name);
      const name = prefix ? `${prefix}/${entry.name}` : entry.name;
      if (entry.isDirectory()) {
        // platform は #968 が専用の検査を持っている（形の述語まで見る）。二重に数えない。
        if (entry.name !== 'platform') walk(path, name);
        continue;
      }
      // 🔴 拡張子軸で漏らさない。`.ts` の hook へ `fetch` を切り出すだけで母集団から
      // 外れる形は #968 レビューが実測している（`use-site-list.ts` が現に `.ts`）。
      if (/\.tsx?$/.test(entry.name) && !entry.name.includes('.test.')) {
        out.push({ name, source: stripComments(readFileSync(path, 'utf8')) });
      }
    }
  };
  walk(ADMIN_DIR, '');
  return out;
}

/** 「失敗を報告する `catch`」に囲まれていない `fetch` の数（ファイルごと）。 */
function unguardedByFile(): Map<string, number> {
  const counts = new Map<string, number>();
  for (const { name, source } of adminFiles()) {
    const blocks = tryCatchBlocks(source);
    let unguarded = 0;
    for (const site of fetchSites(source)) {
      const guard = blocks.find((b) => site >= b.tryBody.start && site < b.tryBody.end);
      if (guard === undefined) {
        unguarded += 1;
        continue;
      }
      if (!reportsFailure(source.slice(guard.catchBody.start, guard.catchBody.end))) unguarded += 1;
    }
    if (unguarded > 0) counts.set(name, unguarded);
  }
  return counts;
}

describe('管理画面の通信失敗 (#973)', () => {
  const IO_TIMEOUT = 30_000;

  it(
    '🔴 台帳に無いファイルの fetch は、失敗を報告する catch に囲まれている',
    () => {
      const actual = unguardedByFile();
      const unexpected = [...actual].filter(([file]) => !REMAINING.has(file));
      expect(
        unexpected.map(([file, n]) => `${file}: ${n}`),
        '無言で失敗する fetch が増えている。直すか、台帳へ理由付きで足すこと',
      ).toEqual([]);
    },
    IO_TIMEOUT,
  );

  it(
    '🔴 台帳の件数を増やせない（ラチェット）',
    () => {
      const actual = unguardedByFile();
      const grown = [...REMAINING]
        .filter(([file, allowed]) => (actual.get(file) ?? 0) > allowed)
        .map(([file, allowed]) => `${file}: ${allowed} → ${actual.get(file) ?? 0}`);
      expect(grown, '台帳のファイルで無言の fetch が増えている').toEqual([]);
      expect(
        [...actual.values()].reduce((sum, n) => sum + n, 0),
        '合計が台帳を超えている',
      ).toBeLessThanOrEqual(REMAINING_TOTAL);
    },
    IO_TIMEOUT,
  );

  /**
   * 🔴 **ドリフトを落とす。** 直したのに台帳へ残っていると、「まだ 76 箇所ある」という
   * 数字が実態から離れ、次に読む人の判断材料が汚れる（`check-cjk-literals.ts` の例外リストと
   * 同じ型）。#968 が台帳を空にできたのは、この検査があったからである。
   */
  it(
    '台帳に「もう直っている」ものが残っていない',
    () => {
      const actual = unguardedByFile();
      const stale = [...REMAINING]
        .filter(([file, allowed]) => (actual.get(file) ?? 0) < allowed)
        .map(([file, allowed]) => `${file}: ${allowed} → ${actual.get(file) ?? 0}`);
      expect(stale, '直ったぶんを台帳から減らすこと').toEqual([]);
    },
    IO_TIMEOUT,
  );

  /**
   * 🔴 **走査が壊れたら落ちる。** 母集団が 0 件になっても上の 3 本は全部通る
   * （「無言の fetch は増えていない」が空虚に真になる）。#968 が「走査の限界を自分で
   * 検出する」と書いているのと同じ理由で、下界を張る。
   */
  it(
    '走査そのものが生きている（母集団が空でない）',
    () => {
      const files = adminFiles();
      expect(files.length, '管理画面のファイルを 1 本も走査していない').toBeGreaterThan(20);
      const withFetch = files.filter(({ source }) => fetchSites(source).length > 0);
      expect(withFetch.length, 'fetch を 1 件も見つけていない').toBeGreaterThan(20);
    },
    IO_TIMEOUT,
  );

  /**
   * この増分で直したもの。**台帳から消えていること**を名指しで固定する ――
   * 「直した」と書いた PR が実際には直していない、を落とす。
   */
  it(
    'ログインの送信は失敗を報告する（この増分で直した）',
    () => {
      expect(unguardedByFile().has('AdminPasswordLogin.tsx')).toBe(false);
      expect(REMAINING.has('AdminPasswordLogin.tsx')).toBe(false);
    },
    IO_TIMEOUT,
  );
});
