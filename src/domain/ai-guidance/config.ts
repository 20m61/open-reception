/**
 * AI 案内の運用設定（純ドメイン）(issue #104 increment 2)。
 *
 * 施設（テナント）ごとに「AI 案内を有効にするか」「どのトピックなら回答してよいか」を
 * 管理者が設定できるようにするための純データ + 純関数。永続化・認可・監査は外側の層が担う
 * （voice-store / flow-config と同じ責務分離）。
 *
 * 安全方針（#104）:
 *  - 既定は無効（enabled=false）。明示的に有効化しない限り AI 案内は動かさない。
 *  - allowedTopics は「回答してよい範囲」の許可リスト。空なら（有効でも）範囲を限定できず
 *    実質的に out-of-scope 扱いになる想定（誤案内防止）。トピックは識別子/カテゴリで PII を含めない。
 */

/** AI 案内の運用設定。 */
export type AiGuidanceConfig = {
  /** AI 案内を有効にするか（既定 false）。 */
  enabled: boolean;
  /** 回答を許可するトピック（FAQ/施設案内/受付操作など）の許可リスト。 */
  allowedTopics: string[];
};

/** トピック 1 件の最大長と件数上限（暴走・肥大化防止）。 */
const MAX_TOPIC_LENGTH = 60;
const MAX_TOPICS = 50;

/** 既定設定: 無効・許可トピックなし。 */
export function defaultAiGuidanceConfig(): AiGuidanceConfig {
  return { enabled: false, allowedTopics: [] };
}

/**
 * トピック入力を正規化する（純関数）。
 *  - 文字列なら改行/カンマ区切りで分割。配列ならそのまま。
 *  - 各要素を trim、空を除去、NFKC 正規化。
 *  - 重複を除去（順序は初出を維持）。
 *  - 長すぎる要素は切り詰め、件数は上限まで。
 */
export function normalizeAllowedTopics(raw: unknown): string[] {
  const parts: string[] = Array.isArray(raw)
    ? raw.map((v) => (typeof v === 'string' ? v : ''))
    : typeof raw === 'string'
      ? raw.split(/[\n,]/)
      : [];

  const seen = new Set<string>();
  const result: string[] = [];
  for (const part of parts) {
    const t = part.normalize('NFKC').trim().slice(0, MAX_TOPIC_LENGTH);
    if (t === '' || seen.has(t)) continue;
    seen.add(t);
    result.push(t);
    if (result.length >= MAX_TOPICS) break;
  }
  return result;
}

/** 設定パッチ（API ボディ相当の生値）。指定フィールドのみ反映する。 */
export type AiGuidanceConfigPatch = {
  enabled?: unknown;
  allowedTopics?: unknown;
};

/**
 * 現在の設定にパッチを適用した新しい設定を返す（純関数・非破壊）。
 * 未指定フィールドは現状維持。enabled は boolean のときのみ反映。
 */
export function applyAiGuidanceConfigPatch(
  current: AiGuidanceConfig,
  patch: AiGuidanceConfigPatch,
): AiGuidanceConfig {
  const next: AiGuidanceConfig = {
    enabled: current.enabled,
    allowedTopics: [...current.allowedTopics],
  };
  if (typeof patch.enabled === 'boolean') next.enabled = patch.enabled;
  if (patch.allowedTopics !== undefined) next.allowedTopics = normalizeAllowedTopics(patch.allowedTopics);
  return next;
}
