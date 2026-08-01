# AI 駆動開発ループ (#424 / #426)

観測 → 仮説 → 実装 → 検証 → 展開を**安全に**回すための基準文書。新しく入る開発者（人間でも
AI でも）が、実装順・制約・成功条件をここから辿れることを目的にする。

**この文書は「あるべき姿」ではなく、いま動いている仕組みの写像である。** 未構築のものは
§9 に分けて書く。理想を現状として書くと、次に読む者が在ると思って探し、無いものを前提に
判断する。#424 の受入条件がまだ 1 つも満たされていないことも §9 に明記する。

## 0. 正本の関係

このループは既存文書の上に立つ。**重複して書かない**（二重管理は片方だけ直る）。

| 関心 | 正本 |
| --- | --- |
| 1 周の手順（ブランチ〜クローズ）・並列オーケストレーション | [`docs/loop-workflow.md`](loop-workflow.md) |
| 着手順・依存 DAG・現在地・落とし穴 | [`docs/loop-queue.md`](loop-queue.md) |
| 品質ゲートの層・閾値・定期運用 | [`docs/quality-gate.md`](quality-gate.md) / `scripts/quality-gate.sh` |
| 体験設計（Actor / Journey / state / fallback） | [`docs/experience/README.md`](experience/README.md) |
| 統合再設計の Wave・移行台帳・重複概念・feature flag registry | [`docs/product-integration-plan.md`](product-integration-plan.md) |
| 覆すとやり直しになる決定 | [`docs/adr/`](adr/README.md) |
| 規約とガード（重大変更条件・署名・パッケージ） | `CLAUDE.md` |
| モデル役割・実行規約・停止境界・完了証拠 | `.claude/rules/opus5-autonomous-loop.md` |
| パススコープ付き制約（認可 / PII / TDD） | `.claude/rules/` |
| KPI の分子分母と計測点 | [`docs/reception-experience-kpi.md`](reception-experience-kpi.md) |

本書が持つのは **10 フェーズと実在する仕組みの対応、および暴走防止ガードの一覧**だけ。

## 1. ループ

```text
Observe → Diagnose → Propose → Prioritize → Plan → Implement → Verify
       → Human Gate → Progressive Delivery → Measure ──┐
       └──────────────────────────────────────────────────┘
```

| フェーズ | いま何で回っているか | 状態 |
| --- | --- | --- |
| Observe | KPI 集計 / 監査ログ / コスト API / `docs/gate-runs.md` / issue・PR 履歴 | 部分（自動収集なし） |
| Diagnose | `/issue-ac-mapping` で AC を実コードへ突き合わせ、`superpowers:systematic-debugging` | 手動 |
| Propose | issue テンプレート（`improvement` / `ai-proposal`。証拠・反証条件・計測を必須欄に） | 有 |
| Prioritize | `docs/loop-queue.md` の依存 DAG と wave 計画 | 手動（スコア式なし） |
| Plan | `superpowers:brainstorming` / `writing-plans`、重大変更は ADR | 有 |
| Implement | TDD（`.claude/rules/testing.md`）・increment 分割・worktree 並列 | 有 |
| Verify | `scripts/quality-gate.sh`（9 ステップ）+ fitness テスト群（§5） | 有 |
| Human Gate | 停止境界（§6）＋ `scripts/hooks/pr-gate-guard.sh` ＋ change-risk 検出器（報告） | 有 |
| Progressive Delivery | 版ライフサイクル（#420）/ デモ版の端末限定配布（#363）/ feature flag / 移行フラグ | 部分 |
| Measure | KPI 画面・監査・コスト。**元 issue への書き戻しは無い** | 未構築 |

## 2. Observe

観測できるものと、その出どころ。

- **受付体験 KPI** … `ReceptionLog.experience` → `docs/reception-experience-kpi.md`
  （30 秒以内呼び出し開始率 / 完遂率 / 所要時間中央値 / ステップ別ファネル / 入力手段）
- **構成の反映失敗** … 版ライフサイクル（#420）の反映状況。公開 → 端末取得 → 反映 ACK が
  一周しており、未反映端末が画面で見える
- **公開前検証** … asset / motion_mapping / language_fallback / 取次到達性のチェッカ
- **監査ログ** … `AuditLog`（誰が何をしたか。PII と secret の値は載せない。
  `.claude/rules/pii-secret-minimization.md`）
