# ループ着手キュー & 残作業マップ

`docs/loop-workflow.md` の運用対象キュー。**独立トラックは並行、統合点は直列、
マージは直列 + ユーザー確認**（理由は workflow の「並列オーケストレーション」節）。

## 現在地（2026-07-02 更新）

初期 DAG・QR チェーン・管理画面クラスタ・受付拡張・受付 UX の各 epic は**完了・クローズ済み**
（`#82` / `#96` / `#119` およびその子 issue はすべてクローズ）。基盤・ルート・コンポーネント・
ドメインは main に実在する。

> 現在の LOOP は **「残った 9 件のオープン issue を、外部リソース待ちを除いて片付ける」**
> フェーズ。本流は **#83 プラットフォームコンソール epic の締め**（JIT 昇格まわり）で、
> 他は互いに独立した security / observability / perf の改善タスク。各周回の冒頭で
> `gh issue view <N>` の AC を既存コードにマッピングし、**未充足の AC だけ**を increment
> として TDD する（純ロジック先行、新規ビルドの重複を避ける）。

## オープン issue 一覧（8 件・2026-07-03 更新）

> 2026-07-02 の自律ループで #264/#275/#273/#261/#83/#289 をクローズ（PR #276〜#293）。
> **ローカルで消化可能なタスクは完了**（#274 クローズ・#284 は外部待ち化）。次の関門は
> **#195 の実 AWS apply（要ユーザー承認）** — これで #196 live Lighthouse・#200 live ZAP・
> #284 backfill・#290 運用 ops が解禁される。
>
> 2026-07-02 のコスト/アーキテクチャ棚卸しで #299（WebStack 監視）/#300（PriceClass_200 +
> S3 ライフサイクル）を起票・同日消化（PR #302/#301）。Billing のコスト配分タグ
> `Project`/`Environment`/`Component` を Active 化済み（以後の請求からプロジェクト別集計可）。
> follow-up として #303（CloudFront 5xx アラーム化、低優先）を積んだ。WebMonitoringStack の
> dev への実 apply は #195 の dev デプロイと同じ流儀で実施可能（未デプロイ）。

| # | 種別 | 状態 | 分類 |
| --- | --- | --- | --- |
| ~~#83~~ | platform epic | **クローズ済**（inc4d UX #280・break-glass #282・フラグwrite #285・read監査 #287。運用ops は #290 へ切り出し） | 完了 2026-07-02 |
| ~~#264~~ | security | **クローズ済**（subject 束縛 #271 + jti 失効 #278 + end route） | 完了 2026-07-02 |
| ~~#261~~ | observability | **クローズ済**（#283: union+adoptKiosk・共有summarize・TTLキャッシュ・分母是正） | 完了 2026-07-02 |
| ~~#200~~ | security | **クローズ済**（live ZAP FAIL 0・[10055] PASS を dev 実機で確認） | 完了 2026-07-03 |
| **#196** | perf | バンドル-19%済・a11y 1.0/BP 0.96 live 確定・TTFB 50-90ms。残: PSI で perf 値取得（クォータ回復後） | PSI 待ち |
| **#195** | infra | **dev 分完了**（Notification/Monitoring 稼働・authorizer 検証済・アラームOK）。残: prod deploy（実機 UAT 後にユーザー判断） | prod 見送り中 |
| **#4** | feature | Vonage 実通話（基盤・interface 済） | #65 スタック |
| **#31** | feature | VRM 状態別モーション再生（実描画済・残 idle .vrma） | #65 スタック |
| **#65** | 集約 | 実機 UAT / 実認証 / WebKit E2E のスタック先 | 外部リソース待ち |
| ~~#273~~ | reliability | **クローズ済**（inc1 fail-closed #277 + inc2 リネーム #281） | 完了 2026-07-02 |
| ~~#274~~ | refactor | **クローズ済**（#291/#294/#295/#296/#298 で全移行完了。reservation/notification の永続化は別増分送り） | 完了 2026-07-03 |
| ~~#275~~ | refactor | **クローズ済**（#279: domain/notification へ集約・参照同一性テスト） | 完了 2026-07-02 |
| ~~#299~~ | infra | **クローズ済**（#302: WebMonitoringStack = アラーム8個 + web ダッシュボード + alarmEmail docs 化。CloudFront 5xx アラームは #303 へ） | 完了 2026-07-03 |
| ~~#300~~ | infra | **クローズ済**（#301: prod CloudFront PriceClass_200・S3 MPU 掃除ライフサイクル。年齢 Expiration は現役アセット失効リスクで不採用を設計固定） | 完了 2026-07-03 |
| ~~#303~~ | infra | **クローズ済**（#306: CloudFrontMonitoringStack(us-east-1) 5xx>1%×15分 + dimensionless ConcurrentExecutions。crossRegionReferences は additive 実証済み。dev apply は別途） | 完了 2026-07-03 |

