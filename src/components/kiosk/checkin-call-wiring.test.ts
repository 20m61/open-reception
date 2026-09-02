/**
 * 端末の意思がサーバへ届く配線 (#736 / #743)。
 *
 * ## なぜ構造で縛るのか
 *
 * 判断は `checkinCallOutcomeFrom`、順序は `confirmAndCall` が固定している。残るのは
 * 「**`CheckinFlow` がそれを通るか**」で、これが今回いちばん長く壊れていた箇所だった
 * ── `/api/kiosk/receptions/:id/call` を一度も呼ばずに「受付が完了しました」と表示していた。
 *
 * 🔴 **振る舞いで縛れない。** このリポジトリには jsdom も testing-library も無く
 * （vitest は node 環境）React の効果を実行できない。E2E からも踏めない ── QR の注入口
 * `?debugScanPayload=` は本番ビルドで無効で、それは token を URL クエリに載せないという
 * 別の正しい判断の帰結（`qr-injection.ts`）。実際、配線を外す変異を当てても
 * **222 テスト全部が green のまま**だった（実測）。
 *
 * よってここは「どの関数を通るか」をソースに対して固定する。弱い縛りだが、
 * **無いよりは落ちる**（今回の回帰そのものは捕まえる）。振る舞いで縛れるようになったら
 * （jsdom 導入 or QR 注入の安全な経路）このファイルは置き換えてよい。
 */
import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

const SOURCE = readFileSync('src/components/kiosk/CheckinFlow.tsx', 'utf8');
const KIOSK_SOURCE = readFileSync('src/components/kiosk/KioskFlow.tsx', 'utf8');

describe('CheckinFlow が実際の呼び出しを通る (#736)', () => {
  it('🔴 confirmAndCall を経由する（確認だけで完了にしない）', () => {
    expect(SOURCE).toContain("from '@/lib/checkin/place-call'");
    expect(SOURCE).toMatch(/await confirmAndCall\(/);
  });

  /**
   * 🔴 **確認 API を直接叩いて完了にする形へ戻さない。** それが元の姿だった
   * （`/checkin/confirm` の 201 を見て `CALL_DONE`）。順序と失敗の写像は
   * `confirmAndCall` に集約してあり、ここへ書き戻すと誰も縛れなくなる。
   */
  it('🔴 確認 API をコンポーネントから直接叩かない', () => {
    expect(SOURCE).not.toContain('/api/kiosk/checkin/confirm');
  });

  /**
   * 実 PSTN の結果待ちはサーバの応答だけで決める（経過時間で結果を作らない）。
   * 判断は `decidePollAction` に閉じているので、それを通ること自体を固定する。
   */
  it('結果待ちの判断は decidePollAction に委ねる', () => {
    expect(SOURCE).toMatch(/decidePollAction\(/);
  });

  it('timeout / unanswered は予告保持ゲートを通る (#832)', () => {
    expect(SOURCE).toContain("from './use-calling-notice-hold'");
    expect(SOURCE).toMatch(/useCallingNoticeHold\(/);
    expect(SOURCE).not.toMatch(
      /setCallFailureReason\(action\.event === 'CALL_TIMEOUT' \? 'unanswered' : 'server'\)/,
    );
  });
});

/**
 * 端末が待つのをやめたことをサーバへ伝える (#743 AC3)。
 *
 * 🔴 **画面を倒すだけでは取次が止まらない。** サーバ側の受付が `'calling'` のまま残ると
 * hop 上限まで進み続け、iPad は諦めたのに社内の電話が鳴り続ける（「無人の呼び出し」）。
 *
 * ここも振る舞いでは縛れない（node 環境で React の効果を実行できない）。上と同じ理由で
 * 構造に対して固定する。
 */
describe('端末の諦めがサーバへ届く (#743)', () => {
  it('🔴 待ち上限に達したらサーバへ受付終了の意思を送る', () => {
    expect(KIOSK_SOURCE).toContain('/give-up');
    // give_up 判断の直後に送っていること（画面を倒すだけで終わらせない）。
    expect(KIOSK_SOURCE).toMatch(/give_up[\s\S]{0,400}giveUpServerSide\(/);
  });

  /**
   * 🔴 **応答を待たない。** 来訪者にできることは無く、画面が「呼び出し中」のまま
   * 固まる方が悪い。届かなければ取次は呼出予算で自然に終わる。
   */
  it('🔴 送信の失敗で画面を止めない', () => {
    expect(KIOSK_SOURCE).toMatch(/giveUpServerSide[\s\S]{0,400}\.catch\(/);
  });
});
