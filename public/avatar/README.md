# 受付アバター（VRM）モデルの配置

受付端末（kiosk）の待機〜案内で表示する VRM アバターのモデルファイル置き場です。

## 既定モデル: AvatarSample_A

`default.vrm` には、VRoid Project 公式の `AvatarSample_A` から書き出した VRM を配置します。

- 権利者: VRoid Project / pixiv
- ライセンス: CC0 ではない（著作権は放棄されていない）
- 許可される用途: 法人利用、商用利用、再配布、改変
- クレジット表記: 不要
- 公式利用条件: https://vroid.pixiv.help/hc/ja/articles/4402394424089-AvatarSample-A-Z
- 公式モデルページ: https://hub.vroid.com/characters/2843975675147313744/models/5644550979324015604

利用条件は変更される可能性があるため、取得日・取得元・ファイルハッシュを `provenance.json` に記録し、リリース前にも再確認します。

## 取得・配置手順

1. VRoid Studio または公式 VRoid Hub から `AvatarSample_A` を取得する。
2. VRoid StudioからVRM形式で書き出す場合は、埋め込みメタデータの利用条件が公式条件と一致することを確認する。
3. ファイル名を `default.vrm` に統一し、このディレクトリへ配置する。
4. SHA-256を計算し、`provenance.json` の `sha256` と `acquiredAt` を更新する。
5. `npm run test`、`npm run build`、iPad実機でのVRM・表情・リップシンク・モーション確認を実施する。

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

VRMモデルは著作物です。出所不明・ライセンス不明のモデルをコミット／配信しません。
AvatarSample_Aは再配布が許可されていますがCC0ではないため、次を必須とします。

- 公式利用条件のURLと取得日を保存
- 配布対象VRMのSHA-256を保存
- VRM埋め込みメタデータを検査
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
