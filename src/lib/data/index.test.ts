/**
 * バックエンド選択（resolveBackendKind）の単体テスト（#273 inc1: fail-closed）。
 *
 * 「実デプロイか」は server-secret.ts と同じ Lambda 実行マーカー
 * `AWS_LAMBDA_FUNCTION_NAME` で判定する。ローカルの production ビルド
 * （quality-gate の build / e2e / lighthouse は `next start`）ではマーカーが
 * 無いため従来どおり memory にフォールバックし、ゲートを壊さない。
 */
import { describe, it, expect } from 'vitest';
import { resolveBackendKind } from './index';

describe('resolveBackendKind', () => {
  describe('非デプロイ環境（dev / test / CI / ローカル production ビルド）', () => {
    it('DATA_BACKEND 未設定なら memory にフォールバックする', () => {
      expect(resolveBackendKind({})).toBe('memory');
    });

    it('NODE_ENV=production でも Lambda マーカーが無ければ memory（ローカル next start）', () => {
      expect(resolveBackendKind({ NODE_ENV: 'production' })).toBe('memory');
    });

    it("DATA_BACKEND='memory' を明示すれば memory", () => {
      expect(resolveBackendKind({ DATA_BACKEND: 'memory' })).toBe('memory');
    });

    it("DATA_BACKEND='dynamodb' なら dynamodb", () => {
      expect(resolveBackendKind({ DATA_BACKEND: 'dynamodb' })).toBe('dynamodb');
    });
  });

  describe('デプロイ環境（AWS_LAMBDA_FUNCTION_NAME あり）', () => {
    const lambda = { AWS_LAMBDA_FUNCTION_NAME: 'open-reception-dev-server' };

    it('DATA_BACKEND 未設定なら throw する（fail-closed）', () => {
      expect(() => resolveBackendKind({ ...lambda })).toThrow(/DATA_BACKEND/);
    });

    it('エラーメッセージに設定手順（dynamodb / web-stack）を含む', () => {
      expect(() => resolveBackendKind({ ...lambda })).toThrow(
        /DATA_BACKEND=dynamodb[\s\S]*web-stack/,
      );
    });

    it("DATA_BACKEND='dynamodb' 明示なら dynamodb", () => {
      expect(resolveBackendKind({ ...lambda, DATA_BACKEND: 'dynamodb' })).toBe('dynamodb');
    });

    it("DATA_BACKEND='memory' の明示は意図的な選択として許容する（設定漏れではない）", () => {
      expect(resolveBackendKind({ ...lambda, DATA_BACKEND: 'memory' })).toBe('memory');
    });
  });

  it('未知の値は環境を問わず throw する', () => {
    expect(() => resolveBackendKind({ DATA_BACKEND: 'postgres' })).toThrow(/Unknown DATA_BACKEND/);
  });
});
