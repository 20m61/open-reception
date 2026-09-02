import { describe, expect, it, vi } from 'vitest';
import { renderToStaticMarkup } from 'react-dom/server';
import { renderScreen } from './reception-screens';
import type { CallingStage } from '@/domain/reception/calling-experience';
import type { FlowData } from './flow-state';

/**
 * 呼び出し中の段階メッセージが非視覚の来訪者に届くこと (#849 / #323 AC3)。
 *
 * AvatarGuide は `ttsSettings` 未指定で speak せず、親は aria-hidden。通知は
 * 本体パネルのメッセージが担う。jsdom は無いので `renderToStaticMarkup` で
 * マークアップを固定する（CheckinFlow.test.tsx と同じ流儀）。
 */

const calling: FlowData = {
  state: 'calling',
  purpose: 'meeting',
  target: { type: 'staff', id: 'staff-sato', label: '佐藤' },
  visitor: { name: '来訪者', company: '会社' },
};

const connected: FlowData = {
  state: 'connected',
  purpose: 'meeting',
  target: { type: 'staff', id: 'staff-sato', label: '佐藤' },
  visitor: { name: '来訪者', company: '会社' },
};

const noop = () => {};

function html(data: FlowData, stage: CallingStage = 'dialing'): string {
  return renderToStaticMarkup(
    renderScreen({
      data,
      dispatch: vi.fn(),
      complete: noop,
      onFallback: noop,
      directory: { departments: [], staff: [] },
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
      callingStageState: { stage, elapsedMs: 0 },
      callingStageTextOverride: {},
      onCallTimeout: noop,
      videoAnswerTimeoutMs: 30_000,
      feedback: { enabled: false, onSubmit: noop },
      sttAdapterFactory: undefined,
      callStages: [],
    }),
  );
}

function messageParagraph(markup: string): string {
  const match = /<p\b[^>]*class="result-panel__message"[^>]*>/.exec(markup);
  expect(match, 'result-panel__message が無い').not.toBeNull();
  return match![0];
}

describe('呼び出し中の段階メッセージは支援技術に届く (#849)', () => {
  it.each(['dialing', 'waiting', 'preTimeoutNotice'] as const)(
    '%s のメッセージは role="status"',
    (stage) => {
      const out = html(calling, stage);
      expect(out).toContain('data-testid="calling"');
      expect(out).toContain(`data-calling-stage="${stage}"`);
      expect(messageParagraph(out)).toContain('role="status"');
    },
  );

  it('アバターへ ttsSettings を渡さず、通知は本体側に置く（重複発話の設計を先回りしない）', () => {
    const out = html(calling, 'preTimeoutNotice');
    expect(out).not.toContain('ttsSettings');
    // コンパニオンは装飾のまま。通知を本体へ寄せた判断を固定する。
    expect(out).not.toContain('kiosk-avatar-companion');
  });

  /**
   * 🔴 **呼び出し中だけ live にする。** ResultPanel 全部に role="status" を付けると、
   * 完了画面の CTA まで毎レンダー読み上げられる。CallingView が `messageLive` を
   * 渡していること（他画面は渡していないこと）を対で縛る。
   */
  it('connected のメッセージは role="status" にしない（呼び出し中だけ届ける）', () => {
    const out = html(connected);
    expect(out).toContain('data-testid="result-connected"');
    expect(messageParagraph(out)).not.toContain('role="status"');
  });

  /**
   * ビデオ経路でも来訪者向け予告は CallingView が持つ (#832)。KioskCallView に差し替えると
   * `data-calling-stage` が消え、ゲートも素通りしていた。
   */
  it('vonageCallId があっても本体パネルに予告段階がある', () => {
    const out = renderToStaticMarkup(
      renderScreen({
        data: calling,
        dispatch: vi.fn(),
        complete: noop,
        onFallback: noop,
        directory: { departments: [], staff: [] },
        guidanceIdle: '',
        vrmUrl: undefined,
        avatarFallbackUrl: undefined,
        sttEnabled: false,
        motionUrl: undefined,
        vonageCallId: 'sess-video',
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
        callingStageState: { stage: 'preTimeoutNotice', elapsedMs: 0 },
        callingStageTextOverride: {},
        onCallTimeout: noop,
        videoAnswerTimeoutMs: 30_000,
        feedback: { enabled: false, onSubmit: noop },
        sttAdapterFactory: undefined,
        callStages: [],
      }),
    );
    expect(out).toContain('data-testid="calling"');
    expect(out).toContain('data-calling-stage="preTimeoutNotice"');
    expect(out).toContain('data-testid="kiosk-call"');
    expect(messageParagraph(out)).toContain('role="status"');
  });
});
