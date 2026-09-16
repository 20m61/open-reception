/**
 * 「サーバ側の問題か、要求が判定された結果か」の境界 (#1123)。
 *
 * 🔴 この 1 本が**担当者画面と受付端末画面の両方**を縛る。境界を 2 か所に手書きしていたとき、
 * 受付端末側は 502 / 503 しか踏んでおらず `>= 501` への変異が素通りした（レビュー 3 周目の実測）。
 */
import { describe, expect, it } from 'vitest';
import { isServerSideFailure } from './http-failure';

describe('サーバ側の失敗の判定 (#1123)', () => {
  it.each([500, 501, 502, 503, 504, 599])('%i はサーバ側の問題', (s) => {
    expect(isServerSideFailure(s)).toBe(true);
  });

  /**
   * 🔴 **下界。** 「5xx は true」だけなら**常に true** でも満たせる。
   * 4xx が false であることまで見る —— ここが true に倒れると、リンク切れや使用済みまで
   * 「サーバー側の問題」と言い出して、利用者が正しい対処（再発行）に辿り着けなくなる。
   */
  it.each([400, 401, 403, 404, 409, 429, 499])('%i は要求が判定された結果', (s) => {
    expect(isServerSideFailure(s)).toBe(false);
  });

  /** 境界そのもの（499 / 500 の 1 段差）を明示的に踏む。 */
  it('境界は 500（499 と 500 で割れる）', () => {
    expect(isServerSideFailure(499)).toBe(false);
    expect(isServerSideFailure(500)).toBe(true);
  });
});
