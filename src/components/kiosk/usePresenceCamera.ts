'use client';

import { useCallback, useEffect, useRef, useState } from 'react';
import {
  DEFAULT_PRESENCE_CONFIG,
  presenceTransition,
  type PresenceState,
} from '@/domain/presence/state';
import { computeCenterMotion, rgbaToGrayscale } from '@/lib/presence/motion-diff';

/**
 * 来訪者検知カメラフック (issue #79, kiosk-integration inc1)。
 *
 * 待機画面で低負荷に「端末に用がありそうな接近」を推定し、検知時に onDetected を呼ぶ。
 * 実装方針（非破壊・フォールバック）:
 *   - enabled=false（既定）のときは getUserMedia を一切呼ばず完全に無効。従来のタップ起動で完走する。
 *   - getUserMedia 未対応 / 権限拒否 / 取得失敗のときは status='unavailable' に倒し、何もしない
 *     （待機画面のタップ起動は常に生きている）。実機カメラ検証は #65 にスタック。
 *   - 検知は Canvas フレーム差分（motion-diff.ts）＋presence 状態機械（state.ts）に委譲する。
 *     ATTRACT（端末前に人がいそう）へ達したら受付候補とみなし onDetected を一度だけ呼ぶ。
 *     顔検出は inc1 では起動しない（CANDIDATE で動きが続けば ATTRACT とみなす軽量近似）。
 *
 * 映像・フレームはローカルでのみ処理し、サーバへ送らない・保存しない（プライバシー方針）。
 */

export type PresenceCameraStatus = 'idle' | 'starting' | 'running' | 'unavailable';

/** 内部フレーム解像度（低負荷方針：80x60 程度の小フレームで差分を取る）。 */
const FRAME_WIDTH = 80;
const FRAME_HEIGHT = 60;
/** サンプリング間隔（低 fps：負荷を抑える）。 */
const SAMPLE_INTERVAL_MS = 400;
/** CANDIDATE が一定回数連続でモーションを観測したら ATTRACT 相当とみなす（顔検出の軽量代替）。 */
const CANDIDATE_MOTION_TICKS_TO_ATTRACT = 2;

export function usePresenceCamera(
  enabled: boolean,
  onDetected: () => void,
): { status: PresenceCameraStatus } {
  const [status, setStatus] = useState<PresenceCameraStatus>('idle');
  // onDetected を ref 経由で参照し、effect の再起動（カメラ再取得）を避ける。
  const onDetectedRef = useRef(onDetected);
  useEffect(() => {
    onDetectedRef.current = onDetected;
  }, [onDetected]);

  // 検知状態は state 機械が保持。effect 内のループで参照・更新する。
  const presenceRef = useRef<PresenceState>('IDLE');
  const candidateTicksRef = useRef(0);
  const detectedRef = useRef(false);

  const handleMotion = useCallback((motionLevel: number) => {
    if (detectedRef.current) return;
    const prev = presenceRef.current;
    const next = presenceTransition(prev, { type: 'MOTION', motionLevel }, DEFAULT_PRESENCE_CONFIG);
    presenceRef.current = next.state;

    // CANDIDATE 中の継続モーションで「端末前に滞在」とみなし ATTRACT へ寄せる（顔検出の代替）。
    if (next.state === 'CANDIDATE') {
      const overThreshold = motionLevel >= DEFAULT_PRESENCE_CONFIG.motionEnterThreshold;
      candidateTicksRef.current = overThreshold ? candidateTicksRef.current + 1 : 0;
      if (candidateTicksRef.current >= CANDIDATE_MOTION_TICKS_TO_ATTRACT) {
        presenceRef.current = 'ATTRACT';
        candidateTicksRef.current = 0;
        detectedRef.current = true;
        onDetectedRef.current();
      }
    } else if (prev !== 'CANDIDATE') {
      candidateTicksRef.current = 0;
    }
  }, []);

  useEffect(() => {
    if (!enabled) {
      setStatus('idle');
      presenceRef.current = 'IDLE';
      candidateTicksRef.current = 0;
      detectedRef.current = false;
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
    detectedRef.current = false;
    presenceRef.current = 'IDLE';
    candidateTicksRef.current = 0;

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
          if (cancelled || !video || !ctx || detectedRef.current) return;
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
      if (video) {
        video.pause();
        video.srcObject = null;
      }
      if (stream) stream.getTracks().forEach((t) => t.stop());
    };
  }, [enabled, handleMotion]);

  return { status };
}
