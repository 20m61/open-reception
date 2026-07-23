/**
 * auto-blink（自動まばたき）の周期駆動 (issue #31 増分)。
 *
 * 背景（`docs/aituber-kit-v1-ui-reference.md` 提案 E — 考え方のみ参考、コード移植なし）:
 *   待機中も自動的にまばたきをすることで「生きている」印象を維持する。感情表情中の抑制は
 *   既に `domain/avatar/expression-blend.ts`（`blendExpressionWeights` の `EMOTION_BLINK_MIN_SCALE`）
 *   が担っているため、本モジュールは「まばたき自体をいつ・どれだけの重みで起こすか」だけを
 *   計算する。減衰・抑制のロジックは重複させず、`components/kiosk/avatar/frame-weights.ts` の
 *   `blinkBaseWeight` 注入 seam に本モジュールの出力をそのまま渡すだけでよい。
 *
 * 副作用なし・three.js / VRM への依存なし。`Math.random()` / `Date.now()` を直接呼ばず、
 * 経過時間(ms)と乱数 seed は引数として注入する（決定論テストのため。実時刻は viewer 側
 * （`VrmAvatarViewer`）でのみ扱い、本モジュールへは値として渡す）。
 */

/**
 * まばたきの間隔（ミリ秒）の設計レンジ。
 * 人の自然な自発的まばたきは概ね毎分15〜20回程度（＝平均間隔 約3〜4秒）とされる一般的な目安を
 * 参考に、単調にならないよう幅を持たせて 2〜6 秒のランダム間隔とした
 * （`docs/aituber-kit-v1-ui-reference.md` 提案 E の「時間ベースの微動」という考え方を、
 * 具体的な数値レンジとして自前で設計したもの）。
 */
export const BLINK_MIN_INTERVAL_MS = 2000;
export const BLINK_MAX_INTERVAL_MS = 6000;

/**
 * 1 回のまばたき動作（閉眼→開眼）にかける時間（ミリ秒）。
 * 生理学的な瞬目動作は概ね 100〜400ms程度とされる一般的な目安を参考に、受付キオスクの
 * 描画フレームレートでも滑らかに見える中間的な値として 300ms を採用した。
 * `BLINK_MIN_INTERVAL_MS` はこの値の 2 倍より十分大きく取り、まばたき動作中に次のまばたきの
 * 予定時刻が重ならないようにしている（`設計レンジの妥当性` テストで固定）。
 */
export const BLINK_DURATION_MS = 300;

/**
 * auto-blink の状態。純関数 `stepAutoBlink` が毎フレーム受け取り・返す。
 * viewer 側は前フレームの戻り値をそのまま次フレームの入力として ref に保持するだけでよい
 * （internal な RNG 状態も本オブジェクトが運ぶため、viewer 側は乱数を一切扱わない）。
 */
export interface AutoBlinkState {
  /** 次にまばたきを開始する予定の経過時刻(ms)。まばたき中はこの値は使われない。 */
  readonly nextBlinkAtMs: number;
  /** 現在まばたき動作中ならその開始時刻(ms)。まばたき動作外は null。 */
  readonly activeBlinkStartMs: number | null;
  /** 次のまばたき間隔を決めるための内部 RNG 状態（xorshift32）。外部から意味を解釈しない。 */
  readonly rngState: number;
}

export interface AutoBlinkFrame {
  readonly state: AutoBlinkState;
  /** 現在フレームで VRM `blink` expression に適用すべき重み(0..1)。 */
  readonly weight: number;
}

/**
 * xorshift32 の 1 ステップ。同じ入力状態からは常に同じ乱数値・次状態を返す純関数。
 * xorshift32 は入力(非0)から常に非0の状態列を生成する既知の性質を持つため、
 * 呼び出し側が非0の状態を渡す限り退化(固定0)しない。
 */
function xorshift32Step(stateIn: number): { value01: number; nextState: number } {
  let x = stateIn | 0;
  x ^= x << 13;
  x ^= x >>> 17;
  x ^= x << 5;
  const nextState = x | 0;
  const value01 = (nextState >>> 0) / 0xffffffff;
  return { value01, nextState };
}

/**
 * 任意の seed 値（0 や負値、非数を含む）を xorshift32 が扱える非0の 32bit 整数状態へ正規化する。
 * fail-safe: 非数は 0 として扱い、0 は既知の退化値（黄金比由来の定数と XOR して拡散）を避ける。
 */
