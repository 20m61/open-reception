import { describe, expect, it } from 'vitest';
import { RETIRED_DEPLOY_CONTEXT_VARS } from '../../src/domain/governance/deploy-context';
import { envWithoutRetiredDeployVars } from '../helpers/deploy-env';

/**
 * `envWithoutRetiredDeployVars` が**正本の一覧どおりに**廃止変数を落とすことを固定する (#1195)。
 *
 * 一覧を書き写すと、廃止変数が増えたときにヘルパだけが古いまま残り、
 * wrapper のテストが再び「テストを走らせている環境」次第で落ちるようになる。
 */
describe('envWithoutRetiredDeployVars (#1195)', () => {
  it('正本の廃止変数をすべて落とし、他の変数は残す', () => {
    const base: Record<string, string | undefined> = { KEEP_ME: 'x', PATH: '/bin' };
    for (const name of RETIRED_DEPLOY_CONTEXT_VARS) base[name] = 'TEST-retired';
    // 🔴 下界: 一覧が空なら「落とした」は空虚に満たされる。
    expect(RETIRED_DEPLOY_CONTEXT_VARS.length).toBeGreaterThan(0);

    const env = envWithoutRetiredDeployVars(base);

    for (const name of RETIRED_DEPLOY_CONTEXT_VARS) expect(env).not.toHaveProperty(name);
    expect(env).toMatchObject({ KEEP_ME: 'x', PATH: '/bin' });
  });

  it('空文字の廃止変数も落とす（wrapper は空文字でも止める）', () => {
    const name = RETIRED_DEPLOY_CONTEXT_VARS[0]!;
    expect(envWithoutRetiredDeployVars({ [name]: '' })).not.toHaveProperty(name);
  });

  it('渡した環境そのものは変更しない', () => {
    const name = RETIRED_DEPLOY_CONTEXT_VARS[0]!;
    const base: Record<string, string | undefined> = { [name]: 'TEST-retired' };
    envWithoutRetiredDeployVars(base);
    expect(base[name]).toBe('TEST-retired');
  });
});
