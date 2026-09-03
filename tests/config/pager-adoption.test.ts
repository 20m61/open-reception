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

/** 手書きのページ送りが残っているファイル。**理由を必ず書く。** */
const PENDING: readonly { readonly file: string; readonly why: string }[] = [
  /*
   * 6 つとも理由は同じ ——「#910 より前からある手書きで、共有部品への移行は
   * 振る舞いを変えない純粋なリファクタ」。**それでも 1 件ずつ書く**: 1 つでも
   * 別の理由（移行できない事情がある）に変わったときに、それが見える形にしておく。
   */
  { file: 'SitesManager.tsx', why: '#909 以前からの手書き。移行は振る舞い不変のリファクタなので別増分' },
  { file: 'DevicesManager.tsx', why: '#910 以前からの手書き。移行は振る舞い不変のリファクタなので別増分' },
  { file: 'ReservationsManager.tsx', why: '#910 以前からの手書き。移行は振る舞い不変のリファクタなので別増分' },
  { file: 'StayManager.tsx', why: '#910 以前からの手書き。移行は振る舞い不変のリファクタなので別増分' },
  { file: 'audit/AuditLogViewer.tsx', why: '#906 で入れた手書き。移行は振る舞い不変のリファクタなので別増分' },
  { file: 'receptions/ReceptionsViewer.tsx', why: '#330 由来の手書き。移行は振る舞い不変のリファクタなので別増分' },
];

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
  it('新しく手書きのページ送りを増やさない', () => {
    const pendingFiles = new Set(PENDING.map((p) => p.file));
    const offenders = adminFiles()
      .filter((f) => handRolled(f.source))
      .filter((f) => !pendingFiles.has(f.name))
      .map((f) => f.name);
    expect(offenders).toEqual([]);
  });

  it('🔴 下界: PENDING はすべて実際に手書きが残っている（消化済みを残さない）', () => {
    const byName = new Map(adminFiles().map((f) => [f.name, f.source]));
    const stale = PENDING.filter((p) => {
      const source = byName.get(p.file);
      return source === undefined || !handRolled(source);
    }).map((p) => p.file);
    expect(stale).toEqual([]);
  });

  it('PENDING には理由が書かれている', () => {
    expect(PENDING.filter((p) => p.why.trim().length < 4).map((p) => p.file)).toEqual([]);
  });

  it('🔴 下界: 共有 Pager が実際に使われている（口だけ作らない）', () => {
    const users = adminFiles().filter((f) => /<Pager\b/.test(f.source)).map((f) => f.name);
    expect(users.length).toBeGreaterThanOrEqual(4);
  });

  it('PENDING が空になったら共有部品へ寄せ切って本レジストリを畳む', () => {
    expect(
      PENDING.length,
      'PENDING が空になった。手書きは残っていないので、PENDING ごと畳んで「手書きを作らない」だけを残すこと',
    ).toBeGreaterThan(0);
  });
});
