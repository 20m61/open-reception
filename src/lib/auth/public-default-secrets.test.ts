import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join, relative } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  assertNoPublicDefaultSecrets,
  PUBLIC_DEFAULT_CHECKED_KEYS,
} from './public-default-secrets';

/**
 * 公開既定値を明示的に貼ったデプロイを起動時に止める (#1124 / PR #1273 レビュー important)。
 *
 * `serverSecret()` は deploy 環境で「公開既定値と同じ値」を未設定として扱う。fail-closed の鍵は
 * そこで throw するが、セッション鍵 2 つ以外は**使った時点で**落ちるだけだった（例: ログインが
 * 500）。ここでは残りの fail-closed 鍵について「既定値を貼った」ことを起動時に止める。
 *
 * 🔴 **未設定は起動時に止めない（下界）。** これらの鍵は機能・provider によって不要なことがある
 * （`ADMIN_PASSWORD` は provider=none のときだけ、`VOICE_TRANSPORT_TOKEN_SECRET` は手順書の
 * 必須一覧にも無い）。未設定で起動を止めると、いま動いているデプロイ全体が落ちる。
 *
 * 🔴 値はすべて明らかな擬似値（`TEST-...`）か、リポジトリに平文で載っている公開既定値。
 */
const LAMBDA = 'AWS_LAMBDA_FUNCTION_NAME';

/** 公開リポジトリに平文で載っている dev フォールバック（攻撃者が知っている値）。 */
const PUBLIC_DEFAULTS: Record<string, string> = {
  ADMIN_PASSWORD: 'open-reception',
  KIOSK_ENROLLMENT_SECRET: 'dev-insecure-kiosk-enroll-secret',
  CALL_ANSWER_SECRET: 'dev-insecure-answer-secret',
  PLATFORM_ELEVATION_SECRET: 'dev-insecure-elevation-secret',
  VOICE_TRANSPORT_TOKEN_SECRET: 'dev-insecure-voice-transport-secret',
};

/** セッション鍵は「未設定でも止める」別の検査（`session-secrets.ts`）が持つ。 */
const SESSION_KEYS = ['ADMIN_SESSION_SECRET', 'KIOSK_SESSION_SECRET'];

const CHECKED = PUBLIC_DEFAULT_CHECKED_KEYS.map((k) => k.env);

beforeEach(() => {
  vi.stubEnv(LAMBDA, undefined);
  for (const env of Object.keys(PUBLIC_DEFAULTS)) vi.stubEnv(env, undefined);
});
afterEach(() => {
  vi.unstubAllEnvs();
  vi.restoreAllMocks();
});

describe('assertNoPublicDefaultSecrets（起動時の自己検査）', () => {
  it('検査対象は 5 鍵ちょうど', () => {
    expect([...CHECKED].sort()).toEqual(Object.keys(PUBLIC_DEFAULTS).sort());
  });

  for (const env of Object.keys(PUBLIC_DEFAULTS)) {
    describe(env, () => {
      it(`🔴 deploy で公開既定値を貼っていたら起動を止める`, () => {
        vi.stubEnv(LAMBDA, 'open-reception-server');
        vi.stubEnv(env, PUBLIC_DEFAULTS[env]);
        expect(() => assertNoPublicDefaultSecrets()).toThrow(new RegExp(env));
      });

      /** 🔴 例外メッセージに値（既定値）を出さない。 */
      it('🔴 例外メッセージに値を載せない', () => {
        vi.stubEnv(LAMBDA, 'open-reception-server');
        vi.stubEnv(env, PUBLIC_DEFAULTS[env]);
        let message = '';
        try {
          assertNoPublicDefaultSecrets();
        } catch (e) {
          message = (e as Error).message;
        }
        expect(message).toMatch(new RegExp(env));
        expect(message).not.toContain(PUBLIC_DEFAULTS[env]);
      });

      /** 下界。正しい値なら起動する（「常に throw」では上を満たせてしまう）。 */
      it('deploy で独自の値なら起動する', () => {
        vi.stubEnv(LAMBDA, 'open-reception-server');
        vi.stubEnv(env, `TEST-${env}`);
        expect(() => assertNoPublicDefaultSecrets()).not.toThrow();
      });

      /** 下界。未設定・空は起動時には止めない（使った時点で getter が fail-closed）。 */
      it.each([
        ['未設定', undefined],
        ['空文字', ''],
      ])('deploy で%sなら起動は止めない', (_label, value) => {
        vi.stubEnv(LAMBDA, 'open-reception-server');
        vi.stubEnv(env, value);
        expect(() => assertNoPublicDefaultSecrets()).not.toThrow();
      });

      /** 下界。ローカル・e2e（`next start`）は既定値で動かす。 */
      it('ローカル（非 Lambda）では公開既定値でも止めない', () => {
        vi.stubEnv(env, PUBLIC_DEFAULTS[env]);
        expect(() => assertNoPublicDefaultSecrets()).not.toThrow();
      });

      /** 🔴 1 鍵だけ壊れた世界で、その鍵を名指しする（先頭の鍵だけ見る変異を残さない）。 */
      it('他の鍵が正しくても、この鍵だけで止める', () => {
        vi.stubEnv(LAMBDA, 'open-reception-server');
        for (const other of Object.keys(PUBLIC_DEFAULTS)) vi.stubEnv(other, `TEST-${other}`);
        vi.stubEnv(env, PUBLIC_DEFAULTS[env]);
        expect(() => assertNoPublicDefaultSecrets()).toThrow(new RegExp(env));
      });
    });
  }
});

/**
 * 🔴 **一覧を手で伸ばすとずれる。** `serverSecret(..., { failClosed: true })` の呼び出し元から
 * env 名を機械的に拾い、「セッション鍵の検査」か「この検査」のどちらかに載っていることを縛る。
 * 新しい fail-closed 鍵を足して検査へ載せ忘れると、ここが赤くなる。
 */
describe('fail-closed 鍵の棚卸し', () => {
  function walk(dir: string, out: string[] = []): string[] {
    for (const name of readdirSync(dir)) {
      const p = join(dir, name);
      if (statSync(p).isDirectory()) walk(p, out);
      else if (/\.tsx?$/.test(name) && !/\.test\.tsx?$/.test(name)) out.push(p);
    }
    return out;
  }

  it('すべての failClosed 鍵が起動時検査のどちらかに載っている', () => {
    const src = join(__dirname, '..', '..');
    const found = new Map<string, string>();
    // 改行をまたぐ呼び出し（`serverSecret('X', 'y', {\n failClosed: true })`）も拾う。
    const call = /serverSecret\(\s*'([A-Z0-9_]+)'\s*,\s*'[^']*'\s*,\s*\{\s*failClosed:\s*true\s*,?\s*\}\s*,?\s*\)/g;
    for (const file of walk(src)) {
      const text = readFileSync(file, 'utf8');
      for (const m of text.matchAll(call)) found.set(m[1], relative(src, file));
    }
    for (const [env, file] of found) {
      expect([...SESSION_KEYS, ...CHECKED], `${env}（${file}）が起動時検査に載っていない`).toContain(env);
    }
    // 🔴 逆向きも縛る。走査が空振りすると上は空虚に通るので、検査側の全鍵が見つかっていること。
    expect([...found.keys()].sort()).toEqual([...SESSION_KEYS, ...CHECKED].sort());
  });
});
