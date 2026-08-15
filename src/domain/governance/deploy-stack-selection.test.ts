/**
 * `--only` によるデプロイ対象の絞り込み（#680 / 2026-08-15）。
 *
 * ## なぜ要るか
 *
 * cross-region 参照は「生産側スタックが SSM へ書いた値を、消費側スタックが読む」形で
 * 実現されている。**新規の消費側スタックは、生産側がデプロイされるまで change set を
 * 作れない**（`Parameters: [ssm:/cdk/exports/...] cannot be found.`）。
 *
 * wrapper は 3 スタックすべてを gate してからまとめてデプロイするので、
 * 消費側の gate が失敗すると生産側のデプロイにも到達しない。実際に
 * `OpenReception-CfMon-dev` の新規作成でこれを踏んだ。
 *
 * 「gate できないものを黙って通す」のは危険なので、代わりに**対象を明示的に絞れる**ようにする。
 *
 * ## ここで守ること
 *
 * 絞り込みは**許可リストの部分集合**でなければならない。任意の名前を渡せると、
 * 層 1（スタック ARN allowlist）が守っている「触れるのは dev の 3 本だけ」を
 * 引数で迂回できてしまう。
 */
import { describe, expect, it } from 'vitest';
import { selectDeployStacks } from './deploy-stack-selection';

const ALL = [
  'OpenReception-Web-dev',
  'OpenReception-WebMonitoring-dev',
  'OpenReception-CfMon-dev',
] as const;

describe('selectDeployStacks', () => {
  it('指定が無ければ全スタックを返す（既定の挙動を変えない）', () => {
    const r = selectDeployStacks(ALL, undefined);
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.selected).toEqual([...ALL]);
  });

  it('空文字は「指定なし」として扱う', () => {
    const r = selectDeployStacks(ALL, '   ');
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.selected).toEqual([...ALL]);
  });

  it('1 本だけ選べる', () => {
    const r = selectDeployStacks(ALL, 'OpenReception-Web-dev');
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.selected).toEqual(['OpenReception-Web-dev']);
  });

  it('複数をカンマ区切りで選べる（元の順序を保つ）', () => {
    const r = selectDeployStacks(ALL, 'OpenReception-CfMon-dev, OpenReception-Web-dev');
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    // 依存順は STACKS の並びが持っているので、指定順ではなく元の順序で返す。
    expect(r.selected).toEqual(['OpenReception-Web-dev', 'OpenReception-CfMon-dev']);
  });

  it('🔴 許可リストに無い名前は拒否する（層 1 を引数で迂回させない）', () => {
    for (const bad of [
      'OpenReception-Web-prod',
      'nodi-dev-app',
      'OpenReception-Web-dev-extra',
      '*',
      'OpenReception-Web-dev,nodi-dev-app',
    ]) {
      const r = selectDeployStacks(ALL, bad);
      expect(r.ok, `${bad} が通ってしまった`).toBe(false);
    }
  });

  it('🔴 拒否した名前を診断に出す（何を直せばよいか分かる）', () => {
    const r = selectDeployStacks(ALL, 'nodi-dev-app');
    expect(r.ok).toBe(false);
    if (r.ok) return;
    expect(r.message).toContain('nodi-dev-app');
    expect(r.message).toContain('OpenReception-Web-dev');
  });

  it('🔴 1 本も選ばれない指定は拒否する（黙って何もしないを作らない）', () => {
    const r = selectDeployStacks(ALL, ',,,');
    expect(r.ok).toBe(false);
  });

  it('重複指定は 1 回にまとめる', () => {
    const r = selectDeployStacks(ALL, 'OpenReception-Web-dev,OpenReception-Web-dev');
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.selected).toEqual(['OpenReception-Web-dev']);
  });
});