- **コスト** … `GET /api/platform/costs`（developer 限定・タグ絞り込み・実績/予測）
- **品質ゲートの履歴** … `docs/gate-runs.md`（append-only）
- **依存・セキュリティ** … `npm audit` / gitleaks / semgrep（`--full`）。**ZAP は `--full` に
  入っていない**。稼働中 URL に対する動的スキャンは別スクリプト `scripts/url-quality-gate.sh`
- **アクセシビリティ** … axe（`tests/e2e/kiosk-vrt-a11y.spec.ts`）

**未構築**: これらを 1 箇所へ集約する仕組みは無い。runtime error / latency の継続収集も無い。

## 3. Diagnose

**症状ではなく原因候補を、証拠・反証条件・影響範囲つきで出す。**

- **着手前に必ず `/issue-ac-mapping` を通す。** issue 本文と `docs/loop-queue.md` の分類は
  **仮説であって事実ではない**。事実は main のコードだけ。この規律を破って既にあるものを
  作り直しかけたことが **5 回**ある（キュー冒頭に記録）。
- 同じ失敗が 3 回続いたら `superpowers:systematic-debugging` / 根本原因分析へ切り替える
  （`.claude/rules/opus5-autonomous-loop.md`）。推測を積み重ねない。
- **「実装が無い」と書くときは参照を実際に引く。** 依存があると仮定して分割を諦めた実例が
  ある（第 28 wave）。
- **契約の消費者を数える。** 導出があってもそれを呼ぶ本番経路が無ければ（消費者ゼロ）、
  中身は静かに実挙動から乖離する。#422 では 9 導出のうち 6 つが消費者ゼロで、調べた 5 つで
  乖離していた。**「一巡した」と書くときは契約ファイル全体で数える**（受付側だけ見て
  宣言し、QR 受付側が視界から外れた実例がある）。

## 4. Propose / Prioritize / Plan

提案は issue テンプレートで形を強制する。

- `.github/ISSUE_TEMPLATE/improvement.md` … 改善・機能。problem statement / evidence /
  affected users（Actor）/ expected outcome / non-goals / architecture impact /
  security・privacy・cost impact / rollback / metrics（成功条件・停止条件）/ 受入条件 /
  人間承認が必要か
- `.github/ISSUE_TEMPLATE/ai-proposal.md` … `[AI Proposal]`。上記に加えて
  **observation（出どころ付き）・hypothesis・反証条件**を必須欄にする。
  **反証条件が埋まらない提案は、検証ではなく思い込みになる。**

来訪者・運用者向けの変更は追加で、`docs/experience/README.md` から次を特定する
（`.claude/rules/opus5-autonomous-loop.md` の Experience loop）:

Actor / Journey ID と step / entry・exit・exception state / 音声とタッチの等価性 /
表示と読上げ / timeout・cancel・fallback / PII・監査影響 / 体験受入条件 / 評価層と対象デバイス

**優先順位**は `docs/loop-queue.md` の依存 DAG と wave 計画で決める。#424 が提案する
スコア式（user impact × evidence confidence × strategic fit × reversibility ÷
implementation effort × operational risk × coupling）は**未導入**。現状は依存順と
「境界内でローカル完結できるか」で並べている。

## 5. Implement / Verify

### 実装の規律

- **1 Issue = 1 検証可能な仮説**、大きい issue は increment に割る。
- **TDD**: 失敗するテストを先に書き、落ちるのを見てから実装する
  （`.claude/rules/testing.md` / `superpowers:test-driven-development`）。
- **テストを削除・skip・弱体化して green にしない。型安全性を下げない。**
- 実機・実認証・実アセットが要る部分は **interface + mock 先行**で書き、実物が要る検証は
  **#65** にスタックする。
- スコープ外の改善は Issue 候補として残す（その場で広げない）。

### ゲート（`scripts/quality-gate.sh`）

| tier | 内容 | いつ |
| --- | --- | --- |
| `--fast` | typecheck + lint + unit | 各変更ごと |
| `--pr` | fast + build | **PR 前必須** |
| `--full` | + secrets / sast / audit / e2e / lighthouse | **マージ前・定期** |

**機械的に強制される。** `scripts/hooks/pr-gate-guard.sh`（PreToolUse:Bash）が
`gh pr create`（要 `--pr` 以上）/ `gh pr merge`（要 `--full`）を、**現在の作業ツリーに対する**
green 記録が無ければブロックする。記録はゲートが実際に検査したツリーに紐づくので、
**ゲート後に編集したら走らせ直す**。

