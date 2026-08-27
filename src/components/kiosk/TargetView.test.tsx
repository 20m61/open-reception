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
    // 🔴 **群に 2 名以上を置く。** 1 群 1 名だと「グリッドは群の全員を描く」が主張できず、
    // **上位 N 件打ち切りの変異が素通りする**（独立レビューの実測: main では killed だった
    // `slice(0, 1)` が HEAD で生存した）。Issue #787 が名指しで禁じた失敗そのもの。
    { id: 'staff-tanaka', displayName: '田中 次郎', kana: 'たなか', aliases: [], departmentId: 'dept-dev', available: true },
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
      openGroupId={null}
      onOpenGroupChange={() => {}}
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
    // 初期表示は担当者を絞るための**群**（#787）。取次先としての部署グリッドとは別物。
    expect(html).toContain('data-testid="staff-groups"');
    expect(html).not.toContain('data-testid="dept-dept-sales"');
    expect(html).not.toContain('data-testid="target-panel-department"');
  });

  /**
   * 担当者グリッドの段階開示 (#787)。**上位 N 件打ち切りにしない**ので、初期表示に
   * 担当者カードは出ないが、部署を開けば必ず出る（＝到達不能を作らない）。
   */
  it('初期表示では担当者カードを出さず、部署を開くと出る', () => {
    expect(render()).not.toContain('data-testid="staff-staff-sato"');
    expect(render({ openGroupId: 'dept-sales' })).toContain('data-testid="staff-staff-sato"');
  });

  it('開いた部署からは戻れる（押した先から出られない画面を作らない）', () => {
    expect(render({ openGroupId: 'dept-sales' })).toContain('data-testid="staff-group-back"');
    expect(render()).not.toContain('data-testid="staff-group-back"');
  });

  /**
   * 🔴 **打ち切りを禁じる。** 名前を知らない来訪者は検索できないので、切り捨てた相手は
   * タッチで永久に到達不能になる（＝呼べない）。群を開いたら**その群の全員**が出ること、
   * かつ**他の群の担当者は出ない**ことを両側から縛る。
   */
  it('群を開くとその群の全員が出て、他の群の担当者は出ない', () => {
    const html = render({ openGroupId: 'dept-dev' });
    expect(html).toContain('data-testid="staff-staff-suzuki"');
    expect(html).toContain('data-testid="staff-staff-tanaka"');
    expect(html).not.toContain('data-testid="staff-staff-sato"');
  });

  /**
   * 🔴 **人数は押せる相手を数える。** 全体件数を出すと、全員不在の部署が「2名」と広告して
   * 開いた先に押せないカードだけが並ぶ。営業時間外は**全部署がこの状態**になる。
   */
  it('群のカードは部署名と、押せる相手の人数を出す', () => {
    const html = render();
    expect(innerTextOf(html, 'staff-group-dept-sales-count')).toBe('1名');
    expect(html).toContain('営業部');
    // 開発部は在席 1（田中）・不在 1（鈴木）なので 1 名。
    expect(innerTextOf(html, 'staff-group-dept-dev-count')).toBe('1名');
  });

  it('押せる相手が居ない部署は、開く前にそれと分かる', () => {
    const absent = { ...DIRECTORY, staff: DIRECTORY.staff.map((m) => ({ ...m, available: false })) };
    const html = render({ directory: absent });
    expect(innerTextOf(html, 'staff-group-dept-sales-absent-badge')).toBe('不在');
    expect(innerTextOf(html, 'staff-group-dept-sales-count')).toBe('0名');
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
    // 鈴木は開発部。段階開示 (#787) 後は群を開かないとカードが出ない。
    const html = render({ openGroupId: 'dept-dev' });
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

  // 「文を持つ」は「読み上げられる」ではない。到着した瞬間から 0 件の場合は要素ごと
  // 新規挿入されるので live region は沈黙する（既存の挙動。#788 で扱う）。ここが縛れる
  // のは中身の配線だけで、実際に読まれるかは E2E のノード同一性テストが見ている。
  it('0 件になったら live region が案内文を持つ（読み上げの可否は E2E 側）', () => {
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
