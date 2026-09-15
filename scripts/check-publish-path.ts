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
 * ## 終了コード（**「駄目」と「分からない」を分ける** / review B1・M1）
 *
 * | コード | 意味 | 呼び出し側 |
 * | --- | --- | --- |
 * | 0 | push できると応答が言っている | 進む |
 * | 3 | **確実に publish できない**（応答は読めたうえで push=false） | **止める** |
 * | 4 | **判定不能**（到達できない / permissions が読めない / 道具が無い） | 警告して進む |
 *
 * 🔴 **判定不能で週次ゲートを止めない。** 止めると、ゲートも記録も
 * `evaluate:gate-runs` も `loop:retro` も publish の後ろに居るので**全部消える** ――
 * FAIL が main に載らないどころか、FAIL の測定自体が無くなる（#656 より悪い）。
 * 一過性の 5xx・レート制限・proxy の瞬断でそれが起きてはいけない。
 */
import { evaluatePushCapability, repoReadRequest } from '../src/domain/governance/github-rest';
import { callGitHubJson, requireCommands, resolveRepoFromOrigin } from './lib/github-api';

function main(): number {
  try {
    requireCommands();
  } catch (e) {
    // 道具が無いのは「publish できない」ではなく「**判定できない**」。
    console.error(`⚠️  公開経路を判定できません: ${e instanceof Error ? e.message : String(e)}`);
    return 4;
  }

  let payload: unknown;
  let label: string;
  try {
    const repo = resolveRepoFromOrigin();
    label = `${repo.owner}/${repo.repo}`;
    payload = callGitHubJson<unknown>(repoReadRequest(repo));
  } catch (e) {
    // 到達できなかったことは「publish できない」ではない（一過性でありうる）。
    console.error(`⚠️  GitHub REST へ到達できませんでした: ${e instanceof Error ? e.message : String(e)}`);
    return 4;
  }

  const verdict = evaluatePushCapability(payload);
  if (verdict.capability === 'denied') {
    console.error(`❌ ${label} へ publish できません: ${verdict.reason}`);
    console.error('   この状態でゲートを回しても、記録は push できても PR は作れません（#656 の形）。');
    return 3;
  }
  if (verdict.capability === 'unknown') {
    console.error(`⚠️  ${label} の publish 可否を判定できませんでした: ${verdict.reason}`);
    return 4;
  }

  console.error(`✅ 公開経路に到達できます（${label} / push 権限あり）`);
  return 0;
}

process.exit(main());
