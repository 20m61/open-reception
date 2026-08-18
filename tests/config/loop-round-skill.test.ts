import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';
import { buildDelegationPrompt } from '../../src/domain/governance/delegation-prompt';

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
});
