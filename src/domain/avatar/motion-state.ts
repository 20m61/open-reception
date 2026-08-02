/**
 * `.vrma` モーション適用の**結果**を観測可能にする (#578 増分 2)。
 *
 * ## なぜ要るか
 *
 * `VrmAvatarViewer` のモーション読込は**失敗しても完全に黙る**:
 *
 * ```ts
 * if (!vrmAnimation || !vrm) return;   // 無言
 * catch { }                             // 無言
 * ```
 *
 * 公開している `data-motion-url` は**要求した URL** を出すだけなので、実際に再生された
 * かどうかは分からない。つまり実機で「モーションが変」と言われたとき、
 * **「再生されていない」のか「再生されているが見た目が変」なのか**を区別できない。
 * 前者なら読込・アセットの問題、後者なら版差・リターゲット・カメラの問題で、
 * 打つ手がまったく違う。
 *
 * ## ここで版に応じた適用制御はしない
 *
 * 当初は「VRM 0.0 / 1.0 を判定してモーション適用を制御する」設計を検討したが、
 * **`@pixiv/three-vrm-animation` が既に版差を補正している**ことが分かったため取り下げた:
 *
 * ```js
 * createVRMAnimationHumanoidTracks(vrmAnimation, humanoid, metaVersion)
 * //   回転:     metaVersion === '0' && i % 2 === 0 ? -v : v
 * //   平行移動: metaVersion === '0' && i % 3 !== 1 ? -v : v
 * ```
 *
 * ここへ独自の版判定を足すと**二重補正**になって逆に壊す。よってこのモジュールは
 * 「何が起きたか」を表現するだけで、補正も抑止もしない。
 */

/** モーション適用の観測状態。 */
export type MotionState =
  /** モーション URL が指定されていない（＝手続き的ポーズで動く正常状態）。 */
  | 'none'
  /** 読込中。 */
  | 'loading'
  /** 再生中。 */
  | 'playing'
  /** 要求されたが再生できなかった。理由は `MotionFailure`。 */
  | 'failed';

/**
 * 再生できなかった理由。**まとめない** — 打つ手が違うため。
 */
export type MotionFailure =
  /** `.vrma` は読めたが VRMAnimation が入っていない（アセットの中身の問題）。 */
  | 'no-animation'
  /** VRM 本体が未読込（モデル側の問題。モーションの問題ではない）。 */
  | 'no-vrm'
  /** 取得・パースに失敗（URL・ネットワーク・壊れたファイル）。 */
  | 'load-error';

export type MotionObservation = {
  state: MotionState;
  /** `state === 'failed'` のときだけ意味を持つ。 */
  failure?: MotionFailure;
};

/**
 * 観測結果を `data-motion-state` 用の 1 文字列にする。
 *
 * 失敗は理由まで含めて出す（`failed:no-animation` 等）。`failed` だけだと、
 * 実機で見たときに次に何を調べればよいか分からない。
 */
export function motionStateAttribute(observation: MotionObservation): string {
  if (observation.state !== 'failed') return observation.state;
  return observation.failure ? `failed:${observation.failure}` : 'failed';
}

/**
 * 読込結果から観測状態を決める。
 *
 * **判定順が意味を持つ**: VRM 未読込を先に見る。VRM が無ければ `.vrma` の中身に関わらず
 * 適用しようがなく、原因はモデル側にある。ここを後回しにすると「モーションのアセットが
 * 悪い」と誤診する。
 */
export function resolveMotionObservation(input: {
  /** 要求されたモーション URL。未指定なら `none`。 */
  requestedUrl: string | undefined;
  /** VRM 本体が読めているか。 */
  vrmLoaded: boolean;
  /** `.vrma` の取得・パースに成功したか。未完了なら `undefined`。 */
  loaded?: boolean;
  /** 取得できた `.vrma` に VRMAnimation が入っていたか。 */
  hasAnimation?: boolean;
}): MotionObservation {
  if (input.requestedUrl === undefined || input.requestedUrl === '') return { state: 'none' };
  if (input.loaded === undefined) return { state: 'loading' };
  if (input.loaded === false) return { state: 'failed', failure: 'load-error' };
  // VRM が無ければ、`.vrma` が正常でも適用先が無い。モーション側の問題と誤診しない。
  if (!input.vrmLoaded) return { state: 'failed', failure: 'no-vrm' };
  if (input.hasAnimation !== true) return { state: 'failed', failure: 'no-animation' };
  return { state: 'playing' };
}
