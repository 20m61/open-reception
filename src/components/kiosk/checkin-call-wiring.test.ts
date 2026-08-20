/**
 * QR 受付が実際の呼び出しを通ること（配線） (#736 Gate A)。
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
});
