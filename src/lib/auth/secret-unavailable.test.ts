/**
 * failClosed な鍵が未設定のときの応答とログの方針 (#1123)。
 *
 * ここで縛るのは 3 つ:
 * 1. **未認証で叩ける面なので、出力量を攻撃者に握らせない**（ラッチ）
 * 2. **内部の設定状態を本文に出さない**（env 名はサーバログだけ）
 * 3. 503 であること（先例に揃える。403 との差は残る＝#1127）
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  __resetSecretUnavailableLog,
  reportIncompleteConfig,
  reportSecretUnavailable,
  secretUnavailableResponse,
} from './secret-unavailable';

let spy: ReturnType<typeof vi.spyOn>;

beforeEach(() => {
  __resetSecretUnavailableLog();
  spy = vi.spyOn(console, 'error').mockImplementation(() => {});
});

afterEach(() => {
  spy.mockRestore();
  __resetSecretUnavailableLog();
});

describe('設定不備の記録 (#1123)', () => {
  it('🔴 同じ env は何度呼んでも 1 度しか記録しない（出力量を攻撃者に握らせない）', () => {
    for (let i = 0; i < 5; i += 1) reportSecretUnavailable('CALL_ANSWER_SECRET');
    expect(spy).toHaveBeenCalledTimes(1);
  });

  /**
   * 🔴 **下界。** 「1 度しか出さない」だけなら**一度も出さない**世界でも満たせる。
   * 実際に 1 度は出ること、そこに env 名が載っていることまで見る。
   */
  it('🔴 1 度は必ず出し、env 名が分かる（運用者が直せる）', () => {
    reportSecretUnavailable('CALL_ANSWER_SECRET');
    expect(spy).toHaveBeenCalledTimes(1);
    expect(String(spy.mock.calls[0]?.[0])).toContain('CALL_ANSWER_SECRET');
  });

  /** env ごとに独立。1 つ記録しても別の鍵の記録を飲み込まない。 */
  it('env ごとに 1 度ずつ記録する', () => {
    reportSecretUnavailable('CALL_ANSWER_SECRET');
    reportSecretUnavailable('KIOSK_ENROLLMENT_SECRET');
    reportSecretUnavailable('CALL_ANSWER_SECRET');
    expect(spy).toHaveBeenCalledTimes(2);
  });
});

describe('設定不備の応答 (#1123)', () => {
  it('🔴 503 を返す（voice-transport/token の先例に揃える）', () => {
    expect(secretUnavailableResponse('CALL_ANSWER_SECRET').status).toBe(503);
  });

  it('🔴 本文に env 名・鍵名を出さない（未認証で到達できる面）', async () => {
    const body = await secretUnavailableResponse('CALL_ANSWER_SECRET').json();
    expect(JSON.stringify(body)).not.toMatch(/CALL_ANSWER_SECRET|SECRET|dev-insecure/);
    // 何も返さないのではなく、使えないことは伝える。
    // 🔴 「一時的（temporarily）」とは言わない —— 設定を直すまで復旧しないので、
    // 機械が叩く相手に**果たせない期間の約束**をしない。
    expect(body).toEqual({ error: 'unavailable', message: 'unavailable' });
  });

  /**
   * 🔴 **本文だけでなくヘッダも見る。** 「内部の設定状態を漏らさない」と書いているのに、
   * 機械が見ていたのは**本文だけ**だった —— `headers: { 'x-config-missing': envName }` を
   * 足す変異が unit 132 本を素通りする（レビュー 8 周目の実測）。今日漏れているものは
   * 無いので**将来の穴**だが、散文が主張していることを機械が見ていない点は
   * 7 周目の「catch の射程」と同型。
   *
   * 4 入口はすべてこの 1 関数を通るので、**route 側に 4 コピーを作らない**。
   */
  it('🔴 ヘッダにも env 名・鍵名を出さない（未認証で到達できる面）', () => {
    const res = secretUnavailableResponse('CALL_ANSWER_SECRET');
    expect(JSON.stringify([...res.headers])).not.toMatch(
      /CALL_ANSWER|KIOSK_ENROLLMENT|ADMIN_|SECRET|dev-insecure/i,
    );
  });

  it('応答を返すときも記録はラッチされる', () => {
    secretUnavailableResponse('CALL_ANSWER_SECRET');
    secretUnavailableResponse('CALL_ANSWER_SECRET');
    expect(spy).toHaveBeenCalledTimes(1);
  });
});

/**
 * 「秘密の未設定」と「設定の不完全」は別の文面にする (#1123)。
 * 同じ文で書くと、いずれか 1 つが欠けているだけなのに運用者が全部入れ直しにいく。
 */
describe('設定の不完全の記録 (#1123)', () => {
  it('🔴 未設定とは別の文面で出す（「is not set」と言わない）', () => {
    reportIncompleteConfig('COGNITO_*', 'cognito provider selected but COGNITO_* is incomplete');
    expect(spy).toHaveBeenCalledTimes(1);
    const logged = String(spy.mock.calls[0]?.[0]);
    expect(logged).toContain('incomplete');
    expect(logged).not.toMatch(/is not set/);
  });

  it('同じ鍵は 1 度だけ（未認証で叩ける点は同じ）', () => {
    for (let i = 0; i < 3; i += 1) reportIncompleteConfig('COGNITO_*', 'x is incomplete');
    expect(spy).toHaveBeenCalledTimes(1);
  });

  /** 下界。鍵が違えば別に記録する（片方が他方を飲み込まない）。 */
  it('鍵ごとに 1 度ずつ', () => {
    reportIncompleteConfig('COGNITO_*', 'a is incomplete');
    reportSecretUnavailable('CALL_ANSWER_SECRET');
    expect(spy).toHaveBeenCalledTimes(2);
  });

  /**
   * 🔴 **2 つの報告関数のキー空間が衝突しないこと。**
   *
   * 上の「鍵ごとに 1 度ずつ」は**たまたま別名**を渡しているだけで、
   * `reportIncompleteConfig('COGNITO_REGION', …)` のような自然な呼び方が
   * `reportSecretUnavailable('COGNITO_REGION')` を**黙って飲み込む**形を禁じていない
   * （レビュー 7 周目）。衝突しえない構造（接頭辞での名前空間化）にしたので、
   * **その構造を観測可能にする** —— 散文で守らない。
   */
  it('🔴 同じ文字列でも用途が違えば別に記録する（キー空間が衝突しない）', () => {
    reportIncompleteConfig('COGNITO_REGION', 'COGNITO_REGION is incomplete');
    reportSecretUnavailable('COGNITO_REGION');
    expect(spy).toHaveBeenCalledTimes(2);
  });
});
