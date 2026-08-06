import { execFileSync } from 'node:child_process';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

/**
 * `scripts/quality-gate.sh` の tier がどのステップに解決するかを固定する (#628)。
 *
 * ## なぜテキスト検索ではなく実行するのか
 *
 * #628 の本体は「`infra/test/**` がゲートで 1 度も実行されていなかった」で、しかも
 * **誰も気づかなかった**。ステップの不在は赤にならないので、テストが無ければ次の周回で
 * 静かに戻る。`grep` でスクリプトの字面を見るテストはリファクタで簡単に嘘になるため、
 * **実際に起動して解決後の実行計画を読む**（`QUALITY_GATE_DRY_RUN=1` は 1 つも
 * ステップを起動しない）。
 */
const SCRIPT = resolve(process.cwd(), 'scripts/quality-gate.sh');

function plan(...args: string[]): Record<string, string> {
  const out = execFileSync(SCRIPT, args, {
    encoding: 'utf8',
    env: { ...process.env, QUALITY_GATE_DRY_RUN: '1' },
  });
  return Object.fromEntries(
    out
      .trim()
      .split('\n')
      .map((line) => {
        const i = line.indexOf('=');
        return [line.slice(0, i), line.slice(i + 1)];
      }),
  );
}

describe('quality-gate tier → ステップ解決 (#628)', () => {
  it('--fast は infra を含まない（synth が重く、各変更ごとの高速チェックを殺す）', () => {
    const p = plan('--fast');
    expect(p.tier).toBe('fast');
    expect(p.infra).toBe('0');
  });

  it('--pr は infra を含む（PR 前に CDK テンプレートの退行を止める）', () => {
    const p = plan('--pr');
    expect(p.tier).toBe('pr');
    expect(p.infra).toBe('1');
  });

  it('--full は infra を含む', () => {
    expect(plan('--full').infra).toBe('1');
  });

  it('--no-infra で後から除外できる', () => {
    expect(plan('--pr', '--no-infra').infra).toBe('0');
  });

  it('--infra で fast へ追加できる', () => {
    expect(plan('--fast', '--infra').infra).toBe('1');
  });

  it('既存 tier の中身を巻き添えで変えていない', () => {
    const pr = plan('--pr');
    expect(pr).toMatchObject({ typecheck: '1', lint: '1', unit: '1', build: '1', e2e: '0' });
    const full = plan('--full');
    expect(full).toMatchObject({ e2e: '1', secrets: '1', sast: '1', lighthouse: '1', vrm: '1' });
  });

  it('--dry-run はステップを 1 つも起動しない（起動していれば数秒では返らない）', () => {
    const started = process.hrtime.bigint();
    plan('--full');
    const ms = Number(process.hrtime.bigint() - started) / 1e6;
    expect(ms).toBeLessThan(5000);
  });
});
