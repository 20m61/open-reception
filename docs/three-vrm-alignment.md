# three-vrm 版追従の点検記録

`VrmAvatarViewer` と周辺モジュールが `@pixiv/three-vrm` の**最新版・公式の推奨手順**に
沿っているか、疎結合が保たれているかを点検した記録。版を上げるたびにここを更新する。

## 2026-09-02 点検（three-vrm 3.5.5 / three r184）

### 収集した一次情報

| 情報源 | 要点 |
| --- | --- |
| npm `@pixiv/three-vrm` dist-tags | `latest` = **3.5.5**（2026-07-09 公開。依存更新のみ）。`three` peer は `>=0.137` |
| GitHub Releases v3.3.0〜v3.5.5 | v3.3.0 `VRMUtils.combineMorphs` 追加（**モバイル GPU のシェーダエラー防止**・VRAM 削減）。v3.3.1 `combineSkeletons` / `removeUnnecessaryJoints` の修正。v3.3.2 `specVersion` 無し `.vrma`（UniVRM v0.120 未満）を読めるように。v3.4.1 `VRMLookAtQuaternionProxy.name` の fallback 修正。v3.4.4 three r180 へ。v3.5.0 **MToon `rimLightingMixFactor` の挙動修正（見た目が変わりうる破壊的変更）**・`removeUnnecessaryVertices` が interleaved buffer 対応。v3.5.3 SpringBone/MToon の読込エラー処理改善。v3.5.4 VRM0 humanoid の node index `-1` を許容 |
| `packages/three-vrm/README.md`（3.5.5 同梱） | 例は three **r180** の importmap。WebGPU は `MToonNodeMaterial`（r167+、まだ不安定と明記） |
| `packages/three-vrm/examples/basic.html` | 読込後に `VRMUtils.removeUnnecessaryVertices(gltf.scene)` → `VRMUtils.combineSkeletons(gltf.scene)` → `VRMUtils.combineMorphs(vrm)` → `scene.traverse(obj => obj.frustumCulled = false)`。ライトは `DirectionalLight(0xffffff, Math.PI)` |
| `packages/three-vrm-animation/examples/loader-plugin.html` | VRM 読込後に `new VRMLookAtQuaternionProxy(vrm.lookAt)` を**名前付き**で `vrm.scene.add`。`createVRMAnimationClip(vrmAnimation, vrm)` → `AnimationMixer(vrm.scene)`。更新順は **`mixer.update(dt)` → `vrm.update(dt)`** |
| `VRMUtils/removeUnnecessaryJoints.ts` | **deprecated**。`combineSkeletons` を使う（次のメジャーで削除） |
| `createVRMAnimationClip` 実装（3.5.5） | `vrm.lookAt` があるのに proxy が無いと `console.warn` して自動生成する。名前が空でも警告 |
| three r184 / r185 リリースノート | r184: `AnimationAction` の `timeScale` 反転修正・GLTFLoader morph target 修正。r185: `AnimationAction` time warping 修正・`Matrix3.scale/rotate/translate` 非推奨。VRM 側に影響する破壊的変更なし |

### 判定と反映

