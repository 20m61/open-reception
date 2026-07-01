/**
 * 通知ルート設定バリデーションの app 側エントリ (#275)。
 *
 * 実装は src/domain/notification/call-route-validation.ts に単一化した。本ファイルは
 * 既存 import パスを保つ再輸出のみ（参照同一性は
 * src/domain/notification/schema-consistency.test.ts で担保）。
 */
export * from '@/domain/notification/call-route-validation';
