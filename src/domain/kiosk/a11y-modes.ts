/**
 * 来訪者が選べるアクセシビリティ支援モードのドメイン型・純ロジック (issue #321)。
 *
 * 背景: axe/Lighthouse ゲート（#38/#125）と画面プロファイル基盤（#113）は「基準を満たす」ための
 * 仕組みであり、来訪者ごとに表示を変える手段が無かった。本モジュールは KioskFlow が保持する
 * 支援モードの状態・テナント有効/無効設定を表す純粋な型と、その補正（sanitize）ロジックのみを扱う。
 * 実際の見た目（フォントサイズ・配色・配置の切り替え）は globals.css の属性セレクタが担い、
 * ここでは「どの値が有効か」「不正入力をどう既定へ丸めるか」だけを決める（I/O を持たない）。
 *
 * 4 モード:
 *   - 大きな文字（fontScale）: 1 / 1.3 / 1.6 倍。
 *   - ハイコントラスト（highContrast）: 背景/前景コントラストを強化（ブランド accent は保持）。
 *   - 低位置レイアウト（lowReach）: 主要操作を画面下半分へ寄せる（車椅子・低身長の利用者向け）。
 *   - やさしい日本語: 本モジュールでは扱わない。i18n の 'ja-simple' locale として
 *     `src/lib/i18n` 側で扱う（表示言語の一種として locale 状態に統合する設計、#321）。
 *
 * 既定復帰: セッション終了・無操作リセットで `DEFAULT_A11Y_MODE_STATE` へ戻す（次の来訪者へ
 * 持ち越さない）。呼び出し側（KioskFlow）が idle 復帰時にこの既定値へ setState する。
 */

/** フォントスケールの許容値（#113 の `baseFontSize` 相当を来訪者が動的に選べるようにしたもの）。 */
export const FONT_SCALES = ['1', '1.3', '1.6'] as const;
export type FontScale = (typeof FONT_SCALES)[number];

export const DEFAULT_FONT_SCALE: FontScale = '1';

/** 値がフォントスケールとして妥当か。 */
export function isFontScale(value: unknown): value is FontScale {
  return typeof value === 'string' && (FONT_SCALES as readonly string[]).includes(value);
}

/** 来訪者が選んだ支援モードの現在値（大きな文字・ハイコントラスト・低位置レイアウト）。 */
export type A11yModeState = {
  fontScale: FontScale;
  highContrast: boolean;
  lowReach: boolean;
};

/** 既定（無支援）状態。次の来訪者へ持ち越さないためのリセット先。 */
export const DEFAULT_A11Y_MODE_STATE: A11yModeState = {
  fontScale: DEFAULT_FONT_SCALE,
  highContrast: false,
  lowReach: false,
};

/**
 * テナント/サイト設定でモードごとに来訪者へ出す/出さないを切り替えるフラグ (#321 AC「テナント/
 * サイト設定で機能ごとに有効/無効を切替可能に」)。`simpleJapanese` は 'ja-simple' locale の
 * 選択可否を表す（i18n の enabledLocales とは独立: 通常言語一覧には出さず、支援モードパネル
 * 経由でのみ選ばせるため専用フラグを持つ）。
 */
export type A11yEnabledModes = {
  largeText: boolean;
  highContrast: boolean;
  lowReach: boolean;
  simpleJapanese: boolean;
};

/** 既定は全モード有効（既存テナントは自動で有効になる後方互換の既定、#320 feedbackEnabled と同方針）。 */
export const DEFAULT_A11Y_ENABLED_MODES: A11yEnabledModes = {
  largeText: true,
  highContrast: true,
  lowReach: true,
  simpleJapanese: true,
};

/**
 * 任意入力（永続化データ・API リクエストボディ）を安全な `A11yEnabledModes` へ補正する純関数。
 * 未設定・不正値（boolean 以外）は既定=有効へフォールバックする（無効化だけを明示的な `false` で表す）。
 */
export function sanitizeA11yEnabledModes(input: unknown): A11yEnabledModes {
  const o = (typeof input === 'object' && input !== null ? input : {}) as Record<string, unknown>;
  const bool = (value: unknown, fallback: boolean): boolean => (typeof value === 'boolean' ? value : fallback);
  return {
    largeText: bool(o.largeText, DEFAULT_A11Y_ENABLED_MODES.largeText),
    highContrast: bool(o.highContrast, DEFAULT_A11Y_ENABLED_MODES.highContrast),
    lowReach: bool(o.lowReach, DEFAULT_A11Y_ENABLED_MODES.lowReach),
    simpleJapanese: bool(o.simpleJapanese, DEFAULT_A11Y_ENABLED_MODES.simpleJapanese),
  };
}

/**
 * 無効化されたモードの現在値を既定へ丸める。テナント設定変更やパネル非表示化の後でも、
 * 既に選ばれていた無効モードの値が残留して表示に反映され続けることを防ぐ。
 */
export function clampA11yModeState(state: A11yModeState, enabled: A11yEnabledModes): A11yModeState {
  return {
    fontScale: enabled.largeText ? state.fontScale : DEFAULT_FONT_SCALE,
    highContrast: enabled.highContrast ? state.highContrast : false,
    lowReach: enabled.lowReach ? state.lowReach : false,
  };
}
