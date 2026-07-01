---
paths:
  - "src/**/*.test.ts"
  - "src/**/*.test.tsx"
  - "tests/**"
---

# テスト規約（TDD）

このプロジェクトは Issue 消化ループを **TDD** で回す（`docs/loop-workflow.md`）。
superpowers の `test-driven-development` スキルに沿って **red → green → refactor** を守る。

- **失敗するテストを先に書く**（red）。実装を通す最小限だけ書き（green）、その後 refactor。
  テストが一度も落ちていない「後付けテスト」は避ける。
- **純ロジック先行**: ドメイン/純関数（`src/domain/**`・純ヘルパ）を UI/IO より先に固める。
  受付やアバターのように実機/実認証/実アセットが要る層は **interface + mock 先行**で書き、
  実物が要る検証は #65 にスタックする（`CLAUDE.md` ガード参照）。
- **配置**: テストは対象コードに co-located（`foo.ts` → `foo.test.ts`）。ランナーは **Vitest**。
- **境界を突く**: 正常系だけでなく 401/403（テナント越境・viewer 書込）、失効・タイムアウト・
  空状態・重複/競合ウィンドウ（`consume` 原子性・並行フロー作成のフレーク）を必ず covering。
- **認可のテストは純関数へ**: 認可判定は `src/domain/tenant/authorization.ts` の純関数を直接
  テストし、ルートでは「ガードを通す」ことだけを検証する（`rules/admin-api-authz.md`）。
- **PII/secret をテストデータに残さない**: フィクスチャは最小の擬似データ。実来訪者情報・
  実 secret・実トークンを混入させない（`rules/pii-secret-minimization.md`）。
- **フレーク対策**: e2e は seed/分離/reuse を明示し、共有状態に依存しない。負荷時の
  `ECONNRESET` 散発は既知（handoff 参照）。変更後の e2e は本番ビルド再利用のため再ビルド必須。

> unit/統合は `npm test`、PR 前は `./scripts/quality-gate.sh --pr`、マージ前は `--full`。