### architecture fitness functions（実在するもの）

「規律で守る」ものを機械検証へ移した実績。新しく規律を足すときは、まずこの形にできないか見る。

| 何を守るか | どこ |
| --- | --- |
| 管理 API の認可ガード網羅（新ルートを足しても気づかない構造だった） | `src/app/api/admin/authz-coverage.test.ts` |
| 管理ルートのナビ未登録検出（作る周回と IA を触る周回が別なので規律では抜ける） | `src/components/admin/navigation.ts` のメタテスト |
| Journey / 状態モデルと実装の対応 | `src/domain/experience/journey-map.ts` |
| server-only モジュールが `'use client'` から import されない | `src/domain/provider-config/server-only-import.test.ts` |
| kiosk 配下の生 CJK リテラル禁止（＝新規文言の翻訳漏れ） | `scripts/check-cjk-literals.ts` |
| 契約と表示層の一致（どのボタンを出すかの二重実装検出） | `src/components/kiosk/quick-actions.test.ts` ほか |
| 常設要素が 3 領域（案内 / 回答対象 / ヘルプ）に閉じている | `src/components/kiosk/persistent-regions.ts` + e2e |
| locale 網羅（ja/en/ko/zh 全キー・`ja-simple` は意図的な部分網羅） | `src/lib/i18n/i18n.test.ts` |
| 停止境界に触れた変更の検出（§6 の列挙を変更パスから判定） | `src/domain/governance/change-risk.ts` |

### UX complexity budget

常設要素は受付のどの局面でも視界に居座るので、増えるほど来訪者の注意が分散する。
`persistent-regions.ts` の登録簿に載せて 3 領域のどれかに属させる。**属せないなら常設すべき
ものではない**。後退系コントロールは 2 語（戻る / 最初に戻る）＋文脈固有 1 以内
（`docs/reception-ux-contract.md`）。

### 評価は安い層から

`.claude/rules/opus5-autonomous-loop.md` の 7 層: static → state/model → browser/E2E →
instrumentation → screenshot → video/agent → human/device。

- **VRT はベースラインを更新する前に差分画像と実物を見る。** 機械的に `--update-snapshots`
  すると崩れをそのまま焼き込む。
- **閾値内でも実物を見る。** `maxDiffPixelRatio: 0.02` に隠れて本物のレイアウト崩れが
  **pass した**実例がある（第 77 wave）。
- **視線・VRM の実描画は headless では確認できない**（WebGL fallback へ落ちる）→ #65。

## 6. Human Gate（自動承認しない変更）

`CLAUDE.md` と `.claude/rules/opus5-autonomous-loop.md` の停止境界。**AI は提案と実装まで、
公開と境界変更は人間が決める。**

- 本番デプロイ・本番データ操作
- Cognito / 認可 / PIN・IP 制御の境界変更
- DynamoDB の非互換変更、公開 API・永続スキーマの破壊的変更
- 新しい外部送信（Vonage 等）
- secret / PII / 監査ログ方針の変更
- 新規依存・ライセンス判断（#105 の SPDX / LICENSE / 商用可否）
- 継続的な AWS 費用増加
- **主要 Journey / state / fallback の意味を変える仕様判断**（状態を到達不能にする変更を含む）

上記以外は、**ゲート green ＋ レビュー blocking なし**で自動マージしてよい
（`docs/loop-workflow.md` 手順 8）。ユーザーはいつでも interrupt できる。

この列挙は `src/domain/governance/change-risk.ts` が変更パスから機械判定し、
`quality-gate.sh` が毎回**報告のみ**で見せる（`npm run change-risk` 単体でも実行できる）。
ゲートを FAIL させないのは意図的で、**偽陽性のある検出器でゲートを赤くすると「赤を無視する
習慣」がつく方が危険**だから。判定が「要る」と出たら人が見る、が正しい使い方で、
**「要らない」と出たことを免罪符にしない**（パスから分かるのは境界を運びうる領域に触れた
ことまでで、実際に破壊的かは分からない）。

## 7. Progressive Delivery

段階公開に使える現物:

1. **draft → preview → publish**（版ライフサイクル #420）。公開 → 端末取得 → 反映 ACK が
   一周しており、公開前検証チェッカが通らない版は止まる。
2. **指定端末にだけ配る**（#363 のデモ版。デモ版を publish すると本番端末の配信先が消えるため
   draft のまま配る）。
