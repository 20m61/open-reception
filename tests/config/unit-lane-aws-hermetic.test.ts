/**
 * unit レーンが AWS 資格情報について hermetic であることを、**走っているプロセス自身**で
 * 確かめる（ADR 0010 / #1103）。
 *
 * ## なぜ要るか（2026-09-14 に実測）
 *
 * `instrumentation.test.ts` と `cognito-srp.test.ts` は AWS client を実際に構築する。
 * 構築経路が `awsClientConfig()` を通るようになったとき、**開発者の ambient な
 * 実 AWS 資格情報**（デプロイ窓の短命 STS 3 点）が env に載っていると guard が発火して
 * 落ちた。つまりそれ以前から、この 2 本は「窓が開いているか」で挙動が変わる
 * **非決定なテスト**だった ―― 緑だったので誰も気づかなかっただけである。
 *
 * `vitest.config.ts` の `env` で dummy を固定して直したが、設定は**黙って戻せる**。
 * ここで走行中プロセスの env を直接見て、戻ったら赤くする。
 *
 * 🔴 **`vitest.config.ts` の**文字列**を grep して満足しない。** 設定が効いているかは
 * ファイルの中身ではなくプロセスの env が決める（`env` の綴りを間違えても grep は通る）。
 */
import { describe, expect, it } from 'vitest';
import { checkAwsRuntimeSafety } from '@/domain/governance/aws-runtime';

describe('unit レーンの AWS hermeticity', () => {
  it('🔴 実 AWS 資格情報の痕跡がプロセスに無いこと', () => {
    // 下界も兼ねる: 痕跡があれば violation として必ず現れる（guard 自身のテストが保証）。
    const violations = checkAwsRuntimeSafety({ ...process.env, AWS_RUNTIME: 'ministack' });
    expect(
      violations.map((v) => v.code),
      `unit レーンに実 AWS 資格情報が漏れている: ${violations.map((v) => v.detail).join(' / ')}`,
    ).not.toContain('real_credentials');
  });

  it('dummy 資格情報が実際に入っていること（上界）', () => {
    // 「痕跡が無い」だけなら、資格情報が**何も**無い世界でも通る。その世界では
    // SDK が ambient chain（~/.aws / IMDS）へ落ちるので、明示の dummy が要る。
    expect(process.env.AWS_ACCESS_KEY_ID).toBe('test');
    expect(process.env.AWS_SECRET_ACCESS_KEY).toBe('test');
  });

  it('既定の実行系では AWS client 設定が endpoint を持たない（挙動不変の確認）', async () => {
    // 抽象化を入れる前と同じ形（region だけ）であることを固定する。
    const { awsClientConfig } = await import('@/lib/aws/client-config');
    const cfg = awsClientConfig();
    expect(cfg.endpoint).toBeUndefined();
    expect(typeof cfg.region).toBe('string');
  });
});
