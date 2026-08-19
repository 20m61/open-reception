import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';
import {
  LOCAL_FAST_GATE_VALUES,
  buildDelegationPrompt,
} from '../../src/domain/governance/delegation-prompt';

/**
 * 1 周の手順が**入口ごとに食い違わない**ことを固定する。
 *
 * ## なぜ要るか
 *
 * ループの入口は 2 つある:
 *
 * - **web セッション**（人が claude.ai/code で開く）… `.claude/skills/loop-round/SKILL.md`
 * - **routine セッション**（委譲）… `buildDelegationPrompt` が生成する散文
 *
 * どちらも「PR はこう作る / マージはこうする」を**別々の場所に書いている**。
 * 二重管理なので放っておけば必ずずれる ―― そして**ずれても誰も落ちない**。
 *
 * 実際 2026-08-18 に 2 度踏んだ:
 *
 * 1. `gh pr create` が 403 になると分かった後も、生成器は `gh pr create --base` を配り続けていた
 * 2. `gh pr merge` が 403 と判明した日、docs と生成器は「`gh pr merge` は通る」と書いていた
 *
 * どちらも**散文が実測から遅れた**ことによる。ここでは「両方の入口が同じコマンドを
 * 名指ししていること」だけを機械で縛る（文章の言い回しは縛らない）。
 */
const SKILL = resolve(process.cwd(), '.claude/skills/loop-round/SKILL.md');

const BASE = {
  branch: 'feat/x',
  headSha: 'abc1234',
  baseSha: 'def5678',
  title: 'feat(kiosk): 何かをする',
  summary: '説明。',
  changedFiles: ['src/a.ts'],
  refs: [675],
  // #705: ローカルゲートの結果は**申告が必須**（生成器は確かめられない）。
  localFastGate: 'green' as const,
};

describe('loop-round スキルと委譲プロンプトの整合', () => {
  const skill = readFileSync(SKILL, 'utf8');
  const prompt = buildDelegationPrompt(BASE);

  /** 入口が変わっても同じでなければならないコマンド。 */
  const SHARED_COMMANDS = [
    'scripts/create-pull-request.ts',
    'scripts/merge-pull-request.ts',
    'quality-gate.sh',
  ];

  it.each(SHARED_COMMANDS)('%s を両方の入口が名指ししている', (cmd) => {
    expect(skill, `スキルが ${cmd} を名指ししていない`).toContain(cmd);
    expect(prompt, `委譲プロンプトが ${cmd} を名指ししていない`).toContain(cmd);
  });

  /**
   * 🔴 **push は委譲の前提** (#711)。委譲先は `git fetch origin && git checkout` で
   * **リモートの**コミットを取るので、push していないツリーは手に入らない。裏取りも
   * `origin/<branch>` まで一致して初めて「裏取り済み」と言うため、SKILL がこの 1 行を
   * 落とすと**毎回「裏取りできませんでした」になり、警告が意味を失う**（レビューで実測）。
   *
   * 委譲プロンプト側には出ない（push するのはローカルで、委譲先ではない）ので
   * `SHARED_COMMANDS` ではなくここで縛る。
   */
  it('🔴 委譲の手順が、生成の前にコミット→push することを名指ししている', () => {
    const from = skill.indexOf('## 5.');
    const to = skill.indexOf('## 6.');
    // 見出しを改名すると `slice(from, -1)` で節が黙って広がる。節が取れないことを先に落とす。
    expect(from, '## 5. が見つからない').toBeGreaterThan(-1);
    expect(to, '## 6. が ## 5. より後ろに無い').toBeGreaterThan(from);
    const section = skill.slice(from, to);
    // 裏取りは「HEAD == spec の headSha」「clean」「origin/<branch> == HEAD」まで見るので、
    // **コミットと push の両方**が前提。片方だけ書いても毎回 unverified になる。
    for (const cmd of ['git add -A && git commit', 'git push -u origin HEAD']) {
      expect(section, `委譲の節が ${cmd} を名指ししていない`).toContain(cmd);
    }
    const commit = section.indexOf('git add -A && git commit');
    const push = section.indexOf('git push -u origin HEAD');
    const generate = section.indexOf('delegate-gate-prompt.ts');
    expect(commit, 'コミットが push より後ろに書かれている').toBeLessThan(push);
    expect(push, 'push が生成器より後ろに書かれている').toBeLessThan(generate);
  });

  it.each([
    ['gh pr create --base'],
    ['gh pr create --fill'],
    ['gh pr merge <番号>'],
  ])('どちらの入口も 403 になる実行形 %s を配らない', (form) => {
    // **実行形だけを禁ずる。**「`gh pr create` は使わないこと」という注意書きは
    // 両方に必要なので、素の文字列で禁ずると注意書きごと消える。
    expect(skill).not.toContain(form);
    expect(prompt).not.toContain(form);
  });

  it('スキルが「どこで走っているか」の判定を持つ（入口ごとに変わる部分を明示する）', () => {
    // ローカルとクラウドで**変わるのはゲートの範囲とブランチ削除だけ**、という
    // 区別がスキルの要点。判定手段を書いていなければ、読み手は区別できない。
    expect(skill).toContain('CLAUDE_CODE_REMOTE');
  });

  it('スキルが AC マッピングを省略させない', () => {
    // このリポジトリで**最も繰り返された失敗**（既に main に在るものを作り直す）の入口。
    expect(skill).toContain('issue-ac-mapping');
  });

  it('スキルが完了の証拠を要求する（idle や「終わりました」で完了にしない）', () => {
    expect(skill).toContain('ブランチが出来た');
    expect(skill).toContain('idle');
  });
  describe('ローカルゲートの申告 (#705)', () => {
    /**
     * `localFastGate` は**呼び出し側が申告する**必須項目。web セッションで人が spec を
     * 書くときの唯一の案内が SKILL.md なので、**そこに書いていなければ気づけない**
     * （実行時に落ちて初めて分かる）。散文と実装がずれる型をここで止める。
     */
    it('スキルが localFastGate を名指ししている', () => {
      expect(skill).toContain('localFastGate');
    });

    it.each(LOCAL_FAST_GATE_VALUES)('スキルが申告値 %s を書いている', (value) => {
      // 値を増やしたら doc の更新を強制する（union に足しただけでは通らない）。
      expect(skill, `スキルが ${value} を書いていない`).toContain(value);
    });
  });
});
