import { describe, expect, it } from 'vitest';
import {
  ORIGIN_VERIFY_HEADER,
  evaluateOriginVerify,
  readOriginVerifyConfig,
} from './origin-verify';

describe('readOriginVerifyConfig (#612)', () => {
  it('OAC / ローカルの既定は無効（secret 無し・required でない）', () => {
    expect(readOriginVerifyConfig({})).toEqual({ secret: undefined, required: false });
  });

  it('ORIGIN_VERIFY_REQUIRED は空文字と "0" 以外を真とする（曖昧な値は fail-closed 側へ倒す）', () => {
    expect(readOriginVerifyConfig({ ORIGIN_VERIFY_REQUIRED: '1' }).required).toBe(true);
    // CDK が渡すのは常に '1'。それ以外の綴りで「立てたつもりが立っていない」を作らない。
    expect(readOriginVerifyConfig({ ORIGIN_VERIFY_REQUIRED: 'true' }).required).toBe(true);
    expect(readOriginVerifyConfig({ ORIGIN_VERIFY_REQUIRED: 'yes' }).required).toBe(true);
    // 明示的な無効化の 2 通りだけが偽。
    expect(readOriginVerifyConfig({ ORIGIN_VERIFY_REQUIRED: '0' }).required).toBe(false);
    expect(readOriginVerifyConfig({ ORIGIN_VERIFY_REQUIRED: '' }).required).toBe(false);
  });

  it('空文字のシークレットは「未解決」として扱う（"" 一致で全通しにしない）', () => {
    expect(readOriginVerifyConfig({ ORIGIN_VERIFY_SECRET: '' }).secret).toBeUndefined();
  });

  it('シークレットが解決済みならそのまま持つ', () => {
    expect(readOriginVerifyConfig({ ORIGIN_VERIFY_SECRET: 'TEST-origin-verify' }).secret).toBe(
      'TEST-origin-verify',
    );
  });
});

describe('evaluateOriginVerify (#612)', () => {
  const enabled = { secret: 'TEST-origin-verify', required: true };

  it('未設定（OAC / ローカル）は検証しない', () => {
    expect(evaluateOriginVerify({ secret: undefined, required: false }, null)).toEqual({
      ok: true,
      reason: 'disabled',
    });
  });

  // 🔴 これが無いと、appSecretsName の JSON に ORIGIN_VERIFY_SECRET を同居させた配備で
  // `-c originVerifySecretName=` を渡し忘れたとき、CloudFront はヘッダを送らないのに
  // Lambda 側だけ値を持ち、全ルートが 403 になる。シークレットの存在は方式の証拠ではない。
  it('方式を表明していなければ、シークレットが env に在っても検証しない', () => {
    const strayEnvSecret = { secret: 'TEST-origin-verify', required: false };
    expect(evaluateOriginVerify(strayEnvSecret, null)).toEqual({ ok: true, reason: 'disabled' });
    expect(evaluateOriginVerify(strayEnvSecret, 'wrong')).toEqual({ ok: true, reason: 'disabled' });
  });

  it('一致すれば通す', () => {
    expect(evaluateOriginVerify(enabled, 'TEST-origin-verify')).toEqual({
      ok: true,
      reason: 'matched',
    });
  });

  it('不一致（Function URL 直叩き）は拒否する', () => {
    expect(evaluateOriginVerify(enabled, 'wrong')).toEqual({ ok: false, reason: 'mismatch' });
  });

  it('ヘッダ欠落（CloudFront 迂回）は拒否する', () => {
    expect(evaluateOriginVerify(enabled, null)).toEqual({ ok: false, reason: 'mismatch' });
  });

  it('origin-verify 方式なのにシークレットが未解決なら fail-closed で拒否する', () => {
    // Secrets Manager 解決の失敗・JSON キー欠落で secret が空になったときに
    // 「未設定だから検証しない」へ落ちると、CloudFront 迂回が素通りする。
    expect(evaluateOriginVerify({ secret: undefined, required: true }, 'anything')).toEqual({
      ok: false,
      reason: 'missing-secret',
    });
  });

  it('ヘッダ名は CloudFront の origin custom header と同じ', () => {
    expect(ORIGIN_VERIFY_HEADER).toBe('x-origin-verify');
  });
});
