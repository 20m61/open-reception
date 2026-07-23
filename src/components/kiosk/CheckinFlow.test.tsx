import { describe, expect, it, vi } from 'vitest';
import { renderToStaticMarkup } from 'react-dom/server';
import { renderCheckin, type FlowData } from './CheckinFlow';
import type { Locale } from '@/lib/i18n';
import type { CheckinSummary } from '@/domain/checkin/types';

/**
 * QR 受付シェル（`renderCheckin`）の i18n 直書き解消テスト (issue #361 残)。
 *
 * `renderCheckin` は hooks を使わない純粋な描画関数のため、`VoiceReadbackConfirm.test.tsx` と同じ
 * `renderToStaticMarkup` の流儀で各 `CheckinState` の描画を検証できる（プロジェクトに jsdom/RTL は
 * 無いため、これが実機を介さず確認できる最も直接的な手段）。
 */
function html(data: FlowData, locale: Locale = 'ja') {
  return renderToStaticMarkup(
    <>{renderCheckin(data, vi.fn(), vi.fn(), vi.fn(), locale)}</>,
  );
}

const summary: CheckinSummary = {
  visitorName: '山田太郎',
  companyName: '株式会社サンプル',
  visitAt: '2026-07-23T10:00:00.000Z',
  targetType: 'staff',
  targetId: 'staff-1',
  usagePolicy: 'single_use',
};

describe('renderCheckin の日本語直書き解消（#361 残）: 全 CheckinState が 4 言語で描画できる', () => {
  const states: FlowData[] = [
    { state: 'idle' },
    { state: 'selectingMethod' },
    { state: 'checkingCamera' },
    { state: 'scanning' },
    { state: 'resolving' },
    { state: 'confirming', summary },
    { state: 'calling' },
    { state: 'completed' },
    { state: 'cancelled' },
    { state: 'manualFallback' },
    { state: 'cameraError' },
    { state: 'scanError' },
    { state: 'expiredError' },
    { state: 'usedError' },
    { state: 'revokedError' },
    { state: 'networkError' },
  ];

  it.each(states)('$state は ja/en/ko/zh いずれでも空描画にならない', (data) => {
    for (const locale of ['ja', 'en', 'ko', 'zh'] as const) {
      const out = html(data, locale);
      expect(out.length, `state=${data.state} locale=${locale}`).toBeGreaterThan(0);
    }
  });

  it('locale 切替で idle 画面の文言が追随する（直書きテンプレ文字列を残さない）', () => {
    const ja = html({ state: 'idle' }, 'ja');
    const en = html({ state: 'idle' }, 'en');
    expect(ja).toContain('QR で受付');
    expect(ja).toContain('受付を開始する');
    expect(en).toContain('Check in with QR');
    expect(en).toContain('Start check-in');
    expect(en).not.toContain('QR で受付');
  });

  it('locale 切替で selectingMethod 画面の文言が追随する', () => {
    expect(html({ state: 'selectingMethod' }, 'ja')).toContain('通常受付（手入力）');
    expect(html({ state: 'selectingMethod' }, 'ko')).toContain('일반 접수(직접 입력)');
  });

  it('locale 切替で checkingCamera 画面の文言が追随する', () => {
    expect(html({ state: 'checkingCamera' }, 'ja')).toContain('カメラを許可して読み取りへ');
    expect(html({ state: 'checkingCamera' }, 'zh')).toContain('请允许使用摄像头');
  });

  it('locale 切替で scanning 画面の文言が追随する', () => {
    expect(html({ state: 'scanning' }, 'ja')).toContain('QR を読み取っています');
    expect(html({ state: 'scanning' }, 'en')).toContain('Scanning QR code');
  });

  it('confirming 画面: 予約サマリ（お名前・会社名・ご予定）と locale 追随の文言を出す（PII はそのまま表示のみ）', () => {
    const ja = html({ state: 'confirming', summary }, 'ja');
    expect(ja).toContain('ご予約内容をご確認ください');
    expect(ja).toContain('お名前');
    expect(ja).toContain('山田太郎');
    expect(ja).toContain('会社名');
    expect(ja).toContain('株式会社サンプル');
    expect(ja).toContain('この内容で呼び出す');

    const en = html({ state: 'confirming', summary }, 'en');
    expect(en).toContain('Please confirm your reservation details');
    expect(en).toContain('Name');
    expect(en).toContain('山田太郎'); // 表示名は翻訳しない（組織管理の値をそのまま表示）
    expect(en).toContain('Call with these details');
  });

  it('confirming 画面: companyName 未指定なら会社名欄を出さない（任意情報の最小化、既存挙動を維持）', () => {
    const { companyName: _companyName, ...noCompany } = summary;
    const ja = html({ state: 'confirming', summary: noCompany as CheckinSummary }, 'ja');
    expect(ja).not.toContain('会社名');
  });

  it('confirming 画面: visitAt を locale の Intl 表記で整形する（#367/OutOfHoursView と同じ方針）', () => {
    const ja = html({ state: 'confirming', summary }, 'ja');
    const en = html({ state: 'confirming', summary }, 'en');
    // 日本語は和暦/漢字の年月日表記、英語は月名表記になり同一文字列にはならない
    expect(ja).not.toBe(en);
    expect(ja).toContain('checkin-confirm-visitat');
  });

  it('calling / completed / cancelled / manualFallback の locale 追随', () => {
    expect(html({ state: 'calling' }, 'ja')).toContain('担当者を呼び出しています');
    expect(html({ state: 'calling' }, 'en')).toContain('Calling the staff member');
    expect(html({ state: 'completed' }, 'ja')).toContain('受付が完了しました');
    expect(html({ state: 'completed' }, 'zh')).toContain('登记已完成');
    expect(html({ state: 'cancelled' }, 'ja')).toContain('受付をキャンセルしました');
    expect(html({ state: 'cancelled' }, 'ko')).toContain('접수를 취소했습니다');
    expect(html({ state: 'manualFallback' }, 'ja')).toContain('通常受付に切り替えます');
    expect(html({ state: 'manualFallback' }, 'en')).toContain('Switching to standard check-in');
  });

  it('エラー種別ごとに異なる文言を出し分ける（期限切れ/使用済み/失効/不正/通信断/カメラ不可を区別、#98 AC）', () => {
    expect(html({ state: 'cameraError' }, 'ja')).toContain('カメラを使用できませんでした');
    expect(html({ state: 'scanError' }, 'ja')).toContain('QR を読み取れませんでした');
    expect(html({ state: 'expiredError' }, 'ja')).toContain('有効期限が切れています');
    expect(html({ state: 'usedError' }, 'ja')).toContain('すでに受付に使用されています');
    expect(html({ state: 'revokedError' }, 'ja')).toContain('無効化されています');
    expect(html({ state: 'networkError' }, 'ja')).toContain('通信に失敗しました');
  });

  it('エラー画面も locale に追随する', () => {
    expect(html({ state: 'expiredError' }, 'en')).toContain('This QR code has expired');
    expect(html({ state: 'expiredError' }, 'ko')).toContain('유효기간이 만료되었습니다');
    expect(html({ state: 'networkError' }, 'zh')).toContain('通信失败');
  });

  it('locale 省略時は既定 locale（ja）で描画する（後方互換）', () => {
    expect(renderToStaticMarkup(<>{renderCheckin({ state: 'idle' }, vi.fn(), vi.fn(), vi.fn())}</>)).toContain(
      'QR で受付',
    );
  });
});
