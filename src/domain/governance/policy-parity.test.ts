/**
 * 🔴 **層 2（cfn-exec の identity policy）と層 4（boundary）は同じ規則の 2 つの写しである。**
 *
 * 実効権限は `identity ∩ boundary` なので、**片方だけ直しても効かない**。
 * 2026-08-15 のデプロイはこれで 2 度落ちた:
 *
 * - 移行の窓を境界にだけ開けた → `explicitDeny` のまま
 * - dev の secret 読み取りを境界にだけ足した → CloudFormation が
 *   `secretsmanager:GetSecretValue` を必要とする段で `explicitDeny`
 *
 * 個別に直すのをやめ、**dev スタックが必要とする能力を 1 か所に列挙して、
 * 両方のポリシーに同じ判定を要求する**。片側にしか当たらない修正はここで落ちる。
 *
 * `aws-policy-shape.test.ts` の `ESCALATION_SCOPED_POLICIES` が
 * 「両方に同じ**禁止**を要求する」のと対になる ―― こちらは**許可**の対称性を見る。
 */
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';
import type { PolicyDocument, PolicyStatement } from './aws-policy-shape';

const load = (name: string): PolicyDocument =>
  JSON.parse(readFileSync(resolve(process.cwd(), 'scripts/aws-policies', name), 'utf8'));

/** 層 2 と層 4。どちらが欠けても実効権限は出ない。 */
const BOTH_LAYERS = ['claude-boundary.json', 'claude-cfn-exec.json'] as const;

/**
 * dev スタックが **デプロイ時またはランタイムに実際に必要とする**能力。
 *
 * ここに足すのは「あると便利」ではなく「**無いと壊れた**」もの。
 * 由来を必ず書き、実際に踏んだ事象を残す。
 */
const REQUIRED_CAPABILITIES: ReadonlyArray<{
  readonly action: string;
  /**
   * `runtime` … アプリが作る実行ロールが使う。**boundary だけ**が天井として効く。
   * `deploy`  … CloudFormation（cfn-exec role）自身が使う。**boundary と cfn-exec の両方**が要る
   *             （cfn-exec role にも boundary が付いているため）。
   */
  readonly neededBy: 'runtime' | 'deploy';
  readonly why: string;
}> = [
  {
    action: 'secretsmanager:GetSecretValue',
    neededBy: 'deploy',
    why: 'ServerFn の起動時読み取り（ランタイム）と、CloudFormation の動的参照解決（デプロイ時）の両方。2026-08-15 に dev が 500 になり、デプロイも AccessDenied で落ちた',
  },
  {
    action: 'ce:GetCostAndUsage',
    neededBy: 'runtime',
    why: 'developer コスト画面（#377）。天井に無いと画面が実行時 AccessDenied',
  },
];

const layersFor = (neededBy: 'runtime' | 'deploy'): ReadonlyArray<string> =>
  neededBy === 'deploy' ? BOTH_LAYERS : ['claude-boundary.json'];

const actionsOf = (s: PolicyStatement): ReadonlyArray<string> =>
  typeof s.Action === 'string' ? [s.Action] : (s.Action ?? []);

/** その action を無条件・全資源で Deny している文があるか（＝どう Allow しても通らない）。 */
function hasBlanketDeny(doc: PolicyDocument, action: string): boolean {
  const service = `${action.split(':')[0]}:*`;
  return doc.Statement.some(
    (s) =>
      s.Effect === 'Deny' &&
      (actionsOf(s).includes(action) || actionsOf(s).includes(service)) &&
      s.Resource === '*' &&
      s.NotResource === undefined &&
      s.Condition === undefined,
  );
}

/** その action を Allow している文があるか。 */
function hasAllow(doc: PolicyDocument, action: string): boolean {
  const service = `${action.split(':')[0]}:*`;
  return doc.Statement.some(
    (s) => s.Effect === 'Allow' && (actionsOf(s).includes(action) || actionsOf(s).includes(service)),
  );
}

describe.each(REQUIRED_CAPABILITIES)('$action ($neededBy)', ({ action, neededBy, why }) => {
  const layers = layersFor(neededBy);

  it.each(layers)(`🔴 %s が許可している（${why}）`, (name) => {
    const doc = load(name);
    expect(hasAllow(doc, action), `${name} が ${action} を Allow していない`).toBe(true);
  });

  it.each(layers)('🔴 %s に「どう Allow しても通らない」包括 Deny が無い', (name) => {
    const doc = load(name);
    expect(hasBlanketDeny(doc, action), `${name} が ${action} を包括 Deny している`).toBe(false);
  });

  /**
   * 🔴 **`deploy` のものは片側だけ直しても効かない。** 実効権限は `identity ∩ boundary` なので、
   * 両方に無ければ通らない。ここが 2026-08-15 に 2 度落ちた地点。
   */
  if (neededBy === 'deploy') {
    it('🔴 boundary と cfn-exec の両方が許可している（片側だけの修正を許さない）', () => {
      for (const name of BOTH_LAYERS) {
        const doc = load(name);
        expect(hasAllow(doc, action) && !hasBlanketDeny(doc, action), `${name} 側が通していない`).toBe(
          true,
        );
      }
    });
  }
});
