import { describe, expect, it } from 'vitest';
import { readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';

/**
 * ページ送りを写さない (#910 / 課題 18)。
 *
 * #910 でページングを 4 一覧へ足す時点で、同じ形が **6 ファイルに写されていた**
 * （`SitesManager` / `DevicesManager` / `ReservationsManager` / `StayManager` /
 * `AuditLogViewer` / `ReceptionsViewer`）。そのまま足すと 10 個になる ——
 * `MetricCard` / `StatusBadge` が二重定義のまま**角丸が食い違った** #895 / #897 と同じ形。
 *
 * そこで共有 `ui/Pager` へ寄せ、**新しく写すことを機械で止める**。既存 6 つの移行は
 * 振る舞いを変えない純粋なリファクタなので `PENDING` に理由つきで残す
 * （ここが空になったら `PENDING` ごと畳む）。
 */

const ADMIN_DIR = join(process.cwd(), 'src/components/admin');


function adminFiles(dir = ADMIN_DIR, prefix = ''): { name: string; source: string }[] {
  return readdirSync(dir, { withFileTypes: true }).flatMap((e) => {
    const path = join(dir, e.name);
    const name = prefix ? `${prefix}/${e.name}` : e.name;
    if (e.isDirectory()) return adminFiles(path, name);
    return e.isFile() && e.name.endsWith('.tsx') && !e.name.includes('.test.')
      ? [{ name, source: readFileSync(path, 'utf8') }]
      : [];
  });
}

/** 手書きのページ送り＝共有部品を使わずに `pageCount` を直接見て前/次を描いている。 */
function handRolled(source: string): boolean {
  return /paged\.pageCount > 1/.test(source) && !/<Pager\b/.test(source);
}

describe('ページ送りの共有部品採用 (#910 / 課題 18)', () => {
  /*
   * 🔴 **もう例外は無い。** #910 で 6 つとも `ui/Pager` へ寄せ切ったので、`PENDING` ごと
   * 畳んだ（レジストリを残すと「ここに足せば通る」という逃げ道が残る）。
   */
  it('手書きのページ送りを作らない（例外なし）', () => {
    const offenders = adminFiles().filter((f) => handRolled(f.source)).map((f) => f.name);
    expect(offenders).toEqual([]);
  });

  it('🔴 下界: 共有 Pager が実際に使われている（口だけ作らない）', () => {
    const users = adminFiles().filter((f) => /<Pager\b/.test(f.source)).map((f) => f.name);
    expect(users.length).toBeGreaterThanOrEqual(10);
  });
});
