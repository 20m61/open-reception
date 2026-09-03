'use client';

import { useEffect, useRef, useState } from 'react';
import type { VRM } from '@pixiv/three-vrm';
import type { AnimationClip } from 'three';
import {
  resolveVrmSpecVersion,
  vrmVersionAttribute,
  type VrmSpecVersion,
} from '@/domain/avatar/vrm-version';
import { motionStateAttribute, type MotionObservation } from '@/domain/avatar/motion-state';
import { cameraFramingAttribute, resolveCameraFraming } from '@/domain/avatar/camera-framing';
import { ResourceTracker } from '@/lib/three/resource-tracker';
import { measureHeadHeight, prepareLoadedVrm, vrmPreparedAttribute } from '@/lib/three/vrm-prepare';
import { AvatarFallbackImage } from './avatar/fallback-image';
import { shouldShowVrmFallback } from './avatar/fallback-state';
import { emotionExpressionValues } from './avatar/vrm-expression';
import { poseEntries, resolveStatePose } from './avatar/vrm-pose';
import { createMotionPlayer } from './avatar/motion-player';
import { gazeOffsetFor, type GazeOffset } from './avatar/vrm-gaze';
import { resolveFrameExpressionWeights } from './avatar/frame-weights';
import { createAutoBlinkState, stepAutoBlink, type AutoBlinkState } from '@/domain/avatar/auto-blink';
import type { AvatarExpression } from './avatar/guidance';
import type { AvatarState, GazeTarget } from '@/domain/reception/ui-contract';
import type { KioskLayout } from './layout';

/**
 * VRM アバター表示基盤 (issue #36)。
 * - vrmUrl が無い/読み込み失敗/WebGL 不可のときは fallback（静止画 or プレースホルダ）を表示。
 * - three / three-vrm は vrmUrl があるときのみ動的 import（初期バンドル・SSR を汚さない）。
 * - unmount 時に renderer/geometry/material/texture を破棄する。
 * - 受付フローとは疎結合。実描画は実機 UAT で確認する（headless では fallback 経路を検証）。
 *
 * three-vrm への依存はこのファイルに閉じる。three を触らずに検証できる部分は外へ出してある:
 * - 読込直後の公式手順（VRMUtils 最適化 / frustumCulled / rotateVRM0 / lookAt proxy）
 *   → `lib/three/vrm-prepare.ts`（依存注入。配線の有無と順序を unit で固定）
 * - `.vrma` 切替の競合制御（後発が勝つ / 空 URL で止める / 破棄後の遅延読込を捨てる）
 *   → `avatar/motion-player.ts`
 * - 表情・ポーズ・視線・まばたき・画角の計算 → `avatar/*` と `domain/avatar/*` の純関数
 * 版追従の点検記録は `docs/three-vrm-alignment.md`。
 *
 * 状態別モーション再生（#31）: motionUrl の .vrma を AnimationMixer で切替再生する。
 * リップシンク（#5）は expression(aa) と `avatar/frame-weights.ts` の合成関数
 * （`domain/avatar/expression-blend.ts`）を通して協調する。感情付き表情中は口の開き重みを
 * 減衰し、まばたきを抑制することで表情と口パクの破綻を避ける（#31 感情連動）。
 *
 * auto-blink（#31 増分）: `domain/avatar/auto-blink.ts` が計算する周期的なまばたき重みを
 * 毎フレーム `resolveFrameExpressionWeights` の `blinkBaseWeight` へ渡す。感情中の抑制は
 * 既存の合成（`expression-blend.ts`）がそのまま処理するため、ここでは重複制御しない。
 * `prefers-reduced-motion` は考慮しない: まばたきは大きな動きを伴う演出アニメーションではなく
 * 生理的な自然動作（`vrm-idle.ts` の呼吸・揺れも同様に無条件で適用している）であり、CSS の
 * トランジション/オートプレイ動画のような「抑制すべき派手な動き」には当たらないため
 * （既存の `globals.css` の reduced-motion 対応は UI のフェード/パルス演出が対象）。
 * 実描画・実モーションの確認は実機 UAT（#65）。
 */
