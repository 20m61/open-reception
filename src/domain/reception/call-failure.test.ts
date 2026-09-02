/**
 * 呼び出し失敗の理由と文言の対応の単体テスト (issue #422 / 体験設計 J-OR-05)。
 */
import { describe, expect, it } from 'vitest';
import {
  CALL_FAILURE_REASONS,
  callFailureReasonFrom,
  failedMessageKeyFor,
  shouldOfferAlternativeContact,
} from './call-failure';
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

/**
 * 営業時間外に「呼び出しに失敗しました」と言わない (#736 Gate A / 体験設計 J-OR-05)。
 *
 * ## 事実
 *
 * `POST /api/kiosk/receptions/:id/call` は営業時間外に **409 `out_of_hours`**（`reopenAt` 付き）
 * を返す。ところが端末側の失敗理由は `network` / `server` / `unrouted` の 3 つしか無く、
 * 409 は最後の else に落ちて `server` になっていた。
 *
 * 結果、来訪者には「**呼び出しに失敗しました。別の方法でお呼びすることもできます。**」が出て、
 * さらに `shouldOfferAlternativeContact('server') === true` なので
 * 「**代表窓口にお繋ぎします**」という、営業時間外には果たせない約束が主 CTA として出る。
 *
 * 🔴 **`unrouted` で塞いだ嘘と同型。** あちらも「一度も撃っていない」のに失敗として読ませて
 * いた。営業時間外も呼び出しは**一度も行われていない**し、サーバは再開時刻まで返している。
 *
 * ## 到達経路
 *
 * `resolveKioskMode` は `receptionState === 'idle'` のときしか `out_of_hours` を返さない
 * （進行中の来訪者を中断しないため）。よって**営業中に受付を始めて、確認画面で手間取って
 * いる間に閉店した来訪者**は必ずこの枝を通る。
 */
describe('営業時間外の呼び出し (#736)', () => {
  it('理由として扱える（server に潰さない）', () => {
    expect(CALL_FAILURE_REASONS).toContain('out_of_hours');
  });

  it('🔴 「呼び出しに失敗しました」と読ませない', () => {
    expect(failedMessageKeyFor('out_of_hours')).toBe('reception.failedOutOfHoursBody');
    expect(failedMessageKeyFor('out_of_hours')).not.toBe(failedMessageKeyFor('server'));
  });

  /**
   * 🔴 代替導線は「代表窓口にお繋ぎします。受付スタッフが対応いたします」という約束。
   * 営業時間外にその約束は果たせない。
   */
  it('🔴 代替の連絡先を主 CTA にしない', () => {
    expect(shouldOfferAlternativeContact('out_of_hours')).toBe(false);
  });

  it('全 locale で文言が引ける（未翻訳のキーを作らない）', () => {
    for (const locale of ['ja', 'en', 'ko', 'zh', 'ja-simple'] as const) {
      const text = makeT(locale)('reception.failedOutOfHoursBody');
      expect(text.length).toBeGreaterThan(0);
      expect(text).not.toBe('reception.failedOutOfHoursBody');
    }
  });

  /**
   * 🔴 **文言が「受付時間外である」ことを述べていること。** キーを足しただけで中身が
   * 「呼び出しに失敗しました」のままなら、来訪者から見て何も変わっていない。
   * 語彙で縛ると言い換えで壊れるので、**既存の失敗文言と同一でないこと**と
   * **時間に言及していること**の 2 点で見る。
   */
  it('🔴 日本語の文言が受付時間に言及し、失敗文言の使い回しでない', () => {
    const text = makeT('ja')('reception.failedOutOfHoursBody');
    expect(text).not.toBe(makeT('ja')('reception.failedBody'));
    expect(text).toMatch(/受付時間|営業時間|時間外/);
  });
});

/**
 * 応答本文の `error` → 失敗理由の写像 (#736)。
 *
 * 🔴 **ここは今まで `KioskFlow.tsx` の中に手書きで散らばっていて、テストが 1 本も無かった。**
 * `unrouted` だけを特別扱いする `if` が 1 つあり、それ以外の `error` は状態分岐を素通りして
 * 最後の else で `server` になる、という形だったので、**サーバが新しい理由を返しても
 * 端末は黙って「呼び出しに失敗しました」に潰す**。実際 `out_of_hours` がそうなっていた。
 */
describe('callFailureReasonFrom (#736)', () => {
  it('🔴 営業時間外を server に潰さない', () => {
    expect(callFailureReasonFrom('out_of_hours')).toBe('out_of_hours');
  });

  it('実発信の停止は unrouted', () => {
    expect(callFailureReasonFrom('unrouted')).toBe('unrouted');
  });

  it('error が無ければ失敗ではない（状態で判断させる）', () => {
    expect(callFailureReasonFrom(undefined)).toBeUndefined();
  });

  /**
   * 未知の理由は `server` へ倒す。**握り潰さない**のが要点で、
   * 「知らない error を成功として扱う」と、呼ばれていないのに先へ進む。
   */
  it('未知の理由は server へ倒す（成功として扱わない）', () => {
    expect(callFailureReasonFrom('TEST-unknown')).toBe('server');
  });

  it('🔴 既知の理由をすべて写せる（サーバが返す語彙と端末の語彙がずれない）', () => {
    // 端末側で意味を持つ理由のうち、サーバの応答本文で運ばれるものは全部引けること。
    for (const reason of ['unrouted', 'out_of_hours'] as const) {
      expect(callFailureReasonFrom(reason)).toBe(reason);
    }
  });
});
