/**
 * `.vrma` モーションの切替再生を、three.js から切り離した制御器にする。
 *
 * `VrmAvatarViewer` の effect 内に閉じていた「後発の要求が勝つ」「空 URL で止める」
 * 「破棄後の遅延読込を捨てる」「失敗を黙らない (#578 増分 2)」の 4 つを、読込と再生を
 * 注入して unit で縛る。three-vrm 固有の処理（`GLTFLoader` + `VRMAnimationLoaderPlugin` で
 * 読む、`createVRMAnimationClip` → `AnimationMixer` で再生する）は呼び出し側が
 * `load` / `play` として渡す。
 *
 * 版差（0.x の 180° 反転）は `createVRMAnimationClip` が `vrm.meta.metaVersion` を見て
 * 補正する。ここで独自に判定すると二重補正になるので触らない（`domain/avatar/motion-state`）。
 */
import { resolveMotionObservation, type MotionObservation } from '@/domain/avatar/motion-state';

/**
 * 再生中のアクション。three の `AnimationAction` のうち使う面だけ。
 *
 * `release` はクロスフェード完了後に呼ばれる。`fadeOut` は重みを 0 にするだけで
 * `LoopRepeat` のアクションは mixer の評価対象に残り続けるため、ここで `stop()` と
 * `mixer.uncacheClip(clip)` を行わないと**状態遷移のたびにアクションが 1 つずつ増える**
 * （24 時間稼働の受付端末で毎フレームの評価対象が単調増加する。独立レビュー M3）。
 */
export type MotionAction = { fadeOut: (durationSec: number) => void; release?: () => void };

export type MotionPlayerDeps<Animation> = {
  /** VRM 本体が読めているか。false なら読込を試みず `failed:no-vrm` を報告する。 */
  vrmLoaded: boolean;
  /** `.vrma` を取得して先頭の VRMAnimation を返す。入っていなければ `undefined`。 */
  load: (url: string) => Promise<Animation | undefined>;
  /** クリップを作って再生を開始し、後で止めるためのアクションを返す。 */
  play: (animation: Animation) => MotionAction;
  /** 観測 (`data-motion-state`)。 */
  observe: (observation: MotionObservation) => void;
  /** 切替時のクロスフェード秒。既定 0.3。 */
  fadeSec?: number;
  /** `fadeSec` 後に `release` を呼ぶための遅延実行。既定は `setTimeout`。テストで差し替える。 */
  defer?: (fn: () => void, delaySec: number) => void;
};

export type MotionPlayer = {
  /** モーションを要求する。`undefined` は「モーション無し＝手続き的ポーズへ戻す」。 */
  request: (url: string | undefined) => Promise<void>;
  /** `.vrma` が再生中か（手続き的ポーズを適用するかの判定に使う）。 */
  isPlaying: () => boolean;
  /** 以降の読込結果を全部捨てる。再生中のアクションは呼び出し側が mixer ごと止める。 */
  dispose: () => void;
};

export function createMotionPlayer<Animation>(deps: MotionPlayerDeps<Animation>): MotionPlayer {
  const fadeSec = deps.fadeSec ?? 0.3;
  const defer = deps.defer ?? ((fn, delaySec) => void setTimeout(fn, delaySec * 1000));
  let current: MotionAction | null = null;
  let token = 0;
  let disposed = false;

  const stopCurrent = () => {
    const previous = current;
    current = null;
    if (!previous) return;
    previous.fadeOut(fadeSec);
    // フェードが終わってから解放する（フェード中に stop すると切替がカクつく）。
    // 破棄後は呼ばない（呼び出し側が mixer ごと止めている。破棄済みシーンに触らない）。
    defer(() => {
      if (!disposed) previous.release?.();
    }, fadeSec);
  };
  const observe = (o: MotionObservation) => {
    if (!disposed) deps.observe(o);
  };

  const request = async (url: string | undefined): Promise<void> => {
    // 破棄後の要求は何もしない（unmount 後に setState を呼ばない）。
    if (disposed) return;
    if (!url) {
      // token を進めないと、飛行中だった前の要求が「まだ現役」と誤判定して後から再生され、
      // `data-motion-url` は空なのに `data-motion-state=playing` になる。
      ++token;
      stopCurrent();
      observe({ state: 'none' });
      return;
    }
    const mine = ++token;
    const initial = resolveMotionObservation({ requestedUrl: url, vrmLoaded: deps.vrmLoaded });
    observe(initial);
    // 適用先が無いなら読込に意味が無い（原因はモデル側。`motion-state` の判定順と同じ）。
    if (initial.state === 'failed') return;
    try {
      const animation = await deps.load(url);
      // 破棄済み or 後発の要求が来ていれば捨てる。観測も更新しない —— 後発が既に書いている。
      if (disposed || mine !== token) return;
      const observation = resolveMotionObservation({
        requestedUrl: url,
        vrmLoaded: deps.vrmLoaded,
        loaded: true,
        hasAnimation: animation !== undefined,
      });
      if (observation.state !== 'playing' || animation === undefined) {
        // 失敗を報告する以上、前のモーションを回し続けない
        // （`failed:*` を見た運用者は「再生されていない」と読む）。
        stopCurrent();
        observe(observation);
        return;
      }
      const next = deps.play(animation);
      stopCurrent();
      current = next;
      observe(observation);
    } catch {
      // 読込失敗は受付フローを止めない（手続き的ポーズで継続）。ただし黙らない。
      if (disposed || mine !== token) return;
      stopCurrent();
      observe(
        resolveMotionObservation({ requestedUrl: url, vrmLoaded: deps.vrmLoaded, loaded: false }),
      );
    }
  };

  return {
    request,
    isPlaying: () => current !== null,
    dispose: () => {
      disposed = true;
      ++token;
    },
  };
}