3. **テナント単位の feature flag**（`src/domain/platform/feature-flags.ts`。
   `voiceSynthesis` / `avatarReception`）。
4. **移行フラグ + 自動フォールバック**（ADR 0004。新経路が失敗したら旧経路へ落ちる）。

**未構築**: internal/demo → 拠点 → テナント → GA の段階を通す運用手順と、段階ごとの
成功/停止条件の宣言。

## 8. Measure / ロールバック

- KPI は `docs/reception-experience-kpi.md` の分子分母で見る。テナント横断集計は
  プラットフォーム側（#284 拡張）。
- ゲートの定期実行は `docs/gate-runs.md` に append-only で記録する。
- ロールバックの単位は「移行フラグを戻す」「版を publish し直す」「PR を revert する」。
  台帳 `docs/product-integration-plan.md` の §9 Breaking-change register と
  §10 Rollback playbook に、影響と戻し手順が登録されている（§11 に KPI baseline と目標）。

**未構築（#424 の核心）**: マージ後の測定結果を**元 issue へ書き戻す**経路が無い。よって
「KPI 未改善の変更が完了扱いされず再評価される」という受入条件は満たしていない。現状の
追跡は wave 番号 + issue 番号 + PR 番号の人手による対応づけ（`docs/loop-queue.md` の
wave 表）で、専用の追跡 ID は無い。

## 9. 現状と未構築（#424 受入条件に対する正直な棚卸し）

| #424 受入条件 | 状態 |
| --- | --- |
| AI が 1 件の観測データから証拠付き改善 Issue を生成できる | **未**（観測の集約と Issue 生成の自動化が無い） |
| Issue から小規模 PR と検証レポートを作成できる | **部分**（PR テンプレートが仮説・計測・ロールバック・ゲート結果を要求する形になった。ただし「検証レポート」の生成は手書き） |
| 高リスク変更が人間承認なしで公開されない | **有**（§6 の停止境界 + `pr-gate-guard.sh`。ただし「公開」自体は手動） |
| 失敗時に自動停止または rollback 提案が行われる | **部分**（ゲート red で止まる。移行フラグの自動フォールバックは在る。KPI 悪化による自動停止は無い） |
| 全判断と変更が GitHub 上で追跡可能 | **部分**（issue / PR / ADR / wave 表。プロンプトとツール実行の監査ログは GitHub 上に無い） |
| KPI 未改善の変更が「完了」扱いされず再評価される | **未**（§8 のとおり書き戻し経路が無い） |

### 未構築の実装範囲（#424 のチェックリスト）

- [x] Issue の必須テンプレート … `.github/ISSUE_TEMPLATE/improvement.md`（改善・機能）と
      `ai-proposal.md`（`[AI Proposal]`。**観測 / 仮説 / 反証条件**を必須欄にした）
- [x] PR 本文への **仮説 / rollback / 計測** の必須化 …
      `.github/pull_request_template.md`（仮説 / 計測・成功停止条件 / リスクと戻し方 /
      基準文書・ADR 参照 / 人間承認が必要な変更）
- [x] **API** schema の diff チェック … `src/domain/governance/api-surface.ts`（純関数）+
      `src/app/api/api-surface.test.ts`（走査とスナップショット比較）+ `docs/api-surface.txt`
      （170 経路）。**削除・改名でテストが落ちる**ので、スナップショット更新が diff に現れ
      「何が消えたか」がレビューで必ず目に入る。**壊れる相手はリポジトリの外に居る** —
      同一リポジトリ内の呼び出し元は typecheck が捕まえるが、配布済みの受付端末が叩く
      `/api/kiosk/*` は捕まえられない。更新は `UPDATE_API_SURFACE=1 npx vitest run ...`。
      **config（env / フロー設定）の schema diff は未実装**（単一の宣言的な定義が無いので、
      作るなら定義の一元化が先。API と同じ手は使えない）
- [x] change-risk classifier … `src/domain/governance/change-risk.ts`（純関数）+
      `scripts/change-risk.ts`（git から集めて印字）。`quality-gate.sh` が毎回**報告のみ**で
      呼ぶ。**検出器であって判定者ではない**（偽陽性に倒してある）ので、承認の実行は人間
