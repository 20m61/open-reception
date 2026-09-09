import { describe, expect, it } from 'vitest';
import { makeT } from '@/lib/i18n';
import {
  CHECKOUT_CONFIRM_TIMEOUT_MS,
  CHECKOUT_CONFIRM_UNKNOWN_REASON,
  CHECKOUT_FAILURE_MESSAGE,
  CHECKOUT_READ_TIMEOUT_MS,
  confirmFailureFromAbort,
  confirmFailureReason,
} from './logic';

describe('CHECKOUT_FAILURE_MESSAGE (issue #102 / #327 i18n)', () => {
  it('失敗理由ごとに来訪者向け文言を返す（PII を含まない, ja）', () => {
    const tr = makeT('ja');
    expect(CHECKOUT_FAILURE_MESSAGE('not_found', tr)).toContain('見つかりません');
    expect(CHECKOUT_FAILURE_MESSAGE('already_checked_out', tr)).toContain('退館済み');
    expect(CHECKOUT_FAILURE_MESSAGE('invalid', tr)).toContain('受付番号');
    expect(CHECKOUT_FAILURE_MESSAGE('network', tr)).toContain('通信エラー');
    expect(CHECKOUT_FAILURE_MESSAGE(undefined, tr)).toContain('通信エラー');
  });

  it('en locale では日本語が一切露出しない', () => {
    const tr = makeT('en');
    expect(CHECKOUT_FAILURE_MESSAGE('not_found', tr)).toBe(
      'We could not find that reception number. Please check the number and try again.',
    );
    expect(CHECKOUT_FAILURE_MESSAGE('already_checked_out', tr)).toBe(
      'This reception number has already been checked out.',
    );
    expect(CHECKOUT_FAILURE_MESSAGE('invalid', tr)).toBe('Please enter a reception number.');
    expect(CHECKOUT_FAILURE_MESSAGE('network', tr)).toBe('A network error occurred. Please try again.');
    expect(CHECKOUT_FAILURE_MESSAGE(undefined, tr)).toBe('A network error occurred. Please try again.');
  });

  it('ko / zh locale でも対応する文言を解決する', () => {
    expect(CHECKOUT_FAILURE_MESSAGE('not_found', makeT('ko'))).toContain('접수 번호');
    expect(CHECKOUT_FAILURE_MESSAGE('not_found', makeT('zh'))).toContain('受理编号');
  });

  it('自己特定（#328/#339）由来の失敗理由も文言化する（expired/throttled/not_recognized）', () => {
    const tr = makeT('ja');
    expect(CHECKOUT_FAILURE_MESSAGE('expired', tr)).toContain('有効期限');
    expect(CHECKOUT_FAILURE_MESSAGE('throttled', tr)).toContain('制限');
    expect(CHECKOUT_FAILURE_MESSAGE('not_recognized', tr)).toContain('確認できませんでした');
    // en でも日本語が露出しない。
    const en = makeT('en');
    expect(CHECKOUT_FAILURE_MESSAGE('expired', en)).toBe(
      'This checkout code has expired. Please ask reception for help.',
    );
    expect(CHECKOUT_FAILURE_MESSAGE('throttled', en)).toBe(
      'Too many checkout code attempts. Please wait a moment, use your checkout QR, or ask reception for help.',
    );
    expect(CHECKOUT_FAILURE_MESSAGE('not_recognized', en)).toBe(
      'We could not recognize that checkout code or visit target. Please check and try again.',
    );
  });
});

