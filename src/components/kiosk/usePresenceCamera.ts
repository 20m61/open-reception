'use client';

import { useCallback, useEffect, useRef, useState } from 'react';
import { DEFAULT_PRESENCE_CONFIG } from '@/domain/presence/state';
import {
  INITIAL_ATTRACT_DETECTOR_STATE,
  resumeAttractDetector,
  stepAttractDetector,
  type AttractDetectorState,
} from '@/lib/presence/attract-detector';
import { computeCenterMotion, rgbaToGrayscale } from '@/lib/presence/motion-diff';

/**
 * 来訪者検知カメラフック (issue #79 / #362, kiosk-integration)。
 *
 * 待機画面で低負荷に「端末に用がありそうな接近」を推定し、ATTRACT に達したら
 * `onAttract` を呼ぶ。**このフックは受付を開始しない**。ATTRACT は「画面だけ反応する」
 * 段階であり、受付開始（KioskMode の signage → reception/qr_reception 遷移）は
 * 呼び出し側が ATTRACT オーバーレイの明示 CTA タップを受けたときにだけ行う (issue #362)。
 *
 * 検知ロジック本体は `src/lib/presence/attract-detector.ts` の純関数に委譲し、ここは
 * カメラ取得・フレームサンプリング・タイムアウト管理だけを持つ薄い DOM 層にする。
 *
 * 実装方針（非破壊・フォールバック）:
 *   - enabled=false（既定）のときは getUserMedia を一切呼ばず完全に無効。従来のタップ起動で完走する。
 *   - getUserMedia 未対応 / 権限拒否 / 取得失敗のときは status='unavailable' に倒し、何もしない
 *     （待機画面のタップ起動は常に生きている）。実機カメラ検証は #65 にスタック。
 *   - ATTRACT シグナル後、無操作のまま `attractTimeoutMs` 経過したら `onAttractTimeout` を呼び、
 *     検知状態を初期化して次の来訪者を再検知できるようにする（8〜12 秒、既定は
 *     `DEFAULT_PRESENCE_CONFIG.attractTimeoutMs`）。
 *
 * 映像・フレームはローカルでのみ処理し、サーバへ送らない・保存しない（プライバシー方針）。
 */

export type PresenceCameraStatus = 'idle' | 'starting' | 'running' | 'unavailable';

/** 内部フレーム解像度（低負荷方針：80x60 程度の小フレームで差分を取る）。 */
const FRAME_WIDTH = 80;
const FRAME_HEIGHT = 60;
/** サンプリング間隔（低 fps：負荷を抑える）。 */
const SAMPLE_INTERVAL_MS = 400;

export type UsePresenceCameraOptions = {
  /** ATTRACT で無操作のままサイネージへ戻すまでの時間 (ms)。既定 8000（8〜12 秒の下限）。 */
  attractTimeoutMs?: number;
  /** ATTRACT タイムアウトで待機へ戻ったときに呼ぶ（サイネージ再開の演出フック）。 */
  onAttractTimeout?: () => void;
};

