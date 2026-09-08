import { describe, expect, it } from 'vitest';
import { asCallResult, asCreatedReception } from './parse';

/**
 * 受付作成 `POST /api/kiosk/receptions` の応答が**確かめられた形か** (#1004 増分 2)。
 *
 * ## なぜ `id` だけを、これほど厳しく見るのか
 *
 * `(await createRes.json()) as { id: string }` は実行時に何も検査しない。`id` が欠けた 200 が
 * 返ると、その `undefined` が**そのまま 2 か所へ流れる**:
 *
 * 1. `dispatch({ type: 'SESSION_CREATED', sessionId: undefined })` ―― 状態機械が
 *    `data.sessionId` に `undefined` を持つ
 * 2. `fetch('/api/kiosk/receptions/undefined/call')` ―― サーバは `getReception('undefined')`
 *    に失敗して非 200 を返す
 *
 * 結果として来訪者には呼び出し失敗が出るが、**理由が嘘になる**（到達も呼び出しもできて
 * いないのに `server` ＝「呼び出しを完了できなかった」と読める）。
 *
 * 🔴 **さらに悪いのは、受付がサーバ側に残ることである。** 作成の POST は 200 を返して
 * いるので受付レコードは存在する。しかし端末はその ID を持っていないので、
 * **呼ぶことも・完了することも・取り消すこともできない**（`leaveWithServer` の
 * `shouldCancelOnServer` は `sessionId` を要求する）。来訪者が「最初に戻る」を押しても
 * `/cancel` は飛ばない。運用者からは受付が始まったように見えたまま宙に浮く。
 *
 * **述語で防げるのはこのうち 2 つ**（嘘の理由と `/undefined/call`）。**孤児レコードは
 * 防げない** ―― ID を知らないものは取り消しようがない。そこはサーバ側の TTL/掃除の
 * 領分なので、ここでは「これ以上悪化させない」ことだけを担う。
 */

describe('asCreatedReception (#1004)', () => {
  it('正しい形はそのまま通る', () => {
    expect(asCreatedReception({ id: 'r-1' })).toEqual({ id: 'r-1' });
  });

  it('サーバがフィールドを足しても通る（前方互換）', () => {
    expect(asCreatedReception({ id: 'r-1', state: 'created', addedLater: 'x' })).toEqual({ id: 'r-1' });
  });

  /**
   * 🔴 **これが本題。** `undefined` が URL へ入って `/api/kiosk/receptions/undefined/call` に
   * なり、受付がサーバ側に孤児として残る。
   */
  it('id が無い／文字列でなければ通さない', () => {
    expect(asCreatedReception({})).toBeNull();
    expect(asCreatedReception({ ok: true })).toBeNull();
    expect(asCreatedReception({ id: null })).toBeNull();
    expect(asCreatedReception({ id: 42 })).toBeNull();
  });

  /**
   * 🔴 **空文字と空白のみも弾く。** 型としては `string` なので素通りするが、URL に入れると
   * `/api/kiosk/receptions//call`（パスが 1 つ潰れる）になり、`undefined` とは**別の**
   * 経路で壊れる。`shouldOpenVideoView` が `trim().length > 0` を見ているのと同じ理由。
   */
  it('空文字・空白のみの id は通さない（パスが潰れる形）', () => {
    expect(asCreatedReception({ id: '' })).toBeNull();
    expect(asCreatedReception({ id: '   ' })).toBeNull();
  });

  it('オブジェクトでなければ通さない', () => {
    for (const notObject of [null, undefined, 'r-1', 3, true, []]) {
      expect(asCreatedReception(notObject)).toBeNull();
    }
  });
});

describe('asCallResult (#1004)', () => {
  it('通常の呼び出し応答はそのまま通る', () => {
    const res = { state: 'calling', vonageSessionId: 'v-1', stages: [] };
    expect(asCallResult(res)).toEqual(res);
  });

  /**
   * 🔴 **`state` を必須にしない。** 営業時間外の 409 は `{ error, reason, reopenAt }` を返し、
   * `state` を持たない。必須にすると**閉店後の来訪者向けの正しい案内を弾く**
   * （`kiosk-out-of-hours-call.spec.ts` が固定している経路）。
   */
  it('state を持たない失敗応答（営業時間外の 409 など）も通す', () => {
    const outOfHours = { error: 'out_of_hours', reason: 'out_of_hours', reopenAt: '2026-08-21T00:00:00.000Z' };
    expect(asCallResult(outOfHours)).toEqual(outOfHours);
  });

  /**
   * 🔴 **これが本題。** `200 text/html` や `200 null` で `res.json()` が throw すると
   * 外側の catch が `CALL_FAILED reason: 'network'` を出し、
   * `shouldOfferAlternativeContact('network') === false` なので**画面からボタンが 1 つも
   * 無くなる**。到達はしているので `server`（＝代替導線を主 CTA にする）へ倒す。
   */
  it('オブジェクトでなければ通さない（読めなかった 200）', () => {
    for (const notObject of [null, undefined, 'x', 3, true, []]) {
      expect(asCallResult(notObject)).toBeNull();
    }
  });

  it('読むフィールドの型が違えば通さない', () => {
    // `callFailureReasonFrom(error: string | undefined)` と `shouldOpenVideoView` が読む。
    expect(asCallResult({ error: 42 })).toBeNull();
    expect(asCallResult({ state: 42 })).toBeNull();
  });
});
