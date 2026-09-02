# semgrep-rules — SAST のルールセット（#841）

`./scripts/quality-gate.sh --sast`（および `--full`）が読む **リポジトリ内の** semgrep ルール。
実行の入口は `scripts/sast.sh`、npm からは `npm run sast`。

## なぜレジストリを引かないのか

以前は `--config p/default` でレジストリ（`semgrep.dev`）を引いていたが、2 つ問題があった。

1. **遮断環境で恒久的に実行できない。** `CLAUDE.md` は `--pr` / `--full` をクラウド既定と
   しているが、クラウドコンテナからは `semgrep.dev` へ CONNECT できない（実測 403）。
   semgrep が導入済みでも sast が走らない ——「入っている」は「動く」ではない。
2. **決定性が無い。** レジストリのルールは外側で更新されるので、同じツリーに対する結果が
   日によって変わる。ゲートが何を保証しているのかが不定になる。

サードパーティのルールセット（`semgrep/semgrep-rules`）の取り込みは検討したが見送った。
**LICENSE ファイルが `semgrep.dev/legal/rules-license` への 1 行のポインタで、その参照先が
到達できない**ため、`CLAUDE.md` ガードが要求する #105 のライセンス確認（本文の実取得・
商用可否）を満たせない。到達できる環境で本文を確認できたら再検討してよい。

## ルールの書き方

1 ルール = **2 ファイル**。ファイル名の basename を揃える。

```
semgrep-rules/
  next-public-secret.yaml   ← ルール本体
  next-public-secret.ts     ← フィクスチャ（`semgrep --test` が検査する）
```

フィクスチャには**両側**を書く。

```ts
// ruleid: next-public-secret
const bad = process.env.NEXT_PUBLIC_API_SECRET;
// ok: next-public-secret
const good = process.env.NEXT_PUBLIC_APP_URL;
```

`ok:` を必ず入れること。`ruleid:` だけだと「**全部に当たる**」ルールでも自己テストが通る
（下界が縛られていない）。`tests/config/quality-gate-sast.test.ts` が両方の注釈を機械で要求する。

## 🔴 静かに無効化される 2 つの罠（実測）

`semgrep --test` は**テストが 1 件も見つからなくても exit 0 を返す**。終了コードだけを見ていると、
下のどちらを踏んでもルールが空虚になったことに気づけない。

| 踏むと | 症状 |
| --- | --- |
| 拡張子を `.yml` にする | 探索対象にならない（`.yaml` のみ）。「テスト 0 件」で exit 0 |
| ディレクトリをドット始まりにする（`.semgrep/` 等） | 丸ごと探索から除外される。同じく exit 0 |

`scripts/sast.sh` は終了コードではなく**出力に `N/N: ✓ All tests passed` が在るか**を見て
判定し、無ければ exit 3（＝ゲートの `skip_unverified`「検査できなかった」）へ倒す。
`tests/config/quality-gate-sast.test.ts` が両方の罠を回帰として固定している。

## 走査対象

`scripts/sast.sh` は `--exclude semgrep-rules` を付ける。フィクスチャは**意図的に違反を含む**
ので、外さないと必ず赤くなる。

## 現在のルール

| id | 何を止めるか | 正本 |
| --- | --- | --- |
| `next-public-secret` | `NEXT_PUBLIC_*` に機密を示す名前を付ける（フロント bundle に配布される） | `.claude/rules/pii-secret-minimization.md`（#105 / #19） |
| `dynamic-code-execution` | `eval` / `new Function` による動的コード実行 | — |

**意図的に最小**にしてある。既存の検査と重複させないため、次は semgrep へ持ち込んでいない。

- 管理 API の認可網羅 → `src/app/api/admin/authz-coverage.test.ts` が理由付き allowlist つきで
  既に静的検証している。semgrep で書き直すと allowlist の根拠が失われる
- `dangerouslySetInnerHTML` → 現在の唯一の利用箇所（`DevicesManager.tsx` の QR SVG）は内部生成で、
  ルールを入れると product コードに `nosemgrep` を足す必要が出る。別 issue で扱う
