/**
 * `scripts/aws-negative-tests.ts` の判定関数の配線を固定する (Critical 1 の回帰テスト)。
 *
 * このスクリプト自体は AWS 認証情報が無いと実行できないため（本サイクルでは一度も
 * 実走しない）、判定ロジックは `src/domain/governance/negative-test-outcome.ts` の
 * 純関数へ切り出し、そちらをテストしている。
 *
 * しかし **「どちらの判定関数をどちらの catch で呼ぶか」という配線そのもの**が誤ると
 * 意味が反転する: `aws()`（対象アクションを直接実試行）の catch は `classifyAwsError`
 * を使ってよいが、`simulate()`（`iam:SimulatePrincipalPolicy` という別の API を呼ぶ）の
 * catch で `classifyAwsError` を使うと、`SimulatePrincipalPolicy` 自体への AccessDenied が
 * 「評価対象アクションが denied だった（＝PASS）」に化ける（2026-08-12 レビューで発見）。
 * 純関数のテストだけではこの配線ミスを検出できないため、
 * `tests/hooks/aws-cloud-deploy.test.ts` と同じ「ソースを読んで固定する」方針で covering する。
 */
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

const SOURCE = readFileSync(resolve(process.cwd(), 'scripts/aws-negative-tests.ts'), 'utf8');

function extractFunctionBody(source: string, functionSignature: string, nextMarker: string): string {
  const start = source.indexOf(functionSignature);
  if (start === -1) throw new Error(`function not found in source: ${functionSignature}`);
  const end = source.indexOf(nextMarker, start);
  if (end === -1) throw new Error(`next marker not found after ${functionSignature}: ${nextMarker}`);
  return source.slice(start, end);
}

describe('aws() と simulate() の catch が正しい判定関数を呼んでいる', () => {
  it('aws()（対象アクションを直接実試行）の catch は classifyAwsError を使う', () => {
    const body = extractFunctionBody(SOURCE, 'function aws(', 'const assumeRole');
    expect(body).toContain('classifyAwsError(stderr)');
  });

  it('simulate()（SimulatePrincipalPolicy という別の API）の catch は classifyAwsError を使わない', () => {
    const body = extractFunctionBody(SOURCE, 'function simulate(', 'function main(');
    expect(body).not.toContain('classifyAwsError(stderr)');
  });

  it('simulate() の catch は classifySimulationError を使う', () => {
    const body = extractFunctionBody(SOURCE, 'function simulate(', 'function main(');
    expect(body).toContain('classifySimulationError(stderr)');
  });
});
