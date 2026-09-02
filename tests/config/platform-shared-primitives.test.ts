import { describe, expect, it } from 'vitest';
import { readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';

/**
 * platform コンソールが共有プリミティブを使う (#895 / 課題 07)。
 *
 * `platform/primitives.tsx` は冒頭で「共有プリミティブが用意され次第そちらへ寄せる
 * （重複定義しない）」と**自ら宣言していた**のに、#92 で共有版が出来た後も
 * `MetricCard` / `StatusBadge` を独自に持ち続け、角丸が 12/999 対 14/9999 で食い違っていた。
 * 散文の宣言は機械が読まないので守られない。ここで読む。
 */

const PLATFORM_DIR = join(process.cwd(), 'src/components/admin/platform');
const SHARED = ['MetricCard', 'StatusBadge'] as const;

/** 移行済みの画面。ここから剥がれたら退行として落とす（増えるのは構わない）。 */
const EXPECTED_USERS: Record<(typeof SHARED)[number], string[]> = {
  MetricCard: [
    'AwsCostPanel.tsx',
    'FeatureFlags.tsx',
    'MaintenanceStatus.tsx',
    'Observability.tsx',
    'PlatformDashboard.tsx',
    'TenantDetail.tsx',
    'TenantList.tsx',
    'UpdateStatus.tsx',
  ],
  StatusBadge: ['TenantDetail.tsx', 'TenantList.tsx'],
};

function stripComments(source: string): string {
  return source.replace(/\/\*[\s\S]*?\*\//g, '').replace(/(^|[^:])\/\/.*$/gm, '$1');
}

function platformSources(): { file: string; source: string }[] {
  return readdirSync(PLATFORM_DIR)
    .filter((n) => n.endsWith('.tsx'))
    .map((file) => ({ file, source: stripComments(readFileSync(join(PLATFORM_DIR, file), 'utf8')) }));
}

describe('platform の共有プリミティブ移行 (#895 / 課題 07)', () => {
  it.each(SHARED)('%s を platform で再定義しない', (name) => {
    const offenders = platformSources()
      .filter(({ source }) => new RegExp(`export function ${name}\\b`).test(source))
      .map(({ file }) => file);
    expect(offenders).toEqual([]);
  });

  it.each(SHARED)('%s を使う platform ファイルは共有バレルから取る', (name) => {
    const offenders = platformSources()
      .filter(({ source }) => new RegExp(`<${name}\\b`).test(source))
      .filter(({ source }) => {
        const imported = /^import \{([^}]*)\} from '@\/components\/admin\/ui';$/m.exec(source);
        return !imported?.[1]?.split(',').some((n) => n.trim() === name);
      })
      .map(({ file }) => file);
    expect(offenders).toEqual([]);
  });

  /*
   * 下界。上の 2 本は「platform が誰も使っていない」世界でも通る —— 使わなければ
   * 再定義も誤った import も無いので、**部品を全部消せば緑になる**。
   *
   * 🔴 「1 つ以上のファイルが使っている」では足りない。移行済みの画面を 1 つ残して
   * 他を全部剥がしても通ってしまう（実測で生存した変異がこれ）。**画面を名指しする。**
   * 集合が増えるのは歓迎なので、包含（⊇）で見る。
   */
  it.each(Object.entries(EXPECTED_USERS))('下界: %s は名指しの画面すべてで使われている', (name, expected) => {
    const users = platformSources()
      .filter(({ source }) => new RegExp(`<${name}\\b`).test(source))
      .map(({ file }) => file);
    expect(users).toEqual(expect.arrayContaining([...expected]));
  });

  it('未接続の明示を落とさない（placeholder は文言つきで使う）', () => {
    /*
     * platform は「値が無い」を空欄で表さない（#90: 偽の安心を与えない）。
     * 共有版は既定が空欄なので、platform 側は必ず `placeholderText` を添える。
     */
    const offenders = platformSources().flatMap(({ file, source }) =>
      [...source.matchAll(/<MetricCard\b[^>]*>/g)]
        .map((m) => m[0])
        .filter((tag) => /\bplaceholder\b/.test(tag) && !/placeholderText=/.test(tag))
        .map((tag) => `${file}: ${tag}`),
    );
    expect(offenders).toEqual([]);
  });
});
