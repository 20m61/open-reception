import { describe, expect, it } from 'vitest';
import type { ReactElement } from 'react';
import { readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { renderToStaticMarkup } from 'react-dom/server';
import { AuditLogs } from './AuditLogs';
import { ProviderConfig } from './ProviderConfig';
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

/** platform 配下の `.tsx` ソース（テスト除く）。JSX コメントは落とす。 */
function platformSources(): string[] {
  const dir = join(process.cwd(), 'src/components/admin/platform');
  const out: string[] = [];
  const walk = (d: string): void => {
    for (const entry of readdirSync(d, { withFileTypes: true })) {
      const path = join(d, entry.name);
      if (entry.isDirectory()) walk(path);
      else if (entry.name.endsWith('.tsx') && !entry.name.includes('.test.'))
        out.push(readFileSync(path, 'utf8').replace(/\/\*[\s\S]*?\*\//g, ''));
    }
  };
  walk(dir);
  return out;
}

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
   * 🔴 **下界を「件数の固定」から「網羅」へ変える (#896 レビュー m1)。**
   *
   * `LISTS.length === 12` という固定値は、**新しい一覧を足しても増えない** ——
   * 実測で「新規画面を `loaded failed={false}`（定数）で描き、定数免除に偽の理由で
   * 登録する」変異が生存した。`LISTS` が手書きである限り、新しい画面は実描画の
   * 観測に載らないまま通ってしまう。
   *
   * ソースを走査して「`failed` を**式**で渡している `DataTable`」を全部見つけ、
   * それが漏れなく `LISTS` に載っていることを要求する。こうすると一覧を足した人は
   * ここへ登録するまで緑にできない。
   */
  it('🔴 網羅: failed を式で渡す DataTable は全部 LISTS に載っている', () => {
    const covered = new Set(LISTS.map((l) => l.testId));
    const wired = platformSources().flatMap((source) =>
      [...source.matchAll(/<DataTable\b[\s\S]*?\/>/g)]
        .map((m) => m[0])
        .filter((b) => /\bfailed=\{(?!true\}|false\})/.test(b))
        .map((b) => /testId="([^"]*)"/.exec(b)?.[1] ?? '(testId なし)'),
    );
    const missing = wired.filter((t) => !covered.has(t));
    expect(missing, 'この一覧を LISTS へ足すこと（実描画で観測されていない）').toEqual([]);
  });

  it('🔴 下界: LISTS が実在の一覧を指している（腐った登録を残さない）', () => {
    const all = platformSources()
      .flatMap((source) => [...source.matchAll(/testId="([^"]*)"/g)].map((m) => m[1]))
      .filter((t): t is string => Boolean(t));
    const stale = LISTS.filter((l) => !all.includes(l.testId)).map((l) => l.testId);
    expect(stale).toEqual([]);
  });
});


/**
 * 読めていない設定画面から**全置換 upsert を撃たせない** (#968 レビュー M2)。
 *
 * `ProviderConfig` は取得に失敗しても `data` が `null` のままなので、`presence` を
 * `'missing'` に潰すと画面は「secret 未設定」「provider `mock`」「無効」と**断定**する。
 * `PUT /api/platform/integrations/provider-config` は `buildTenantProviderConfig` →
 * `putTenantProviderConfig` の**全置換 upsert**で楽観ロックが無いため、その状態から
 * 「設定を保存」を押すと**実 CCaaS 設定が既定値で上書きされる** —— 来訪者は担当者を
 * 呼べず「取り次げません」になる。#870 の `OperatingHoursManager` と同じ型
 * （取得できていないことを「未設定」と言い換える）。
 *
 * `renderToStaticMarkup` は `useEffect` を走らせないので、観測できるのは
 * **fetch 前の初期状態**（`data === null`）である。読み取り失敗も同じ状態なので、
 * ここで縛れば失敗時の断定表示と保存導線の両方が閉じる。
 */
describe('ProviderConfig は読めていない状態で断定しない (#968 レビュー M2)', () => {
  const html = renderToStaticMarkup(<ProviderConfig />);

  /** 表示文字列を含む `<button …>` の開始タグ。 */
  function buttonTagFor(label: string): string {
    const at = html.indexOf(`>${label}<`);
    if (at < 0) return '(ボタンが見つからない)';
    const open = html.lastIndexOf('<button', at);
    return html.slice(open, at + 1);
  }

  it('secret の状態を「未設定」とも「取得できていません」とも断定しない', () => {
    expect(html, '取得できていないのに「未設定」と出している').not.toContain('未設定</strong>');
    /*
     * 🔴 **`renderToStaticMarkup` が観測しているのは `useEffect` 前＝「読み込み中」である。**
     * ここに `取得できていません` を期待していたので、**テストが loading の語彙を failed に
     * 固定していた**（#968 レビュー 4 周目 MAJOR-3）。3 状態を潰さない。
     */
    expect(html, '読み込み中を「取得できていません」と断定している').not.toContain('取得できていません');
    expect(html).toContain('読み込み中…');
  });

  it('読めていない間は保存系を押せない（既定値で上書きさせない）', () => {
    expect(buttonTagFor('設定を保存'), '設定を保存が押せる').toContain('disabled');
    expect(buttonTagFor('secret を保存'), 'secret を保存が押せる').toContain('disabled');
    expect(buttonTagFor('secret を消去'), 'secret を消去が押せる').toContain('disabled');
  });

  it('🔴 下界: ボタンを実際に見つけている（消して通す形にしない）', () => {
    for (const label of ['設定を保存', 'secret を保存', 'secret を消去'])
      expect(buttonTagFor(label), `${label} が描かれていない`).toContain('<button');
  });
});
