import { describe, expect, it, afterEach, vi } from 'vitest';
import { serverSecret } from './server-secret';

const ENV = 'TEST_SECRET_X';
const LAMBDA = 'AWS_LAMBDA_FUNCTION_NAME';

afterEach(() => {
  delete process.env[ENV];
  delete process.env[LAMBDA];
  vi.restoreAllMocks();
});

describe('serverSecret', () => {
  it('env が設定済みならその値を返す', () => {
    process.env[ENV] = 'real-secret';
    expect(serverSecret(ENV, 'fallback')).toBe('real-secret');
  });

  it('ローカル（非Lambda）で未設定なら dev フォールバックを返す', () => {
    expect(serverSecret(ENV, 'fallback')).toBe('fallback');
  });

  it('Lambda 実行かつ failClosed なら未設定で throw', () => {
    process.env[LAMBDA] = 'fn-prod';
    expect(() => serverSecret(ENV, 'fallback', { failClosed: true })).toThrow(/TEST_SECRET_X/);
  });

  it('Lambda 実行かつ failClosed でも env 設定済みなら値を返す', () => {
    process.env[LAMBDA] = 'fn-prod';
    process.env[ENV] = 'real-secret';
    expect(serverSecret(ENV, 'fallback', { failClosed: true })).toBe('real-secret');
  });

  it('Lambda 実行で failClosed 無しなら警告しつつフォールバック', () => {
    process.env[LAMBDA] = 'fn-prod';
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    expect(serverSecret(ENV, 'fallback')).toBe('fallback');
    expect(warn).toHaveBeenCalledOnce();
  });

  /**
   * 🔴 **公開既定値を「明示的に設定した」デプロイも未設定と同じに扱う (#1124)。**
   * 既定値はリポジトリに平文で載っているので、env に同じ文字列を入れても秘密にならない
   * （`.env.example` からのコピーや、手順書の例をそのまま貼る形で起こる）。
   */
  it('🔴 Lambda 実行かつ failClosed なら、公開既定値と同じ値でも throw（値は出さない）', () => {
    process.env[LAMBDA] = 'fn-prod';
    process.env[ENV] = 'TEST-public-default';
    let message = '';
    try {
      serverSecret(ENV, 'TEST-public-default', { failClosed: true });
    } catch (e) {
      message = (e as Error).message;
    }
    expect(message).toMatch(/TEST_SECRET_X/);
    expect(message).not.toContain('TEST-public-default');
  });

  /** failClosed で無い鍵も、公開既定値と同じ値なら警告する（黙って使わない）。 */
  it('Lambda 実行で failClosed 無しなら、公開既定値と同じ値でも警告する', () => {
    process.env[LAMBDA] = 'fn-prod';
    process.env[ENV] = 'fallback';
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    expect(serverSecret(ENV, 'fallback')).toBe('fallback');
    expect(warn).toHaveBeenCalledOnce();
  });

  /** 下界。既定値と**似ているだけ**の値は通す（完全一致だけを拒否する）。 */
  it('Lambda 実行でも、公開既定値と異なる値は通る', () => {
    process.env[LAMBDA] = 'fn-prod';
    process.env[ENV] = 'fallback-but-rotated';
    expect(serverSecret(ENV, 'fallback', { failClosed: true })).toBe('fallback-but-rotated');
  });

  /** ローカル（非Lambda）では既定値と同じ値を設定しても動かす（e2e / 手元を壊さない）。 */
  it('ローカルでは公開既定値と同じ値でもそのまま返す', () => {
    process.env[ENV] = 'fallback';
    expect(serverSecret(ENV, 'fallback', { failClosed: true })).toBe('fallback');
  });
});
