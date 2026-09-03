import { describe, expect, it } from 'vitest';
import type { ReactElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { AuditLogs } from './AuditLogs';
import { Integrations } from './Integrations';
import { MaintenanceStatus } from './MaintenanceStatus';
import { Observability } from './Observability';
import { TenantDetail } from './TenantDetail';
import { TenantList } from './TenantList';
import { UpdateStatus } from './UpdateStatus';

/**
 * 移行した platform の一覧が、**配線として**「まだ読めていない」を出す (#896 AC1 / レビュー M1)。
 *
 * ## なぜ構造ガードでは足りないか
 *
 * `tests/config/platform-list-states.test.ts` は「`loaded` / `failed` を対で渡している」ことを
 * **ソースの文字列**で見る。独立レビューで実測されたとおり、それは
 * `loaded={data !== null}` → `loaded`（＝定数 `true`）という**配線の変異で満たせてしまう**。
 * `.claude/rules/opus5-autonomous-loop.md`「方式を替えたら〜」の由来欄が名指しする #826 と
 * 同型 —— 部品（`DataTable`）の純粋な振る舞いに変異を当てて「4/4 kill」と報告したが、
 * **配線を変異させていなかった**ため `KioskFlow` を戻しても緑のままだった、という型である。
 *
 * ここは部品ではなく**画面**を描き、実際に出た DOM を読む。
 *
 * ## なぜ「読み込み中」だけを見るのか
 *
 * このリポジトリに jsdom / testing-library は無く、`renderToStaticMarkup` は
 * `useEffect` を走らせない。したがって観測できるのは **`fetch` 前の初期状態**
 * （`data === null` かつ `error === null`）である。それで十分に効く:
 *
 *   - `loaded` を定数 `true` へ変異させると、初期状態が `'loaded'` と判定され
 *     **「〜がありません。」と断定する** → ここが落ちる
 *   - `rows` の受け渡しを壊しても落ちる
 *
 * `failed` 側（`failed={error !== null}` → `failed={false}`）は初期状態では区別できない。
 * そちらは `platform-list-states.test.ts` の「`loaded`/`failed` は定数ではなく式に束ねる」で
 * 縛る。**2 つで 1 組**であり、どちらか片方だけでは配線は閉じない。
 */

/** 移行した一覧と、その `testId`。`AwsCostPanel` は `data` が載ってからしか表を描かないので対象外。 */
const LISTS: readonly { readonly label: string; readonly element: ReactElement; readonly testId: string }[] = [
  { label: 'TenantList', element: <TenantList />, testId: 'platform-tenants' },
  { label: 'TenantDetail', element: <TenantDetail tenantId="t1" />, testId: 'platform-tenant-sites' },
  { label: 'Observability(連携)', element: <Observability />, testId: 'platform-observability-integrations' },
  { label: 'Observability(履歴)', element: <Observability />, testId: 'platform-recent-activity' },
  { label: 'Integrations(連携)', element: <Integrations />, testId: 'platform-integrations' },
  { label: 'Integrations(認証)', element: <Integrations />, testId: 'platform-auth-methods' },
  { label: 'MaintenanceStatus(端末)', element: <MaintenanceStatus />, testId: 'platform-maintenance-devices' },
  { label: 'MaintenanceStatus(障害)', element: <MaintenanceStatus />, testId: 'platform-incidents' },
  { label: 'MaintenanceStatus(予定)', element: <MaintenanceStatus />, testId: 'platform-maintenance-windows' },
  { label: 'MaintenanceStatus(お知らせ)', element: <MaintenanceStatus />, testId: 'platform-notices' },
  { label: 'AuditLogs', element: <AuditLogs />, testId: 'platform-audit-logs' },
  { label: 'UpdateStatus', element: <UpdateStatus />, testId: 'platform-updates' },
];

describe('platform の一覧は配線として「読み込み中」を出す (#896 レビュー M1)', () => {
  it.each(LISTS.map((l) => [l.label, l] as const))(
    '%s: 取得前は「読み込み中」で、0 件だと断定しない',
    (_label, list) => {
      const html = renderToStaticMarkup(list.element);
      expect(html, `${list.testId}-loading が無い`).toContain(`data-testid="${list.testId}-loading"`);
      expect(html, `${list.testId}-empty が出ている（0 件だと断定している）`).not.toContain(
        `data-testid="${list.testId}-empty"`,
      );
    },
  );

  /*
   * 🔴 **下界。** 上の主張は「一覧を全部消す」「`testId` を全部書き換える」で空虚に満たせる
   * ——`-loading` も `-empty` も出なくなれば `toContain` は落ちるが、`LISTS` を空にすれば
   * `it.each` は 1 件も走らずに緑になる。件数を固定する。
   */
  it('🔴 下界: 12 の一覧を実際に描いている（表を数えずに通す形にしない）', () => {
    expect(LISTS.length).toBe(12);
  });
});
