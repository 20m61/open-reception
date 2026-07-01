/**
 * /notify リクエスト検証の worker 側エントリ (#275)。
 *
 * 実装は src/domain/notification/notify-validation.ts に単一化した。本ファイルは
 * handler からの既存 import パスを保つ再輸出のみ（参照同一性は
 * src/domain/notification/schema-consistency.test.ts で担保）。
 *
 * NOTE: Lambda バンドル（infra/lib/constructs/notification-function.ts の esbuild）が
 * tsconfig paths に依存しないよう、domain へは相対 import で参照する。
 */
export {
  validateNotificationRequest,
  MAX_MESSAGE_LENGTH,
} from '../../domain/notification/notify-validation';
export type { ValidationResult } from '../../domain/notification/notify-validation';
