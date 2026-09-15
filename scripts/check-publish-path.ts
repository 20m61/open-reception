#!/usr/bin/env tsx
/**
 * 週次ゲートの**公開経路**が生きているかを、ゲートを回す前に確かめる (#1117 AC3)。
 *
 * ## なぜ前に置くのか
 *
 * `record-gate-run.sh --publish` は `--full --strict`（20〜25 分）を回してから
 * 記録を commit / push し、最後に PR を作る。公開経路が壊れていると、**20 分払った後で**
 * 最後の一手だけが落ちる。落ち方は「記録は push 済み・PR は無し」＝ #656 そのもので、
 * 2026-08-03 には FAIL が 5 日間 main に載らなかった。
 *
 * 2026-09-15 にはさらに素朴な形で壊れた ―― サンドボックスに `gh` が無く、PR 作成が
 * 到達しなかった (#1117)。**どちらも、ゲートを回す前に 1 回引けば判る。**
 *
 * ## 何を確かめるか（前提を数え上げず、能力を測る）
 *
 * 🔴 **「`GITHUB_TOKEN` が在るか」のような前提の列挙で判定しない。** このサンドボックスの
 * agent proxy は資格情報を注入するので、token が無くても 200 が返る（2026-09-15 実測）。
 * 前提を数えると、**実際には publish できる環境を塞ぐ**。逆に token が在っても権限が
 * 無ければ publish はできない。だから**実際に 1 回引いて、返ってきた権限を読む**。
 *
 * ⚠️ これは**下限の検査**である。`permissions.push` は申告であって、保護ブランチや
 * レビュー必須やアプリのスコープはここに現れない。「通れば必ず publish できる」ではなく
 * 「落ちたら確実に publish できない」を早く知るためのもの。
 *
 * 使い方:
 *   npx tsx scripts/check-publish-path.ts
 *
 * 終了コード: 0 = 到達可能 / 3 = 到達不能（理由を stderr に出す）
 */
import { evaluatePushCapability, repoReadRequest } from '../src/domain/governance/github-rest';
import { callGitHubJson, requireCommands, resolveRepoFromOrigin } from './lib/github-api';

function main(): number {
  try {
    requireCommands();
  } catch (e) {
    console.error(`❌ 公開経路を使えません: ${e instanceof Error ? e.message : String(e)}`);
    return 3;
  }

  let payload: unknown;
  let label: string;
  try {
    const repo = resolveRepoFromOrigin();
    label = `${repo.owner}/${repo.repo}`;
    payload = callGitHubJson<unknown>(repoReadRequest(repo));
  } catch (e) {
    console.error(`❌ GitHub REST へ到達できませんでした: ${e instanceof Error ? e.message : String(e)}`);
    console.error('   この状態でゲートを回しても、記録は push できても PR は作れません（#656 の形）。');
    return 3;
  }

  const verdict = evaluatePushCapability(payload);
  if (!verdict.ok) {
    console.error(`❌ ${label} へ publish できません: ${verdict.reason}`);
    console.error('   この状態でゲートを回しても、記録は push できても PR は作れません（#656 の形）。');
    return 3;
  }

  console.error(`✅ 公開経路に到達できます（${label} / push 権限あり）`);
  return 0;
}

process.exit(main());