export function VrmAvatarViewer({
  vrmUrl,
  fallbackImageUrl,
  motionUrl,
  expression,
  expressionIntensity,
  speaking,
  avatarState,
  gazeTarget,
  layout,
  className,
}: {
  vrmUrl?: string;
  fallbackImageUrl?: string;
  /**
   * 受付状態に応じて解決済みのモーション URL（#31）。
   * 実際の .vrma 再生は実機 UAT（#65）で実装。ここでは描画要素へ接続して受け渡しを明示する。
   */
  motionUrl?: string;
  /** 受付状態に応じた論理表情（#31）。VRM expressionManager に毎フレーム適用する。 */
  expression?: AvatarExpression;
  /**
   * 表情の強度 0..1（省略時 1 = フル適用）。現状の avatarGuidanceFor には強度概念が無いため
   * 常に未指定 = フル適用で扱われるが、将来の強度可変入力を受けるための注入 seam
   * （感情連動リップシンク + まばたき抑制、#31 / `docs/aituber-kit-v1-ui-reference.md` 提案 B）。
   */
  expressionIntensity?: number;
  /** TTS 発話中か（#5 簡易リップシンク）。true の間、口形素 `aa` を時間ベースで開閉する。 */
  speaking?: boolean;
  /** 受付アバター状態（#31）。.vrma 非再生時に状態別の手続き的ポーズ/所作を適用する。 */
  avatarState?: AvatarState;
  /**
   * 視線誘導先 (#422 inc5-c 増分 3)。契約 `gazeTargetFor(screenState)` の値。
   * `layout` と組で向く方向が決まる（横向きは右レール、縦向きは真下）。
   */
  gazeTarget?: GazeTarget;
  /** 画面レイアウト。視線の向きに効く。未指定は横向き扱い（既定プロファイル）。 */
  layout?: KioskLayout;
  className?: string;
}) {
  const canvasRef = useRef<HTMLCanvasElement | null>(null);
  /**
   * **どの URL で失敗したか**を持つ（#932）。真偽値だと一度立つと戻らず、`vrmUrl` を
   * 差し替えても静止画のままになる（effect は `if (!canvas) return;` をリセットより前に
   * 持ち、fallback 中は canvas が DOM に無いので、リセット自体へ到達しない）。
   */
  const [failedUrl, setFailedUrl] = useState<string | undefined>(undefined);
  /** mixer に残っている `.vrma` アクション数（#930）。切替後も 1 のままであるべき。 */
  const [liveMotionActions, setLiveMotionActions] = useState(0);
  /**
   * 読み込んだ VRM の仕様版 (#578 増分 1)。**診断のためだけ**に持つ。
   *
   * 実機で「モーションが変」と分かっても、版が出ていないとモデル版・モーション・カメラの
   * どれに帰属するのか切り分けられない。`data-vrm-version` として観測可能にする。
   */
  const [vrmVersion, setVrmVersion] = useState<VrmSpecVersion>('unknown');
  const [vrmLoaded, setVrmLoaded] = useState(false);
  /**
   * モーション適用の**結果** (#578 増分 2)。`data-motion-url` は要求した URL を出すだけで、
   * 実際に再生されたかは分からなかった。「再生されていない」と「再生されているが見た目が
   * 変」を実機で区別できるようにする。
   */
  const [motionObservation, setMotionObservation] = useState<MotionObservation>({ state: 'none' });
  /**
   * 実効画角 (#578 増分 1 の残り)。**診断のためだけ**に持つ（描画は three.js 側が持つ値で行う）。
   *
   * 版とモーションは観測できるようになったのに**カメラだけが出ていない**ため、実機で
   * 「顔が切れる / 真っ黒」を見ても帰属先を絞れなかった。とくに頭の高さは黙って既定へ
   * 倒され、黙って妥当域へ寄せられるので、その事実（`src=`）まで載せる。
   */
  const [cameraFramingAttr, setCameraFramingAttr] = useState<string>('none');
  /**
   * 配線の観測（独立レビュー B1）。`data-vrm-prepared` は読込後の公式手順が通ったこと、
   * `data-render-state` は最初のフレームが実際に描かれたことを表す。
   *
   * どちらも**落としても unit は緑のまま**で、描画も「それらしく」見える（`setAnimationLoop`
   * が呼ばれなければ透明な canvas が残るだけで fallback には落ちない）。実描画検査が
   * この 2 つを名指しで期待する。
   */
  const [preparedAttr, setPreparedAttr] = useState<string>('none');
  const [renderState, setRenderState] = useState<'pending' | 'rendering'>('pending');
  // 表情はレンダーループ（[vrmUrl] 依存）の外から更新されるため ref で最新値を渡す。
  const expressionRef = useRef<AvatarExpression>(expression ?? 'neutral');
  useEffect(() => {
    expressionRef.current = expression ?? 'neutral';
  }, [expression]);
  // 表情強度も同様に ref 経由で渡す（#31 感情連動リップシンク + まばたき抑制の注入 seam）。
  const expressionIntensityRef = useRef<number | undefined>(expressionIntensity);
  useEffect(() => {
    expressionIntensityRef.current = expressionIntensity;
  }, [expressionIntensity]);
  // 発話中フラグもレンダーループ外から変化するため ref で渡す（#5 リップシンク）。
  const speakingRef = useRef<boolean>(speaking ?? false);
  useEffect(() => {
    speakingRef.current = speaking ?? false;
  }, [speaking]);
  // 受付状態もレンダーループ外から変化するため ref で渡す（#31 状態別ポーズ）。
  const avatarStateRef = useRef<AvatarState>(avatarState ?? 'idle');
  // 視線は毎フレーム参照するので ref に持つ（再マウントせず追従させる）。
  const gazeRef = useRef<GazeOffset>(gazeOffsetFor(gazeTarget ?? 'none', layout ?? 'ipad-landscape'));
  useEffect(() => {
    avatarStateRef.current = avatarState ?? 'idle';
    gazeRef.current = gazeOffsetFor(gazeTarget ?? 'none', layout ?? 'ipad-landscape');
  }, [avatarState, gazeTarget, layout]);

  // モーション URL も [vrmUrl] エフェクト外から変化するため ref 経由で渡す。
  // VRM ロード完了後に loadMotionRef.current が設定され、状態遷移ごとに .vrma を切替える（#31）。
  const motionUrlRef = useRef<string | undefined>(motionUrl);
  const loadMotionRef = useRef<((url: string | undefined) => void) | null>(null);
  useEffect(() => {
    motionUrlRef.current = motionUrl;
    loadMotionRef.current?.(motionUrl);
  }, [motionUrl]);
  // auto-blink（#31 増分）の状態。純関数 stepAutoBlink の戻り値をそのまま次フレームへ
  // 引き継ぐだけの ref（乱数の生成・解釈は domain 層に閉じ、viewer 側は状態を運ぶだけ）。
  const autoBlinkStateRef = useRef<AutoBlinkState | null>(null);

  useEffect(() => {
    // vrmUrl が無ければ WebGL を一切初期化しない（既定の受付画面を軽量に保つ）。
    if (!vrmUrl) return;
    const canvas = canvasRef.current;
    if (!canvas) return;

    // **前モデルの観測を持ち越さない** (#578 レビュー M6)。リセットしないと、新モデルの
    // ダウンロード中（実機で数秒）に前モデルの版・再生状態を報告し続ける。
    setVrmVersion('unknown');
    setVrmLoaded(false);
    setMotionObservation({ state: 'none' });
    setPreparedAttr('none');
    setRenderState('pending');

    let disposed = false;
    const tracker = new ResourceTracker();
    let renderer: { dispose: () => void; setAnimationLoop: (cb: null) => void } | null = null;

    (async () => {
      try {
        const THREE = await import('three');
        const { GLTFLoader } = await import('three/examples/jsm/loaders/GLTFLoader.js');
        const { VRMLoaderPlugin, VRMUtils } = await import('@pixiv/three-vrm');
        const { VRMAnimationLoaderPlugin, VRMLookAtQuaternionProxy, createVRMAnimationClip } =
          await import('@pixiv/three-vrm-animation');

        if (disposed) return;
        const gl = new THREE.WebGLRenderer({ canvas, alpha: true, antialias: false });
        // iPad 向け軽量モード: pixelRatio を抑制。
        gl.setPixelRatio(Math.min(globalThis.devicePixelRatio || 1, 1.5));
        renderer = gl;

        const scene = new THREE.Scene();
        // 画角はモデルの背丈から決めるので、ここでは器だけ作る（#578 増分 3）。
        // 実際の位置・注視点・aspect は VRM 読込後の applyFraming で確定する。
        const camera = new THREE.PerspectiveCamera(30, 1, 0.1, 20);

        /**
         * 画角をモデルと描画領域から決め直す (#578 増分 3)。
         *
         * 従来は `position.set(0, 1.3, 2.2)` の決め打ちで、**モデルの背丈に依存しなかった**
         * （VRM は身長差が大きい）。さらに `aspect` は読込時 1 回だけで
         * `updateProjectionMatrix()` も呼ばれておらず、**横向き iPad で回転すると歪んで**いた。
         */
        let headHeight: number | undefined = undefined;
        let headHeightApplied: number | undefined;
        /** 直前に適用した実寸。同値なら何もしない（自己参照フィードバックの再発防止）。 */
        let appliedSize: { w: number; h: number } | null = null;
        const applyFraming = () => {
          const w = canvas.clientWidth || 320;
          const h = canvas.clientHeight || 480;
          // **冪等にする。** 万一寸法が自分の書き込みで揺れても、同値なら再適用しない。
          if (appliedSize?.w === w && appliedSize.h === h && headHeightApplied === headHeight) return;
          appliedSize = { w, h };
          headHeightApplied = headHeight;
          gl.setSize(w, h, false);
          const framing = resolveCameraFraming({ headHeight, aspect: w / h });
          camera.aspect = w / h;
          camera.fov = framing.fov;
          camera.position.set(framing.position.x, framing.position.y, framing.position.z);
          camera.lookAt(framing.target.x, framing.target.y, framing.target.z);
          // これを忘れると aspect / fov の変更が反映されない（歪んだまま）。
          camera.updateProjectionMatrix();
          /**
           * 実効画角を観測可能にする (#578 増分 1 の残り)。
           *
           * **同値なら前の値を返して React に bail out させる。** applyFraming 自体は
           * 冪等だが、状態更新は再レンダリングを呼び、再レンダリングは canvas の実寸に
           * 触れうる。増分 3 で踏んだ自己参照フィードバックの入口をここにも作らない。
           */
          const attr = cameraFramingAttribute(framing);
          if (!disposed) setCameraFramingAttr((prev) => (prev === attr ? prev : attr));
        };
        applyFraming();
        const light = new THREE.DirectionalLight(0xffffff, 1.2);
        light.position.set(1, 1, 1);
        scene.add(light);

        const loader = new GLTFLoader();
        loader.register((parser) => new VRMLoaderPlugin(parser));
        const gltf = await loader.loadAsync(vrmUrl);
        if (disposed) {
          VRMUtils.deepDispose(gltf.scene);
          return;
        }
        // `gltf.userData` は `any`。ここで型を付けないと以降の three-vrm API が全部無検査になる
        // （VRM でない glTF を読んだときは undefined）。
        const vrm = gltf.userData.vrm as VRM | undefined;
        // 読込直後の公式手順（VRMUtils 最適化・frustumCulled・0.x の向き補正・lookAt proxy）。
        // 何を・どの順で呼ぶかは `lib/three/vrm-prepare.ts` に集約し unit で固定している。
        if (vrm) {
          const prepared = prepareLoadedVrm(vrm, {
            utils: VRMUtils,
            LookAtProxy: VRMLookAtQuaternionProxy,
          });
          setPreparedAttr(vrmPreparedAttribute(prepared));
        }
        // 版を観測可能にする (#578 増分 1)。rotateVRM0 が「何に対して」効いたのかを
        // 実機から確認できるようにする（推測で既定へ倒さない。判別不能は unknown）。
        setVrmVersion(resolveVrmSpecVersion(vrm?.meta));
        setVrmLoaded(Boolean(vrm));
        scene.add(gltf.scene);
        // humanoid から頭の高さを取り、画角を決め直す（背丈の違うモデルでも顔が切れない）。
        // 取れなければ undefined のまま＝既定へ倒す（0 を渡してカメラを原点に埋めない）。
        headHeight = vrm ? measureHeadHeight(vrm, () => new THREE.Vector3()) : undefined;
        applyFraming();
        tracker.track({ dispose: () => VRMUtils.deepDispose(gltf.scene) });

        // --- 状態別モーション（.vrma）再生 (#31) ---
        // 受付状態 → motionUrl は AvatarGuide/KioskFlow が解決する。ここでは .vrma を読み込み、
        // AnimationMixer で切替再生する。競合制御と観測は `avatar/motion-player.ts`。
        const mixer = new THREE.AnimationMixer(vrm?.scene ?? gltf.scene);
        /**
         * `.vrma` の**生存アクション数**を観測する（#930）。
         *
         * 🔴 **`play` で +1 / `release` で −1 する数え方にしない。** それは
         * 「`release` が**呼ばれた**」ことしか見ておらず、`release` の中身
         * （`action.stop()` / `mixer.uncacheClip(clip)`）を落とす変異が素通りする。
         * #923 が直した欠陥はまさに「呼んでいるのに mixer から外れていない」形だった。
         *
         * そこで **mixer に残っているか**を直接引く。`uncacheClip` が効いていれば
         * `existingAction` は `null` を返すので、外し忘れた分だけ数が増える。
         * `knownClips` は退場したクリップも保持し続ける（外れたことを見るために要る）。
         * 種類数は状態ごとのモーション数で頭打ちなので伸び続けない。
         */
        const knownClips = new Set<AnimationClip>();
        const reportLiveActions = () => {
          let live = 0;
          for (const clip of knownClips) if (mixer.existingAction(clip)) live += 1;
          if (!disposed) setLiveMotionActions(live);
        };

        const motionPlayer = createMotionPlayer({
          vrmLoaded: Boolean(vrm),
          load: async (url) => {
            const animLoader = new GLTFLoader();
            animLoader.register((parser) => new VRMAnimationLoaderPlugin(parser));
            const vrma = await animLoader.loadAsync(url);
            return vrma.userData.vrmAnimations?.[0];
          },
          play: (vrmAnimation) => {
            if (!vrm) throw new Error('VRM is not loaded');
            // 版差（0.x の 180° 反転）は createVRMAnimationClip が `vrm.meta.metaVersion` を
            // 見て補正する。ここで独自に判定すると二重補正になるので触らない。
            const clip = createVRMAnimationClip(vrmAnimation, vrm);
            const action = mixer.clipAction(clip);
            action.reset().setLoop(THREE.LoopRepeat, Infinity).fadeIn(0.3).play();
            knownClips.add(clip);
            reportLiveActions();
            return {
              fadeOut: (d) => void action.fadeOut(d),
              // フェード後に mixer から外す。`fadeOut` だけでは `LoopRepeat` のアクションが
              // 評価対象に残り続け、状態遷移のたびに増える（`motion-player.ts` 参照）。
              release: () => {
                action.stop();
                mixer.uncacheClip(clip);
                reportLiveActions();
              },
            };
          },
          observe: (o) => {
            if (!disposed) setMotionObservation(o);
          },
        });
        tracker.track({ dispose: () => motionPlayer.dispose() });
        loadMotionRef.current = (url) => void motionPlayer.request(url);
        void motionPlayer.request(motionUrlRef.current);

        const clock = new THREE.Clock();
        // auto-blink（#31 増分）: 描画ループ開始時刻を種に初期状態を生成する。実時刻
        // （Date.now()）を扱うのはここ（viewer 側）だけで、domain 側の純関数へは値として
        // 渡すのみ（`domain/avatar/auto-blink.ts` は Math.random()/Date.now() を呼ばない）。
        autoBlinkStateRef.current = createAutoBlinkState(Date.now());
        let firstFrameReported = false;
        const render = () => {
          if (disposed) return;
          const dt = clock.getDelta();
          // auto-blink を 1 フレーム進める。まばたき動作の有無に関わらず毎フレーム呼び、
          // 経過時刻の追跡を継続する（表情合成の外側で state を進めることで、
          // expressionManager 不在（読み込み途中等）でもスケジュールがずれない）。
          let blinkBaseWeight = 0;
          if (autoBlinkStateRef.current) {
            const autoBlinkFrame = stepAutoBlink(autoBlinkStateRef.current, clock.elapsedTime * 1000);
            autoBlinkStateRef.current = autoBlinkFrame.state;
            blinkBaseWeight = autoBlinkFrame.weight;
          }
          // 受付状態に応じた表情を expressionManager に適用（#31）。感情 preset のみを操作し、
          // 口形素/瞬き/視線は触らない（リップシンク #5 と非干渉）。
          const expressionManager = vrm?.expressionManager;
          if (expressionManager) {
            for (const { name, value } of emotionExpressionValues(expressionRef.current)) {
              expressionManager.setValue(name, value);
            }
            // 簡易リップシンク（#5）+ 感情連動の重み合成（#31）: 発話中は口形素 `aa` を
            // 時間ベースで開閉しつつ、感情付き表情中は口の開き重みを減衰させ、まばたきは
            // 抑制する（表情と口パクの破綻回避。`domain/avatar/expression-blend` 参照）。
            // blinkBaseWeight は auto-blink（#31 増分）が計算した周期的な生の重み。感情中の
            // 抑制は resolveFrameExpressionWeights 内の既存合成が処理するため、ここでは
            // 重複して抑制しない。
            const frameWeights = resolveFrameExpressionWeights({
              expression: expressionRef.current,
              expressionIntensity: expressionIntensityRef.current,
              speaking: speakingRef.current,
              elapsedSec: clock.elapsedTime,
              blinkBaseWeight,
            });
            expressionManager.setValue('aa', frameWeights.mouthAa);
            expressionManager.setValue('blink', frameWeights.blink);
          }
          // .vrma モーションが無いときは受付状態に応じた手続き的ポーズ/所作を適用する（#31）。
          // モーション再生中は AnimationMixer がボーンを駆動するため適用しない。
          const humanoid = vrm?.humanoid;
          if (!motionPlayer.isPlaying() && humanoid) {
            const pose = resolveStatePose(avatarStateRef.current, clock.elapsedTime);
            // 視線誘導 (#422 inc5-c 増分 3)。首と頭に分けて配分し、頭だけが不自然に回るのを
            // 避ける。ポーズ（呼吸・頷き等）へ**加算**するので、既存の所作は失われない。
            const gaze = gazeRef.current;
            if (gaze.yaw !== 0 || gaze.pitch !== 0) {
              pose.neck = {
                ...(pose.neck ?? {}),
                x: (pose.neck?.x ?? 0) + gaze.pitch * 0.4,
                y: (pose.neck?.y ?? 0) + gaze.yaw * 0.4,
              };
              pose.head = {
                ...(pose.head ?? {}),
                x: (pose.head?.x ?? 0) + gaze.pitch * 0.6,
                y: (pose.head?.y ?? 0) + gaze.yaw * 0.6,
              };
            }
            // 正規化ボーンへ書く。`vrm.update()` の humanoid.update が raw ボーンへ転写する
            // （`autoUpdateHumanBones` 既定 true）。
            for (const [bone, rot] of poseEntries(pose)) {
              const node = humanoid.getNormalizedBoneNode(bone);
              if (node) node.rotation.set(rot.x ?? 0, rot.y ?? 0, rot.z ?? 0);
            }
          }
          // 公式例と同じ順: mixer が正規化ボーン/表情/lookAt proxy を書き、vrm.update が
          // humanoid → raw 転写・lookAt・expression・constraint・springBone を適用する。
          mixer.update(dt);
          vrm?.update(dt);
          gl.render(scene, camera);
          // 最初のフレームを描いた事実だけを 1 回報告する（毎フレーム setState しない）。
          if (!firstFrameReported) {
            firstFrameReported = true;
            if (!disposed) setRenderState('rendering');
          }
        };
        tracker.track({ dispose: () => mixer.stopAllAction() });

        /**
         * 描画領域の変化に追従する (#578 増分 3)。
         *
         * これが無いと `aspect` は読込時の 1 回きりで、**横向き iPad を回転させると
         * 縦横比がずれたまま描画され続ける**（`updateProjectionMatrix()` も未呼び出しだった）。
         * `ResizeObserver` は canvas 自身の実寸変化を見るので、`orientationchange` や
         * CSS レイアウト由来の変化も同じ経路で拾える。
         */
        if (typeof ResizeObserver !== 'undefined') {
          const observer = new ResizeObserver(() => {
            if (!disposed) applyFraming();
          });
          // **canvas ではなく親を観測する。** canvas を観測すると、`gl.setSize` が書いた
          // backing store の変化を自分で拾って発散し得る（上の style で切り離してはいるが、
          // 観測対象を親にしておけば構造的にその経路が存在しない）。
          observer.observe(canvas.parentElement ?? canvas);
          tracker.track({ dispose: () => observer.disconnect() });
        }
        // three.js 推奨のループ。`setAnimationLoop(null)` で止まるので、破棄経路が 1 本になる
        // （以前は rAF を自前で回しつつ、使っていない setAnimationLoop(null) も呼んでいた）。
        gl.setAnimationLoop(render);
      } catch {
        // WebGL 不可 / VRM 読み込み失敗 → fallback。受付フローは継続。
        // `setFailedUrl(vrmUrl)` で `showFallback` が真になり canvas 自体が描かれなくなるため、
        // ここで観測属性を触っても誰も読めない（#578 レビュー m9）。状態は effect 冒頭の
        // リセットで既に初期化済み。
        if (!disposed) setFailedUrl(vrmUrl);
      }
    })();

    return () => {
      disposed = true;
      loadMotionRef.current = null;
      autoBlinkStateRef.current = null;
      tracker.disposeAll();
      try {
        renderer?.setAnimationLoop(null);
        renderer?.dispose();
      } catch {
        /* ignore */
      }
    };
  }, [vrmUrl]);

  const showFallback = shouldShowVrmFallback({ vrmUrl, failedUrl });

  if (showFallback) {
    // VRM も fallback 画像も無ければ何も表示しない（既定の受付画面の体裁を保つ）。
    if (!fallbackImageUrl) return null;
    return <AvatarFallbackImage src={fallbackImageUrl} className={className} />;
  }

  // data-motion-url: 現在再生中のモーション URL（#31。AnimationMixer で再生、実描画確認は #65）。
  return (
    <canvas
      ref={canvasRef}
      className={className}
      /**
       * **レイアウト寸法を CSS で確定させる**（#578 増分 3 の退行修正）。
       *
       * これが無いと canvas のレイアウト寸法＝`width`/`height` **属性**（intrinsic size）に
       * なる。`gl.setSize(w, h, false)` は属性へ `w * pixelRatio` を書くので、
       * **自分が書いた値が次の `clientWidth` になる**。それを `ResizeObserver` で観測すると
       * 1 フレームごとに `pixelRatio` 倍へ発散し、DPR>1（＝実機 iPad）で canvas が
       * 数百 ms のうちに上限まで肥大して GPU が落ちる。
       * CSS で寸法を決めれば属性を書き換えてもレイアウトは動かない。
       */
      style={{ display: 'block', width: '100%', height: '100%' }}
      data-testid="vrm-canvas"
      data-motion-url={motionUrl}
      // 読み込んだ VRM の仕様版 (#578 増分 1)。`none`=未読込/失敗、`unknown`=読めたが版不明。
      data-vrm-version={vrmVersionAttribute({ loaded: vrmLoaded, version: vrmVersion })}
      // モーション適用の結果 (#578 増分 2)。失敗は理由まで出す（failed:no-animation 等）。
      data-motion-state={motionStateAttribute(motionObservation)}
      // 実効画角 (#578 増分 1)。`none`=未確定。`src=fallback|clamped` は頭の高さを
      // 実測できなかった／妥当域へ寄せたことを表す（黙って倒さない）。
      data-camera-framing={cameraFramingAttr}
      // 配線の観測（独立レビュー B1）。`optimized[;lookat-proxy]`=公式手順が通った、`none`=未読込。
      data-vrm-prepared={preparedAttr}
      // `rendering`=最初のフレームを描いた。`pending` のままなら描画ループが配線されていない。
      data-render-state={renderState}
      // mixer に残っている `.vrma` アクション数 (#930)。**切替を繰り返しても 1 のまま**が正。
      // 増えるなら退場したアクションが評価対象に残っている（24 時間稼働で単調増加する）。
      data-motion-actions={liveMotionActions}
    />
  );
}
