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

describe('NoTypingTargetView (#1057)', () => {
  it('visitor-facing typing control を一切描画しない', () => {
    const html = render();
    expect(html).not.toContain('<input');
    expect(html).not.toContain('<textarea');
    expect(html).not.toContain('contenteditable');
    expect(html).not.toContain('contentEditable');
  });

  it('担当者タブでは音声認識と部署群ボタンを同じ Stage 内に出す', () => {
    const html = render();
    expect(html).toContain('data-testid="no-typing-stt-listen"');
    expect(html).toContain('data-testid="no-typing-staff-groups"');
    expect(html).toContain('data-testid="no-typing-staff-group-dept-sales"');
    expect(html).toContain('data-testid="no-typing-staff-group-dept-dev"');
  });

  it('STT が無効でもキーボードを出さず有人支援 CTA を出す', () => {
    const html = render({ sttEnabled: false });
    expect(html).not.toContain('data-testid="no-typing-stt-listen"');
    expect(html).toContain('data-testid="no-typing-assistance"');
    expect(html).not.toContain('<input');
  });

  it('有人支援が未注入でも部署群のタッチ経路は残す', () => {
    const html = render({ sttEnabled: false, onRequestAssistance: undefined });
    expect(html).not.toContain('data-testid="no-typing-assistance"');
    expect(html).toContain('data-testid="no-typing-staff-groups"');
  });

  it('部署を開くとその部署の担当者だけを表示する', () => {
    const html = render({ openGroupId: 'dept-dev' });
    expect(html).toContain('data-testid="no-typing-staff-staff-suzuki"');
    expect(html).toContain('data-testid="no-typing-staff-staff-tanaka"');
    expect(html).not.toContain('data-testid="no-typing-staff-staff-sato"');
    expect(html).toContain('data-testid="no-typing-staff-group-back"');
  });

  it('部署タブは部署ボタンだけを描画する', () => {
    const html = render({ tab: 'department' });
    expect(html).toContain('data-testid="no-typing-departments"');
    expect(html).toContain('data-testid="no-typing-dept-dept-sales"');
    expect(html).not.toContain('data-testid="no-typing-stt-listen"');
    expect(html).not.toContain('<input');
  });
});
