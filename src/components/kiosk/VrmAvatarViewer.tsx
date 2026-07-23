'use client';

import { useEffect, useRef, useState } from 'react';
import { ResourceTracker } from '@/lib/three/resource-tracker';
import { AvatarFallbackImage } from './avatar/fallback-image';
import { emotionExpressionValues } from './avatar/vrm-expression';
import { resolveStatePose } from './avatar/vrm-pose';
import { resolveFrameExpressionWeights } from './avatar/frame-weights';
import { createAutoBlinkState, stepAutoBlink, type AutoBlinkState } from '@/domain/avatar/auto-blink';
import type { AvatarExpression } from './avatar/guidance';
import type { AvatarState } from '@/domain/reception/ui-contract';

/**
 * VRM アバター表示基盤 (issue #36)。
 * - vrmUrl が無い/読み込み失敗/WebGL 不可のときは fallback（静止画 or プレースホルダ）を表示。
 * - three / three-vrm は vrmUrl があるときのみ動的 import（初期バンドル・SSR を汚さない）。
 * - unmount 時に renderer/geometry/material/texture を破棄する。
 * - 受付フローとは疎結合。実描画は実機 UAT で確認する（headless では fallback 経路を検証）。
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
  className?: string;
}) {
  const canvasRef = useRef<HTMLCanvasElement | null>(null);
  const [failed, setFailed] = useState(false);
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
  useEffect(() => {
    avatarStateRef.current = avatarState ?? 'idle';
  }, [avatarState]);

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

    let disposed = false;
    let animationId = 0;
    const tracker = new ResourceTracker();
    let renderer: { dispose: () => void; setAnimationLoop?: (cb: null) => void } | null = null;

    (async () => {
      try {
        const THREE = await import('three');
        const { GLTFLoader } = await import('three/examples/jsm/loaders/GLTFLoader.js');
        const { VRMLoaderPlugin, VRMUtils } = await import('@pixiv/three-vrm');
        const { VRMAnimationLoaderPlugin, createVRMAnimationClip } = await import(
          '@pixiv/three-vrm-animation'
        );

        if (disposed) return;
        const gl = new THREE.WebGLRenderer({ canvas, alpha: true, antialias: false });
        // iPad 向け軽量モード: pixelRatio を抑制。
        gl.setPixelRatio(Math.min(globalThis.devicePixelRatio || 1, 1.5));
        gl.setSize(canvas.clientWidth || 320, canvas.clientHeight || 480, false);
        renderer = gl;

        const scene = new THREE.Scene();
        const camera = new THREE.PerspectiveCamera(30, (canvas.clientWidth || 320) / (canvas.clientHeight || 480), 0.1, 20);
        camera.position.set(0, 1.3, 2.2);
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
        const vrm = gltf.userData.vrm;
        // VRM 0.x は -Z 向き（カメラから背面）規約のため、+Z 向きへ 180° 回す。
        // VRM 1.0 には no-op。これが無いと 0.x モデルは常に後ろ姿で描画される
        // （実描画検証 2026-07-22 で発覚。同梱 Rose は 0.x）。
        if (vrm) VRMUtils.rotateVRM0(vrm);
        scene.add(gltf.scene);
        tracker.track({ dispose: () => VRMUtils.deepDispose(gltf.scene) });

        // --- 状態別モーション（.vrma）再生 (#31) ---
        // 受付状態 → motionUrl は AvatarGuide/KioskFlow が解決する。ここでは .vrma を読み込み、
        // AnimationMixer で切替再生する。読込失敗時は idle ポーズのまま安全に継続する。
        const mixer = new THREE.AnimationMixer(vrm?.scene ?? gltf.scene);
        let currentAction: { fadeOut: (d: number) => void } | null = null;
        let motionToken = 0;
        const loadMotion = async (url: string | undefined): Promise<void> => {
          if (!url) return;
          const token = ++motionToken;
          try {
            const animLoader = new GLTFLoader();
            animLoader.register((parser) => new VRMAnimationLoaderPlugin(parser));
            const vrma = await animLoader.loadAsync(url);
            // 破棄済み or 後発のモーション要求が来ていれば破棄（古い読込を捨てる）。
            if (disposed || token !== motionToken) return;
            const vrmAnimation = vrma.userData.vrmAnimations?.[0];
            if (!vrmAnimation || !vrm) return;
            const clip = createVRMAnimationClip(vrmAnimation, vrm);
            const action = mixer.clipAction(clip);
            action.reset().setLoop(THREE.LoopRepeat, Infinity).fadeIn(0.3).play();
            currentAction?.fadeOut(0.3);
            currentAction = action;
          } catch {
            // モーション読込失敗は受付フローを止めない（idle 継続）。
          }
        };
        loadMotionRef.current = (url) => void loadMotion(url);
        void loadMotion(motionUrlRef.current);

        const clock = new THREE.Clock();
        // auto-blink（#31 増分）: 描画ループ開始時刻を種に初期状態を生成する。実時刻
        // （Date.now()）を扱うのはここ（viewer 側）だけで、domain 側の純関数へは値として
        // 渡すのみ（`domain/avatar/auto-blink.ts` は Math.random()/Date.now() を呼ばない）。
        autoBlinkStateRef.current = createAutoBlinkState(Date.now());
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
          if (!currentAction && humanoid) {
            const pose = resolveStatePose(avatarStateRef.current, clock.elapsedTime);
            for (const [bone, rot] of Object.entries(pose)) {
              const node = humanoid.getNormalizedBoneNode(bone);
              if (node) node.rotation.set(rot.x ?? 0, rot.y ?? 0, rot.z ?? 0);
            }
          }
          mixer.update(dt);
          vrm?.update?.(dt);
          gl.render(scene, camera);
          animationId = requestAnimationFrame(render);
        };
        tracker.track({ dispose: () => mixer.stopAllAction() });
        render();
      } catch {
        // WebGL 不可 / VRM 読み込み失敗 → fallback。受付フローは継続。
        if (!disposed) setFailed(true);
      }
    })();

    return () => {
      disposed = true;
      loadMotionRef.current = null;
      autoBlinkStateRef.current = null;
      if (animationId) cancelAnimationFrame(animationId);
      tracker.disposeAll();
      try {
        renderer?.setAnimationLoop?.(null);
        renderer?.dispose();
      } catch {
        /* ignore */
      }
    };
  }, [vrmUrl]);

  const showFallback = !vrmUrl || failed;

  if (showFallback) {
    // VRM も fallback 画像も無ければ何も表示しない（既定の受付画面の体裁を保つ）。
    if (!fallbackImageUrl) return null;
    return <AvatarFallbackImage src={fallbackImageUrl} className={className} />;
  }

  // data-motion-url: 現在再生中のモーション URL（#31。AnimationMixer で再生、実描画確認は #65）。
  return <canvas ref={canvasRef} className={className} data-testid="vrm-canvas" data-motion-url={motionUrl} />;
}