function seedToRngState(seed: number): number {
  const normalized = Number.isFinite(seed) ? Math.trunc(seed) : 0;
  const mixed = (normalized ^ 0x9e3779b9) | 0;
  return mixed === 0 ? 1 : mixed;
}

/** 乱数値(0..1)を設計レンジ [BLINK_MIN_INTERVAL_MS, BLINK_MAX_INTERVAL_MS] の間隔(ms)へ写像する。 */
function intervalFromRandomValue(value01: number): number {
  const clamped = Math.min(1, Math.max(0, value01));
  return BLINK_MIN_INTERVAL_MS + clamped * (BLINK_MAX_INTERVAL_MS - BLINK_MIN_INTERVAL_MS);
}

/**
 * seed から auto-blink の初期状態を決定論的に生成する。
 * viewer は VRM 描画ループ開始時に一度だけ呼び、以降は `stepAutoBlink` の戻り値を
 * そのまま次フレームの入力として使い回す。
 */
export function createAutoBlinkState(seed: number): AutoBlinkState {
  const { value01, nextState } = xorshift32Step(seedToRngState(seed));
  return {
    nextBlinkAtMs: intervalFromRandomValue(value01),
    activeBlinkStartMs: null,
    rngState: nextState,
  };
}

/**
 * 経過時刻(ms)を基準とした、まばたき動作中の重みカーブ(0..1)。
 * 0（開眼）→ durationMs/2 で max=1（完全閉眼）→ durationMs で 0（開眼）へ戻る単一の
 * sine 半波で滑らかに補間する（三角波ではなく sine を使うことで開始・終了が加減速し、
 * 機械的な直線運動に見えない）。
 * fail-safe: 経過時間が負・非数、または duration が非数・0 以下のときは 0 を返す。
 */
export function blinkCurveWeight(
  elapsedSinceBlinkStartMs: number,
  durationMs: number = BLINK_DURATION_MS,
): number {
  if (!Number.isFinite(elapsedSinceBlinkStartMs) || elapsedSinceBlinkStartMs < 0) return 0;
  if (!Number.isFinite(durationMs) || durationMs <= 0) return 0;
  if (elapsedSinceBlinkStartMs >= durationMs) return 0;
  const t = elapsedSinceBlinkStartMs / durationMs;
  return Math.sin(Math.PI * t);
}

/**
 * auto-blink を 1 フレーム進める純関数。
 * - 待機中（`activeBlinkStartMs === null`）: `elapsedMs` が `nextBlinkAtMs` に達していなければ
 *   重み0で状態も変化しない。達していればまばたきを開始し、その時点のカーブ重みを返す。
 * - まばたき中: 開始からの経過に応じて `blinkCurveWeight` を返す。動作時間を過ぎていれば
 *   まばたきを完了させ、次のまばたき間隔（設計レンジ内）を新たに引いて待機状態へ戻る。
 *
 * fail-safe:
 *  - `elapsedMs` が NaN/Infinity/負値なら状態を変えず重み0を返す（呼び出し側の異常入力を
 *    伝播させない）。
 *  - 時間が逆行した（前回より小さい `elapsedMs` が来た）場合も、状態を破壊せず重み0を返す。
 *    実際の描画クロックは巻き戻らない前提だが、タブのバックグラウンド復帰等で `elapsedMs` の
 *    計算元が想定外の値を返しても安全側に倒す。
 *  - 想定外に大きく時間が飛んでも例外は投げず、次フレームでまばたき完了として自己修復する。
 */
export function stepAutoBlink(state: AutoBlinkState, elapsedMs: number): AutoBlinkFrame {
  if (!Number.isFinite(elapsedMs) || elapsedMs < 0) {
    return { state, weight: 0 };
  }

  if (state.activeBlinkStartMs !== null) {
    if (elapsedMs < state.activeBlinkStartMs) {
      return { state, weight: 0 };
    }
    const sinceStart = elapsedMs - state.activeBlinkStartMs;
    if (sinceStart < BLINK_DURATION_MS) {
      return { state, weight: blinkCurveWeight(sinceStart) };
    }
    const { value01, nextState } = xorshift32Step(state.rngState);
    return {
      state: {
        nextBlinkAtMs: elapsedMs + intervalFromRandomValue(value01),
        activeBlinkStartMs: null,
        rngState: nextState,
      },
      weight: 0,
    };
  }

  if (elapsedMs < state.nextBlinkAtMs) {
    return { state, weight: 0 };
  }

  return {
    state: { ...state, activeBlinkStartMs: state.nextBlinkAtMs },
    weight: blinkCurveWeight(elapsedMs - state.nextBlinkAtMs),
  };
}
