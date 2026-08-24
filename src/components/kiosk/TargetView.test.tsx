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
      tab="staff"
      onTabChange={() => {}}
      locale={locale}
      {...over}
    />,
  );
}

/**
 * `data-testid` を持つ要素の**中身**を切り出す。`indexOf` 以降を丸ごと見る書き方だと、
 * 後続要素の文言（例: 「現在不在です…」）がバッジの中身として通ってしまう。
 */
function innerTextOf(html: string, testId: string): string {
  const at = html.indexOf(`data-testid="${testId}"`);
  expect(at, `data-testid=${testId} が無い`).toBeGreaterThan(-1);
  const open = html.indexOf('>', at) + 1;
  return html.slice(open, html.indexOf('<', open));
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
    // roving tabindex（APG）。非選択タブを Tab キーの順路から外す。
    expect(tagOf(html, 'target-tab-staff')).toContain('tabindex="0"');
    expect(tagOf(html, 'target-tab-department')).toContain('tabindex="-1"');
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
    // バッジは**中身が読める**こと。空文字にすると透明度だけの表現へ逆戻りする。
    expect(innerTextOf(html, 'staff-staff-suzuki-absent-badge')).toBe('不在');
    expect(innerTextOf(html, 'staff-staff-suzuki-absent')).toContain('現在不在です');
    expect(tagOf(html, 'staff-staff-suzuki')).toContain('data-unavailable="true"');
    expect(tagOf(html, 'staff-staff-suzuki')).toContain('aria-disabled="true"');
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
    expect(html.indexOf('data-testid="target-recovery-department-cta"')).toBeGreaterThan(-1);
    expect(html.indexOf('data-testid="target-recovery-department-cta"')).toBeLessThan(
      html.indexOf('data-testid="target-recovery-chat-cta"'),
    );
  });

  it('チャットを注入していなければチャット導線を出さない', () => {
    const html = render({ directory: { departments: DIRECTORY.departments, staff: [] }, onRequestChat: undefined });
    expect(html).not.toContain('data-testid="target-recovery-chat-cta"');
  });

  it('4 言語でタブ文言を描画できる（生リテラルを置かない）', () => {
    expect(render({}, 'en')).toContain('Choose a person');
    expect(render({}, 'ko')).toContain('담당자로 선택');
    expect(render({}, 'zh')).toContain('按负责人选择');
  });
});

describe('0 件の読み上げ (#776)', () => {
  it('live region は候補が有るうちから存在する（変化の前から在らないと読まれない）', () => {
    const html = render();
    expect(html).toContain('data-testid="target-live"');
    expect(tagOf(html, 'target-live')).toContain('role="status"');
    expect(innerTextOf(html, 'target-live')).toBe('');
  });

  it('0 件になったら live region が案内文を持つ', () => {
    const html = render({ directory: { departments: DIRECTORY.departments, staff: [] } });
    expect(innerTextOf(html, 'target-live')).toContain('該当する担当者が見つかりません');
  });

  it('recovery パネル自身は live region にしない（属性の後付けでは読まれない）', () => {
    const html = render({ directory: { departments: DIRECTORY.departments, staff: [] } });
    expect(tagOf(html, 'target-recovery')).not.toContain('role="status"');
  });
});

describe('部署タブ (#776)', () => {
  it('部署タブで開くと部署グリッドだけを出し、担当者グリッドも検索欄も出さない', () => {
    const html = render({ tab: 'department' });
    expect(html).toContain('data-testid="dept-dept-sales"');
    expect(html).toContain('data-testid="target-panel-department"');
    expect(html).not.toContain('data-testid="staff-staff-sato"');
    expect(html).not.toContain('data-testid="staff-search"');
    expect(tagOf(html, 'target-tab-department')).toContain('aria-selected="true"');
  });

  it('選択中のタブだけが実在するパネルを aria-controls で指す', () => {
    const html = render({ tab: 'department' });
    expect(tagOf(html, 'target-tab-department')).toContain('aria-controls="target-panel-department"');
    // 非活性パネルは DOM に無いので、参照も持たせない（存在しない id を指さない）。
    expect(tagOf(html, 'target-tab-staff')).not.toContain('aria-controls');
    expect(html).not.toContain('id="target-panel-staff"');
  });

  it('部署が 1 つも無ければ空の枠ではなく recovery を出す（真っ白な画面を作らない）', () => {
    const html = render({
      tab: 'department',
      directory: { departments: [], staff: DIRECTORY.staff },
    });
    expect(html).toContain('data-testid="target-recovery"');
    expect(html).toContain('部署・窓口の一覧がありません');
    // 担当者へ戻す導線とチャットが出る。
    expect(html).toContain('data-testid="target-recovery-staff-cta"');
    expect(html).toContain('data-testid="target-recovery-chat-cta"');
  });

  it('担当者が全員不在なら「担当者から選ぶ」を出さない（押せないカードの前に置かない）', () => {
    // 判定は**カードの枚数ではなく選べる件数**。`searchStaffScored` は不在を除外しない
    // ので、枚数で決めると押せないカードだけのグリッドへ送ることになる。
    const absent = DIRECTORY.staff.map((s) => ({ ...s, available: false }));
    const html = render({ tab: 'department', directory: { departments: [], staff: absent } });
    expect(html).toContain('data-testid="target-recovery"');
    expect(html).not.toContain('data-testid="target-recovery-staff-cta"');
  });

  it('部署タブでも roving tabindex が選択中に追従する', () => {
    const html = render({ tab: 'department' });
    expect(tagOf(html, 'target-tab-department')).toContain('tabindex="0"');
    expect(tagOf(html, 'target-tab-staff')).toContain('tabindex="-1"');
  });

  it('部署が 0 件なら 0 件 recovery に「部署から選ぶ」を出さない（空の先へ送らない）', () => {
    const html = render({ directory: { departments: [], staff: [] } });
    expect(html).toContain('data-testid="target-recovery"');
    expect(html).not.toContain('data-testid="target-recovery-department-cta"');
  });

  it('次の一手が 1 つも無いときは有人支援の案内だけを出す', () => {
    const html = render({
      directory: { departments: [], staff: [] },
      onRequestChat: undefined,
    });
    expect(html).toContain('近くの受付スタッフにお声がけください');
    expect(html).not.toContain('data-testid="target-recovery-');
  });
});
