import { describe, expect, it } from 'vitest';
import { renderToStaticMarkup } from 'react-dom/server';
import { TargetView } from './reception-screens';
import type { Directory } from './useEffectiveConfiguration';
import type { Locale } from '@/lib/i18n';

const DIRECTORY: Directory = {
  departments: [
    { id: 'dept-sales', name: '営業部' },
    { id: 'dept-dev', name: '開発部' },
  ],
  staff: [
    { id: 'staff-sato', displayName: '佐藤 太郎', kana: 'さとう', aliases: [], departmentId: 'dept-sales', available: true },
    { id: 'staff-suzuki', displayName: '鈴木 花子', kana: 'すずき', aliases: [], departmentId: 'dept-dev', available: false },
  ],
};

function render(
  over: Partial<Parameters<typeof TargetView>[0]> = {},
  locale: Locale = 'ja',
): string {
  return renderToStaticMarkup(
    <TargetView
      directory={DIRECTORY}
      sttEnabled={false}
      onSelect={() => {}}
      onRequestChat={() => {}}
      locale={locale}
      {...over}
    />,
  );
}

/** `data-testid` を持つ要素の開始タグだけを切り出す（属性の並び順に依存しないため）。 */
function tagOf(html: string, testId: string): string {
  const at = html.indexOf(`data-testid="${testId}"`);
  expect(at, `data-testid=${testId} が無い`).toBeGreaterThan(-1);
  return html.slice(html.lastIndexOf('<', at), html.indexOf('>', at) + 1);
}

describe('TargetView の初期表示密度 (#776)', () => {
  it('開いた直後に部署グリッドを出さない（担当者/部署の 2 グリッド同時表示を禁じる）', () => {
    const html = render();
    expect(html).toContain('data-testid="staff-staff-sato"');
    expect(html).not.toContain('data-testid="dept-dept-sales"');
    expect(html).not.toContain('data-testid="target-panel-department"');
  });

  it('探し方のタブを両方出し、担当者タブを選択済みにする（部署へもタッチで到達できる）', () => {
    const html = render();
    expect(html).toContain('data-testid="target-tab-staff"');
    expect(html).toContain('data-testid="target-tab-department"');
    // 選択状態は aria-selected が正本。片方だけが true。
    // 属性の並び順に依存しないよう、各 <button> 要素の範囲を切り出して見る。
    expect(tagOf(html, 'target-tab-staff')).toContain('aria-selected="true"');
    expect(tagOf(html, 'target-tab-department')).toContain('aria-selected="false"');
    expect(html.match(/aria-selected="true"/g) ?? []).toHaveLength(1);
  });

  it('検索欄は担当者タブの主操作として出る', () => {
    expect(render()).toContain('data-testid="staff-search"');
  });

  it('音声が無効なら音声 UI を一切出さない', () => {
    const html = render({ sttEnabled: false });
    expect(html).not.toContain('data-testid="stt-panel"');
    expect(html).not.toContain('data-testid="stt-listen"');
  });

  it('音声が有効でも独立セクションではなく検索欄に付随させる（主導線と競合させない）', () => {
    const html = render({ sttEnabled: true });
    expect(html).toContain('data-testid="stt-listen"');
    // 検索欄と音声ボタンが同一の行コンテナに入っていること。
    const row = html.slice(html.indexOf('class="target-search"'), html.indexOf('data-testid="stt-listen"'));
    expect(row).toContain('data-testid="staff-search"');
    // 候補が無いうちは候補グリッドを出さない。
    expect(html).not.toContain('data-testid="stt-candidates"');
  });

  it('不在の担当者は透明度ではなくバッジと文言で示し、押せない', () => {
    const html = render();
    const card = html.slice(html.indexOf('data-testid="staff-staff-suzuki"'));
    expect(card).toContain('data-testid="staff-staff-suzuki-absent-badge"');
    expect(card).toContain('不在');
    expect(card).toContain('data-testid="staff-staff-suzuki-absent"');
    expect(html).toContain('data-unavailable="true"');
    expect(html).toContain('aria-disabled="true"');
    // 透明度だけの表現へ戻さない。
    expect(html).not.toContain('opacity:0.55');
    expect(html).not.toContain('opacity: 0.55');
  });

  it('担当者が 0 件なら recovery パネルを 1 枚だけ出す（警告と案内を重ねない）', () => {
    const html = render({ directory: { departments: DIRECTORY.departments, staff: [] } });
    expect(html).toContain('data-testid="target-recovery"');
    // 旧実装の 2 枚（staff-empty + search-no-results-guidance）へ戻さない。
    expect(html).not.toContain('data-testid="staff-empty"');
    expect(html).not.toContain('data-testid="search-no-results-guidance"');
    expect(html.match(/notice notice--warning/g) ?? []).toHaveLength(1);
  });

  it('recovery の次の一手は部署が先、チャットが後', () => {
    const html = render({ directory: { departments: DIRECTORY.departments, staff: [] } });
    expect(html.indexOf('data-testid="search-empty-department-cta"')).toBeGreaterThan(-1);
    expect(html.indexOf('data-testid="search-empty-department-cta"')).toBeLessThan(
      html.indexOf('data-testid="search-empty-chat-cta"'),
    );
  });

  it('チャットを注入していなければチャット導線を出さない', () => {
    const html = render({ directory: { departments: DIRECTORY.departments, staff: [] }, onRequestChat: undefined });
    expect(html).not.toContain('data-testid="search-empty-chat-cta"');
  });

  it('4 言語でタブ文言を描画できる（生リテラルを置かない）', () => {
    expect(render({}, 'en')).toContain('Choose a person');
    expect(render({}, 'ko')).toContain('담당자로 선택');
    expect(render({}, 'zh')).toContain('按负责人选择');
  });
});
