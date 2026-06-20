/**
 * サイネージの検証・巡回ロジック (issue #101, increment 1)。純関数のみ。
 *
 * - validateConfig / validateItem: 設定の整合性を検証する（保存前に呼ぶ）。
 * - playableItems:                 巡回対象（有効かつ表示内容が揃った項目）に絞る。
 * - itemDuration:                  項目の表示秒数を解決する（個別 > 既定）。
 * - nextIndex:                     現在の index から次へ進める（末尾で先頭へ）。
 *
 * 実タイマや setInterval は持たない。呼び出し側（次増分の kiosk フック）が時間を進め、
 * このモジュールへ「次は何を、何秒出すか」を問い合わせる。
 */
import {
  SIGNAGE_LIMITS,
  isSignageContentType,
  type SignageConfig,
  type SignageItem,
} from './types';

export type ValidationError = { code: 'invalid_input'; field: string; message: string };
export type ValidationResult =
  | { ok: true }
  | { ok: false; errors: ValidationError[] };

function err(field: string, message: string): ValidationError {
  return { code: 'invalid_input', field, message };
}

/** URL が http(s) の絶対 URL かを判定する（信頼オリジン制限の最小チェック）。 */
export function isHttpUrl(value: string): boolean {
  try {
    const u = new URL(value);
    return u.protocol === 'http:' || u.protocol === 'https:';
  } catch {
    return false;
  }
}

/** 1 項目を検証する。type ごとに必須フィールドを確認する。 */
export function validateItem(item: SignageItem, index: number): ValidationError[] {
  const at = (field: string) => `items[${index}].${field}`;
  const errors: ValidationError[] = [];

  if (!item.id) errors.push(err(at('id'), 'id is required'));
  if (!isSignageContentType(item.type)) {
    errors.push(err(at('type'), 'unknown content type'));
    return errors; // 種別不明ならこれ以上の検証は無意味。
  }

  switch (item.type) {
    case 'clock':
      // 追加フィールド不要。
      break;
    case 'message':
      if (!item.message || item.message.trim().length === 0) {
        errors.push(err(at('message'), 'message is required for message type'));
      } else if (item.message.length > SIGNAGE_LIMITS.maxMessageLength) {
        errors.push(err(at('message'), 'message is too long'));
      }
      break;
    case 'image':
      if (!item.imageUrl) {
        errors.push(err(at('imageUrl'), 'imageUrl is required for image type'));
      } else if (!isHttpUrl(item.imageUrl)) {
        errors.push(err(at('imageUrl'), 'imageUrl must be an http(s) URL'));
      }
      break;
    case 'slides': {
      const urls = item.slideUrls ?? [];
      if (urls.length === 0) {
        errors.push(err(at('slideUrls'), 'at least one slide URL is required'));
      } else if (urls.length > SIGNAGE_LIMITS.maxSlidesPerItem) {
        errors.push(err(at('slideUrls'), 'too many slides'));
      } else if (!urls.every(isHttpUrl)) {
        errors.push(err(at('slideUrls'), 'all slide URLs must be http(s) URLs'));
      }
      break;
    }
  }

  if (item.durationSeconds !== undefined) {
    const d = item.durationSeconds;
    if (!Number.isFinite(d) || d < SIGNAGE_LIMITS.minIntervalSeconds || d > SIGNAGE_LIMITS.maxIntervalSeconds) {
      errors.push(err(at('durationSeconds'), 'durationSeconds is out of range'));
    }
  }

  return errors;
}

/** 設定全体を検証する。enabled が true のときは少なくとも 1 つの再生可能項目を要求する。 */
export function validateConfig(config: SignageConfig): ValidationResult {
  const errors: ValidationError[] = [];

  const interval = config.defaultIntervalSeconds;
  if (
    !Number.isFinite(interval) ||
    interval < SIGNAGE_LIMITS.minIntervalSeconds ||
    interval > SIGNAGE_LIMITS.maxIntervalSeconds
  ) {
    errors.push(err('defaultIntervalSeconds', 'defaultIntervalSeconds is out of range'));
  }

  if (config.items.length > SIGNAGE_LIMITS.maxItems) {
    errors.push(err('items', 'too many items'));
  }

  const seen = new Set<string>();
  config.items.forEach((item, i) => {
    if (seen.has(item.id)) errors.push(err(`items[${i}].id`, 'duplicate item id'));
    seen.add(item.id);
    errors.push(...validateItem(item, i));
  });

  // モードを有効にするなら、待機画面が空にならないことを保証する。
  if (config.enabled && playableItems(config).length === 0) {
    errors.push(err('items', 'enabled signage requires at least one playable item'));
  }

  return errors.length === 0 ? { ok: true } : { ok: false, errors };
}

/** 項目単体が再生可能か（有効 + 内容が揃っている）。 */
export function isPlayable(item: SignageItem): boolean {
  if (!item.enabled) return false;
  return validateItem(item, 0).length === 0;
}

/** 巡回対象の項目を、設定の並び順を保って返す。 */
export function playableItems(config: SignageConfig): SignageItem[] {
  return config.items.filter(isPlayable);
}

/** 項目の表示秒数を解決する（個別指定 > 設定既定）。 */
export function itemDuration(item: SignageItem, config: SignageConfig): number {
  return item.durationSeconds ?? config.defaultIntervalSeconds;
}

/**
 * 現在の index から次の index を返す（末尾で先頭へループ）。
 * total が 0 のときは 0 を返す（呼び出し側は再生対象なしとして扱う）。
 */
export function nextIndex(current: number, total: number): number {
  if (total <= 0) return 0;
  return (current + 1) % total;
}
