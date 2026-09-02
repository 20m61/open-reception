# ADR 0005: デモ公開モデルと受付体験版モデルの統合方針

- ステータス: 提案（**移行の実施はユーザー承認待ち**。永続スキーマとスコープ語彙を動かすため）。
- 関連: issue #363（デモスタジオ）、#420（受付体験の版管理）、#419（ProductContext）、#418（親 Epic）
- 関連ドキュメント: `docs/product-integration-plan.md` §5 重複概念 / §6 暫定 ID / §9 Breaking-change register
- 現物: `src/domain/demo-studio/publication.ts` + `publication-store.ts` /
  `src/domain/experience-version/` + `src/lib/experience-version/`

## 背景

「下書き → 公開 → ロールバック」を持つモデルが **2 つ**在る。移行台帳 §5 は「版モデルは
`domain/experience-version/` へ一本化し、**両方を恒久的に残さない**」と決めているが、統合の
形と順序は未決だった。本 ADR でそれを固定する。

### 2 つのモデルの実際の差（第 33 wave に現物で確認）

| | `DemoPublication`（#363） | `ReceptionExperienceVersion`（#420） |
| --- | --- | --- |
| 状態 | `draft` / `test` / `published` | `draft` / `published` / `archived` / `rolled_back` |
| 版の中身 | `DemoScenario`（シナリオ定義の深いコピー） | `ExperienceConfigurationSnapshot`（解決済み全セクション値） |
| 承認 | 無し | `approvedBy` を記録（公開の前提） |
| 検証 | 無し | `validationSummary`（秘匿値・asset・motion・言語・取次） |
| 公開先 | `{ siteId, kioskId }` を**明示指定**し fail-closed で照合 | 拠点（tenant/site）単位。端末は構成取得時に束縛から解決 |
| スコープ語彙 | **`siteId` にテナント ID を入れている**（`defaultAdminTenantId()`。単一テナント MVP の近道） | `ProductContext` の tenant/site（#419 の権威解決） |
| 端末の母集合 | 旧 kiosk レジストリ（`listKiosks`） | 端末台帳（tenant store の device） |
| 履歴 | append-only + rollback | append-only + rollback |
| 共有 | 共有トークンで未認証閲覧（`/demo/[token]`） | 無し（管理画面のみ） |

**重要**: デモ公開は旧レジストリと旧スコープ語彙で**一貫して閉じている**。UI が候補に出す端末も
旧 kiosk レジストリなので、現時点で「実端末へ公開できない」といった実害は生じていない。
つまりこれは壊れている機能ではなく、**別語彙で完結した並行実装**である。

## 決定

### 1. 版モデルは `domain/experience-version/` へ一本化する

`DemoPublication` の版・履歴・rollback は `ReceptionExperienceVersion` へ寄せる。理由:

- 検証（`validationSummary`）と承認（`approvedBy`）を持つのは後者だけで、**公開前ゲートは
  こちらにしか無い**。デモを先に本番へ出せる経路を残すと、検証を迂回する裏口になる。
- 端末への配信は既に後者のスナップショットが権威（#420 Inc2）。デモだけ別経路で配ると、
  「いま端末に何が出ているか」が再び 2 箇所に分かれる（#419 が解消した問題の再発）。

### 2. デモ固有の関心は「版の属性」ではなく「版の**用途**」として持つ

デモにしか無いのは次の 3 つで、いずれも版モデルの本体ではない:

- **`test` 状態** … 「本番の端末には出さないが実機で見たい」。版の `status` を増やすのではなく、
  **配信対象の指定**（どの端末が受け取るか）として表現する。状態を増やすと `publishedVersion`
  の意味が揺れ、#420 の「公開版は 1 つ」という不変条件が崩れる。
- **共有トークンによる未認証閲覧** … 版とは独立した公開リンクの機能。`share-token` はそのまま
  残し、参照先を `DemoPublication` から版 ID へ差し替える。
- **シナリオ（`DemoScenario`）** … 構成スナップショットとは別物（モックの応答台本）。
  版が固定するのは構成であって台本ではないので、**シナリオは版に埋めずに参照**する。

### 3. スコープ語彙は `ProductContext` に合わせる

`siteId` にテナント ID を入れる近道（`defaultAdminTenantId()`）をやめ、tenant/site を分ける。
端末の母集合も旧 kiosk レジストリから端末台帳へ寄せる（§5 の「kiosk → tenant/site 解決」統合と
同じ方向）。**これが移行の実体で、既存の公開記録の `target.siteId` の意味が変わる。**

## 代替案

| 案 | 却下理由 |
| --- | --- |
| 両方を残し、デモは触らない | 台帳 §5 の決定に反する。検証を迂回する公開経路が恒久化する |
| 逆方向（`DemoPublication` へ寄せる） | 検証・承認・スナップショット配信を作り直すことになる。#420 の実装が丸ごと無駄になる |
| `test` を版の status に足す | 「公開版は 1 つ」の不変条件が崩れ、`publishedVersion` / 反映状況の判定が揺れる |
| デモ公開の siteId だけ先に直す | 現時点で実害が無く、統合予定の subsystem に互換対応だけが積む。**第 33 wave で実際に検討して見送った** |

## 影響（移行手順・撤回条件）

**破壊的変更**（台帳 §9 へ B-07 として登録）。既存の公開記録は `target.siteId` にテナント ID を
持つため、語彙統一の時点で意味が変わる。次の順で行う（additive 先行 → 切替 → 撤去）:

1. **additive**: 版モデル側にデモ用途（配信対象の限定・シナリオ参照）を足す。デモ側は無変更。
2. **二重運用**: 新規のデモ公開を版モデルで作る。既存記録は読み取り専用で表示し続ける。
3. **切替**: `/api/admin/demo/publications` の実装を版モデルへ差し替える（**応答形は維持**）。
4. **撤去**: `domain/demo-studio/publication.ts` と旧ストアを削除。§9 の予告を閉じる。

**ユーザー承認が要る点**（CLAUDE.md 重大変更条件・`.claude/rules/opus5-autonomous-loop.md` 停止境界）:

- 既存の公開記録を移行するのか、読み取り専用で残して自然消滅させるのか
- 語彙統一のタイミング（デモの `siteId` がテナント ID から実サイト ID へ変わる）
- `/api/admin/demo/publications` の応答形を維持するか、版モデルの形へ寄せるか（公開 API 変更）

**撤回条件**: 手順 3 までは旧実装が残るため、切替をやめれば元に戻せる。手順 4 を実施したら
戻せないので、**2 wave の観測（デモ公開が版モデルで問題なく回ること）を経てから実施する**。
