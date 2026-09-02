import { describe, expect, it } from 'vitest';
import { evaluateAudit, type Advisory, type AllowEntry } from './audit-allowlist';

const NOW = new Date('2026-08-06T00:00:00Z');

function adv(over: Partial<Advisory> = {}): Advisory {
  return {
    id: 'GHSA-aaaa-bbbb-cccc',
    severity: 'high',
    module: 'brace-expansion',
    workspace: 'infra',
    title: 'DoS',
    ...over,
  };
}

function allow(over: Partial<AllowEntry> = {}): AllowEntry {
  return {
    id: 'GHSA-aaaa-bbbb-cccc',
    reason: 'aws-cdk-lib の bundleDependencies なので上書き不能。synth 時のみ・外部入力なし',
    expires: '2026-11-01',
    ...over,
  };
}

describe('evaluateAudit (#634)', () => {
  it('allowlist に無い advisory は blocking', () => {
    const v = evaluateAudit([adv({ id: 'GHSA-zzzz-zzzz-zzzz' })], [allow()], NOW);
    expect(v.blocking.map((a) => a.id)).toEqual(['GHSA-zzzz-zzzz-zzzz']);
  });

  it('allowlist にある advisory は allowed（blocking にしない）', () => {
    const v = evaluateAudit([adv()], [allow()], NOW);
    expect(v.blocking).toEqual([]);
    expect(v.allowed.map((a) => a.id)).toEqual(['GHSA-aaaa-bbbb-cccc']);
  });

  it('期限切れの entry は許可として働かず blocking に戻る', () => {
    const v = evaluateAudit([adv()], [allow({ expires: '2026-08-05' })], NOW);
    expect(v.blocking.map((a) => a.id)).toEqual(['GHSA-aaaa-bbbb-cccc']);
    expect(v.expired.map((e) => e.id)).toEqual(['GHSA-aaaa-bbbb-cccc']);
    expect(v.allowed).toEqual([]);
  });

  it('期限当日はまだ有効（境界で 1 日早く落とさない）', () => {
    const v = evaluateAudit([adv()], [allow({ expires: '2026-08-06' })], NOW);
    expect(v.blocking).toEqual([]);
    expect(v.expired).toEqual([]);
  });

  it('使われていない entry は unused として報告する（上流が直した合図）', () => {
    const v = evaluateAudit([], [allow()], NOW);
    expect(v.unused.map((e) => e.id)).toEqual(['GHSA-aaaa-bbbb-cccc']);
  });

  it('使われている entry は unused に入れない', () => {
    const v = evaluateAudit([adv()], [allow()], NOW);
    expect(v.unused).toEqual([]);
  });

  it('期限切れの entry は unused に二重計上しない（見つかっている以上「未使用」ではない）', () => {
    const v = evaluateAudit([adv()], [allow({ expires: '2026-08-05' })], NOW);
    expect(v.unused).toEqual([]);
  });

  it('module 指定がある entry は、その module の advisory にだけ効く', () => {
    const entry = allow({ module: 'brace-expansion' });
    expect(evaluateAudit([adv({ module: 'fast-uri' })], [entry], NOW).blocking).toHaveLength(1);
    expect(evaluateAudit([adv({ module: 'brace-expansion' })], [entry], NOW).blocking).toEqual([]);
  });

  it('同じ advisory が複数 workspace で出たら、それぞれ判定する', () => {
    const found = [adv({ workspace: 'root' }), adv({ workspace: 'infra' })];
    const v = evaluateAudit(found, [allow()], NOW);
    expect(v.allowed).toHaveLength(2);
  });

  it('何も無ければ全部空', () => {
    const v = evaluateAudit([], [], NOW);
    expect(v).toEqual({ blocking: [], allowed: [], expired: [], unused: [] });
  });
});