export function usePresenceCamera(
  enabled: boolean,
  onAttract: () => void,
  options: UsePresenceCameraOptions = {},
): { status: PresenceCameraStatus } {
  const [status, setStatus] = useState<PresenceCameraStatus>('idle');
  const attractTimeoutMs = options.attractTimeoutMs ?? DEFAULT_PRESENCE_CONFIG.attractTimeoutMs;
  // onAttract / onAttractTimeout を ref 経由で参照し、effect の再起動（カメラ再取得）を避ける。
  const onAttractRef = useRef(onAttract);
  useEffect(() => {
    onAttractRef.current = onAttract;
  }, [onAttract]);
  const onAttractTimeoutRef = useRef(options.onAttractTimeout);
  useEffect(() => {
    onAttractTimeoutRef.current = options.onAttractTimeout;
  }, [options.onAttractTimeout]);

  // 検知状態は純ロジック（attract-detector.ts）が保持。effect 内のループで参照・更新する。
  const detectorRef = useRef<AttractDetectorState>(INITIAL_ATTRACT_DETECTOR_STATE);
  const attractTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  const clearAttractTimer = useCallback(() => {
    if (attractTimerRef.current !== null) {
      clearTimeout(attractTimerRef.current);
      attractTimerRef.current = null;
    }
  }, []);

  const handleMotion = useCallback(
    (motionLevel: number) => {
      const result = stepAttractDetector(detectorRef.current, motionLevel);
      detectorRef.current = result.state;
      if (!result.attractSignal) return;

      // ATTRACT に到達: 画面だけ反応させる（受付は開始しない）。
      onAttractRef.current();
      clearAttractTimer();
      attractTimerRef.current = setTimeout(() => {
        // 無操作のまま時間切れ。検知状態を初期化し、次の来訪者を再検知できるようにする。
        detectorRef.current = resumeAttractDetector();
        attractTimerRef.current = null;
        onAttractTimeoutRef.current?.();
      }, attractTimeoutMs);
    },
    [attractTimeoutMs, clearAttractTimer],
  );

  useEffect(() => {
    if (!enabled) {
      setStatus('idle');
      detectorRef.current = resumeAttractDetector();
      clearAttractTimer();
      return;
    }

    let cancelled = false;
    let stream: MediaStream | null = null;
    let video: HTMLVideoElement | null = null;
    let timer: ReturnType<typeof setInterval> | null = null;
    let prevGray: Uint8Array | null = null;

    const md =
      typeof navigator !== 'undefined' ? navigator.mediaDevices : undefined;
    if (!md || typeof md.getUserMedia !== 'function') {
      setStatus('unavailable');
      return;
    }

    setStatus('starting');
    detectorRef.current = resumeAttractDetector();
    clearAttractTimer();

    const canvas = document.createElement('canvas');
    canvas.width = FRAME_WIDTH;
    canvas.height = FRAME_HEIGHT;
    const ctx = canvas.getContext('2d', { willReadFrequently: true });

    void md
      .getUserMedia({ video: { width: 160, height: 120, facingMode: 'user' }, audio: false })
      .then(async (s) => {
        if (cancelled) {
          s.getTracks().forEach((t) => t.stop());
          return;
        }
        stream = s;
        video = document.createElement('video');
        video.muted = true;
        video.playsInline = true;
        video.srcObject = s;
        await video.play().catch(() => undefined);
        if (cancelled || !ctx) return;
        setStatus('running');

        timer = setInterval(() => {
          if (cancelled || !video || !ctx || detectorRef.current.attractSignaled) return;
          try {
            ctx.drawImage(video, 0, 0, FRAME_WIDTH, FRAME_HEIGHT);
            const { data } = ctx.getImageData(0, 0, FRAME_WIDTH, FRAME_HEIGHT);
            const gray = rgbaToGrayscale(data, FRAME_WIDTH, FRAME_HEIGHT);
            if (prevGray) {
              const { motionLevel } = computeCenterMotion(prevGray, gray, {
                width: FRAME_WIDTH,
                height: FRAME_HEIGHT,
              });
              handleMotion(motionLevel);
            }
            prevGray = gray;
          } catch {
            /* フレーム処理の失敗は致命的でない（次のサンプルで回復、なければタップ起動）。 */
          }
        }, SAMPLE_INTERVAL_MS);
      })
      .catch(() => {
        // 権限拒否 / 未対応 / 取得失敗。タップ起動へフォールバック。
        if (!cancelled) setStatus('unavailable');
      });

    return () => {
      cancelled = true;
      if (timer) clearInterval(timer);
      clearAttractTimer();
      if (video) {
        video.pause();
        video.srcObject = null;
      }
      if (stream) stream.getTracks().forEach((t) => t.stop());
    };
  }, [enabled, handleMotion, clearAttractTimer]);

  return { status };
}
