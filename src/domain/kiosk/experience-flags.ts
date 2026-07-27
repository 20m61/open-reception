/**
 * 受付端末の体験シェル移行フラグ (issue #422 / epic #418)。
 *
 * `docs/product-integration-plan.md` §7 の feature flag registry に対応する**移行用**フラグ。
 * テナント機能フラグ（`TENANT_FEATURE_FLAG_KEYS`）とは目的が違うので同居させない:
 * あちらは「そのテナントがその機能を使うか」（恒久）、こちらは「新旧どちらの経路で動くか」
 * （移行完了後に撤去）。
 *
 * 解決順（後勝ち）:
 *   1. ビルド時の既定 `NEXT_PUBLIC_KIOSK_EFFECTIVE_CONFIG`（環境ごとの既定値）
 *   2. URL クエリ `?effectiveConfig=1|0`（**端末 1 台単位で切り戻せる**）
 *
 * クエリ上書きを本番でも許すのは、既存のタイマー上書き（`?inactivityMs=` 等）と同じ流儀で、
 * かつロールバック手順（台帳 §10）を「その端末の URL を変える」だけで完了させたいため。
 * このフラグ自体は秘匿値を運ばない（`?debugScanPayload=` と違い本番で塞ぐ理由がない）。
 */

export type KioskExperienceFlags = {
  /**
   * 構成取得を `/api/configuration/effective` の 1 回取得に切り替えるか (#419 × #422)。
   * false のときは個別 API（`/api/kiosk/branding` 等）から取る従来経路。
   */
  effectiveConfiguration: boolean;
};

/** 既定は旧経路。移行フラグは「明示的に入れる」まで倒れない。 */
export const DEFAULT_KIOSK_EXPERIENCE_FLAGS: KioskExperienceFlags = {
  effectiveConfiguration: false,
};

/** `1` / `true` / `on` を真、`0` / `false` / `off` を偽とみなす。それ以外は未指定扱い。 */
function parseBooleanish(value: string | null | undefined): boolean | undefined {
  if (value === null || value === undefined) return undefined;
  const normalized = value.trim().toLowerCase();
  if (normalized === '1' || normalized === 'true' || normalized === 'on') return true;
  if (normalized === '0' || normalized === 'false' || normalized === 'off') return false;
  return undefined;
}

/**
 * 体験シェルの移行フラグを解決する。純関数（`window` / `process` を直接読まない）。
 *
 * @param input.search 現在の URL クエリ文字列（`window.location.search` 相当）。
 * @param input.env    ビルド時に埋め込まれた既定値（`NEXT_PUBLIC_KIOSK_EFFECTIVE_CONFIG`）。
 */
export function resolveKioskExperienceFlags(input: {
  search?: string;
  env?: string;
}): KioskExperienceFlags {
  const fromEnv = parseBooleanish(input.env);
  const fromQuery = parseBooleanish(new URLSearchParams(input.search ?? '').get('effectiveConfig'));
  return {
    effectiveConfiguration:
      fromQuery ?? fromEnv ?? DEFAULT_KIOSK_EXPERIENCE_FLAGS.effectiveConfiguration,
  };
}