| 観点 | 点検前 | 判定 | 反映 |
| --- | --- | --- | --- |
| 版 | `@pixiv/three-vrm ^3.5.4` / `three-vrm-animation 3.5.4`（片方だけ固定） | 最新は 3.5.5。**caret と固定が混在**すると `npm update` で 2 パッケージの版がずれる。三者は `three-vrm-core` を**各パッケージのバンドルへ静的に取り込んでいる**（外部 import は `three` だけ）ので、`VRM` を作る側と `.vrma` を解釈する側で meta / humanoid の解釈が版ごとに食い違いうる。※当初「core が二重化して `instanceof` が壊れる」と書いたが、独立レビューの実測で誤り（`VRMLookAtQuaternionProxy` の定義と `instanceof` 判定は同じバンドル内）と分かり訂正 | 両方 **3.5.5 に固定**（`-E`）。同じ版で揃えることを規約にする |
| three | 0.184（三者 README は r180 想定、peer は `>=0.137`） | 互換。r185 は VRM に影響する変更が無いが、three-vrm の検証版を超えるので急がない | 据え置き |
| 読込後の最適化 | `rotateVRM0` のみ。`removeUnnecessaryVertices` / `combineSkeletons` / `combineMorphs` を**呼んでいなかった** | **未準拠**。`combineMorphs` はリリースノートが「モバイル GPU のシェーダエラー防止」と明記しており、受付端末が iPad である本プロジェクトに直結。**これらはジオメトリ・スキニング・モーフ束縛を書き換える**ので「純粋な最適化」ではない（`combineMorphs` 後の `morphTargetDictionary` は合成後のもの。名前でモーフを引く実装を将来足すときは注意） | `lib/three/vrm-prepare.ts` の `prepareLoadedVrm` に公式例の順で集約。**順序が効く**: `combineSkeletons` が共有ジオメトリを複製して `morphAttributes` を別物にするので、その後の `combineMorphs`（元の `morphAttributes` を空にする）が兄弟メッシュを壊さない。`rotateVRM0` は公式例（1.0 モデル）には無い本 repo の追加で順序非依存（`combineSkeletons` は bindMatrix を恒等にする）。配線の有無と順序を unit で固定し、**実際に通ったことは `data-vrm-prepared` で観測**する |
| `frustumCulled` | 未設定（既定 true） | **未準拠**。スキンメッシュの bounding sphere は動かないので、腕を大きく振る所作や頭寄りの画角で**モデルが消えうる** | `prepareLoadedVrm` が scene 配下を全部 false にする |
| `VRMLookAtQuaternionProxy` | 未作成。`createVRMAnimationClip` が毎モデル `console.warn` しつつ自動生成 | 挙動は同じだが警告がノイズ。公式例は明示作成 | `prepareLoadedVrm` が名前付きで足す（`lookAt` の無いモデルには足さない） |
| 更新順 | `mixer.update` → `vrm.update` | 準拠 | — |
| 版差の補正 | `createVRMAnimationClip` に任せ独自判定しない（#578） | 準拠 | — |
| 破棄 | `VRMUtils.deepDispose(gltf.scene)` + `renderer.dispose()` | 準拠 | rAF 自前ループ＋未使用の `setAnimationLoop(null)` を、three 推奨の `setAnimationLoop(render)` に一本化。最初のフレームを描いたことを `data-render-state=rendering` で観測（ループが配線されていなくても fallback には落ちず透明な canvas が残るだけなので、属性で見る） |
| `.vrma` の解放 | 切替時に前の `AnimationAction` を `fadeOut` するだけ。`LoopRepeat` のアクションは重み 0 でも mixer の評価対象に残り、クリップも `uncacheClip` されない（**点検前からの欠陥**。状態遷移のたびに 1 つ増える） | 24 時間稼働の端末で毎フレームの評価対象が単調増加する | `motion-player.ts` がフェード後に `release`（`action.stop()` + `mixer.uncacheClip(clip)`）を呼ぶ。遅延実行を注入して unit で固定 |
| 型安全 | `gltf.userData.vrm` が `any` のため viewer 内の three-vrm API 呼び出しが**全部無検査**。ボーン名も `string` | **疎結合の穴**。`getNormalizedBoneNode('haed')` のような誤字が実機まで届く | `as VRM \| undefined` で型付け。ボーン名は `HumanoidBoneName`（`VRMHumanBoneName` の部分集合であることを型テストで固定）、表情 preset も `VRMExpressionPresetName` の部分集合であることを型テストで固定。いずれも `import type` のみで実行時依存は増えない |
| 疎結合 | `.vrma` 切替の競合制御（後発が勝つ・空 URL で止める・破棄後の遅延読込を捨てる）が effect 内に閉じ**未テスト** | three を注入で切り離せる | `avatar/motion-player.ts` に抽出。読込と再生を注入して競合を unit で固定 |
| ライト強度 | `DirectionalLight(0xffffff, 1.2)`。公式例は `Math.PI`（r155 の物理単位化に合わせた値） | 本プロジェクトは r17x 以降の物理単位で実描画レビュー（`docs/ui-review-2026-07-22.md`）を通して 1.2 に落ち着いているので、**見た目を変える変更は実機 UAT（#65）で判断** | 据え置き。候補として記録 |
| `vrm.lookAt`（眼球） | 未使用。視線誘導は首・頭ボーンの回転で表現 | 公式は `vrm.lookAt.target` で眼球を向ける。受付での「目が合う」演出に使える | 候補として記録（画面上の誘導先を 3D 座標へ写す設計が要る） |
| WebGPU / `MToonNodeMaterial` | 未使用 | README が「まだ壊れやすい」と明記。iPad Safari の WebGPU も段階的 | 見送り |

### 独立レビュー（2026-09-03）で直したこと

- **配線の観測**（BLOCKER）: `prepareLoadedVrm` の呼び出しと `setAnimationLoop(render)` を両方
  落としても unit 6663 本が全部緑だった（レビューの実測）。VRM は e2e / VRT / soak では
  無効で、実描画検査（`npm run vrm:check`）だけが見える層。そこで `data-vrm-prepared` /
  `data-render-state` を足し、検査が名指しで期待するようにした。`.vrma` 再生も
  `data-motion-state=playing` を期待する（「フレームが変わる」は呼吸で空虚に通る）
- **アクションの蓄積**（MAJOR・点検前からの欠陥）: 上表「`.vrma` の解放」
- **依存固定の根拠**（minor）: 上表「版」の訂正
- `--full` の vrm ステップは chromium が無いと `skip_unverified` で緑になる。この種の変更では
  `--strict` を付けるか、routine 側で chromium を必須にする（Issue 候補）

### 変えないと決めたこと（理由つき）

- **three を r185 へ上げない。** three-vrm 3.5.5 が検証している版は r180 で、0.184 は既にその外側。
  VRM に影響する変更が無いことは確認したが、上げる利益も無い。
- **ライト強度と `vrm.lookAt` は触らない。** どちらも見た目が変わる。headless の画素検査は
  「描かれているか」しか見ないので、実機で見てから決める。

### 次に版を上げるときの手順

1. `npm view @pixiv/three-vrm version` と Releases を読み、**破壊的変更（MToon の見た目・
   `VRMUtils` の削除）** を拾う
2. `npm install -E @pixiv/three-vrm@<v> @pixiv/three-vrm-animation@<v>`（**同じ版で揃える**）
3. 公式例（`basic.html` / `loader-plugin.html`）の読込後手順と `lib/three/vrm-prepare.ts` を
   突き合わせ、差分があれば `prepareLoadedVrm` と `vrm-prepare.test.ts` を同時に直す
4. `./scripts/quality-gate.sh --pr` に加えて `npm run vrm:check`（実描画・DPR 2）
5. 本書に点検行を足す

### Issue 候補（スコープ外）

- 品質ゲート `--full` の vrm ステップを、VRM に触る変更では SKIP でなく FAIL にする（`--strict` 相当）
- soak（24 時間）で VRM を有効にし、アクション蓄積のような単調増加をフレームレートで検出する
- `vrm.lookAt.target` による眼球の視線誘導（首・頭の回転と併用）
- ライト強度を公式例（`Math.PI`）へ寄せるかの実機比較
- `MToonNodeMaterial` + WebGPU の追試（iPad Safari の対応状況を見てから）
