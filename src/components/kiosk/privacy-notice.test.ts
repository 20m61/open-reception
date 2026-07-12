import { describe, expect, it } from 'vitest';
import { resolvePrivacyNoticeContent } from './privacy-notice';

/**
 * 来訪者向けプライバシー通知の文言解決 (issue #314)。
 *
 * 検証する不変条件:
 *  - 既定文言は locale ごとに非空（i18n 辞書網羅は i18n.test.ts が別途保証する）。
 *  - テナント上書き文言（#28 案内文言設定と同じ仕組み）は既定 locale (ja) のみ適用する
 *    （待機画面 guidanceIdle と同じ既存パターン。#103/#324）。
 *  - presence カメラ有効時のみローカル処理・非保存の注記を含む（#79）。
 */
describe('resolvePrivacyNoticeContent (#314)', () => {
  it('ja はテナント上書き文言があればそれを summary に使う', () => {
    const content = resolvePrivacyNoticeContent('ja', {
      overrideSummary: 'カスタム通知文言です',
      presenceCameraEnabled: false,
    });
    expect(content.summary).toBe('カスタム通知文言です');
  });

  it('ja でも上書きが未設定/空文字なら既定文言にフォールバックする', () => {
    const withoutOverride = resolvePrivacyNoticeContent('ja', {
      presenceCameraEnabled: false,
    });
    expect(withoutOverride.summary.length).toBeGreaterThan(0);

    const blank = resolvePrivacyNoticeContent('ja', {
      overrideSummary: '   ',
      presenceCameraEnabled: false,
    });
    expect(blank.summary).toBe(withoutOverride.summary);
  });

  it('ja 以外は上書き文言を適用せず既定（辞書）文言のみを使う', () => {
    const overridden = resolvePrivacyNoticeContent('en', {
      overrideSummary: 'カスタム通知文言です',
      presenceCameraEnabled: false,
    });
    const notOverridden = resolvePrivacyNoticeContent('en', { presenceCameraEnabled: false });
    expect(overridden.summary).toBe(notOverridden.summary);
    expect(overridden.summary).not.toBe('カスタム通知文言です');
  });

  it('全 locale で title/summary/詳細ラベル/本文が非空', () => {
    for (const locale of ['ja', 'en', 'ko', 'zh'] as const) {
      const content = resolvePrivacyNoticeContent(locale, { presenceCameraEnabled: false });
      expect(content.title.trim().length).toBeGreaterThan(0);
      expect(content.summary.trim().length).toBeGreaterThan(0);
      expect(content.detailsShowLabel.trim().length).toBeGreaterThan(0);
      expect(content.detailsHideLabel.trim().length).toBeGreaterThan(0);
      expect(content.purposeLabel.trim().length).toBeGreaterThan(0);
      expect(content.purposeText.trim().length).toBeGreaterThan(0);
      expect(content.storageLabel.trim().length).toBeGreaterThan(0);
      expect(content.storageText.trim().length).toBeGreaterThan(0);
      expect(content.retentionLabel.trim().length).toBeGreaterThan(0);
      expect(content.retentionText.trim().length).toBeGreaterThan(0);
      expect(content.contactLabel.trim().length).toBeGreaterThan(0);
      expect(content.contactText.trim().length).toBeGreaterThan(0);
      expect(content.presenceCameraLabel.trim().length).toBeGreaterThan(0);
    }
  });

  it('presence カメラ無効時は注記を含まない', () => {
    const content = resolvePrivacyNoticeContent('ja', { presenceCameraEnabled: false });
    expect(content.presenceCameraNote).toBeUndefined();
  });

  it('presence カメラ有効時のみローカル処理・非保存の注記を含む（#79）', () => {
    const content = resolvePrivacyNoticeContent('ja', { presenceCameraEnabled: true });
    expect(content.presenceCameraNote?.trim().length).toBeGreaterThan(0);
  });
});
