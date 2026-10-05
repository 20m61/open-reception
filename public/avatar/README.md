# 受付アバター（VRM）モデルの配置

受付端末（kiosk）の待機〜案内で表示する VRM アバターのモデルファイル置き場です。

## 既定モデル: receptiom

`default.vrm` は、owner（@20m61）が VRoid Studio 2.11.0 で作成・書き出した `receptiom`（VRM 0.0）です
（2026-10-05、#399 の AvatarSample_A 導入計画を置き換え）。

- 作者: 20m61（このリポジトリの owner）
- SHA-256: `925b2fcbaa815dd5e352a7dbefcef9a73041c9be58f78472e8987d7955017a5f`（12,425,848 bytes）
- head ボーンのワールド高さ（rest pose）: 1.4046m（`camera-framing.test.ts` の実測値）
- 記録: `provenance.json`

### 埋め込みメタデータと使い方の食い違い（owner 判断で受容）

VRM に埋め込まれた利用条件は `allowedUserName: OnlyAuthor` / `commercialUssageName: Disallow` /
`licenseName: Redistribution_Prohibited` です。一方、このリポジトリは public で、受付製品として
商用に使います。**作者本人である owner が、メタデータを変えずにこのまま commit すると判断しました**
（2026-10-05）。

- このファイルは public に置かれていますが、**第三者にライセンスされたものではありません**。
  第三者は埋め込みメタデータ（作者のみ・商用不可・再配布禁止）に従ってください。
- メタデータを実際の使い方に合わせる場合は、VRoid Studio で利用条件を変えて書き出し直し、
  `default.vrm` と `provenance.json`（`sha256` / `embeddedMeta` / `verificationStatus`）を更新します。

## モデルを差し替えるとき

1. ライセンス・出所を確認し、埋め込みメタデータの利用条件が実際の使い方と一致するか確かめる。
   一致しない場合は owner の判断を `provenance.json` に記録する。
2. ファイル名を `default.vrm` に統一し、このディレクトリへ配置する。
3. SHA-256 を計算し、`provenance.json` を更新する。`THIRD_PARTY_NOTICES.md` も合わせる。
4. head ボーンのワールド高さを測り、`src/domain/avatar/camera-framing.test.ts` の実測値を更新する。
5. `npm run test`、`npm run build`、`npm run vrm:check`、iPad 実機での VRM・表情・リップシンク・モーション確認を実施する。

## 使い方

環境変数で既定モデルを指定します。

```env
KIOSK_DEFAULT_VRM_URL=/avatar/default.vrm
```

管理画面（`/admin/motions` / アセット管理）で VRM を登録・選択した場合は、そちらが優先されます。
`KIOSK_DEFAULT_VRM_URL` を未設定 / 空 / `none` / `off` にすると、VRMなしのプレースホルダ表示に戻ります。

## モーション検証

`VrmAvatarViewer` は次の2経路を持ちます。

- `.vrma` が割り当てられている場合: `@pixiv/three-vrm-animation` と `AnimationMixer` でループ再生
- `.vrma` がない場合: 受付状態に応じた手続き的ポーズを適用

少なくとも以下を確認します。

- idle: 呼吸、軽い重心移動、自然な待機姿勢
- listening: 聞く姿勢、視線、過剰でない前傾
- thinking: 考え中の静かな所作
- speaking / guiding: 表情、口形素 `aa`、案内所作
- calling / success / error: 状態遷移時の破綻、腕・肩・首のねじれ、表情復帰
- 画面回転・リサイズ: 4:3横向きiPadで頭部や手先が切れないこと

## ライセンス運用

VRMモデルは著作物です。出所不明・ライセンス不明のモデルをコミット／配信しません。次を必須とします。

- 作者・取得元と取得日を保存
- 配布対象VRMのSHA-256を保存
- VRM埋め込みメタデータを検査し、実際の使い方との食い違いがあれば owner 判断を記録
- モデル差し替え時に `THIRD_PARTY_NOTICES.md` と `provenance.json` を更新
- 宗教・政治・反社会的・差別的な演出へ転用しない

## 同梱の既定モーション

`idle.vrma` … `scripts/generate-idle-vrma.mjs` で**自作生成**した待機モーション（呼吸・ゆるい揺れ・
腕を下ろした立ち姿。VRM Animation 1.0 / `VRMC_vrm_animation`）。自作のため CC0 相当・出所明確。
管理画面（/admin/motions）でアセット登録（URL: `/avatar/idle.vrma`）して割り当てる。

## 実装メモ

- 表示は `src/components/kiosk/VrmAvatarViewer.tsx`（three / @pixiv/three-vrm）。
  VRM 0.x モデルは `VRMUtils.rotateVRM0()` で +Z 向きへ正規化する（無いと背面向きになる）。
- 受付状態 → 表情（expression）の写像は `src/components/kiosk/avatar/vrm-expression.ts`。
- モーション（.vrma）再生は `@pixiv/three-vrm-animation` の AnimationMixer 切替で実装済み。
  再生中は手続き的ポーズ（`vrm-idle.ts`）を適用しないため、待機系クリップは腕を下ろす回転を
  含めること（`generate-idle-vrma.mjs` 参照）。
- 実描画・.vrma 再生は SwiftShader(WebGL2) の headless Chromium で検証済み
  （`scripts/vrm-visual-check.mjs`、2026-07-22。記録: `docs/ui-review-2026-07-22.md`）。
  実機 iPad の負荷・リップシンク優先順位の検証は引き続き #65。WebGL 不可・読込失敗時は
  静止画/プレースホルダへ安全に fallback する。
