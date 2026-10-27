import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { getAdminSecret } from './admin';
import { getKioskSecret } from './kiosk';
import { assertSessionSecretsConfigured } from './session-secrets';

/**
 * 管理 / 受付端末**セッション**の署名鍵を fail-closed にする (#1124)。
 *
 * これまで `getAdminSecret()` / `getKioskSecret()` は warn-only で、鍵を入れ忘れた
 * デプロイでは**公開既定値で署名した cookie が有効なセッションとして通った**。
 * ここでは鍵ごとに「deploy で未設定 / 公開既定値なら使わない」と、
 * 起動時の自己検査（`assertSessionSecretsConfigured`）を縛る。
 *
 * 🔴 値はすべて明らかな擬似値（`TEST-...`）。実 secret を置かない。
 */
const LAMBDA = 'AWS_LAMBDA_FUNCTION_NAME';

/** 公開リポジトリに平文で載っている dev フォールバック（攻撃者が知っている値）。 */
const PUBLIC_DEFAULTS = {
  ADMIN_SESSION_SECRET: 'dev-insecure-admin-secret',
  KIOSK_SESSION_SECRET: 'dev-insecure-kiosk-secret',
} as const;

const GETTERS = [
  { env: 'ADMIN_SESSION_SECRET', get: getAdminSecret },
  { env: 'KIOSK_SESSION_SECRET', get: getKioskSecret },
] as const;

/** 両方の鍵を正しく入れたデプロイ。 */
function healthyDeploy(): void {
  vi.stubEnv(LAMBDA, 'open-reception-server');
  vi.stubEnv('ADMIN_SESSION_SECRET', 'TEST-admin-session-secret');
  vi.stubEnv('KIOSK_SESSION_SECRET', 'TEST-kiosk-session-secret');
}

beforeEach(() => {
  // 舞台を作る。unit レーンの固定（空文字）へ寄りかからない。
  vi.stubEnv(LAMBDA, undefined);
  vi.stubEnv('ADMIN_SESSION_SECRET', undefined);
  vi.stubEnv('KIOSK_SESSION_SECRET', undefined);
});
afterEach(() => {
  vi.unstubAllEnvs();
  vi.restoreAllMocks();
});

describe('セッション署名鍵の getter (#1124)', () => {
  for (const { env, get } of GETTERS) {
    describe(env, () => {
      it('🔴 deploy で未設定なら throw する（公開既定値で署名・検証しない）', () => {
        vi.stubEnv(LAMBDA, 'open-reception-server');
        expect(() => get()).toThrow(new RegExp(env));
      });

      it('🔴 deploy で空文字なら throw する', () => {
        vi.stubEnv(LAMBDA, 'open-reception-server');
        vi.stubEnv(env, '');
        expect(() => get()).toThrow(new RegExp(env));
      });

      it('🔴 deploy で公開既定値そのものを設定していても throw する', () => {
        vi.stubEnv(LAMBDA, 'open-reception-server');
        vi.stubEnv(env, PUBLIC_DEFAULTS[env]);
        expect(() => get()).toThrow(new RegExp(env));
      });

      /** 下界。正しく設定したデプロイは動く（「常に throw」では上を満たせてしまう）。 */
      it('deploy でも設定済みならその値を返す', () => {
        healthyDeploy();
        expect(get()).toBe(env === 'ADMIN_SESSION_SECRET' ? 'TEST-admin-session-secret' : 'TEST-kiosk-session-secret');
      });

      /** 下界。ローカル・e2e（`next start`）は実鍵なしで動かす。 */
      it('ローカル（非 Lambda）では未設定でも既定値で動く', () => {
        expect(get()).toBe(PUBLIC_DEFAULTS[env]);
      });
    });
  }
});

describe('assertSessionSecretsConfigured（起動時の自己検査, #1124）', () => {
  it('両方設定済みの deploy では通る', () => {
    healthyDeploy();
    expect(() => assertSessionSecretsConfigured()).not.toThrow();
  });

  /** 否定ケースは鍵ごと × 壊れ方ごとに当てる（片方だけ検査する変異を残さない）。 */
  for (const env of ['ADMIN_SESSION_SECRET', 'KIOSK_SESSION_SECRET'] as const) {
    for (const [label, value] of [
      ['未設定', undefined],
      ['空文字', ''],
      ['公開既定値', PUBLIC_DEFAULTS[env]],
    ] as const) {
      it(`🔴 deploy で ${env} が${label}なら起動を止める`, () => {
        healthyDeploy();
        vi.stubEnv(env, value);
        expect(() => assertSessionSecretsConfigured()).toThrow(new RegExp(env));
      });
    }
  }

  /** 🔴 例外メッセージに鍵の値（既定値を含む）を出さない。 */
  it('🔴 例外メッセージに値を載せない', () => {
    healthyDeploy();
    vi.stubEnv('ADMIN_SESSION_SECRET', PUBLIC_DEFAULTS.ADMIN_SESSION_SECRET);
    let message = '';
    try {
      assertSessionSecretsConfigured();
    } catch (e) {
      message = (e as Error).message;
    }
    expect(message).toMatch(/ADMIN_SESSION_SECRET/);
    expect(message).not.toContain(PUBLIC_DEFAULTS.ADMIN_SESSION_SECRET);
    expect(message).not.toContain('TEST-kiosk-session-secret');
  });

  /** 下界。ローカル・e2e では鍵が無くても起動を止めない。 */
  it('ローカル（非 Lambda）では未設定でも通る', () => {
    expect(() => assertSessionSecretsConfigured()).not.toThrow();
  });
});
