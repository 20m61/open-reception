import { describe, expect, it, vi } from 'vitest';
import { renderToStaticMarkup } from 'react-dom/server';
import { renderScreen } from './reception-screens';
import type { FlowData } from './flow-state';

const noop = () => {};
const directory = {
  departments: [{ id: 'dept-sales', name: '営業部' }],
  staff: [
    {
      id: 'staff-sato',
      displayName: '佐藤 太郎',
      kana: 'さとう',
      aliases: [],
      departmentId: 'dept-sales',
      available: true,
    },
  ],
};

function html(data: FlowData): string {
  return renderToStaticMarkup(
    renderScreen({
      data,
      dispatch: vi.fn(),
      complete: noop,
      onFallback: noop,
      directory,
      guidanceIdle: '',
      vrmUrl: undefined,
      avatarFallbackUrl: undefined,
      sttEnabled: false,
      motionUrl: undefined,
      vonageCallId: null,
      staffResponse: null,
      onStaffResponseFallback: noop,
      onEntry: noop,
      onHandoff: noop,
      locale: 'ja',
      onLocaleChange: noop,
      branding: {},
      onVoiceUse: noop,
      checkoutCredential: null,
      privacyNoticeOverride: undefined,
      presenceCameraEnabled: false,
      onSearchQuery: noop,
      onRequestChat: noop,
      targetTab: 'staff',
      onTargetTabChange: noop,
      openStaffGroupId: null,
      onOpenStaffGroupChange: noop,
      callingStageState: { stage: 'dialing', elapsedMs: 0 },
      callingStageTextOverride: {},
      onCallTimeout: noop,
      videoAnswerTimeoutMs: 30_000,
      feedback: { enabled: false, onSubmit: noop },
      sttAdapterFactory: undefined,
      callStages: [],
    }),
  );
}

describe('renderScreen No Typing routing (#1057)', () => {
  it('selectingTarget は NoTypingTargetView へ配線され software keyboard control を描画しない', () => {
    const out = html({ state: 'selectingTarget', purpose: 'meeting' });

    expect(out).toContain('data-testid="no-typing-target-view"');
    expect(out).toContain('data-testid="staff-groups"');
    expect(out).not.toContain('data-testid="staff-search"');
    expect(out).not.toContain('<input');
    expect(out).not.toContain('<textarea');
    expect(out).not.toContain('contenteditable');
  });

  it('他 state は legacy renderer へ委譲し、段階移行の範囲を selectingTarget に限定する', () => {
    const out = html({
      state: 'inputVisitorInfo',
      purpose: 'meeting',
      target: { type: 'staff', id: 'staff-sato', label: '佐藤 太郎' },
    });

    // visitor-info は次の増分で移行する。今回ここまで同時に変えないことを固定する。
    expect(out).not.toContain('data-testid="no-typing-target-view"');
    expect(out).toContain('data-testid="visitor-name"');
  });
});
