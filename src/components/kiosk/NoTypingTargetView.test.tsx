import { describe, expect, it } from 'vitest';
import { renderToStaticMarkup } from 'react-dom/server';
import type { Directory } from './useEffectiveConfiguration';
import { NoTypingTargetView } from './NoTypingTargetView';

const DIRECTORY: Directory = {
  departments: [
    { id: 'dept-sales', name: '営業部' },
    { id: 'dept-dev', name: '開発部' },
  ],
  staff: [
    {
      id: 'staff-sato',
      displayName: '佐藤 太郎',
      kana: 'さとう',
      aliases: [],
      departmentId: 'dept-sales',
      available: true,
    },
    {
      id: 'staff-suzuki',
      displayName: '鈴木 花子',
      kana: 'すずき',
      aliases: [],
      departmentId: 'dept-dev',
      available: false,
    },
    {
      id: 'staff-tanaka',
      displayName: '田中 次郎',
      kana: 'たなか',
      aliases: [],
      departmentId: 'dept-dev',
      available: true,
    },
  ],
};

function render(
  over: Partial<Parameters<typeof NoTypingTargetView>[0]> = {},
): string {
  return renderToStaticMarkup(
    <NoTypingTargetView
      directory={DIRECTORY}
      sttEnabled
      onSelect={() => {}}
      onRequestAssistance={() => {}}
      tab="staff"
      onTabChange={() => {}}
      openGroupId={null}
      onOpenGroupChange={() => {}}
      locale="ja"
      {...over}
    />,
  );
}

function tagOf(html: string, testId: string): string {
  const at = html.indexOf(`data-testid="${testId}"`);
  expect(at, `data-testid=${testId} が無い`).toBeGreaterThan(-1);
  return html.slice(html.lastIndexOf('<', at), html.indexOf('>', at) + 1);
}

function innerTextOf(html: string, testId: string): string {
  const at = html.indexOf(`data-testid="${testId}"`);
  expect(at, `data-testid=${testId} が無い`).toBeGreaterThan(-1);
  const open = html.indexOf('>', at) + 1;
  return html.slice(open, html.indexOf('<', open));
}

describe('NoTypingTargetView (#1057)', () => {
  it('visitor-facing typing control と旧 staff-search を一切描画しない', () => {
    const html = render();
    expect(html).not.toContain('<input');
    expect(html).not.toContain('<textarea');
    expect(html).not.toContain('contenteditable');
    expect(html).not.toContain('contentEditable');
    expect(html).not.toContain('data-testid="staff-search"');
  });

  it('既存 E2E が参照する semantic testid を維持しつつ音声 + 部署群を出す', () => {
    const html = render();
    expect(html).toContain('data-testid="stt-listen"');
    expect(html).toContain('data-testid="staff-groups"');
    expect(html).toContain('data-testid="staff-group-dept-sales"');
    expect(html).toContain('data-testid="staff-group-dept-dev"');
  });

  it('STT が無効でもキーボードを出さず部署群のタッチ経路を残す', () => {
    const html = render({ sttEnabled: false });
    expect(html).not.toContain('data-testid="stt-listen"');
    expect(html).toContain('data-testid="staff-groups"');
    expect(html).not.toContain('<input');
  });

  it('担当者が 0 件なら keyboard ではなく recovery を出す', () => {
    const html = render({ directory: { departments: [], staff: [] } });
    expect(html).toContain('data-testid="target-recovery"');
    expect(html).toContain('data-testid="target-recovery-assistance-cta"');
    expect(html).toContain('data-testid="stt-retry"');
    expect(html).not.toContain('<input');
  });

  it('有人支援が未注入でも recovery は software keyboard を生成しない', () => {
    const html = render({
      directory: { departments: [], staff: [] },
      sttEnabled: false,
      onRequestAssistance: undefined,
    });
    expect(html).toContain('data-testid="target-recovery"');
    expect(html).not.toContain('data-testid="target-recovery-assistance-cta"');
    expect(html).not.toContain('<input');
  });

  it('部署を開くとその部署の担当者だけを表示する', () => {
    const html = render({ openGroupId: 'dept-dev' });
    expect(html).toContain('data-testid="staff-staff-suzuki"');
    expect(html).toContain('data-testid="staff-staff-tanaka"');
    expect(html).not.toContain('data-testid="staff-staff-sato"');
    expect(html).toContain('data-testid="staff-group-back"');
  });

  it('不在担当者は button にせず aria-disabled + バッジ + 文言で示す', () => {
    const html = render({ openGroupId: 'dept-dev' });
    const tag = tagOf(html, 'staff-staff-suzuki');
    expect(tag.startsWith('<div')).toBe(true);
    expect(tag).toContain('aria-disabled="true"');
    expect(tag).toContain('data-unavailable="true"');
    expect(innerTextOf(html, 'staff-staff-suzuki-absent-badge')).toBe('不在');
    expect(innerTextOf(html, 'staff-staff-suzuki-absent')).toContain('現在不在です');
  });

  it('押せる相手が居ない部署は開く前に不在と 0 名を示す', () => {
    const absent: Directory = {
      ...DIRECTORY,
      staff: DIRECTORY.staff.map((staff) => ({ ...staff, available: false })),
    };
    const html = render({ directory: absent });
    expect(innerTextOf(html, 'staff-group-dept-sales-absent-badge')).toBe('不在');
    expect(innerTextOf(html, 'staff-group-dept-sales-count')).toBe('0名');
  });

  it('担当者/部署タブは既存 testid と roving tabindex / aria-selected を維持する', () => {
    const html = render();
    expect(tagOf(html, 'target-tab-staff')).toContain('aria-selected="true"');
    expect(tagOf(html, 'target-tab-staff')).toContain('tabindex="0"');
    expect(tagOf(html, 'target-tab-department')).toContain('aria-selected="false"');
    expect(tagOf(html, 'target-tab-department')).toContain('tabindex="-1"');
    expect(html.match(/aria-selected="true"/g) ?? []).toHaveLength(1);
  });

  it('live region は候補変化より前から常設する', () => {
    const html = render();
    const live = tagOf(html, 'target-live');
    expect(live).toContain('role="status"');
  });

  it('部署タブは部署ボタンだけを描画し音声UIを競合させない', () => {
    const html = render({ tab: 'department' });
    expect(html).toContain('data-testid="departments"');
    expect(html).toContain('data-testid="dept-dept-sales"');
    expect(html).not.toContain('data-testid="stt-listen"');
    expect(html).not.toContain('data-testid="staff-groups"');
    expect(html).not.toContain('<input');
  });

  it('4言語で No Typing 構造を維持する', () => {
    for (const locale of ['ja', 'en', 'ko', 'zh'] as const) {
      const html = render({ locale });
      expect(html).not.toContain('<input');
      expect(html).toContain('data-testid="target-tab-staff"');
      expect(html).toContain('data-testid="target-tab-department"');
    }
  });
});
