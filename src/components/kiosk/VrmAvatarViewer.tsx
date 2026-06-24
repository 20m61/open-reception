'use client';

import { useEffect, useRef, useState } from 'react';
import { ResourceTracker } from '@/lib/three/resource-tracker';
import { emotionExpressionValues } from './avatar/vrm-expression';
import type { AvatarExpression } from './avatar/guidance';

/**
 * VRM アバター表示基盤 (issue #36)。
 * - vrmUrl が無い/読み込み失敗/WebGL 不可のときは fallback（静止画 or プレースホルダ）を表示。
 * - three / three-vrm は vrmUrl があるときのみ動的 import（初期バンドル・SSR を汚さない）。
 * - unmount 時に renderer/geometry/material/texture を破棄する。
 * - 受付フローとは疎結合。実描画は実機 UAT で確認する（headless では fallback 経路を検証）。
 *
 * NOTE: 状態別モーション再生（#31）・リップシンク（#5）は本コンポーネントの接続口
 * （vrmUrl/motionUrl props と onReady）経由で後続実装が利用する。
 */
export function VrmAvatarViewer({
  vrmUrl,
  fallbackImageUrl,
  motionUrl,
  expression,
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
  className?: string;
}) {
  const canvasRef = useRef<HTMLCanvasElement | null>(null);
  const [failed, setFailed] = useState(false);
  // 表情はレンダーループ（[vrmUrl] 依存）の外から更新されるため ref で最新値を渡す。
  const expressionRef = useRef<AvatarExpression>(expression ?? 'neutral');
  useEffect(() => {
    expressionRef.current = expression ?? 'neutral';
  }, [expression]);

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
        scene.add(gltf.scene);
        tracker.track({ dispose: () => VRMUtils.deepDispose(gltf.scene) });

        const render = () => {
          if (disposed) return;
          // 受付状態に応じた表情を expressionManager に適用（#31）。感情 preset のみを操作し、
          // 口形素/瞬き/視線は触らない（リップシンク #5 と非干渉）。
          const expressionManager = vrm?.expressionManager;
          if (expressionManager) {
            for (const { name, value } of emotionExpressionValues(expressionRef.current)) {
              expressionManager.setValue(name, value);
            }
          }
          vrm?.update?.(1 / 60);
          gl.render(scene, camera);
          animationId = requestAnimationFrame(render);
        };
        render();
      } catch {
        // WebGL 不可 / VRM 読み込み失敗 → fallback。受付フローは継続。
        if (!disposed) setFailed(true);
      }
    })();

    return () => {
      disposed = true;
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
    return (
      <div className={className} data-testid="vrm-fallback" aria-hidden="true">
        {/* eslint-disable-next-line @next/next/no-img-element */}
        <img src={fallbackImageUrl} alt="" style={{ width: '100%', height: '100%', objectFit: 'contain' }} />
      </div>
    );
  }

  // data-motion-url: 現在の状態で再生すべきモーション URL（#31 の接続口。実再生は #65）。
  return <canvas ref={canvasRef} className={className} data-testid="vrm-canvas" data-motion-url={motionUrl} />;
}
