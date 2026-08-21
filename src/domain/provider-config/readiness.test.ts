/**
 * 「この設定で実際に取り次げるか」(#763)。
 *
 * 「有効か」を判定する述語が管理画面・保存 API・受付の実挙動で揃っておらず、
 * **secret を入れる前に「vonage・有効・発信元番号」を保存できてしまう**状態だった。
 * その状態だと管理画面は「未接続」と出るのに受付端末は全件 503 になる ──
 * 管理画面のトグル 1 回で、警告も確認もなくテナントの受付が落ちる。
 */
import { describe, expect, it } from 'vitest';
import type { TenantProviderConfig } from './types';
import {
  intendsRealDialingFrom,
  PROVIDER_CONFIG_WARNINGS,
  providerConfigWarnings,
} from './readiness';

function cfg(over: Partial<TenantProviderConfig> = {}): TenantProviderConfig {
  return {
    tenantId: 'tenant-a',
    provider: 'vonage',
    enabled: true,
    applicationId: 'TEST-app',
    fromNumber: '+815000000000',
    updatedAt: '2026-08-21T00:00:00.000Z',
    updatedBy: 'platform:dev',
    ...over,
  };
}

describe('intendsRealDialingFrom (#763)', () => {
  it('vonage + enabled + fromNumber なら意図あり', () => {
    expect(intendsRealDialingFrom(cfg())).toBe(true);
  });

  /** 🔴 secret を見ない（「意図」と「今できるか」を畳まない）。 */
  it('🔴 secret の有無を引数に取らない（意図だけを答える）', () => {
    expect(intendsRealDialingFrom.length).toBe(1);
  });

  /**
   * 🔴 **Video 受付だけのテナントを巻き込まない。** `VonageCallAdapter`（遠隔顔合わせ）に
   * 発信元番号は要らないので、`fromNumber` を条件に含めないと正常な受付を全断させる。
   */
  it.each([
    ['fromNumber なし', cfg({ fromNumber: undefined })],
    ['fromNumber が空文字', cfg({ fromNumber: '' })],
    ['disabled', cfg({ enabled: false })],
    ['provider が mock', cfg({ provider: 'mock' })],
  ])('🔴 %s なら意図なし', (_label, config) => {
    expect(intendsRealDialingFrom(config)).toBe(false);
  });

  it.each([null, undefined])('設定が %p でも落ちない', (config) => {
    expect(intendsRealDialingFrom(config)).toBe(false);
  });
});

describe('providerConfigWarnings (#763)', () => {
  it('揃っていれば警告なし', () => {
    expect(providerConfigWarnings(cfg(), 'set')).toEqual([]);
  });

  /** 🔴 これが本体。トグル 1 回で受付が落ちる状態を、保存した本人へその場で伝える。 */
  it('🔴 実発信の意図があるのに secret が無ければ警告する', () => {
    expect(providerConfigWarnings(cfg(), 'missing')).toContain('real_dialing_without_secret');
  });

  it('🔴 実発信の意図があるのに applicationId が無ければ警告する', () => {
    expect(providerConfigWarnings(cfg({ applicationId: undefined }), 'set')).toContain(
      'real_dialing_without_application_id',
    );
  });

  it('両方欠けていれば両方出す（片方だけ直して安心させない）', () => {
    expect(providerConfigWarnings(cfg({ applicationId: '' }), 'missing')).toEqual([
      'real_dialing_without_secret',
      'real_dialing_without_application_id',
    ]);
  });

  /**
   * 🔴 **意図が無いテナントを警告で埋めない。** Video 専用・mock・未設定はいずれも
   * 正常な構成で、ここで警告を出すと本物の警告が埋もれる。
   */
  it.each([
    ['Video 専用（fromNumber なし）', cfg({ fromNumber: undefined })],
    ['mock', cfg({ provider: 'mock' })],
    ['disabled', cfg({ enabled: false })],
  ])('🔴 %s では secret が無くても警告しない', (_label, config) => {
    expect(providerConfigWarnings(config, 'missing')).toEqual([]);
  });

  it('未設定テナントは警告なし', () => {
    expect(providerConfigWarnings(null, 'missing')).toEqual([]);
  });

  /**
   * 🔴 **語彙は列挙で固定する。** 任意の文字列を許すと、設定値や secret の断片が
   * メッセージに混ざりうる（`rules/pii-secret-minimization.md`）。
   */
  it('🔴 返す値はすべて既知の語彙', () => {
    const all = [
      ...providerConfigWarnings(cfg({ applicationId: '' }), 'missing'),
      ...providerConfigWarnings(cfg(), 'missing'),
    ];
    for (const w of all) expect(PROVIDER_CONFIG_WARNINGS).toContain(w);
  });

  it('🔴 警告に設定値そのものを載せない', () => {
    const serialized = JSON.stringify(
      providerConfigWarnings(cfg({ fromNumber: '+81900001111', applicationId: '' }), 'missing'),
    );
    expect(serialized).not.toContain('81900001111');
  });
});
