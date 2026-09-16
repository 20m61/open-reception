/**
 * answer-token の単体テスト。署名往復・期限・用途(role)・改ざんを検証する。
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { signSession } from '@/lib/auth/session';
import { getAnswerSecret, issueAnswerToken, readAnswerToken } from './answer-token';

/**
 * 🔴 **env を直接書き換えない。** `vitest.config.ts` が `CALL_ANSWER_SECRET` などを
 * **空文字へ固定**している（unit レーンの hermeticity）。`delete` や代入で片付けると固定が
 * 崩れ、`--no-isolate` で隣のテストが落ちる。`vi.stubEnv` は元の値へ正しく戻る。
 */
beforeEach(() => {
  vi.stubEnv('CALL_ANSWER_SECRET', 'test-answer-secret');
});

afterEach(() => {
  vi.unstubAllEnvs();
});

describe('answer-token', () => {
  it('round-trips a receptionId', async () => {
    const token = await issueAnswerToken('rec-123');
    expect(await readAnswerToken(token)).toEqual({ receptionId: 'rec-123' });
  });

  it('rejects an expired token', async () => {
    const token = await issueAnswerToken('rec-123', -1000); // already expired
    expect(await readAnswerToken(token)).toBeNull();
  });

  it('rejects undefined / malformed tokens', async () => {
    expect(await readAnswerToken(undefined)).toBeNull();
    expect(await readAnswerToken('not-a-token')).toBeNull();
  });

  it('rejects a tampered token', async () => {
    const token = await issueAnswerToken('rec-123');
    const [body] = token.split('.');
    expect(await readAnswerToken(`${body}.deadbeef`)).toBeNull();
  });

  it('rejects a token signed with a different secret', async () => {
    const token = await issueAnswerToken('rec-123');
    vi.stubEnv('CALL_ANSWER_SECRET', 'different-secret');
    expect(await readAnswerToken(token)).toBeNull();
  });

  /**
   * 🔴 **鍵の分離だけでは信頼境界は守れない (#1021 AC2 の 2 本目の柵)。**
   *
   * 鍵を分けても、**同じ鍵で署名された別用途のトークン**が通れば意味がない。
   * `readAnswerToken` は `role === 'call_answer'` を確かめるが、それを主張する
   * テストが 1 本も無かった（元からの穴）。鍵分離と同じ増分で縛る。
   */
  it('🔴 同じ鍵でも用途(role)が違うトークンは通さない', async () => {
    const foreign = await signSession(
      { role: 'kiosk', receptionId: 'rec-123', exp: Date.now() + 60_000 },
      getAnswerSecret(),
    );
    expect(await readAnswerToken(foreign)).toBeNull();
  });

  /**
   * 🔴 **下界。** 上の 1 本は「全部 null」の世界でも満たせる。同じ鍵・正しい用途なら
   * 確かに通ることまで見る（判定が role を見ていることの確認）。
   */
  it('🔴 同じ鍵で用途が正しければ通る（下界）', async () => {
    const own = await signSession(
      { role: 'call_answer', receptionId: 'rec-123', exp: Date.now() + 60_000 },
      getAnswerSecret(),
    );
    expect(await readAnswerToken(own)).toEqual({ receptionId: 'rec-123' });
  });
});

/**
 * 応答トークンの鍵が deploy 検知を通ること (#1021 AC2)。
 *
 * ## 何が問題だったか
 *
 * `CALL_ANSWER_SECRET` は `serverSecret()` を通していなかったため、deploy 環境で
 * 未設定でも**警告すら出なかった**。加えて `KIOSK_SESSION_SECRET` へフォールバックする
 * ＝ **kiosk セッション鍵と応答トークン鍵が同一**（信頼境界の共有）。
 *
 * 両方とも未設定のデプロイでは、公開ソース上の既知文字列で応答トークンを偽造できる。
 * 受け取り側は subscriber トークンを発行して受付を `connected` に確定するので、
 * **来訪者には「担当者が応答しました」と出る**（誰も出ていない）。
 *
 * 消費者は `/api/staff/calls/[id]/answer` と `.../respond` だけ（要求ごとに評価される）
 * なので、failClosed にしても他の経路は壊れない。
 */
describe('getAnswerSecret (#1021 AC2)', () => {
  const LAMBDA = 'AWS_LAMBDA_FUNCTION_NAME';

  it('設定済みならその値を返す', () => {
    vi.stubEnv('CALL_ANSWER_SECRET', 'answer-key');
    expect(getAnswerSecret()).toBe('answer-key');
  });

  it('🔴 deploy 環境で未設定なら throw する', () => {
    vi.stubEnv('CALL_ANSWER_SECRET', undefined);
    vi.stubEnv(LAMBDA, 'open-reception-server');
    expect(() => getAnswerSecret()).toThrow(/CALL_ANSWER_SECRET/);
  });

  /**
   * 🔴 **信頼境界を共有しない (#1021 AC2)。** kiosk セッション鍵が設定されていても、
   * それを応答トークンの鍵に流用しない。流用すると、kiosk 鍵を握った者が
   * 「担当者が応答した」を偽造できる。
   */
  it('🔴 KIOSK_SESSION_SECRET へフォールバックしない', () => {
    vi.stubEnv('CALL_ANSWER_SECRET', undefined);
    vi.stubEnv('KIOSK_SESSION_SECRET', 'kiosk-key');
    vi.stubEnv(LAMBDA, 'open-reception-server');
    expect(() => getAnswerSecret()).toThrow(/CALL_ANSWER_SECRET/);
  });

  it('ローカル（非 Lambda）では既定値を返す（開発と e2e を壊さない）', () => {
    vi.stubEnv('CALL_ANSWER_SECRET', undefined);
    expect(getAnswerSecret()).toBe('dev-insecure-answer-secret');
  });

  /**
   * 🔴 **この増分が閉じていないことを、閉じていないまま固定する (#1123)。**
   *
   * 鍵未設定のデプロイでは、トークンの有無に関わらず `readAnswerToken` は throw する。
   * したがって route 層では 403 ではなく 500 になり、**応答の差から「この環境は鍵を
   * 持っていない」が外から読める**。
   *
   * 一度「トークンが無いときだけ鍵を解決しない」早期 return を入れたが、**撤回した** ——
   * トークンを 1 文字付ければオラクルはそのまま残るので、片側しか塞がない機構でありながら
   * 「塞いだ」と読める doc を残すことになる。塞ぐのは route 層の仕事で #1123。
   *
   * ここで固定するのは**現状**であって、望ましい状態ではない。#1123 がこの 2 本を
   * 「どちらも 403 相当」へ書き換える。
   */
  it.each([undefined, '', 'some.token'])(
    '鍵未設定のデプロイでは token=%p でも throw する（未解決。#1123）',
    async (token) => {
      vi.stubEnv('CALL_ANSWER_SECRET', undefined);
      vi.stubEnv(LAMBDA, 'open-reception-server');
      await expect(readAnswerToken(token)).rejects.toThrow(/CALL_ANSWER_SECRET/);
    },
  );
});
