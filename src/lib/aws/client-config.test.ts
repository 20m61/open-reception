/**
 * AWS SDK クライアント設定の単一解決点（ADR 0010 / #1103）。
 *
 * 各モジュールが個別に `new XxxClient({ region })` を組んでいると、
 * **guard を置く場所が無い**。ここを通すことで「どこを向くか」と
 * 「向いてよいか」が 1 か所に揃う。
 */
import { describe, expect, it } from 'vitest';
import { awsClientConfig } from './client-config';

describe('awsClientConfig', () => {
  it('実 AWS では region だけを返す（SDK の既定解決に任せる）', () => {
    const cfg = awsClientConfig({ AWS_RUNTIME: 'aws', AWS_REGION: 'ap-northeast-1' });
    expect(cfg).toEqual({ region: 'ap-northeast-1' });
    expect('endpoint' in cfg).toBe(false);
    expect('credentials' in cfg).toBe(false);
  });

  it('エミュレータでは endpoint と dummy 資格情報を載せる', () => {
    const cfg = awsClientConfig({ AWS_RUNTIME: 'ministack' });
    expect(cfg.endpoint).toBe('http://127.0.0.1:4566');
    expect(cfg.credentials).toEqual({ accessKeyId: 'test', secretAccessKey: 'test' });
  });

  it('🔴 呼び出し側の region 指定を尊重する（既存の呼び出し形を壊さない）', () => {
    // 既存コードは `new SecretsManagerClient({ region: this.region })` のように
    // region を持っている。抽象化でそれを奪うと挙動が変わる。
    const cfg = awsClientConfig({ AWS_RUNTIME: 'moto' }, { region: 'us-east-1' });
    expect(cfg.region).toBe('us-east-1');
    expect(cfg.endpoint).toBe('http://127.0.0.1:5000');
  });

  it('🔴 危険な組み合わせでは client 設定を作らせない', () => {
    expect(() =>
      awsClientConfig({ AWS_RUNTIME: 'ministack', AWS_ACCESS_KEY_ID: 'AKIAREALSENTINEL00000' }),
    ).toThrow(/real_credentials/);
  });

  it('引数なしは process.env を読む（環境の安全性を仮定しない）', () => {
    // 🔴 **「引数なしで成功する」と書いてはいけない。** このテストが走る環境に
    // 実 AWS 資格情報があれば、guard は**正しく**例外を投げる。実際 2026-09-14 の
    // セッションはデプロイ窓が開いており、素朴に書いたこのテストが落ちて guard が
    // 効いていることを示した。
    //
    // 主張すべきは「既定引数が `process.env` である」ことだけなので、
    // **明示的に渡した場合と同じ結果になる**ことで縛る（成功でも例外でも一致する）。
    const explicit = (() => {
      try {
        return { ok: true as const, value: awsClientConfig(process.env) };
      } catch (e) {
        return { ok: false as const, message: (e as Error).message };
      }
    })();
    const implicit = (() => {
      try {
        return { ok: true as const, value: awsClientConfig() };
      } catch (e) {
        return { ok: false as const, message: (e as Error).message };
      }
    })();
    expect(implicit).toEqual(explicit);
  });
});
