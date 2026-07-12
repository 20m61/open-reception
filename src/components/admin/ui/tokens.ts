/**
 * 管理画面 共有デザイントークン (issue #92, increment 1)。
 *
 * 既存ページは CSS 変数（`src/app/globals.css` の `--color-*` / `--space-*`）と
 * インラインスタイルで実装されている。本モジュールはその CSS 変数を **TypeScript から
 * 参照する単一の入口** を提供し、ui/ プリミティブのトーンを統一する。
 *
 * 方針:
 * - 色は CSS 変数を参照する文字列（`var(--color-…)`）。テーマ切替やコントラスト調整は
 *   CSS 側で完結し、TS 側は名前だけを知る。
 * - 間隔/角丸/タイポは数値・rem。`--space-*` と整合する値を採用する。
 * - 「状態（status）」「トーン（tone）」は管理画面全体で語彙を統一する（#92 表示ルール）。
 *
 * 本増分では新設のみ。既存コンポーネントの色定義は次増分で本モジュールへ寄せる。
 */

/** 色トークン。値は globals.css の CSS 変数を指す。 */
export const color = {
  bg: 'var(--color-bg)',
  surface: 'var(--color-surface)',
  surface2: 'var(--color-surface-2)',
  text: 'var(--color-text)',
  muted: 'var(--color-muted)',
  accent: 'var(--color-accent)',
  success: 'var(--color-success)',
  danger: 'var(--color-danger)',
  warning: 'var(--color-warning)',
  /**
   * 罫線・区切り。globals.css の `--color-border` / `--color-border-strong` を **単一ソース**
   * として参照する（#329: 旧 `rgba(255,255,255,0.1)/0.2` の直値は CSS 定義（0.08 / 0.16）と
   * 乖離していた。CSS を正として TS を参照へ統一。テーマ/コントラスト調整も CSS 側で完結）。
   */
  border: 'var(--color-border)',
  borderStrong: 'var(--color-border-strong)',
  /**
   * プラットフォーム運用コンソール（superadmin 危険域）のセマンティック色 (#329)。
   * globals.css の `--color-platform-*` を単一ソースとして参照する。半透明は消費側で
   * `color-mix(in srgb, var(--color-platform-*) N%, transparent)` として導出する
   * （旧直値 #e0a880 / #e66e6e / #7fe0a0 と可変 alpha rgba を集約）。
   */
  platformWarn: 'var(--color-platform-warn)',
  platformDanger: 'var(--color-platform-danger)',
  platformOk: 'var(--color-platform-ok)',
} as const;

/**
 * 間隔トークン（px）。globals.css の `--space-*` と同値（#329 検証テストで一致を担保）。
 * テンプレートリテラル（`${space.xs}px`）で数値が要る消費側があるため数値で保持する。
 */
export const space = {
  xs: 6,
  sm: 12,
  md: 16,
  lg: 24,
  xl: 40,
} as const;

/**
 * 角丸トークン（px）。globals.css の `--radius-*` を正とし同値で保持する
 * （#329: 旧 TS 値 sm:8/md:12/lg:16/pill:999 は CSS の 10/14/18/9999 と乖離していた。
 * CSS を正として TS を修正）。`borderRadius: radius.md` 等で数値が要るため数値で保持し、
 * 一致は `tokens-css-parity.test.ts` が globals.css を解析して検証する。
 */
export const radius = {
  sm: 10,
  md: 14,
  lg: 18,
  xl: 28,
  pill: 9999,
} as const;

/** タイポトークン。管理画面（情報密度寄り）の標準値。 */
export const font = {
  caption: '0.75rem',
  small: '0.85rem',
  body: '0.95rem',
  label: '1.1rem',
  metric: '1.9rem',
} as const;

/**
 * 状態（status）の語彙 (#92 表示ルール: 正常 / 注意 / 異常 / 停止 / メンテナンス中)。
 * 管理画面の StatusBadge / HealthIndicator はこの語彙に揃える。
 */
export type StatusKind = 'ok' | 'warning' | 'critical' | 'stopped' | 'maintenance';

/** 状態 → 表示メタ（業務向けの日本語ラベルと色トークン）。 */
export const STATUS_META: Record<StatusKind, { label: string; color: string }> = {
  ok: { label: '正常', color: color.success },
  warning: { label: '注意', color: color.warning },
  critical: { label: '異常', color: color.danger },
  stopped: { label: '停止', color: color.muted },
  maintenance: { label: 'メンテナンス中', color: color.accent },
};

/**
 * トーン（tone）の語彙。数値・テキストの強調色に使う（状態とは別軸の見た目分類）。
 * MetricCard の値の色などに使う。
 */
export type Tone = 'neutral' | 'success' | 'warning' | 'danger' | 'accent';

/** トーン → 前景色トークン。 */
export const TONE_COLOR: Record<Tone, string> = {
  neutral: color.text,
  success: color.success,
  warning: color.warning,
  danger: color.danger,
  accent: color.accent,
};

/** シークレット状態の語彙 (#92: 登録済み / 未設定 / 要更新 のみを見せる)。 */
export type SecretPresence = 'configured' | 'missing' | 'needs_rotation';

/** シークレット状態 → 表示メタ。値そのものは決して扱わない。 */
export const SECRET_META: Record<SecretPresence, { label: string; color: string }> = {
  configured: { label: '登録済み', color: color.success },
  missing: { label: '未設定', color: color.muted },
  needs_rotation: { label: '要更新', color: color.warning },
};

/**
 * トーンに対応する半透明背景（notice/alert の地色）。
 * notice--success 等の既存 rgba 地色と整合させる。
 */
export const TONE_SOFT_BG: Record<Exclude<Tone, 'neutral'>, string> = {
  success: 'rgba(34, 197, 94, 0.15)',
  warning: 'rgba(251, 191, 36, 0.15)',
  danger: 'rgba(248, 113, 113, 0.15)',
  accent: 'rgba(56, 189, 248, 0.15)',
};