## 本流トラック — #83 platform epic 締め

進捗（マージ済 increment）: read 実接続（inc1-3）→ 高詳細監査 AC13（#249）→ 対象テナント
選択（#204/205）→ ダッシュボード実データ AC3（#253）→ アップデート横断 read AC6（#250）→
簡易オブザーバビリティ実接続（#259）→ **JIT 昇格ゲート基盤 AC5/AC10（#263）→ incident /
maintenance-window / notice 登録を昇格ゲートで解禁 inc4c（#265/266/267）**。

残タスク（依存順）:

1. **#264 jti 失効ストア**（本流の直接の続き・実認証不要）
   - 発行 jti を TTL=昇格窓の短命ストアに記録し、`/elevate/end`・管理操作で失効可能に。
   - `assertElevated` で失効チェックを追加。cookie subject 束縛（済）と合わせて replay を封じる。
   - → 完了で **#264 クローズ**、#83 の JIT 昇格まわり（AC5/AC10）が一段落。
2. **#83 break-glass 運用**（AC の §3）
   - `break_glass` フラグ・利用理由必須・高重要度監査・平常時 UI では非表示/ロック。
3. **#83 残 AC の監査・網羅**
   - データマスク（§4）の網羅検証、二者承認（任意）、実 MFA 再認証は **#65 にスタック**。
   - 全 AC 充足で **#83 クローズ**。

## 独立トラック（worktree 分離で並行可・ファイル非重複）

| トラック | Issue | 触る主な領域 | 注意 |
| --- | --- | --- | --- |
| Obs | **#261** 端末実死活 | `src/domain` の Device/kiosk レジストリ, observability 画面 | source-of-truth 統一が肝。撤回した #260 の `deriveConnectivity`/`DEFAULT_ONLINE_WINDOW_MS` は再利用可。**まとめて設計**（二重レジストリ・surface 不整合・無境界スキャン・分母希釈） |
| Sec | **#200** nonce CSP | `proxy.ts`/middleware, `next.config.ts` | **撤回履歴あり**。段階導入（script-src のみ先行）。切り分け手順はメモ `csp-nonce-nextjs16` 参照。hydration 感受性高、E2E で全画面確認 |
| Perf | **#196** Lighthouse perf | 初期バンドル/フォント/LCP, kiosk 初期描画の遅延読込 | ローカルは計測不能（`lighthouse-no-navstart-local`）→ **live URL で検証**。#195 の prod / OAC 解消に依存しがち |

## 外部リソース待ち（#65 スタック・現環境で完了不可）

- **#195** Notification/Monitoring デプロイ + prod: siteTokenSecret（Secrets Manager）設定・
  CloudWatch アラーム検証・prod 実 apply。実 AWS 承認が要る。
- **#4** Vonage 実通話: `VONAGE_*` 実認証情報。基盤・interface・mock e2e は実装済。
- **#31** VRM 状態別モーション: 実 `.vrma` アセット。`VrmAvatarViewer` 実描画は dev 確認済、
  残は idle 系モーション。
- **#65**: 上記の集約 + iPad 実機 UAT・QR 実読取・presence カメラ実機・Entra 実ログイン・
  多言語 TTS 実再生・WebKit E2E（本開発機は Tier3 で WebKit 非対応）。

> いずれも unit/統合ゲートは緑。実機/実認証が整い次第、各 issue で検証を再開する。

## 進め方メモ

- 各トラックは独立 worktree（または `isolation: "worktree"` のサブエージェント）で実装。
- fresh worktree は `node_modules` が無いが、`quality-gate.sh` の bootstrap が自己修復する。
- コミット署名は 1Password `op-ssh-sign`（ロック中は失敗→アンロックして再実行）。
- マージは 1 本ずつゲート green を示してユーザー確認 → squash + `--delete-branch`。
  後続トラックはマージ後 main を `git pull --ff-only` で取り込んでから整合確認。
- 状態は本ファイルの表で更新していく。
