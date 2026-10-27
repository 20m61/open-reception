#!/usr/bin/env tsx
/**
 * 公開経路（GitHub REST）へ**いま到達できるか**を確かめる (#1117)。
 *
 * ## 何を見て、何を見ないか
 *
 * 見るのは**到達性だけ**。`GET /repos/{owner}/{repo}` が 2xx を返せば 0、
 * 返らなければ理由を名指しして非 0。道具（`curl`）の欠落・通信不能・401 / 403 /
 * レート制限が全部ここに出る ―― **#1117 を作った故障族そのもの**である。
 *
 * 🔴 **push 権限の申告は見ない（撤回した / 独立レビュー 2 周目）。**
 * `permissions.push` は `contents:write` の申告で、PR 作成に要る `pull_requests:write`
 * とは別物であり、この環境では proxy が無認証でも `push:true` を返す。
 * **申告を解釈するより、到達したかどうかという事実だけを使う。**
 * 理由は `src/domain/governance/github-rest.ts` の該当箇所に残してある。
 *
 * ## どこから呼ばれるか（`scripts/record-gate-run.sh`）
 *
 * | 呼ばれる場所 | 結果の使い方 |
 * | --- | --- |
 * | ゲートの**前** | **報告だけ。止めない** |
 * | `git push` の**直前** | 非 0 なら **push せずに**終える |
 *
 * 🔴 **ゲートの前では止めない。** 記録の追記も `evaluate:gate-runs` も `loop:retro` も
 * publish の後ろに居るので、ここで止めると FAIL の測定そのものが消える（#656 より悪い）。
 * fresh clone では `npx --no-install tsx` 自体が失敗するが、ゲート本体が `npm ci` するので
 * push の直前には解決している。
 *
 * 🔴 **push の直前では止める。** 到達できないまま push すると
 * 「記録は push 済み・PR は無し」＝ #656 そのものの orphan ブランチが残る。
 * push しなければ、ゲートも記録も既に済んでいて、**残骸だけを作らずに済む**。
 *
 * ⚠️ 0 は publish の**保証ではない**。保護ブランチ・レビュー必須・App のスコープは
 * ここに現れないし、proxy が何でも 200 にする環境ではなおさらである。
 * 確かなのは「到達できなかった」側だけで、それがこの検査の値打ちである。
 *
 * 使い方:
 *   npx tsx scripts/check-publish-path.ts
 *
 * 終了コード: 0 = 到達できた / 3 = 到達できなかった（理由を stderr に出す）
 */
import { repoReadRequest } from '../src/domain/governance/github-rest';
import { callGitHubJson, requireCommands, resolveRepoFromOrigin } from './lib/github-api';

function main(): number {
  let label = '(不明)';
  try {
    requireCommands();
    const repo = resolveRepoFromOrigin();
    label = `${repo.owner}/${repo.repo}`;
    callGitHubJson<unknown>(repoReadRequest(repo));
  } catch (e) {
    console.error(`❌ 公開経路へ到達できません: ${e instanceof Error ? e.message : String(e)}`);
    return 3;
  }
  console.error(`✅ 公開経路へ到達できます（${label}）`);
  return 0;
}

process.exit(main());
