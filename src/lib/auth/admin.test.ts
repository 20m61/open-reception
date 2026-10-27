import { afterEach, describe, expect, it, vi } from 'vitest';
import { getAdminPassword } from './admin';

/**
 * 管理パスワードが deploy 検知を通ること (#1021 AC1)。
 *
 * ## 何が問題だったか
 *
 * 署名鍵はすべて `serverSecret()` を通り、`AWS_LAMBDA_FUNCTION_NAME` を見て deploy 時に
 * throw か loud warn する。**最も価値の高い資格情報である管理パスワードだけが、
 * その経路を通っていなかった** —— `process.env.ADMIN_PASSWORD ?? 'open-reception'`。
 *
 * 既定 provider は `none`（＝パスワード認証が有効）で、既定値は**公開リポジトリに平文で
 * 載っている**。`ADMIN_PASSWORD` を入れ忘れたデプロイでは
 * `POST /api/admin/login {"password":"open-reception"}` で `tenant_admin` が取れ、
 * 全テナントの設定・監査ログ・予約 PII に到達する。
 *
 * ## なぜ failClosed にしてよいか（実測）
 *
 * `getAdminPassword()` の**本番の消費者は `/api/admin/login` の `provider=none` の枝だけ**
 * （`rg` で確認。Cognito / Entra はその手前で return する）。したがって throw するのは
 * 「パスワード認証を使っているデプロイで未設定」という、まさに塞ぎたい場合に限られ、
 * 他の認証方式のデプロイは壊れない。
 */
const LAMBDA = 'AWS_LAMBDA_FUNCTION_NAME';

/**
 * 🔴 **`delete` で片付けない。** `vitest.config.ts` はこれらを**空文字へ固定**しており
 * （unit レーンの hermeticity。#1021 / #1103 と同型）、`delete` するとキーごと消えて
 * 固定が崩れる。`--no-isolate` や pool 設定を変えた瞬間に隣のテストが落ちる時限装置に
 * なるので、元の値へ正しく戻る `vi.stubEnv` / `vi.unstubAllEnvs` を使う。
 */
afterEach(() => {
  vi.unstubAllEnvs();
});

describe('getAdminPassword (#1021 AC1)', () => {
  it('設定済みならその値を返す', () => {
    vi.stubEnv('ADMIN_PASSWORD', 'real-password');
    expect(getAdminPassword()).toBe('real-password');
  });

  /**
   * 🔴 **これが本体。** 既定値のまま本番で認証を通さない。
   * throw はログインを壊すが、**公開されている既知のパスワードを受け入れるより良い** ——
   * 運用者は落ちたことに気づいて secret を入れられる。
   */
  it('🔴 deploy 環境で未設定なら throw する（公開既定値を受け入れない）', () => {
    vi.stubEnv(LAMBDA, 'open-reception-server');
    expect(() => getAdminPassword()).toThrow(/ADMIN_PASSWORD/);
  });

  it('deploy 環境でも設定済みなら通る', () => {
    vi.stubEnv(LAMBDA, 'open-reception-server');
    vi.stubEnv('ADMIN_PASSWORD', 'real-password');
    expect(getAdminPassword()).toBe('real-password');
  });

  /**
   * 下界。ローカル・e2e（`next start` は NODE_ENV=production でも実シークレット無しで
   * 動かす）を壊さない。**「常に throw」では上の主張を満たせてしまう。**
   */
  it('ローカル（非 Lambda）では既定値を返す（開発と e2e を壊さない）', () => {
    expect(getAdminPassword()).toBe('open-reception');
  });
});
