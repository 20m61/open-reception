import { describe, expect, it, vi } from 'vitest';
import { renderToStaticMarkup } from 'react-dom/server';
import { TENANT_CONTEXT_LABEL, TenantContextChip, TenantSelect } from './TenantContextView';

/**
 * 対象テナント表示の共有部品 (#423「別実装の TenantSwitcher を共通契約へ統合」)。
 *
 * admin と platform の切替は**意味が違う**ので一本化しない（母集合・「未選択」の有無・
 * 永続化経路と監査・反映方法がすべて別）。重複していたのは**表示**だけで、
 * `AdminShell` の固定表示と admin `TenantSwitcher` の単一所属表示が testid・inline style・
 * 文言まで逐語的に同じだった。しかも排他レンダリングなので片方を直しても誰も気づかない。
 *
 * プロジェクトに jsdom/RTL は無いので `renderToStaticMarkup` で描画を検証する
 * （`CheckinFlow.test.tsx` と同じ流儀）。
 */

describe('TenantContextChip: 固定表示（切り替え不可）', () => {
  it('対象テナント名を出し、既存 e2e が引く testid を保つ', () => {
    const html = renderToStaticMarkup(<TenantContextChip tenantName="アクメ商事" />);
    expect(html).toContain('data-testid="active-tenant"');
    expect(html).toContain(TENANT_CONTEXT_LABEL);
    expect(html).toContain('アクメ商事');
    // 名前は強調する（従来の <strong> 表示を保つ）。
    expect(html).toContain('<strong>アクメ商事</strong>');
  });

  it('HTML エスケープされる（テナント名は運用者入力）', () => {
    const html = renderToStaticMarkup(<TenantContextChip tenantName={'<img src=x>'} />);
    expect(html).not.toContain('<img src=x>');
    expect(html).toContain('&lt;img');
  });
});

describe('TenantSelect: 切替 UI の表示', () => {
  const options = [
    { id: 't1', name: 'アクメ商事' },
    { id: 't2', name: 'ベータ工業' },
  ];

  it('選択肢を並べ、現在の選択を value に反映する', () => {
    const html = renderToStaticMarkup(
      <TenantSelect testId="admin-tenant-switcher" options={options} value="t2" onSelect={vi.fn()} />,
    );
    expect(html).toContain('data-testid="admin-tenant-switcher"');
    expect(html).toContain('アクメ商事');
    expect(html).toContain('ベータ工業');
    expect(html).toContain('selected');
  });

  it('testId は呼び出し側が決める（admin と platform で取り違えられない）', () => {
    // 統合前は**両方が `tenant-switcher`** を使っていた。意味の違う 2 つが同じ testid だと、
    // 片方向けに書いた e2e がもう片方に当たって通ってしまう。
    const admin = renderToStaticMarkup(
      <TenantSelect testId="admin-tenant-switcher" options={options} value="t1" onSelect={vi.fn()} />,
    );
    const platform = renderToStaticMarkup(
      <TenantSelect
        testId="platform-tenant-switcher"
        options={options}
        value="t1"
        onSelect={vi.fn()}
      />,
    );
    expect(admin).toContain('data-testid="admin-tenant-switcher"');
    expect(admin).not.toContain('data-testid="platform-tenant-switcher"');
    expect(platform).toContain('data-testid="platform-tenant-switcher"');
  });

  it('nullOption を渡すと「未選択」を先頭に出す（platform の全テナント横断）', () => {
    const html = renderToStaticMarkup(
      <TenantSelect
        testId="platform-tenant-switcher"
        options={options}
        value={null}
        nullOptionLabel="全テナント横断"
        onSelect={vi.fn()}
      />,
    );
    expect(html).toContain('全テナント横断');
  });

  it('nullOption を渡さなければ「未選択」は出ない（admin は必ず 1 つ選ばれている）', () => {
    // ここが 2 つの意味の違いそのもの。admin に「全テナント横断」が生えると、
    // 単一テナント管理者に存在しない権限があるように見える。
    const html = renderToStaticMarkup(
      <TenantSelect testId="admin-tenant-switcher" options={options} value="t1" onSelect={vi.fn()} />,
    );
    expect(html).not.toContain('全テナント横断');
    expect(html).not.toContain('value=""');
  });

  it('disabled を渡すと操作できない（切替中の二重送信を防ぐ）', () => {
    const html = renderToStaticMarkup(
      <TenantSelect
        testId="admin-tenant-switcher"
        options={options}
        value="t1"
        disabled
        onSelect={vi.fn()}
      />,
    );
    expect(html).toContain('disabled');
  });

  it('読み上げ用のラベルを持つ（select だけでは何の選択か分からない）', () => {
    const html = renderToStaticMarkup(
      <TenantSelect testId="admin-tenant-switcher" options={options} value="t1" onSelect={vi.fn()} />,
    );
    expect(html).toMatch(/aria-label="[^"]*テナント[^"]*"/);
  });
});

describe('admin と platform の切替が同じ testid を持たない（#423 の再発防止）', () => {
  it('2 つの TenantSwitcher の testid は互いに異なる', async () => {
    // 統合前は**両方が `tenant-switcher`** だった。意味の違う 2 つに同じ selector が当たると、
    // 片方向けに書いた e2e がもう片方に当たって通ってしまう（＝検証したつもりで何も見ていない）。
    // 描画ではなくソースを見るのは、platform 側が mount 時 fetch を伴い静的描画では
    // 実挙動を再現できないため（`no-raw-color-literals.test.ts` と同じ静的走査の流儀）。
    const { readFile } = await import('node:fs/promises');
    const read = (path: string) => readFile(new URL(path, import.meta.url), 'utf8');
    const [admin, platform] = await Promise.all([
      read('./TenantSwitcher.tsx'),
      read('./platform/TenantSwitcher.tsx'),
    ]);

    expect(admin).toContain('testId="admin-tenant-switcher"');
    expect(platform).toContain('testId="platform-tenant-switcher"');
    // 曖昧な共有 testid を復活させない。
    expect(admin).not.toContain('"tenant-switcher"');
    expect(platform).not.toContain('"tenant-switcher"');
  });

  it('どちらも表示部品を共有し、inline style を自前で持たない', () => {
    // 見た目の重複が戻ったら（片方だけ直る形へ退行したら）ここで落とす。
    return Promise.all([
      import('node:fs/promises').then(({ readFile }) =>
        readFile(new URL('./TenantSwitcher.tsx', import.meta.url), 'utf8'),
      ),
      import('node:fs/promises').then(({ readFile }) =>
        readFile(new URL('./platform/TenantSwitcher.tsx', import.meta.url), 'utf8'),
      ),
    ]).then(([admin, platform]) => {
      for (const [name, src] of [
        ['admin', admin],
        ['platform', platform],
      ] as const) {
        expect(src, name).toContain('TenantContextView');
        // チップ/セレクトの見た目を再実装していないこと。
        expect(src, name).not.toContain('borderRadius: 999');
      }
    });
  });
});
