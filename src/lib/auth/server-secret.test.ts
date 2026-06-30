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
});