- [ ] 提案 → Issue → PR → 計測の追跡 ID
- [x] kill switch と 1 ループあたりの変更行数 / ファイル数 …
      `src/domain/governance/change-budget.ts`（純関数）+ `scripts/change-budget.ts`。
      `quality-gate.sh` が**最初に**呼ぶ。**扱いを分けてある**: kill switch
      （`.loop-halt` / `OPEN_RECEPTION_LOOP_HALT`）は人間の明示操作で偽陽性が無いので
      **その場で abort**（green も記録しない）、変更量は**報告のみ**（大きい変更が自動的に
      悪いわけではなく、FAIL にすると override が習慣化して増分 3 と同じ失敗になる）。
      **コスト上限は未実装** — 1 ループのコストを観測する経路が無い（§8 の計測書き戻しと同根）
- [x] 定期評価レポート生成コマンド … `npm run evaluate:gate-runs`
      （`src/domain/governance/gate-run-evaluation.ts` = 純関数 + `scripts/evaluate-gate-runs.ts`）。
      `docs/gate-runs.md` を読み、**事前定義した停止条件**で評価する: 一度も回っていない /
      週次を超えて止まっている / 直近が FAIL / FAIL に issue 参照が無い / SKIP が記録されている
      （`--strict` 下では出ないはず＝strict 未使用か環境劣化）。
      **KPI の評価は含めない** — 稼働環境の実データが無く、今作れば消費者ゼロになる（§8 と同根）。
      **`quality-gate.sh` には組み込まない**: あちらはコード品質の門、こちらは「運用が回っているか」の
      点検。混ぜると Routine が止まっている間ずっと開発者のローカルゲートが赤くなり、override が
      習慣化する（増分 4 と同じ判断）。既定は指摘があれば exit 1（週次 Routine から呼んで黙って
      流れないため）、`--report` で報告のみ。
- [ ] プロンプト・判断根拠・ツール実行・差分の監査ログ

### 既に在るので作らないもの

- 品質ゲートと fitness テスト（§5）。**新しい検査は `quality-gate.sh` かユニットテストへ足す**
  （別系統のチェッカを増やすと誰も回さない）。
- tenant isolation の検査 … `authz-coverage.test.ts` ＋ 認可の純関数テスト
  （`.claude/rules/admin-api-authz.md`）。
- UX complexity checks … `persistent-regions.ts` の登録簿（§5）。
- allowlist 相当 … `.claude/settings.json` の permissions と `scripts/hooks/`、
  `.claude/rules/` のパススコープ制約。

## 10. GitHub 運用

- AI の提案 issue は `.github/ISSUE_TEMPLATE/ai-proposal.md`（`[AI Proposal]` 接頭）で起こす。
- **evidence 不足のものは Issue 化しない**（観測バックログに留める）。Issue を増やすと
  キューの分類が腐りやすくなる。
- PR タイトルは squash 後の main コミットになるので Conventional Commits で書く。
- 本文に `Closes #<N>`（受入条件を満たしたときのみ。**満たさないなら `Refs`**）。
- **消化した周回で `docs/loop-queue.md` を直す。** 分類 stale の直接原因は「分類を書いた
  周回と実装した周回が別で、実装側が表を直さないこと」。wave 表に足すだけでは不十分で、
  該当行そのものを直す。
- 設計判断が変わったら ADR を起こし、`docs/adr/README.md` の表と
  `docs/product-integration-plan.md` §8（ADR index）を更新する。

## 11. 関連 Issue

| # | 主題 |
| --- | --- |
| [#418](https://github.com/20m61/open-reception/issues/418) | 統合再設計プログラム（親） |
| [#419](https://github.com/20m61/open-reception/issues/419) | ProductContext / 実効構成の契約と配線（**本ループの初回適用対象**） |
| [#420](https://github.com/20m61/open-reception/issues/420) | 版ライフサイクル（draft/preview/publish/反映 ACK） |
| [#421](https://github.com/20m61/open-reception/issues/421) | 管理 IA の再編 |
| [#422](https://github.com/20m61/open-reception/issues/422) | キオスク体験の再構成（クローズ済） |
| [#423](https://github.com/20m61/open-reception/issues/423) | 横断シナリオ E2E・共通コンテキスト |
| [#424](https://github.com/20m61/open-reception/issues/424) | 本ループ（本書） |
| [#425](https://github.com/20m61/open-reception/issues/425) | 移行台帳・baseline（`docs/product-integration-plan.md`） |
| [#426](https://github.com/20m61/open-reception/issues/426) | 基準文書の追加（本書を含む） |
