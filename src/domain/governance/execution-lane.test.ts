import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';
import {
  classifyCommand,
  describeLaneBlock,
  runsOnLocalPrivilegedHost,
  shouldBlockHere,
  LOCAL_REQUIRED_RULES,
} from './execution-lane';

/**
 * 実行レーンの分離 (#675)。
 *
 * ## なぜ要るか
 *
 * 開発は Claude Code on the web が既定になった（2026-08-18）。ほとんどの作業はクラウドで
 * 回るが、**クラウドでやってはいけない作業**がある。#675 の必須原則のうち
 * 「production 権限・秘密情報・デプロイは local privileged lane に固定する」がここ。
 *
 * ## 何を local-required と数えるか（数えないものの方が重要）
 *
 * 🔴 **既に別の場所で強制されているものを再掲しない。** 本番デプロイは設計時の候補だったが、
 * `scripts/aws-cloud-deploy.sh` が `OR_DEPLOY_ENV != dev` を**全環境で**拒否しており
 * （脅威 T13）、ここへ足しても**一致し得ないルール**になる。一致し得ない規則は
 * 「ガードが効いている」ように見えて実際は何も見ていない（2026-08-15 に IAM の Deny で
 * 同じ形を踏んだ）。
 *
 * 🔴 **VRT ベースラインの更新は local-required ではない。** linux 側のベースラインは
 * **クラウドでしか取り直せない**（第 94 wave）。ここで止めると正しい作業ができなくなる。
 */
describe('classifyCommand: 実行レーンの分類 (#675)', () => {
  it('短命 STS の発行はローカル限定（クラウドの transcript へ資格情報を出さない）', () => {
    // `scripts/aws-issue-credentials.sh` はローカル Mac の Admin 環境でだけ意味を持ち、
    // **出力に資格情報そのものを含む**。クラウドで走らせると、失敗するだけでなく
    // 「失敗するまでに何を出したか」が使い捨て VM の記録に残りうる。
    for (const cmd of [
      './scripts/aws-issue-credentials.sh',
      'bash scripts/aws-issue-credentials.sh --minutes 60',
      'cd /repo && ./scripts/aws-issue-credentials.sh',
    ]) {
      const v = classifyCommand(cmd);
      expect(v.lane).toBe('local-required');
      expect(v.lane === 'local-required' && v.rule.id).toBe('sts-credentials');
    }
  });

  it('普通の開発コマンドは cloud-eligible（既定は「クラウドでよい」）', () => {
    // **既定を local-required にしない。** 移管の目的はクラウドで回すことなので、
    // 分からないものを止める設計にすると移管そのものを妨げる。
    for (const cmd of [
      'npm test',
      './scripts/quality-gate.sh --full',
      'npx playwright test --update-snapshots',
      'npm run build:open-next',
      'git push -u origin HEAD',
    ]) {
      expect(classifyCommand(cmd).lane).toBe('cloud-eligible');
    }
  });

  it('ルールは id / 理由 / どこでやるかを必ず持つ', () => {
    // 「なぜ止まったか」と「ではどこでやるのか」が無いブロックは、次の周回で
    // 迂回されるか、意味を失って残る。
    expect(LOCAL_REQUIRED_RULES.length).toBeGreaterThan(0);
    for (const rule of LOCAL_REQUIRED_RULES) {
      expect(rule.id).not.toBe('');
      expect(rule.reason).not.toBe('');
      expect(rule.where).not.toBe('');
    }
  });
});

describe('shouldBlockHere: どのホストで止めるか (#675)', () => {
  // local privileged lane = ユーザーの macOS。クラウドセッションは Ubuntu なので
  // platform で見分ける。**この判定は「クラウドかどうか」の近似**であり、
  // Linux のローカル開発機があれば誤って止める。本リポジトリのローカルは macOS だけ。

  it('darwin では local-required も通す（そこが正しい実行場所だから）', () => {
    const v = classifyCommand('./scripts/aws-issue-credentials.sh');
    expect(shouldBlockHere(v, 'darwin')).toBe(false);
  });

  it('darwin 以外では local-required を止める', () => {
    const v = classifyCommand('./scripts/aws-issue-credentials.sh');
    expect(shouldBlockHere(v, 'linux')).toBe(true);
  });

  it('cloud-eligible はどこでも止めない', () => {
    const v = classifyCommand('npm test');
    expect(shouldBlockHere(v, 'linux')).toBe(false);
    expect(shouldBlockHere(v, 'darwin')).toBe(false);
  });

  it('runsOnLocalPrivilegedHost は darwin だけを真とする', () => {
    expect(runsOnLocalPrivilegedHost('darwin')).toBe(true);
    expect(runsOnLocalPrivilegedHost('linux')).toBe(false);
    expect(runsOnLocalPrivilegedHost('win32')).toBe(false);
  });
});

describe('describeLaneBlock: 止めた理由を出す (#675)', () => {
  it('理由とどこでやるかを両方含む', () => {
    const rule = LOCAL_REQUIRED_RULES[0]!;
    const msg = describeLaneBlock(rule);
    expect(msg).toContain(rule.reason);
    expect(msg).toContain(rule.where);
  });
});

describe('配線: フックの事前フィルタと規則がドリフトしない (#675)', () => {
  /**
   * 🔴 **規則を TS に足しただけでは何も止まらない。**
   *
   * `guard-destructive.sh` は全 Bash 呼び出しで走るため、毎回 tsx を起動できない
   * （配線検査がゲートで 5 秒タイムアウトし、偽の赤を仕込みかけた前例がある）。
   * そこで安いリテラル一致で先に絞ってから判定 CLI を呼ぶ設計にしてある。
   * つまり **フック側のリテラルが規則と一致していなければ、その規則は死んでいる** ――
   * unit テストは緑のまま、実際には一度も発火しない。#656 と同じ「作ったが誰も呼ばない」形。
   */
  it('LOCAL_REQUIRED_RULES の matches が全部フックに現れる', () => {
    const hook = readFileSync(resolve(process.cwd(), 'scripts/hooks/guard-destructive.sh'), 'utf8');
    // フック側は grep の正規表現なのでドットがエスケープされている。比較の前に外す。
    const unescaped = hook.replace(/\\\./g, '.');
    for (const rule of LOCAL_REQUIRED_RULES) {
      for (const needle of rule.matches) {
        expect(unescaped, `規則 ${rule.id} の ${needle} がフックの事前フィルタに無い`).toContain(needle);
      }
    }
  });
});