describe('締切による中断の扱い (#1029)', () => {
  const ja = makeT('ja');

  /*
    🔴 **例外の `name` を見ない**（1 周目 MINOR-2 / 残存リスク 1）。締切は相によって
    別の名前で投げ（Chromium 実測: ヘッダ欠 → `TimeoutError` / body 停止 → `AbortError`）、
    **WebKit（実機の iPad Safari）が同じ名前を使う保証は無い**。名前で分けると、
    別の名前を使うエンジンでは締切が黙って `network` へ落ちる ―― 画面に痕跡が残らない。
    自分が張った signal の `aborted` はエンジンに依らない。
  */
  it('締切が切れたなら、退館できたか分からないとして扱う', () => {
    expect(confirmFailureFromAbort(true)).toBe(CHECKOUT_CONFIRM_UNKNOWN_REASON);
  });

  /*
    🔴 **下界。** 締切側へ倒しすぎると、サーバへ**届いていない**失敗まで
    「退館できたか分かりません」と言い、再試行すれば済む来訪者を受付へ歩かせることになる。
  */
  it('締切が切れていないなら、届いていない失敗として扱う', () => {
    expect(confirmFailureFromAbort(false)).toBe('network');
    expect(confirmFailureFromAbort(false)).not.toBe(CHECKOUT_CONFIRM_UNKNOWN_REASON);
  });

  /*
    🔴 **成功を否定しない言い方であること**（#968 が `read-response.ts` に明文化した理由）。
    中断したのはこちらの待ちであって、サーバは退館を受理しているかもしれない。
  */
  it('適用されたか分からない失敗は、断定せず受付へ繋ぐ', () => {
    const message = CHECKOUT_FAILURE_MESSAGE(CHECKOUT_CONFIRM_UNKNOWN_REASON, ja);
    expect(message).toContain('受付');
    expect(message).toContain('確認できませんでした');
    // 既定（`network`）へ倒す変異をここで落とす ―― あれは再試行だけを促す。
    expect(message).not.toContain('もう一度お試しください');
    expect(message).not.toBe(CHECKOUT_FAILURE_MESSAGE(undefined, ja));
    /*
      🔴 **既存の `unexpected` と書き出しから見分けが付くこと**（1 周目 MINOR-3）。
      あれは「退館の手続きを完了できませんでした」＝**失敗の断定**で、意味が逆なのに
      助詞 1 文字しか違わなかった。iPad を一瞥する来訪者は区別できない。
    */
    expect(message.slice(0, 8)).not.toBe(CHECKOUT_FAILURE_MESSAGE('unexpected', ja).slice(0, 8));
  });

  /*
    🔴 **5xx は「拒否された」と同値ではない**（1 周目 MAJOR-1）。本番の origin は
    `serverTimeoutSec` と同じ 30 秒で読み切りを打ち切るので、ハング時にブラウザへ
    **先に届くのは CloudFront の 504** であり、35 秒の締切はほとんど発火しない。
    5xx を既定へ残すと、この理由コードを足した意味が主経路で失われる。
  */
  it('5xx は本文の理由より優先して「分からない」へ寄せる', () => {
    for (const status of [500, 502, 503, 504]) {
      expect(confirmFailureReason(status, 'network')).toBe(CHECKOUT_CONFIRM_UNKNOWN_REASON);
      // 本文が理由を名乗っていても、5xx なら信用しない。
      expect(confirmFailureReason(status, 'already_checked_out')).toBe(CHECKOUT_CONFIRM_UNKNOWN_REASON);
    }
  });

  /*
    🔴 **下界。** 4xx まで「分からない」に寄せると、**サーバが見たうえで断った**ことが
    伝わらなくなる（`already_checked_out` は「もう退館済みです」と言えるのが正しい）。
    ここを潰すと、来訪者は解決できる状況で受付へ歩かされる。
  */
  it('4xx はサーバが見て断ったので、本文の理由をそのまま使う', () => {
    for (const status of [400, 401, 403, 404, 409, 429, 499]) {
      expect(confirmFailureReason(status, 'already_checked_out')).toBe('already_checked_out');
      expect(confirmFailureReason(status, 'expired')).toBe('expired');
    }
  });

  /*
    🔴 **サーバの予算より長いこと**（`infra/lib/config/environments.ts` の
    `serverTimeoutSec` は 3 環境とも 30 秒）。同じかそれ以下にすると、サーバ自身の応答が
    必ずこちらの中断に負け、「確実に完了しなかった」という知り得たはずの事実に到達できない。
  */
  it('退館確定の締切はサーバの予算より長く、読み取りより長い', () => {
    expect(CHECKOUT_CONFIRM_TIMEOUT_MS).toBeGreaterThan(30_000);
    expect(CHECKOUT_CONFIRM_TIMEOUT_MS).toBeGreaterThan(CHECKOUT_READ_TIMEOUT_MS);
  });

  /*
    🔴 **下界を実際の値の直下に置く**（1 周目 MAJOR-4。#968 レビュー 8 周目 m7 と同型）。
    `toBeLessThanOrEqual` しか無かったので、**15s → 3s / 35s → 31s へ縮める変異が
    unit・e2e とも素通り**していた。e2e は待ち時間を同じ定数から導出するので、
    **値を原理的に縛れない** ―― 縛れるのはここだけである。

    縮むと何が起きるか: Lambda のコールドスタートは数秒級なので、正常な resolve が
    中断され、来訪者は「通信エラー」を見て再送する。コード経路の失敗は
    `src/lib/visit/checkout-credential.ts` がスロットルへ計上するので、
    **誤検知がやがて `throttled` を焚く**。
  */
  it('締切は縮めても広げてもいない（両側の界）', () => {
    expect(CHECKOUT_READ_TIMEOUT_MS).toBeGreaterThanOrEqual(15_000);
    expect(CHECKOUT_READ_TIMEOUT_MS).toBeLessThanOrEqual(20_000);
    expect(CHECKOUT_CONFIRM_TIMEOUT_MS).toBeGreaterThanOrEqual(35_000);
    expect(CHECKOUT_CONFIRM_TIMEOUT_MS).toBeLessThanOrEqual(45_000);
  });
});
