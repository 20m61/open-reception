/**
 * runbook が entry role へ勧めるコマンドが、entry role の Allow で実行できることを縛る。
 *
 * 🔴 2026-09-06、`docs/runbook-cloud-aws-deploy.md` ステップ 9b は diff gate の承認手順として
 * `aws cloudformation get-template` を勧めていたが、`OpenReceptionClaudeDeploy-dev` は
 * その action を持っておらず **AccessDenied** になった。クラウドから承認する運用なのに、
 * runbook が指定した唯一の検証手段が塞がっていた ―― しかも**誰も気づかないまま数週間**残った。
 *
 * 散文は実測から遅れる。ここで機械に縛らせる
 * （`tests/config/loop-round-skill.test.ts` と同じ狙い）。
 *
 * 判定は `src/domain/governance/entry-role-cli.ts`（純関数）に持つ。ここは I/O だけ。
 */
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';
import {
  extractAwsCliInvocations,
  extractFencedBlocks,
  extractSection,
  unexecutableInvocations,
  type EntryPolicyDocument,
} from '../../src/domain/governance/entry-role-cli';

const ROOT = process.cwd();
const RUNBOOK = readFileSync(resolve(ROOT, 'docs/runbook-cloud-aws-deploy.md'), 'utf8');
const ENTRY_POLICY = JSON.parse(
  readFileSync(resolve(ROOT, 'scripts/aws-policies/claude-deploy-entry.json'), 'utf8'),
) as EntryPolicyDocument;

/**
 * entry role が自分で叩く節。ここに書いてあるコマンドは**そのまま実行される**。
 *
 * 他の節（ステップ 1〜5 など）はローカル macOS の Admin 環境で人間が実行するので、
 * entry role の Allow で縛るのは誤り（`docs/cloud-dev-environment.md` §3.5 の実行レーン）。
 */
const ENTRY_ROLE_SECTIONS = ['### 9b-1: entry role で findings を読む（2026-09-06 追加）'];

describe('runbook: entry role へ勧めるコマンドは entry role で実行できる', () => {
  it.each(ENTRY_ROLE_SECTIONS)('節が存在する: %s', (heading) => {
    // 見出しを直したのに ENTRY_ROLE_SECTIONS を直し忘れると、
    // 「節が消えたので検査対象ゼロ ＝ 空虚に green」になる。それを先に落とす。
    expect(extractSection(RUNBOOK, heading), heading).not.toBe('');
  });

  it.each(ENTRY_ROLE_SECTIONS)('bash ブロックの aws 呼び出しが全部 Allow 内: %s', (heading) => {
    const section = extractSection(RUNBOOK, heading);
    const bash = extractFencedBlocks(section, 'bash').join('\n');
    const invocations = extractAwsCliInvocations(bash);

    // 下界: 呼び出しを 1 つも拾えていないなら、それは「全部 Allow 内」ではなく
    // 「抽出が壊れている」。空虚な green を先に落とす。
    expect(invocations.length, `${heading} の bash ブロックから aws 呼び出しを拾えていない`).toBeGreaterThan(0);

    const blocked = unexecutableInvocations(invocations, ENTRY_POLICY);
    expect(
      blocked.map((i) => `aws ${i.service} ${i.subcommand} → ${i.action}`),
      'entry role の Allow に無い action を runbook が勧めている',
    ).toEqual([]);
  });

  it('🔴 検査に歯があること: get-template を書けば落ちる（2026-09-06 の実物）', () => {
    // 「全部 Allow 内」は、判定側が常に空を返しても通る。実際に落ちた形で teeth を確かめる。
    const invocations = extractAwsCliInvocations('aws cloudformation get-template --stack-name X');
    expect(unexecutableInvocations(invocations, ENTRY_POLICY).map((i) => i.action)).toEqual([
      'cloudformation:GetTemplate',
    ]);
  });

  it('entry role の CloudFormation Allow は DescribeStacks / DescribeChangeSet の 2 つだけ', () => {
    // 上の検査は Allow が広がれば黙って緩む。広がったこと自体を可視化する
    // （増えたなら ADR 0009 に決定として残っているはず）。
    const actions = (ENTRY_POLICY.Statement ?? [])
      .filter((s) => s.Effect === 'Allow')
      .flatMap((s) => (typeof s.Action === 'string' ? [s.Action] : (s.Action ?? [])))
      .filter((a) => a.toLowerCase().startsWith('cloudformation:'))
      .sort();
    expect(actions).toEqual(['cloudformation:DescribeChangeSet', 'cloudformation:DescribeStacks']);
  });

  it('9b 本文は get-template を「使えない」と明記している', () => {
    const section = extractSection(RUNBOOK, '## ステップ 9b: 🔴 ゲートがブロックしたときの承認手順（#680）');
    expect(section).not.toBe('');
    expect(section).toContain('get-template');
    expect(section).toMatch(/使えない|AccessDenied/);
  });
});
