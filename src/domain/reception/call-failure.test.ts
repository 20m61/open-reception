/**
 * 呼び出し失敗の理由と文言の対応の単体テスト (issue #422 / 体験設計 J-OR-05)。
 */
import { describe, expect, it } from 'vitest';
import { CALL_FAILURE_REASONS, failedMessageKeyFor, shouldOfferAlternativeContact } from './call-failure';
import { makeT } from '@/lib/i18n';

describe('failedMessageKeyFor', () => {
  it('通信断は専用の文言（呼び出しが行われたと読ませない）', () => {
    expect(failedMessageKeyFor('network')).toBe('reception.failedNetworkBody');
  });

  it('サーバ側の失敗は従来の文言', () => {
    expect(failedMessageKeyFor('server')).toBe('reception.failedBody');
  });

  it('理由不明は従来の文言へ倒す（旧経路を壊さない）', () => {
    expect(failedMessageKeyFor(undefined)).toBe('reception.failedBody');
  });

  it('全 locale で文言が引ける（未翻訳のキーを作らない）', () => {
    for (const locale of ['ja', 'en', 'ko', 'zh', 'ja-simple'] as const) {
      const text = makeT(locale)('reception.failedNetworkBody');
      expect(text.length).toBeGreaterThan(0);
      // キー名がそのまま出ていない（辞書に無いと key を返す実装のため）。
      expect(text).not.toBe('reception.failedNetworkBody');
    }
  });
});

describe('shouldOfferAlternativeContact', () => {
  it('通信断では代替の連絡先を主 CTA にしない（押しても同じく届かない）', () => {
    expect(shouldOfferAlternativeContact('network')).toBe(false);
  });

  it('それ以外は従来どおり代替導線を出す（行き止まりを作らない）', () => {
    expect(shouldOfferAlternativeContact('server')).toBe(true);
    expect(shouldOfferAlternativeContact(undefined)).toBe(true);
  });
});

/**
 * 実発信を止めているときに「担当者が応答しました」と出さない (#629 系 / N0)。
 *
 * ## 事実
 *
 * `VOICE_DIALING_DISABLED=1` を引くと `resolveVoiceInitiator` が null を返し
 * （`voice-dial.ts`）、`executeRoutedCall` は mock へ倒れる。mock は bridge 系を
 * **無条件で `'answered'`** にするので（`call-execution.ts` の `createKioskMockProvider`）、
 * 来訪者には `ConnectedView`＝「担当者が応答しました」が出て `completed` に到達する。
 *
 * 🔴 **つまり停止スイッチを引くと、誰も呼ばれていないのに全員が受付完了する。**
 * 運用者から見ると「全員入館できている」ように見えるので、全断に気づくのが遅れる。
 *
 * 「止めても来訪者を締め出さない」という設計意図は保つ（逃げ道は残す）。
 * **やめるのは嘘をつくこと**で、代わりに有人支援へ倒す。
 */
describe('unrouted: 取り次げないことを正直に伝える (N0)', () => {
  it('🔴 理由として unrouted を受け付ける', () => {
    expect(CALL_FAILURE_REASONS).toContain('unrouted');
  });

  it('🔴 「呼び出しに失敗しました」と同じ文言にしない', () => {
    // 呼び出しは**行われていない**。行われて失敗したかのように読ませない。
    expect(failedMessageKeyFor('unrouted')).not.toBe(failedMessageKeyFor(undefined));
    expect(failedMessageKeyFor('unrouted')).not.toBe(failedMessageKeyFor('network'));
  });

  /**
   * 🔴 **果たせない約束をしない。** 代替導線の文言は「代表窓口にお繋ぎします」で、
   * **システムが取り次ぐという約束**（`shouldOfferAlternativeContact` の doc）。
   * 取次そのものが構成されていない／止まっているときに押させると、来訪者を待たせるだけ。
   * 文面側で「スタッフをお呼びください」と案内する。
   */
  it('🔴 代替導線（代表窓口へ）を主 CTA にしない', () => {
    expect(shouldOfferAlternativeContact('unrouted')).toBe(false);
  });
});
