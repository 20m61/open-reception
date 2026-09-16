/**
 * unit レーンが**アプリの秘密**について hermetic であることを、走っているプロセス自身で
 * 確かめる (#1021)。AWS 資格情報側の同型は `unit-lane-aws-hermetic.test.ts`。
 *
 * ## なぜ要るか
 *
 * #1021 で `ADMIN_PASSWORD` と `CALL_ANSWER_SECRET` を `serverSecret(..., failClosed)` へ
 * 寄せた。`serverSecret()` は「値が有るか」と「実デプロイか」の 2 つで分岐するので、
 * **開発者の shell にこれらが載っているかどうかでテストの通り方が変わる**。
 * 同じ commit でも人によって結果が違う、という型は #1103（AWS 資格情報）で一度踏んでいる。
 *
 * 🔴 **`vitest.config.ts` を grep して満足しない。** 設定が効いているかはファイルの中身
 * ではなくプロセスの env が決める（`env` の綴りを間違えても grep は通る）。
 */
import { describe, expect, it } from 'vitest';

/**
 * `serverSecret()` が読む**秘密**のうち、この増分が failClosed 化した周辺のもの。
 *
 * 🔴 **分岐マーカー `AWS_LAMBDA_FUNCTION_NAME` は入れない。** 秘密ではなく、多くのテストが
 * 自由に立て倒しする対象で、Lambda ランタイム以外が供給することもない。ここに入れると
 * 「`delete` で片付けている既存テスト」全部と結合し、一覧を手で伸ばし続けることになる
 * （撤回した #1021 AC5 と同じ「数え上げ」）。
 *
 * 🔴 **この一覧自体もまだ手で並べたものである。** `KIOSK_ENROLLMENT_SECRET` /
 * `SITE_TOKEN_SECRET` を取りこぼしており、正しくは `serverSecret()` の呼び出し元から
 * 導くべき。#1122 AC5 で扱う。
 */
const PINNED = [
  'ADMIN_PASSWORD',
  'ADMIN_SESSION_SECRET',
  'KIOSK_SESSION_SECRET',
  'CALL_ANSWER_SECRET',
] as const;

describe('unit レーンの秘密 hermeticity (#1021)', () => {
  /**
   * 🔴 **下界。** 「値が無い」だけなら、**そもそも固定していない**世界でも通ってしまう
   * （たまたま開発者の shell に載っていないだけ）。キーが**在って空**であることまで
   * 見て初めて、`vitest.config.ts` の固定が効いていると言える。
   */
  it.each(PINNED)('%s が明示的に空へ固定されている', (name) => {
    expect(
      Object.prototype.hasOwnProperty.call(process.env, name),
      `${name} が process.env に無い — vitest.config.ts の env 固定が外れている`,
    ).toBe(true);
    expect(process.env[name], `${name} に値が載っている`).toBe('');
  });

  /**
   * 上界。固定した値が `serverSecret()` から見て「無い」と等価であること
   * （空文字の扱いを変える実装変更に気づく）。
   */
  it('固定した空文字は serverSecret から「未設定」と読まれる', async () => {
    const { serverSecret } = await import('@/lib/auth/server-secret');
    expect(serverSecret('ADMIN_PASSWORD', 'dev-fallback-value')).toBe('dev-fallback-value');
  });

  /**
   * 分岐マーカー（`AWS_LAMBDA_FUNCTION_NAME`）が偽なので、failClosed でもローカルでは
   * throw しない —— 開発と e2e を壊さない。マーカーは固定していないが、**この unit レーンで
   * 真になることはない**（Lambda ランタイム以外が供給しないため）。真なら赤くなるのが正しい。
   */
  it('非デプロイ判定なので failClosed でも throw しない', async () => {
    const { serverSecret } = await import('@/lib/auth/server-secret');
    expect(serverSecret('CALL_ANSWER_SECRET', 'dev-fallback-value', { failClosed: true })).toBe(
      'dev-fallback-value',
    );
  });
});
