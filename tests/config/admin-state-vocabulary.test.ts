import { describe, expect, it } from 'vitest';
import { readFileSync, readdirSync } from 'node:fs';
import { join, relative } from 'node:path';

/**
 * 状態語彙を画面へ書き戻させない (#898 / 課題 11)。
 *
 * `src/components/admin/state-vocabulary.ts` が正本で、その振る舞いは
 * `state-vocabulary.test.ts` が縛る。ここが見るのは**言葉が画面へ散り直すこと**。
 * 元の欠陥はまさにそれで、`ui/tokens.ts` に 5 状態の表がありながら、表のセルは
 * それを通らず生テキストで 6 対以上に分裂していた。
 */

const ADMIN_DIR = join(process.cwd(), 'src/components/admin');
const VOCABULARY = join(ADMIN_DIR, 'state-vocabulary.ts');

/** 注記が主張と一致してしまう事故を避けるため、コメントを落としてから走査する。 */
function stripComments(source: string): string {
  return source.replace(/\/\*[\s\S]*?\*\//g, '').replace(/(^|[^:])\/\/.*$/gm, '$1');
}

function adminFiles(dir = ADMIN_DIR): string[] {
  return readdirSync(dir, { withFileTypes: true }).flatMap((e) => {
    const path = join(dir, e.name);
    if (e.isDirectory()) return adminFiles(path);
    if (!e.isFile() || !/\.tsx?$/.test(e.name) || e.name.includes('.test.')) return [];
    return path === VOCABULARY ? [] : [path];
  });
}

/** 状態の対を手で書いた形。`A ? 'X' : 'Y'` の三項に現れる語の組で見る。 */
const HAND_WRITTEN_PAIRS: readonly { readonly pattern: RegExp; readonly why: string }[] = [
  { pattern: /['"]有効['"]\s*:\s*['"](無効|失効|停止中)['"]/, why: 'enabled 軸' },
  { pattern: /['"](無効|失効|停止中)['"]\s*:\s*['"]有効['"]/, why: 'enabled 軸（反転）' },
  { pattern: /['"]稼働中['"]\s*:\s*['"]停止中['"]/, why: 'status 軸' },
  { pattern: /['"]停止中['"]\s*:\s*['"]稼働中['"]/, why: 'status 軸（反転）' },
];

/** 語彙を実際に使っている画面。ここから剥がれたら退行として落とす（増えるのは構わない）。 */
const EXPECTED_USERS: readonly string[] = [
  'AssetsManager.tsx',
  'DepartmentsManager.tsx',
  'KiosksManager.tsx',
  'ReceptionFlowsManager.tsx',
  'RoutingPolicyManager.tsx',
  'SiteDetail.tsx',
  'SitesManager.tsx',
  'StaffManager.tsx',
  'StaffResponseManager.tsx',
  'integrations/IntegrationsManager.tsx',
  'platform/FeatureFlags.tsx',
  'platform/Integrations.tsx',
  'platform/Observability.tsx',
  'platform/TenantDetail.tsx',
  'platform/TenantList.tsx',
];

describe('状態語彙の一元化 (#898 / 課題 11)', () => {
  it.each(HAND_WRITTEN_PAIRS)('$why の対を画面へ直接書かない', ({ pattern }) => {
    const offenders = adminFiles()
      .filter((path) => pattern.test(stripComments(readFileSync(path, 'utf8'))))
      .map((path) => relative(ADMIN_DIR, path));
    expect(offenders).toEqual([]);
  });

  /*
   * 🔴 「失効」を**全面禁止にはしない**。予約の `revoked` と kiosk token の失効は
   * 期限・取り消しを指す**正しい言葉**で、別の軸にある（`reservations/logic.ts` の
   * 5 値ラベル、`DemoStudio` の QR 結果）。最初に書いた全面禁止はこれらを誤検出した。
   * 落とすべきは「`enabled` の否定側を失効と呼ぶ」形だけで、それは上の対の走査が見ている。
   */

  /*
   * 下界。上の 5 本は「状態表示が 1 つも無い」世界でも通る —— セルを全部消せば
   * 手書きの対も「失効」も無くなるので**緑になる**。実際に語彙が使われていることを縛る。
   * さらに「1 画面でも使っていれば通る」を避けるため、画面を名指しする。
   */
  it('下界: 名指しの画面すべてが語彙モジュールを使う', () => {
    const users = adminFiles()
      .filter((path) => /from '[^']*state-vocabulary'/.test(readFileSync(path, 'utf8')))
      .map((path) => relative(ADMIN_DIR, path).split('\\').join('/'));
    expect(users).toEqual(expect.arrayContaining([...EXPECTED_USERS]));
  });
});
